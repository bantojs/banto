-- Banto 0105_ma_ports: 外部プラグイン（MA・CRM・自動化）向けの 3 つの口（メンテナの決定 2026-11-03）。前方専用。
--   A. LINE で送る口（スコープ line:send、項目 marketing）。外部プラグインが「この会員にこの文を」と頼み、Banto がショップの
--      LINE 公式アカウントのトークン（0021）で 1 通送る。LINE の利用者 ID は Banto の外へ出さない。
--      Banto は頼まれた 1 通を送るだけで、列・予約の時刻・再送・セグメントは持たない（それはプラグイン。docs/line.md §4）。
--      宣伝の分にショップごとの月の上限（shops.settings.line_marketing_limit、既定 150）。取引の知らせ（同梱プラグイン）は数えない。
--      送った記録 line_messages（会員 ID・状態・時刻だけ。文は残さない）は冪等のキーと月の数のため。
--   B. 注文の一覧を会員で絞る・更新順に取りこぼしなく読む（api_orders_list に p_customer_id・p_updated_since・p_after）。
--   C. hooks checkout.abandoned: 会員の予約が決済されないまま期限切れで解放されたとき（Cron の TTL、決済ページの期限切れの Webhook）。
--      支払いの失敗・決済ページを作れなかった・お客様が戻った場合は数えない。ゲストは送らない（案内の同意が無いため）。

-- ---------- A. LINE で送る口 ----------
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send']::text[]
);

create or replace function banto_scope_perm(p_scope text)
returns text language sql immutable as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
    when 'content:read' then 'content'
    when 'content:write' then 'content'
    when 'app_data:write' then 'apps'
    when 'line:send' then 'marketing'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- 送った記録（冪等のキーと月の数のため）。文・LINE の利用者 ID は置かない
