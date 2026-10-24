-- Banto 0004_commerce: 送料、注文番号、キャンセル（在庫戻し）、購入者向け注文照会、会員（オプトイン）
-- 前方専用。既存行には既定値が入る。

-- ---------- 送料・注文番号 ----------
-- 送料設定は shops.settings.shipping（JSON）。計算はアプリ層（src/commerce/shipping.ts）で行い、確定時の金額を予約と注文に残す。
alter table reservations add column shipping_jpy integer not null default 0 check (shipping_jpy >= 0);
alter table orders add column shipping_jpy integer not null default 0 check (shipping_jpy >= 0);
-- ショップごとの連番（1001 から）。人が読める注文番号
alter table shops add column order_seq integer not null default 1000;
alter table orders add column number integer;
create unique index orders_shop_number on orders(shop_id, number) where number is not null;
-- 既存の注文に番号を振る（作成順）
with numbered as (
  select id, shop_id, row_number() over (partition by shop_id order by created_at, id) as rn from orders
)
update orders o set number = 1000 + n.rn from numbered n where n.id = o.id;
update shops s set order_seq = greatest(order_seq, coalesce((select max(number) from orders o where o.shop_id = s.id), 1000));
alter table orders alter column number set not null;

-- 会員（任意）。orders.customer_id は会員が購入した場合だけ入る
create table customers (
  id uuid not null references auth.users(id) on delete cascade,
  shop_id uuid not null references shops(id) on delete cascade,
  email text,
  name text,
  default_address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id)
);
create trigger customers_updated_at before update on customers for each row execute function banto_set_updated_at();
alter table orders add column customer_id uuid;
alter table reservations add column customer_id uuid;
create index on orders(shop_id, customer_id) where customer_id is not null;

alter table customers enable row level security;
-- 会員は自分の行だけ。owner は自ショップの会員を閲覧・削除（退会対応）できる
create policy customers_self on customers for all
  using (id = auth.uid()) with check (id = auth.uid());
create policy customers_owner_select on customers for select using (banto_owns_shop(shop_id));
create policy customers_owner_delete on customers for delete using (banto_owns_shop(shop_id));
-- 会員は自分の注文を閲覧できる
create policy orders_customer_select on orders for select using (customer_id is not null and customer_id = auth.uid());
create policy order_items_customer_select on order_items for select
  using (exists (select 1 from orders o where o.id = order_items.order_id and o.customer_id is not null and o.customer_id = auth.uid()));

