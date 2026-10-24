-- Banto 0002_hooks: hooks（署名付き Webhook 送信）と外部プラグインの登録先
-- CLAUDE.md §5: order.created order.paid order.shipped order.cancelled customer.created product.updated inventory.low
-- 失敗時は指数バックオフで最大5回再送。配信は Cron（SchedulerAdapter）から service_role で行う。

-- ---------- 送信先（外部プラグイン / 任意の URL） ----------
create table hook_endpoints (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  url text not null check (url ~ '^https?://'),
  -- 購読するイベント名。空なら何も受け取らない
  events text[] not null default '{}',
  enabled boolean not null default true,
  -- 外部プラグインが返したマニフェスト（JSON）。シークレットは入れない（CLAUDE.md §1-5）
  manifest jsonb,
  -- マニフェストで宣言された設定項目の値。シークレット型は持たない
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on hook_endpoints(shop_id);
create trigger hook_endpoints_updated_at before update on hook_endpoints for each row execute function banto_set_updated_at();

-- ---------- 配信キュー ----------
create type hook_delivery_status as enum ('pending', 'delivered', 'failed');
create table hook_deliveries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  endpoint_id uuid not null references hook_endpoints(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status hook_delivery_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index on hook_deliveries(status, next_attempt_at);
create index on hook_deliveries(shop_id, created_at desc);

-- ---------- RLS ----------
alter table hook_endpoints enable row level security;
alter table hook_deliveries enable row level security;

create policy hook_endpoints_owner on hook_endpoints for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
-- 配信履歴は owner が閲覧のみ。作成は enqueue_hook、更新は Cron（service_role）。
create policy hook_deliveries_owner_select on hook_deliveries for select using (banto_owns_shop(shop_id));

-- ---------- RPC ----------
-- イベントをキューに積む。shop の有効な送信先のうち、そのイベントを購読するものごとに1行。
-- owner（authenticated、所有を検証）と service_role（DB 内の確定処理）から呼ぶ。戻り値: 積んだ件数。
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' and not banto_owns_shop(p_shop_id) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 配信待ちを取り出す（Cron、service_role）。取り出した行は attempts を進め、10 分のリースを張って二重配信を防ぐ。
create or replace function claim_hook_deliveries(p_limit integer default 50)
returns table (
  id uuid, shop_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer,
  url text, settings jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'claim_hook_deliveries: service_role only' using errcode = '42501';
  end if;
  return query
  with picked as (
    select d.id from hook_deliveries d
      join hook_endpoints e on e.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and e.enabled
     order by d.next_attempt_at
     limit greatest(1, least(p_limit, 500))
     for update of d skip locked
  ),
  leased as (
    update hook_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from picked
     where d.id = picked.id
    returning d.id, d.shop_id, d.endpoint_id, d.event, d.payload, d.attempts, d.created_at
  )
  select l.id, l.shop_id, l.endpoint_id, l.event, l.payload, l.attempts, e.url, e.settings, l.created_at
    from leased l join hook_endpoints e on e.id = l.endpoint_id;
end;
$$;

-- 配信結果を記録する。失敗は 2^attempts 分後に再送、5回失敗で failed（CLAUDE.md §5）。
create or replace function finish_hook_delivery(p_id uuid, p_success boolean, p_status integer, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'finish_hook_delivery: service_role only' using errcode = '42501';
  end if;
  select attempts into v_attempts from hook_deliveries where id = p_id;
  if not found then return; end if;
  if p_success then
    update hook_deliveries
       set status = 'delivered', delivered_at = now(), last_status = p_status, last_error = null
     where id = p_id;
  elsif v_attempts >= 5 then
    update hook_deliveries
       set status = 'failed', last_status = p_status, last_error = left(p_error, 1000)
     where id = p_id;
  else
    update hook_deliveries
       set next_attempt_at = now() + make_interval(mins => power(2, v_attempts)::integer),
           last_status = p_status, last_error = left(p_error, 1000)
     where id = p_id;
  end if;
end;
$$;

-- ---------- 予約に購入者情報を一時保持（KOMOJU 等、決済ページが配送先を集めない場合） ----------
-- 確定時に orders へ移して null にする。解放時も null にする（個人情報を残さない、CLAUDE.md §8）。
alter table reservations add column customer jsonb;

create or replace function attach_reservation_customer(p_reservation_id uuid, p_shop_id uuid, p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'attach_reservation_customer: service_role only' using errcode = '42501';
  end if;
  update reservations set customer = p_customer
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending';
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
end;
$$;

-- 解放時に購入者情報を消す（release_reservation / release_expired_reservations を差し替え）
create or replace function release_reservation(p_reservation_id uuid, p_shop_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_item jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_reservation: service_role only' using errcode = '42501';
  end if;
  select * into v_res from reservations
   where id = p_reservation_id and shop_id = p_shop_id
   for update;
  if not found or v_res.status <> 'pending' then
    return false;
  end if;
  for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
    update inventory set available = available + (v_item->>'qty')::integer, updated_at = now()
     where sku_id = (v_item->>'sku_id')::uuid and shop_id = p_shop_id;
  end loop;
  update reservations set status = 'released', customer = null where id = p_reservation_id;
  return true;
end;
$$;

create or replace function release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res record;
  v_item jsonb;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_expired_reservations: service_role only' using errcode = '42501';
  end if;
  for v_res in
    select id, shop_id, items from reservations
     where status = 'pending' and expires_at < now()
     for update skip locked
  loop
    for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
      update inventory set available = available + (v_item->>'qty')::integer, updated_at = now()
       where sku_id = (v_item->>'sku_id')::uuid and shop_id = v_res.shop_id;
    end loop;
    update reservations set status = 'released', customer = null where id = v_res.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------- ストアフロント用: 有効な同梱決済プラグインとその設定（シークレットは含まない） ----------
create or replace function shop_payment_options(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', substr(e.url, length('https://banto.invalid/plugins/') + 1),
           'settings', e.settings)), '[]'::jsonb)
    from hook_endpoints e
    join shops s on s.id = e.shop_id
   where e.shop_id = p_shop_id and e.enabled and s.published
     and e.url like 'https://banto.invalid/plugins/%';
$$;

-- 注文確定時に DB 内から order.created / order.paid / inventory.low を積む（confirm_reservation を差し替え）
create or replace function confirm_reservation(p_reservation_id uuid, p_shop_id uuid, p_order jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_order_id uuid;
  v_item jsonb;
  v_updated integer;
  v_total integer;
  v_threshold integer;
  v_available integer;
  v_payload jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'confirm_reservation: service_role only' using errcode = '42501';
  end if;

  select * into v_res from reservations
   where id = p_reservation_id and shop_id = p_shop_id
   for update;
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;

  select id into v_order_id from orders where reservation_id = p_reservation_id;
  if found then
    return v_order_id;
  end if;

  if v_res.status = 'released' then
    for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
      update inventory
         set available = available - (v_item->>'qty')::integer, updated_at = now()
       where sku_id = (v_item->>'sku_id')::uuid and shop_id = p_shop_id
         and available >= (v_item->>'qty')::integer;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'insufficient_stock_after_release' using detail = v_item->>'sku_id';
      end if;
    end loop;
  end if;

  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0)
    into v_total
    from jsonb_array_elements(v_res.items) e;

  insert into orders (shop_id, reservation_id, status, total_jpy,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref)
  values (p_shop_id, p_reservation_id, 'paid', v_total,
          coalesce(p_order->>'customer_email', v_res.customer->>'customer_email'),
          coalesce(p_order->>'customer_name', v_res.customer->>'customer_name'),
          coalesce(p_order->'shipping_address', v_res.customer->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref')
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer
    from jsonb_array_elements(v_res.items) e;

  update reservations set status = 'confirmed', customer = null where id = p_reservation_id;

  -- hooks: 注文（個人情報は含めない。必要ならプラグインがヘッドレス API で取る）
  v_payload := jsonb_build_object(
    'order_id', v_order_id, 'shop_id', p_shop_id, 'total_jpy', v_total, 'status', 'paid',
    'payment_provider', p_order->>'payment_provider',
    'items', v_res.items
  );
  perform enqueue_hook(p_shop_id, 'order.created', v_payload);
  perform enqueue_hook(p_shop_id, 'order.paid', v_payload);

  -- hooks: 在庫僅少（shops.settings.low_stock_threshold、既定 3）
  select coalesce((s.settings->>'low_stock_threshold')::integer, 3) into v_threshold from shops s where s.id = p_shop_id;
  for v_item in select e from jsonb_array_elements(v_res.items) e loop
    select available into v_available from inventory where sku_id = (v_item->>'sku_id')::uuid;
    if v_available is not null and v_available <= v_threshold then
      perform enqueue_hook(p_shop_id, 'inventory.low',
        jsonb_build_object('shop_id', p_shop_id, 'sku_id', v_item->>'sku_id', 'available', v_available, 'threshold', v_threshold));
    end if;
  end loop;

  return v_order_id;
end;
$$;

-- ---------- 実行権限 ----------
revoke execute on function enqueue_hook(uuid, text, jsonb) from public, anon;
grant execute on function enqueue_hook(uuid, text, jsonb) to authenticated, service_role;
revoke execute on function claim_hook_deliveries(integer) from public, anon, authenticated;
revoke execute on function finish_hook_delivery(uuid, boolean, integer, text) from public, anon, authenticated;
grant execute on function claim_hook_deliveries(integer) to service_role;
grant execute on function finish_hook_delivery(uuid, boolean, integer, text) to service_role;
revoke execute on function attach_reservation_customer(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function attach_reservation_customer(uuid, uuid, jsonb) to service_role;
revoke execute on function release_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function release_reservation(uuid, uuid) to service_role;
revoke execute on function release_expired_reservations() from public, anon, authenticated;
grant execute on function release_expired_reservations() to service_role;
grant execute on function shop_payment_options(uuid) to anon, authenticated, service_role;
revoke execute on function confirm_reservation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function confirm_reservation(uuid, uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0002_hooks');