create table if not exists line_messages (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid,
  idem_key text not null check (idem_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  status text not null check (status in ('pending', 'sent', 'no_line', 'not_friend', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, idem_key)
);
create index if not exists line_messages_shop_created_idx on line_messages (shop_id, created_at);
-- 退会した会員の行は会員 ID を外す（月の数のために行は残す）
create index if not exists line_messages_customer_idx on line_messages (customer_id) where customer_id is not null;
alter table line_messages enable row level security;
drop policy if exists line_messages_read on line_messages;
create policy line_messages_read on line_messages for select using (banto_shop_perm(shop_id, 'marketing'));
revoke all on line_messages from anon, authenticated;
grant select on line_messages to authenticated;

create or replace function banto_line_messages_customer_gone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update line_messages set customer_id = null where shop_id = old.shop_id and customer_id = old.id;
  return old;
end;
$$;
revoke execute on function banto_line_messages_customer_gone() from public, anon, authenticated;
drop trigger if exists customers_line_messages_gone on customers;
create trigger customers_line_messages_gone after delete on customers for each row execute function banto_line_messages_customer_gone();

-- 宣伝の月の上限（ショップの設定。無ければ 150。0 なら送らない）
create or replace function banto_line_marketing_limit(p_settings jsonb)
returns integer language sql immutable as $$
  select case when coalesce(p_settings->>'line_marketing_limit', '') ~ '^\d{1,7}$' then (p_settings->>'line_marketing_limit')::integer else 150 end;
$$;
revoke execute on function banto_line_marketing_limit(jsonb) from public, anon, authenticated;

-- 今月（日本時間）に送った・送っている数
create or replace function banto_line_month_count(p_shop_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from line_messages
   where shop_id = p_shop_id and status in ('pending', 'sent')
     and created_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');
$$;
revoke execute on function banto_line_month_count(uuid) from public, anon, authenticated;

-- 送る前（Worker、service_role）。返すのは状態と、送るときだけ LINE の利用者 ID と再送キー（行の id）。
-- 同じキーでもう決まった行は、その状態を返す（送り直さない）。pending / failed の行は同じ再送キーで送り直せる（LINE が重ねて届けない）
create or replace function api_line_message_begin(p_token_hash text, p_customer_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens;
  v_row line_messages;
  v_line text;
  v_limit integer;
  v_count integer;
begin
  v_tok := api_require(p_token_hash, 'line:send');
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'invalid_idempotency_key'; end if;
  if p_customer_id is null or not exists (select 1 from customers where id = p_customer_id and shop_id = v_tok.shop_id) then
    raise exception 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('line_messages|' || v_tok.shop_id::text, 0));
  select * into v_row from line_messages where shop_id = v_tok.shop_id and idem_key = p_key;
  if found then
    if v_row.customer_id is distinct from p_customer_id then raise exception 'idempotency_key_reused'; end if;
    if v_row.status in ('sent', 'no_line', 'not_friend') then
      return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'done', true);
    end if;
  end if;
  select subject into v_line from member_identities where shop_id = v_tok.shop_id and customer_id = p_customer_id and provider = 'line';
  if v_line is null then
    if v_row.id is null then
      insert into line_messages (shop_id, customer_id, idem_key, status) values (v_tok.shop_id, p_customer_id, p_key, 'no_line') returning * into v_row;
    else
      update line_messages set status = 'no_line', updated_at = now() where id = v_row.id returning * into v_row;
    end if;
    return jsonb_build_object('id', v_row.id, 'status', 'no_line', 'done', true);
  end if;
  if v_row.id is null or v_row.status = 'failed' then
    v_limit := banto_line_marketing_limit((select settings from shops where id = v_tok.shop_id));
    v_count := banto_line_month_count(v_tok.shop_id);
    if v_count >= v_limit then
      return jsonb_build_object('status', 'quota', 'done', true, 'limit', v_limit, 'count', v_count);
    end if;
  end if;
  -- 古い記録（400 日より前）は消す（月の数にも冪等にも要らない）
  delete from line_messages where shop_id = v_tok.shop_id and created_at < now() - interval '400 days';
  if v_row.id is null then
    insert into line_messages (shop_id, customer_id, idem_key, status) values (v_tok.shop_id, p_customer_id, p_key, 'pending') returning * into v_row;
  else
    update line_messages set status = 'pending', updated_at = now() where id = v_row.id returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'status', 'pending', 'done', false, 'shop_id', v_tok.shop_id, 'line_user_id', v_line, 'retry_key', v_row.id);
end;
$$;

-- 送った後（Worker、service_role）。sent / not_friend / failed（LINE の側の一時的な失敗。月の数に入れない）
create or replace function api_line_message_finish(p_token_hash text, p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_row line_messages;
begin
  v_tok := api_require(p_token_hash, 'line:send');
  if p_status not in ('sent', 'not_friend', 'failed') then raise exception 'invalid_status'; end if;
  update line_messages set status = p_status, updated_at = now()
   where id = p_id and shop_id = v_tok.shop_id and status = 'pending'
  returning * into v_row;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;

-- 今月の数と上限（プラグインの画面の「今月の送った数」）
create or replace function api_line_usage(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'line:send');
  return jsonb_build_object(
    'month', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM'),
    'count', banto_line_month_count(v_tok.shop_id),
    'limit', banto_line_marketing_limit((select settings from shops where id = v_tok.shop_id)));
end;
$$;

-- 管理画面（項目 marketing）: 今月の数と上限
create or replace function line_marketing_usage(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object('count', banto_line_month_count(p_shop_id),
                            'limit', banto_line_marketing_limit((select settings from shops where id = p_shop_id)));
end;
$$;
revoke execute on function line_marketing_usage(uuid) from public, anon;
grant execute on function line_marketing_usage(uuid) to authenticated, service_role;

revoke execute on function api_line_message_begin(text, uuid, text) from public, anon, authenticated;
revoke execute on function api_line_message_finish(text, uuid, text) from public, anon, authenticated;
revoke execute on function api_line_usage(text) from public, anon, authenticated;
grant execute on function api_line_message_begin(text, uuid, text) to service_role;
grant execute on function api_line_message_finish(text, uuid, text) to service_role;
grant execute on function api_line_usage(text) to service_role;

-- ---------- B. 注文の一覧: 会員で絞る・更新順に読む ----------
-- p_updated_since を渡すと updated_at・id の昇順。続きは前の応答の cursor（{ updated_since, after }）をそのまま渡す（同じ時刻の行を読み落とさない）
drop function if exists api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text);
create or replace function api_orders_list(p_token_hash text, p_status text default null, p_from timestamptz default null,
                                           p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0,
                                           p_query text default null, p_customer_id uuid default null,
                                           p_updated_since timestamptz default null, p_after uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens; v_pii boolean; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_number integer;
  v_seq boolean; v_cursor jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_number := case when p_query ~ '^\d+$' then p_query::integer else null end;
  v_seq := p_updated_since is not null;
  if p_after is not null and not v_seq then raise exception 'invalid_cursor'; end if;

  select count(*) into v_total from orders o
   where o.shop_id = v_tok.shop_id
     and (p_status is null or o.status::text = p_status)
     and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
     and (p_customer_id is null or o.customer_id = p_customer_id)
     and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
     and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')));
  with page as (
    select o.id, o.updated_at,
           row_number() over (order by case when v_seq then o.updated_at end asc, case when v_seq then o.id end asc, o.created_at desc, o.id desc) as ord
      from orders o
     where o.shop_id = v_tok.shop_id
       and (p_status is null or o.status::text = p_status)
       and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
       and (p_customer_id is null or o.customer_id = p_customer_id)
       and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
       and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')))
     order by ord
     limit v_limit offset case when v_seq then 0 else v_offset end
  )
  select coalesce(jsonb_agg(api_order_json(o, v_pii) order by p.ord), '[]'::jsonb),
         (select jsonb_build_object('updated_since', l.updated_at, 'after', l.id) from page l order by l.ord desc limit 1)
    into v_items, v_cursor
    from page p join orders o on o.id = p.id;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', case when v_seq then 0 else v_offset end, 'pii', v_pii)
         || case when v_seq then jsonb_build_object('cursor', v_cursor, 'has_more', v_total > jsonb_array_length(v_items)) else '{}'::jsonb end;
end;
$$;
revoke execute on function api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text, uuid, timestamptz, uuid) to service_role;

-- ---------- C. hooks checkout.abandoned ----------
-- 解放した予約が会員のものなら積む。ペイロードは ID と数と金額だけ（個人情報を載せない）
create or replace function banto_enqueue_checkout_abandoned(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_res reservations%rowtype; v_items jsonb;
begin
  select * into v_res from reservations where id = p_reservation_id;
  if not found or v_res.customer_id is null or v_res.status <> 'released' then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku_id', k.id, 'product_id', k.product_id, 'qty', (e->>'qty')::integer,
                                               'unit_price_jpy', (e->>'unit_price_jpy')::integer) order by e->>'sku_id'), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_res.items) e left join skus k on k.id = (e->>'sku_id')::uuid;
  perform enqueue_hook(v_res.shop_id, 'checkout.abandoned', jsonb_build_object(
    'reservation_id', v_res.id, 'shop_id', v_res.shop_id, 'customer_id', v_res.customer_id, 'reason', 'expired',
    'items', v_items,
    'subtotal_jpy', (select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0) from jsonb_array_elements(v_res.items) e),
    'started_at', v_res.created_at));
end;
$$;
revoke execute on function banto_enqueue_checkout_abandoned(uuid) from public, anon, authenticated;

-- 決済ページの期限切れ（Stripe の checkout.session.expired・KOMOJU の payment.expired）。release_reservation と同じに解放して、解放できたら積む
create or replace function release_reservation_abandoned(p_reservation_id uuid, p_shop_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_released boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_reservation_abandoned: service_role only' using errcode = '42501';
  end if;
  v_released := release_reservation(p_reservation_id, p_shop_id);
  if v_released then perform banto_enqueue_checkout_abandoned(p_reservation_id); end if;
  return v_released;
end;
$$;
revoke execute on function release_reservation_abandoned(uuid, uuid) from public, anon, authenticated;
grant execute on function release_reservation_abandoned(uuid, uuid) to service_role;

-- TTL 切れ（Cron）。0010 と同じに解放して、会員の予約なら積む
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
    perform banto_release_coupons(v_res.id);
    update reservations set status = 'released', customer = null where id = v_res.id;
    perform banto_enqueue_checkout_abandoned(v_res.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

insert into banto_migrations (version) values ('0105_ma_ports');