-- ---------- 予約に購入者情報・送料・会員を付ける（0002 の attach を差し替え） ----------
create or replace function attach_reservation_customer(p_reservation_id uuid, p_shop_id uuid, p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shipping integer; v_customer_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'attach_reservation_customer: service_role only' using errcode = '42501';
  end if;
  v_shipping := coalesce((p_customer->>'shipping_jpy')::integer, 0);
  if v_shipping < 0 then raise exception 'invalid_shipping'; end if;
  v_customer_id := nullif(p_customer->>'customer_id', '')::uuid;
  update reservations
     set customer = p_customer - 'shipping_jpy' - 'customer_id',
         shipping_jpy = v_shipping,
         customer_id = v_customer_id
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending';
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
end;
$$;

-- ---------- 注文確定（0002 を差し替え: 送料・番号・会員・hooks の送料） ----------
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
  v_subtotal integer;
  v_number integer;
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
    into v_subtotal
    from jsonb_array_elements(v_res.items) e;

  -- ショップごとの注文番号（shops の行ロックで直列化）
  update shops set order_seq = order_seq + 1 where id = p_shop_id returning order_seq into v_number;

  insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, number, customer_id,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref)
  values (p_shop_id, p_reservation_id, 'paid', v_subtotal + v_res.shipping_jpy, v_res.shipping_jpy, v_number, v_res.customer_id,
          -- Banto のフォームで集めた値を優先し、無ければ決済事業者からの値
          coalesce(v_res.customer->>'customer_email', p_order->>'customer_email'),
          coalesce(v_res.customer->>'customer_name', p_order->>'customer_name'),
          coalesce(v_res.customer->'shipping_address', p_order->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref')
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer
    from jsonb_array_elements(v_res.items) e;

  update reservations set status = 'confirmed', customer = null where id = p_reservation_id;

  v_payload := jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_number, 'shop_id', p_shop_id,
    'subtotal_jpy', v_subtotal, 'shipping_jpy', v_res.shipping_jpy, 'total_jpy', v_subtotal + v_res.shipping_jpy,
    'status', 'paid', 'payment_provider', p_order->>'payment_provider', 'customer_id', v_res.customer_id,
    'items', v_res.items
  );
  perform enqueue_hook(p_shop_id, 'order.created', v_payload);
  perform enqueue_hook(p_shop_id, 'order.paid', v_payload);

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

-- ---------- キャンセル: 在庫を戻し、状態を cancelled / refunded にする（返金自体は Worker が決済事業者 API で行う） ----------
-- 支払い済み（paid）の注文のみ。冪等（既に cancelled/refunded なら何もせず現在の状態を返す）。
create or replace function cancel_order(p_order_id uuid, p_shop_id uuid, p_refunded boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_item record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cancel_order: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_o.status in ('cancelled', 'refunded') then
    return jsonb_build_object('order_id', v_o.id, 'status', v_o.status, 'already', true);
  end if;
  if v_o.status <> 'paid' then raise exception 'not_cancellable' using detail = v_o.status::text; end if;
  for v_item in select sku_id, qty from order_items where order_id = p_order_id loop
    update inventory set available = available + v_item.qty, updated_at = now()
     where sku_id = v_item.sku_id and shop_id = p_shop_id;
  end loop;
  update orders set status = case when p_refunded then 'refunded'::order_status else 'cancelled'::order_status end
   where id = p_order_id;
  perform enqueue_hook(p_shop_id, 'order.cancelled',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy,
                       'status', case when p_refunded then 'refunded' else 'cancelled' end, 'refunded', p_refunded, 'customer_id', v_o.customer_id));
  return jsonb_build_object('order_id', v_o.id, 'status', case when p_refunded then 'refunded' else 'cancelled' end, 'already', false,
                            'payment_provider', v_o.payment_provider, 'payment_ref', v_o.payment_ref);
end;
$$;

-- 返金に必要な情報だけ（Worker のキャンセル処理が先に読む）
create or replace function order_payment_info(p_order_id uuid, p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.role() is distinct from 'service_role' then null
         else (select jsonb_build_object('order_id', o.id, 'status', o.status, 'payment_provider', o.payment_provider,
                                         'payment_ref', o.payment_ref, 'total_jpy', o.total_jpy)
                 from orders o where o.id = p_order_id and o.shop_id = p_shop_id) end;
$$;

-- ---------- 取引メール用: 注文の連絡先と明細（同梱メールプラグインが service_role で読む。hooks のペイロードには載せない） ----------
create or replace function order_contact(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'created_at', v_o.created_at,
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'payment_provider', v_o.payment_provider,
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug,
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

-- ---------- 購入者向け注文照会（anon）: 注文番号 + メールで状態だけ返す。住所は返さない ----------
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                            'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy,
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;

-- ---------- api_* の更新: 注文 JSON に番号・送料・会員、キャンセルは cancel_order 経由 ----------
create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'total_jpy', p_order.total_jpy, 'shipping_jpy', p_order.shipping_jpy,
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref, 'customer_id', p_order.customer_id,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  );
$$;

-- 発送済みのみ。キャンセルは api_order_cancel（返金後に Worker が呼ぶ）
create or replace function api_order_update_status(p_token_hash text, p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if p_status <> 'shipped' then raise exception 'invalid_status'; end if;
  update orders set status = 'shipped', shipped_at = now()
   where id = p_order_id and shop_id = v_tok.shop_id and status = 'paid'
  returning * into v_o;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'order.shipped',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', v_tok.shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status, 'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id));
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

create or replace function api_order_payment_info(p_token_hash text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  v_r := order_payment_info(p_order_id, v_tok.shop_id);
  if v_r is null then raise exception 'not_found'; end if;
  return v_r;
end;
$$;

create or replace function api_order_cancel(p_token_hash text, p_order_id uuid, p_refunded boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  v_r := cancel_order(p_order_id, v_tok.shop_id, p_refunded);
  select * into v_o from orders where id = p_order_id;
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

-- 注文検索（番号・メール・氏名）を一覧に追加。旧シグネチャは削除（オーバーロードの曖昧さを避ける）
drop function if exists api_orders_list(text, text, timestamptz, timestamptz, integer, integer);
create or replace function api_orders_list(p_token_hash text, p_status text default null, p_from timestamptz default null,
                                           p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0,
                                           p_query text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer; v_total integer; v_items jsonb; v_number integer;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_number := case when p_query ~ '^\d+$' then p_query::integer else null end;
  select count(*) into v_total from orders o
   where o.shop_id = v_tok.shop_id
     and (p_status is null or o.status::text = p_status)
     and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
     and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')));
  select coalesce(jsonb_agg(api_order_json(o, v_pii) order by o.created_at desc), '[]'::jsonb) into v_items
    from (select * from orders o
           where o.shop_id = v_tok.shop_id
             and (p_status is null or o.status::text = p_status)
             and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
             and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')))
           order by o.created_at desc
           limit v_limit offset greatest(0, coalesce(p_offset, 0))) o;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', greatest(0, coalesce(p_offset, 0)), 'pii', v_pii);
end;
$$;

-- 送料を含めた集計（revenue は商品代 + 送料 = total_jpy のまま。内訳として shipping を足す）
create or replace function sales_summary_for_shop(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_rows jsonb; v_total jsonb;
begin
  if p_group_by not in ('day', 'month', 'product') then raise exception 'invalid_group_by'; end if;
  select jsonb_build_object(
    'orders', count(*), 'revenue_jpy', coalesce(sum(o.total_jpy), 0), 'shipping_jpy', coalesce(sum(o.shipping_jpy), 0),
    'items', coalesce((select sum(oi.qty) from order_items oi join orders o2 on o2.id = oi.order_id
                        where o2.shop_id = p_shop_id and o2.status in ('paid','shipped') and o2.created_at >= p_from and o2.created_at < p_to), 0),
    'avg_order_jpy', coalesce(round(avg(o.total_jpy)), 0))
    into v_total
    from orders o where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to;

  if p_group_by = 'product' then
    select coalesce(jsonb_agg(r order by (r->>'revenue_jpy')::bigint desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('product_id', p.id, 'product_name', coalesce(p.name, '(削除済み)'), 'sku_code', k.code,
                                'qty', sum(oi.qty), 'revenue_jpy', sum(oi.qty * oi.unit_price_jpy)) as r
        from order_items oi
        join orders o on o.id = oi.order_id
        left join skus k on k.id = oi.sku_id
        left join products p on p.id = k.product_id
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by p.id, p.name, k.code) x;
  else
    select coalesce(jsonb_agg(r order by r->>'period'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('period', to_char(date_trunc(p_group_by, o.created_at at time zone 'Asia/Tokyo'), case when p_group_by = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
                                'orders', count(*), 'revenue_jpy', sum(o.total_jpy), 'shipping_jpy', sum(o.shipping_jpy)) as r
        from orders o
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by date_trunc(p_group_by, o.created_at at time zone 'Asia/Tokyo')) x;
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'group_by', p_group_by, 'timezone', 'Asia/Tokyo', 'total', v_total, 'rows', v_rows);
end;
$$;

-- api_token_shop に接続済み Stripe アカウント ID を含める（返金先の判定用。秘密ではない）
create or replace function api_token_shop(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype; v_acct text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_token_shop: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then raise exception 'unauthorized' using errcode = '42501'; end if;
  select stripe_account_id into v_acct from shops where id = v_tok.shop_id;
  return jsonb_build_object('shop_id', v_tok.shop_id, 'scopes', to_jsonb(v_tok.scopes), 'name', v_tok.name, 'stripe_account_id', v_acct);
end;
$$;

-- ---------- 実行権限 ----------
revoke execute on function attach_reservation_customer(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function attach_reservation_customer(uuid, uuid, jsonb) to service_role;
revoke execute on function confirm_reservation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function confirm_reservation(uuid, uuid, jsonb) to service_role;
revoke execute on function cancel_order(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function cancel_order(uuid, uuid, boolean) to service_role;
revoke execute on function order_payment_info(uuid, uuid) from public, anon, authenticated;
grant execute on function order_payment_info(uuid, uuid) to service_role;
revoke execute on function order_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function order_contact(uuid, uuid) to service_role;
revoke execute on function lookup_order(uuid, integer, text) from public;
grant execute on function lookup_order(uuid, integer, text) to anon, authenticated, service_role;
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname like 'api\_%' or p.proname = 'sales_summary_for_shop')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

insert into banto_migrations (version) values ('0004_commerce');
