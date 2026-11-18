-- 0156_order_payment_status: お支払いの状態を注文の状態と分ける（後払いの器。代金引換の 1 本目、メンテナの決定 2026-11-18、docs/hooks.md「注文の状態」）
--   - orders.status は届けの状態。受付（pending）を足す: pending（受付・未発送）→ shipped（発送）。今までの paid は「お支払い済みで受付」のまま
--   - orders.payment_status（paid / unpaid）と paid_at がお支払いの状態。今までの注文はすべて paid（paid_at は注文の日時）
--   - 未入金の注文（代金引換など。作るのは次の版の同梱モジュール）は確定のとき order.created だけを出し、order.paid は入金を記録したとき
--     （order_payment_record / api_order_payment_record）に出す。受付のまま入金されたら paid（お支払い済みで受付）に、発送の後なら shipped のまま
--     （発送してから入金されることもある = shipped かつ unpaid）
--   - 売上の集計・会員の購入額・ホームの数字は入金済みだけ（payment_status = 'paid'）
--   - 未入金の注文は受付のあいだも発送の後（受け取り拒否）も取り消せる。返金はなく、在庫は戻す。受け取り拒否は cancel_reason = 'refused'
--   - 新しい値 pending は、このマイグレーションの中では文字として比べる（ALTER TYPE ... ADD VALUE は同じトランザクションの中で値として使えない）

alter type order_status add value if not exists 'pending' before 'paid';

alter table orders add column if not exists payment_status text not null default 'paid' check (payment_status in ('paid', 'unpaid'));
alter table orders add column if not exists paid_at timestamptz;
alter table orders add column if not exists cancel_reason text check (cancel_reason is null or cancel_reason in ('refused'));
update orders set paid_at = created_at where paid_at is null and payment_status = 'paid';
-- 受付（pending）は未入金の注文だけ
alter table orders drop constraint if exists orders_pending_unpaid;
alter table orders add constraint orders_pending_unpaid check (status::text <> 'pending' or payment_status = 'unpaid');
create index if not exists orders_unpaid_idx on orders (shop_id, created_at desc) where payment_status = 'unpaid';

-- 入金済みで作る注文（決済の確定・取り込み・復元）の入金日時は、渡されなければ注文の日時。入金済みなら入金日時がある
create or replace function banto_orders_paid_at()
returns trigger language plpgsql as $$
begin
  if new.payment_status = 'paid' and new.paid_at is null then new.paid_at := coalesce(new.created_at, now()); end if;
  return new;
end;
$$;
revoke execute on function banto_orders_paid_at() from public, anon, authenticated;
drop trigger if exists orders_paid_at on orders;
create trigger orders_paid_at before insert on orders for each row execute function banto_orders_paid_at();
alter table orders drop constraint if exists orders_paid_at_set;
alter table orders add constraint orders_paid_at_set check ((payment_status = 'paid') = (paid_at is not null));

-- 運営者の直接の更新: 受付（pending）からも発送できる。お支払いの状態は変えられない（0055 を差し替え）
create or replace function banto_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    -- お支払いの状態は order_payment_record（入金の記録）と cancel_order だけが変える
    if (new.payment_status is distinct from old.payment_status or new.paid_at is distinct from old.paid_at or new.cancel_reason is distinct from old.cancel_reason)
       and current_setting('banto.payment_record', true) is distinct from 'on' then
      raise exception 'use_order_payment_record' using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (old.status::text in ('paid', 'pending') and new.status::text = 'shipped')
       and not (old.status::text = 'pending' and new.status::text = 'paid' and current_setting('banto.payment_record', true) = 'on') then
      raise exception 'use_cancel_order' using errcode = '42501';
    end if;
    -- 発送日時を過去に書くと mask_shipped_orders（180 日）が前倒しで個人情報を消す。運営者が書けるのは今の時刻の近くだけ
    if new.shipped_at is distinct from old.shipped_at
       and (new.shipped_at is null or new.shipped_at < now() - interval '1 day' or new.shipped_at > now() + interval '1 hour') then
      raise exception 'shipped_at_now' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- 送り状の取り込み: 受付（pending）の注文も発送にする（0024 を差し替え）
create or replace function ship_orders(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_o orders%rowtype; v_num text; v_carrier text; v_tracking text;
  v_shipped integer := 0; v_updated integer := 0; v_invalid integer := 0;
  v_missing jsonb := '[]'::jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'orders') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items'; end if;
  for v_row in select e from jsonb_array_elements(p_items) e loop
    v_num := btrim(coalesce(v_row->>'number', ''));
    v_carrier := v_row->>'carrier';
    v_tracking := regexp_replace(coalesce(v_row->>'tracking', ''), '[\s-]', '', 'g');
    if v_num !~ '^[0-9]{1,9}$' or v_carrier is null or v_carrier not in ('yamato', 'sagawa', 'japanpost', 'other') or v_tracking !~ '^[0-9A-Za-z]{4,40}$' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    select * into v_o from orders where shop_id = p_shop_id and number = v_num::integer and status::text in ('pending', 'paid', 'shipped') for update;
    if not found then
      if jsonb_array_length(v_missing) < 50 then v_missing := v_missing || to_jsonb(v_num::integer); end if;
      continue;
    end if;
    if v_o.status::text in ('paid', 'pending') then
      update orders set status = 'shipped', shipped_at = now(), tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now()
       where id = v_o.id returning * into v_o;
      perform enqueue_hook(p_shop_id, 'order.shipped',
        jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status,
                           'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id, 'payment_status', v_o.payment_status));
      v_shipped := v_shipped + 1;
    else
      update orders set tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now() where id = v_o.id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('shipped', v_shipped, 'updated', v_updated, 'invalid', v_invalid, 'missing', v_missing);
end;
$$;

-- AI 用 API の発送: 受付（pending）からも（0004 を差し替え）
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
   where id = p_order_id and shop_id = v_tok.shop_id and status::text in ('paid', 'pending')
  returning * into v_o;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'order.shipped',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', v_tok.shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status, 'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id, 'payment_status', v_o.payment_status));
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

-- 取り消し: 未入金の注文（受付・受け取り拒否）も。理由 refused を残せる（0031 を差し替え。引数が増えるので作り直す）
drop function if exists cancel_order(uuid, uuid, boolean);
create or replace function cancel_order(p_order_id uuid, p_shop_id uuid, p_refunded boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_item record; v_restock boolean; v_refunded boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cancel_order: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_o.status in ('cancelled', 'refunded') then
    return jsonb_build_object('order_id', v_o.id, 'status', v_o.status, 'already', true);
  end if;
  -- 取り消せるのは、お支払い済みで受付（paid）と、未入金の受付（pending）・発送の後（受け取り拒否）
  if not (v_o.status::text in ('paid', 'pending') or (v_o.status::text = 'shipped' and v_o.payment_status = 'unpaid')) then
    raise exception 'not_cancellable' using detail = v_o.status::text;
  end if;
  if p_reason is not null and (p_reason <> 'refused' or v_o.payment_status <> 'unpaid' or v_o.status::text <> 'shipped') then raise exception 'invalid_cancel_reason'; end if;
  -- 未入金の注文には返金が無い
  v_refunded := coalesce(p_refunded, false) and v_o.payment_status = 'paid';
  -- 在庫を戻すのは Banto で予約して確定した注文だけ。取り込んだ注文（external_ref）と復元した注文（予約なし）は在庫を動かしていない
  v_restock := v_o.reservation_id is not null and v_o.external_ref is null;
  if v_restock then
    for v_item in select sku_id, qty from order_items where order_id = p_order_id and sku_id is not null loop
      update inventory set available = available + v_item.qty, updated_at = now()
       where sku_id = v_item.sku_id and shop_id = p_shop_id;
    end loop;
    perform banto_release_coupons(v_o.reservation_id);
  end if;
  update orders set status = case when v_refunded then 'refunded'::order_status else 'cancelled'::order_status end, cancel_reason = p_reason
   where id = p_order_id;
  perform enqueue_hook(p_shop_id, 'order.cancelled',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy,
                       'status', case when v_refunded then 'refunded' else 'cancelled' end, 'refunded', v_refunded, 'customer_id', v_o.customer_id,
                       'restocked', v_restock, 'payment_status', v_o.payment_status, 'reason', p_reason));
  return jsonb_build_object('order_id', v_o.id, 'status', case when v_refunded then 'refunded' else 'cancelled' end, 'already', false,
                            'restocked', v_restock, 'payment_provider', v_o.payment_provider, 'payment_ref', v_o.payment_ref);
end;
$$;
revoke execute on function cancel_order(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function cancel_order(uuid, uuid, boolean, text) to service_role;

-- AI 用 API の取り消し: 受け取り拒否（refused）も渡せる（0028 を差し替え。引数が増えるので作り直す）
drop function if exists api_order_cancel(text, uuid, boolean);
create or replace function api_order_cancel(p_token_hash text, p_order_id uuid, p_refunded boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if not banto_user_shop_perm(v_tok.owner_id, v_tok.shop_id, 'orders_cancel') then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  v_r := cancel_order(p_order_id, v_tok.shop_id, p_refunded, p_reason);
  select * into v_o from orders where id = p_order_id;
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;
revoke execute on function api_order_cancel(text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function api_order_cancel(text, uuid, boolean, text) to service_role;

-- 取り消しの前に読む: お支払いの状態を足す（0004 を差し替え）
create or replace function order_payment_info(p_order_id uuid, p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.role() is distinct from 'service_role' then null
         else (select jsonb_build_object('order_id', o.id, 'status', o.status, 'payment_provider', o.payment_provider,
                                         'payment_ref', o.payment_ref, 'total_jpy', o.total_jpy, 'payment_status', o.payment_status)
                 from orders o where o.id = p_order_id and o.shop_id = p_shop_id) end;
$$;

-- AI 用 API の注文: お支払いの状態・入金日時・取り消しの理由を足す（0106 を差し替え）
create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'total_jpy', p_order.total_jpy, 'shipping_jpy', p_order.shipping_jpy,
    'discount_jpy', p_order.discount_jpy,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_order.discounts, '[]'::jsonb)) d),
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref, 'customer_id', p_order.customer_id,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'payment_status', p_order.payment_status, 'paid_at', p_order.paid_at, 'cancel_reason', p_order.cancel_reason,
    'tags', to_jsonb(p_order.tags),
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  ) || case when p_pii then jsonb_build_object('note', p_order.note) else '{}'::jsonb end;
$$;

-- 売上の集計は入金済みだけ（0076 を差し替え）
create or replace function sales_summary_for_shop(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text, p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_rows jsonb; v_total jsonb; v_tz text := coalesce(nullif(p_time_zone, ''), 'Asia/Tokyo');
begin
  if p_group_by not in ('day', 'month', 'product') then raise exception 'invalid_group_by'; end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'invalid_time_zone';
  end;
  select jsonb_build_object(
    'orders', count(*), 'revenue_jpy', coalesce(sum(o.total_jpy), 0), 'shipping_jpy', coalesce(sum(o.shipping_jpy), 0),
    'items', coalesce((select sum(oi.qty) from order_items oi join orders o2 on o2.id = oi.order_id
                        where o2.shop_id = p_shop_id and o2.status in ('paid','shipped') and o2.payment_status = 'paid' and o2.created_at >= p_from and o2.created_at < p_to), 0),
    'avg_order_jpy', coalesce(round(avg(o.total_jpy)), 0))
    into v_total
    from orders o where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.payment_status = 'paid' and o.created_at >= p_from and o.created_at < p_to;

  if p_group_by = 'product' then
    select coalesce(jsonb_agg(r order by (r->>'revenue_jpy')::bigint desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('product_id', p.id, 'product_name', coalesce(p.name, '(削除済み)'), 'sku_code', k.code,
                                'qty', sum(oi.qty), 'revenue_jpy', sum(oi.qty * oi.unit_price_jpy)) as r
        from order_items oi
        join orders o on o.id = oi.order_id
        left join skus k on k.id = oi.sku_id
        left join products p on p.id = k.product_id
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.payment_status = 'paid' and o.created_at >= p_from and o.created_at < p_to
       group by p.id, p.name, k.code) x;
  else
    select coalesce(jsonb_agg(r order by r->>'period'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('period', to_char(date_trunc(p_group_by, o.created_at at time zone v_tz), case when p_group_by = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
                                'orders', count(*), 'revenue_jpy', sum(o.total_jpy), 'shipping_jpy', sum(o.shipping_jpy)) as r
        from orders o
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.payment_status = 'paid' and o.created_at >= p_from and o.created_at < p_to
       group by date_trunc(p_group_by, o.created_at at time zone v_tz)) x;
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'group_by', p_group_by, 'timezone', v_tz, 'total', v_total, 'rows', v_rows);
end;
$$;

-- ホーム: 発送待ちに受付（pending）を、未入金の数を足す。売上は入金済みだけ（0139 を差し替え）
create or replace function shop_home(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := '{}'::jsonb;
  v_shop shops;
begin
  select * into v_shop from shops where id = p_shop_id;
  if v_shop.id is null or not (banto_owns_shop(p_shop_id) or exists (select 1 from org_member_shops ms where ms.shop_id = p_shop_id and ms.user_id = auth.uid() and ms.org_id = v_shop.org_id)) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if banto_shop_perm(p_shop_id, 'orders') then
    v := v || jsonb_build_object('orders', jsonb_build_object('to_ship', (select count(*) from orders where shop_id = p_shop_id and status::text in ('paid', 'pending')),
      'unpaid', (select count(*) from orders where shop_id = p_shop_id and payment_status = 'unpaid' and status::text in ('pending', 'shipped'))));
  end if;
  if banto_shop_perm(p_shop_id, 'reports') then
    v := v || jsonb_build_object('sales', (select jsonb_build_object('orders', count(*), 'revenue_jpy', coalesce(sum(total_jpy), 0))
                                             from orders where shop_id = p_shop_id and status in ('paid', 'shipped') and payment_status = 'paid' and created_at >= now() - interval '30 days'));
  end if;
  if banto_shop_perm(p_shop_id, 'catalog') then
    v := v || jsonb_build_object('catalog', jsonb_build_object(
      'out_of_stock', (select count(*) from inventory i join skus k on k.id = i.sku_id join products p on p.id = k.product_id
                        where i.shop_id = p_shop_id and p.published and i.available = 0),
      'drafts', (select count(*) from products where shop_id = p_shop_id and not published),
      'products', (select count(*) from products where shop_id = p_shop_id)));
  end if;
  if banto_shop_perm(p_shop_id, 'support') then
    v := v || jsonb_build_object('support', jsonb_build_object('waiting', (select count(*) from inquiries
      where shop_id = p_shop_id and status = 'waiting_shop' and not (origin = 'form' and email_verified_at is null))));
  end if;
  if banto_shop_perm(p_shop_id, 'content') then
    v := v || jsonb_build_object('content', jsonb_build_object(
      'scheduled', (select count(*) from pages where shop_id = p_shop_id and deleted_at is null and published and published_at > now())
                 + (select count(*) from articles where shop_id = p_shop_id and deleted_at is null and published and published_at > now()),
      'drafts', (select count(*) from pages where shop_id = p_shop_id and deleted_at is null and not published)
              + (select count(*) from articles where shop_id = p_shop_id and deleted_at is null and not published)));
  end if;
  if banto_owns_shop(p_shop_id) then
    v := v || jsonb_build_object('setup', jsonb_build_object(
      'legal', nullif(btrim(coalesce(v_shop.legal_notice, '')), '') is not null and nullif(btrim(coalesce(v_shop.privacy_policy, '')), '') is not null and nullif(btrim(coalesce(v_shop.return_policy, '')), '') is not null,
      'product', exists (select 1 from products where shop_id = p_shop_id and published),
      'published', v_shop.published));
  end if;
  return v;
end;
$$;

-- 会員の購入額は入金済みだけ（0133 を差し替え）
create or replace function banto_customer_stats_refresh(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update customers c
     set orders_count = s.n, total_spent_jpy = s.total, last_order_at = s.last
    from (select c2.id, count(o.id)::integer as n, coalesce(sum(o.total_jpy), 0)::bigint as total, max(o.created_at) as last
            from customers c2
            left join orders o on o.shop_id = c2.shop_id and o.customer_id = c2.id and o.status in ('paid', 'shipped') and o.payment_status = 'paid'
           where c2.id = any(p_ids)
           group by c2.id) s
   where c.id = s.id
     and (c.orders_count, c.total_spent_jpy, c.last_order_at) is distinct from (s.n, s.total, s.last);
$$;
revoke execute on function banto_customer_stats_refresh(uuid[]) from public, anon, authenticated;

-- 会員の購入額の数え直し: お支払いの状態が変わったときも（発送の後の入金の記録。0133 を差し替え）
create or replace function banto_orders_customer_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct customer_id) into v_ids from new_rows where customer_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct customer_id) into v_ids from old_rows where customer_id is not null;
  else
    -- 集計に関係する列（会員・状態・金額・日時）が変わった行だけ。印・メモ・送り状番号・個人情報のマスクでは数え直さない
    -- （列のリスト付きのトリガーは遷移表と一緒に使えないので、ここで絞る）
    select array_agg(distinct x) into v_ids from (
      select n.customer_id as x from new_rows n join old_rows o using (id)
       where (n.customer_id, n.status, n.total_jpy, n.created_at, n.payment_status) is distinct from (o.customer_id, o.status, o.total_jpy, o.created_at, o.payment_status)
      union
      select o.customer_id from new_rows n join old_rows o using (id)
       where (n.customer_id, n.status, n.total_jpy, n.created_at, n.payment_status) is distinct from (o.customer_id, o.status, o.total_jpy, o.created_at, o.payment_status)
    ) u where x is not null;
  end if;
  if v_ids is not null then perform banto_customer_stats_refresh(v_ids); end if;
  return null;
end;
$$;
revoke execute on function banto_orders_customer_stats() from public, anon, authenticated;

-- AI 用 API の会員の購入額も入金済みだけ（0050 を差し替え）
create or replace function api_customer_json(p_c customers)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'email', p_c.email, 'name', p_c.name, 'default_address', p_c.default_address,
    'external_ref', p_c.external_ref, 'attributes', coalesce(p_c.attributes, '{}'::jsonb),
    'marketing_consent', p_c.marketing_consent, 'marketing_consent_at', p_c.marketing_consent_at, 'marketing_consent_source', p_c.marketing_consent_source,
    'created_at', p_c.created_at, 'updated_at', p_c.updated_at, 'last_login_at', p_c.last_login_at,
    'orders', (select jsonb_build_object('count', count(*), 'total_jpy', coalesce(sum(o.total_jpy), 0), 'last_order_at', max(o.created_at))
                 from orders o where o.shop_id = p_c.shop_id and o.customer_id = p_c.id and o.status in ('paid', 'shipped') and o.payment_status = 'paid')
  );
$$;
revoke execute on function api_customer_json(customers) from public, anon, authenticated;

-- 注文の検索: 受付（pending）と「未入金」で絞る（0134 を差し替え）
create or replace function admin_search_ids(p_shop_id uuid, p_kind text, p_q text, p_filters jsonb, p_after_k timestamptz, p_after_id uuid, p_limit integer)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_like text;
  v_where text := 'shop_id = $1';
  v_table text;
  v_perm text;
  v_q text := nullif(btrim(left(coalesce(p_q, ''), 100)), '');
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_desc boolean := coalesce(p_filters->>'sort', 'new') <> 'old';
  v_num integer;
  v_phone text;
  v_track text;
  v_out uuid[];
begin
  case p_kind
    when 'products' then v_table := 'products'; v_perm := 'catalog';
    when 'orders' then v_table := 'orders'; v_perm := 'orders';
    when 'customers' then v_table := 'customers'; v_perm := 'customers';
    else raise exception 'invalid_kind' using errcode = '22023';
  end case;
  if not banto_shop_perm(p_shop_id, v_perm) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if p_kind = 'products' then
    if v_like is not null then
      v_where := v_where || ' and (name ilike $2 or slug ilike $2 or id in (select product_id from skus where shop_id = $1 and (code = $3 or gtin = $3)))';
    end if;
    if v_f->>'state' = 'published' then v_where := v_where || ' and published'; end if;
    if v_f->>'state' = 'draft' then v_where := v_where || ' and not published'; end if;
    if coalesce(v_f->>'category', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_where := v_where || ' and (category_id = ($7->>''category'')::uuid or extra_category_ids @> array[($7->>''category'')::uuid])';
    end if;
    if v_f->>'stock' in ('in', 'out') then
      v_where := v_where || case when v_f->>'stock' = 'out' then ' and not' else ' and' end
        || ' exists (select 1 from skus s join inventory i on i.sku_id = s.id where s.product_id = products.id and i.available > 0)';
    end if;
  elsif p_kind = 'orders' then
    if v_like is not null then
      if v_q ~ '^#?\d{1,9}$' then v_num := ltrim(v_q, '#')::integer; end if;
      if v_q ~ '^[0-9+() -]{10,20}$' and length(regexp_replace(v_q, '[^0-9]', '', 'g')) between 10 and 13 then
        v_phone := regexp_replace(regexp_replace(v_q, '[^0-9]', '', 'g'), '^810?', '0');
      end if;
      if v_q ~ '^[0-9A-Za-z-]{4,60}$' and length(replace(v_q, '-', '')) between 4 and 40 then v_track := replace(v_q, '-', ''); end if;
      v_where := v_where || ' and (customer_email ilike $2 or customer_name ilike $2 or payment_ref = $3'
        || case when v_num is not null then ' or number = $8' else '' end
        || case when v_phone is not null then ' or regexp_replace(regexp_replace(coalesce(shipping_address->>''phone'', ''''), ''[^0-9]'', '''', ''g''), ''^810?'', ''0'') = $9' else '' end
        || case when v_track is not null then ' or tracking_number = $10' else '' end
        || ')';
    end if;
    if v_f->>'status' in ('pending', 'paid', 'shipped', 'cancelled', 'refunded') then v_where := v_where || format(' and status = %L', v_f->>'status'); end if;
    -- 未入金（受付・発送の後）
    if v_f->>'paid' = 'unpaid' then v_where := v_where || ' and payment_status = ''unpaid'' and status in (''pending'', ''shipped'')'; end if;
    if v_f->>'payment' in ('stripe', 'komoju', 'amazon_pay', 'free') then v_where := v_where || format(' and payment_provider = %L', v_f->>'payment'); end if;
    if coalesce(v_f->>'from', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      v_where := v_where || ' and created_at >= (($7->>''from'')::date)::timestamp at time zone ''Asia/Tokyo''';
    end if;
    if coalesce(v_f->>'to', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      v_where := v_where || ' and created_at < ((($7->>''to'')::date) + 1)::timestamp at time zone ''Asia/Tokyo''';
    end if;
    if coalesce(v_f->>'min', '') ~ '^\d{1,9}$' then v_where := v_where || ' and total_jpy >= ($7->>''min'')::integer'; end if;
    if coalesce(v_f->>'max', '') ~ '^\d{1,9}$' then v_where := v_where || ' and total_jpy <= ($7->>''max'')::integer'; end if;
    if length(btrim(coalesce(v_f->>'tag', ''))) between 1 and 40 then v_where := v_where || ' and tags @> array[btrim($7->>''tag'')]'; end if;
  else
    if v_like is not null then v_where := v_where || ' and (email ilike $2 or name ilike $2)'; end if;
    if coalesce(v_f->>'field', '') ~ '^[a-z][a-z0-9_]{0,39}$' and nullif(v_f->>'value', '') is not null then
      v_where := v_where || format(' and attributes->>%L ilike $4', v_f->>'field');
    end if;
    if v_f->>'consent' = 'yes' then v_where := v_where || ' and marketing_consent is true'; end if;
    if v_f->>'consent' = 'no' then v_where := v_where || ' and marketing_consent is false'; end if;
    if v_f->>'consent' = 'none' then v_where := v_where || ' and marketing_consent is null'; end if;
  end if;
  if p_after_k is not null and p_after_id is not null then
    v_where := v_where || case when v_desc then ' and (created_at < $5 or (created_at = $5 and id < $6))'
                               else ' and (created_at > $5 or (created_at = $5 and id > $6))' end;
  end if;
  execute format('select coalesce(array_agg(id order by created_at %1$s, id %1$s), ''{}'') from (select id, created_at from %2$I where %3$s order by created_at %1$s, id %1$s limit %4$s) x',
                 case when v_desc then 'desc' else 'asc' end, v_table, v_where, least(greatest(coalesce(p_limit, 50), 1), 1000))
    into v_out
    using p_shop_id, v_like, v_q,
          '%' || replace(replace(replace(coalesce(v_f->>'value', ''), '\', '\\'), '%', '\%'), '_', '\_') || '%',
          p_after_k, p_after_id, v_f, v_num, v_phone, v_track;
  return v_out;
end;
$$;

-- 復元: お支払いの状態・入金日時・取り消しの理由も戻す（0012 を差し替え）
create or replace function restore_shop_data(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay text;
  v_products jsonb := coalesce(p_data->'products', '[]'::jsonb);
  v_skus jsonb := coalesce(p_data->'skus', '[]'::jsonb);
  v_inventory jsonb := coalesce(p_data->'inventory', '[]'::jsonb);
  v_images jsonb := coalesce(p_data->'product_images', '[]'::jsonb);
  v_orders jsonb := coalesce(p_data->'orders', '[]'::jsonb);
  v_items jsonb := coalesce(p_data->'order_items', '[]'::jsonb);
  v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb);
  v_endpoints jsonb := coalesce(p_data->'hook_endpoints', '[]'::jsonb);
  v_row jsonb;
  v_new uuid;
  v_old uuid;
  v_product_map jsonb := '{}'::jsonb;
  v_sku_map jsonb := '{}'::jsonb;
  v_order_map jsonb := '{}'::jsonb;
  v_customer_ok jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  v_skipped_items integer := 0;
  v_skipped_customers integer := 0;
  v_max_number integer;
begin
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if exists (select 1 from products where shop_id = p_shop_id) or exists (select 1 from orders where shop_id = p_shop_id) then
    raise exception 'shop_not_empty';
  end if;
  if jsonb_typeof(v_products) <> 'array' or jsonb_typeof(v_orders) <> 'array' then raise exception 'invalid_export'; end if;

  -- 商品
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_products) loop
    v_old := (v_row->>'id')::uuid;
    insert into products (shop_id, slug, name, description, published, created_at, updated_at)
      values (p_shop_id, v_row->>'slug', v_row->>'name', v_row->>'description', coalesce((v_row->>'published')::boolean, false),
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
    v_product_map := v_product_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('products', v_n);

  -- SKU（inventory 行はトリガーで作られる）→ 在庫数を戻す
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_skus) loop
    if v_product_map ? (v_row->>'product_id') then
      v_old := (v_row->>'id')::uuid;
      insert into skus (shop_id, product_id, code, name, price_jpy, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'code', v_row->>'name', (v_row->>'price_jpy')::integer,
                coalesce((v_row->>'created_at')::timestamptz, now()))
        returning id into v_new;
      v_sku_map := v_sku_map || jsonb_build_object(v_old::text, v_new::text);
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('skus', v_n);
  for v_row in select * from jsonb_array_elements(v_inventory) loop
    if v_sku_map ? (v_row->>'sku_id') then
      update inventory set available = greatest(0, coalesce((v_row->>'available')::integer, 0))
        where sku_id = (v_sku_map->>(v_row->>'sku_id'))::uuid and shop_id = p_shop_id;
    end if;
  end loop;

  -- 画像（R2 のキーはそのまま）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_images) loop
    if v_product_map ? (v_row->>'product_id') then
      insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, sort_order, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'storage_key', v_row->>'thumb_key',
                (v_row->>'width')::integer, (v_row->>'height')::integer, coalesce((v_row->>'sort_order')::integer, 0),
                coalesce((v_row->>'created_at')::timestamptz, now()));
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('product_images', v_n);

  -- 会員: 0012 から会員は Supabase Auth と関係ないので、すべて戻す（同じ id のまま。主キーは (shop_id, id)）。
  -- 同じメールアドレスが重なる行・メールアドレスの無い行は飛ばす
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    v_old := (v_row->>'id')::uuid;
    if nullif(btrim(coalesce(v_row->>'email', '')), '') is not null
       and not exists (select 1 from customers c where c.shop_id = p_shop_id and lower(c.email) = lower(btrim(v_row->>'email'))) then
      insert into customers (id, shop_id, email, name, default_address, created_at)
        values (v_old, p_shop_id, lower(btrim(v_row->>'email')), v_row->>'name', v_row->'default_address', coalesce((v_row->>'created_at')::timestamptz, now()))
        on conflict do nothing;
      v_customer_ok := v_customer_ok || jsonb_build_object(v_old::text, true);
      v_n := v_n + 1;
    else
      v_skipped_customers := v_skipped_customers + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('customers', v_n, 'customers_skipped', v_skipped_customers);

  -- 注文（予約との紐づけは切る。番号は維持）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_orders) loop
    v_old := (v_row->>'id')::uuid;
    -- お支払いの状態（0156）: 書き出しに無ければ入金済み。受付（pending）は未入金。入金日時は入金済みのときだけ、取り消しの理由は未入金のときだけ
    v_pay := case when v_row->>'payment_status' = 'unpaid' or v_row->>'status' = 'pending' then 'unpaid' else 'paid' end;
    insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, number, customer_email, customer_name, shipping_address,
                        payment_provider, payment_ref, shipped_at, customer_id, created_at, updated_at, payment_status, paid_at, cancel_reason)
      values (p_shop_id, null, coalesce((v_row->>'status')::order_status, 'paid'), coalesce((v_row->>'total_jpy')::integer, 0),
              coalesce((v_row->>'shipping_jpy')::integer, 0), (v_row->>'number')::integer, v_row->>'customer_email', v_row->>'customer_name',
              v_row->'shipping_address', v_row->>'payment_provider', v_row->>'payment_ref', (v_row->>'shipped_at')::timestamptz,
              case when v_customer_ok ? (v_row->>'customer_id') then (v_row->>'customer_id')::uuid else null end,
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()),
              v_pay, case when v_pay = 'paid' then coalesce((v_row->>'paid_at')::timestamptz, (v_row->>'created_at')::timestamptz, now()) end,
              case when v_pay = 'unpaid' and v_row->>'cancel_reason' = 'refused' then 'refused' end)
      returning id into v_new;
    v_order_map := v_order_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('orders', v_n);
  select max(number) into v_max_number from orders where shop_id = p_shop_id;
  if v_max_number is not null then
    update shops set order_seq = greatest(order_seq, v_max_number) where id = p_shop_id;
  end if;

  -- 明細（SKU が復元されていない行は飛ばす: skus.id への FK があるため）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_items) loop
    if v_order_map ? (v_row->>'order_id') and v_sku_map ? (v_row->>'sku_id') then
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
        values (p_shop_id, (v_order_map->>(v_row->>'order_id'))::uuid, (v_sku_map->>(v_row->>'sku_id'))::uuid,
                (v_row->>'qty')::integer, (v_row->>'unit_price_jpy')::integer);
      v_n := v_n + 1;
    else
      v_skipped_items := v_skipped_items + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('order_items', v_n, 'order_items_skipped', v_skipped_items);

  -- 連携先（id は振り直す = 署名シークレットも変わる。外部プラグイン側の再設定が要る）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_endpoints) loop
    insert into hook_endpoints (shop_id, name, url, events, enabled, manifest, settings, created_at)
      values (p_shop_id, v_row->>'name', v_row->>'url',
              coalesce((select array_agg(e) from jsonb_array_elements_text(coalesce(v_row->'events', '[]'::jsonb)) e), '{}'),
              coalesce((v_row->>'enabled')::boolean, true), v_row->'manifest', coalesce(v_row->'settings', '{}'::jsonb),
              coalesce((v_row->>'created_at')::timestamptz, now()));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('hook_endpoints', v_n);

  return v_counts;
end;
$$;

-- 個人情報のマスキング: 発送の後も未入金の注文は、入金を記録するか取り消すまで残す（数えるのは今までどおり発送から。0031 を差し替え）
create or replace function mask_shipped_orders(p_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_shipped_orders: service_role only' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where ((status = 'shipped' and payment_status = 'paid' and shipped_at < now() - make_interval(days => p_days))
          or (status in ('cancelled', 'refunded') and updated_at < now() - make_interval(days => p_days)))
     and (customer_name is distinct from '[masked]' or customer_email is not null or shipping_address is not null);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 注文照会・会員の注文・領収書の材料: お支払いの状態を足す（0066 を差し替え。領収書は入金の前に出さない）
create or replace function banto_order_view(p_o orders)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('number', p_o.number, 'status', p_o.status, 'created_at', p_o.created_at, 'shipped_at', p_o.shipped_at,
                            'total_jpy', p_o.total_jpy, 'shipping_jpy', p_o.shipping_jpy, 'discount_jpy', p_o.discount_jpy,
                            'shipping_tax_rate', p_o.shipping_tax_rate, 'tax_rounding', p_o.tax_rounding, 'payment_provider', p_o.payment_provider,
                            'payment_status', p_o.payment_status, 'paid_at', p_o.paid_at,
                            'tracking', case when p_o.tracking_number is not null then jsonb_build_object('carrier', p_o.tracking_carrier, 'number', p_o.tracking_number) end,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(p_o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'sku', coalesce(oi.item_variant, k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = p_o.id));
$$;
revoke execute on function banto_order_view(orders) from public, anon, authenticated;

-- 入金を記録する（運営者、項目 orders）。未入金（受付・発送の後）の注文だけ。もう入金済みなら何もしない（already）。
-- order.paid はここで出す（ペイロードは確定のときと同じ項目に、入金の記録の項目を足したもの。個人情報は載せない）
create or replace function order_payment_record(p_shop_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'orders') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return banto_order_payment_record(p_shop_id, p_order_id);
end;
$$;
revoke execute on function order_payment_record(uuid, uuid) from public, anon;
grant execute on function order_payment_record(uuid, uuid) to authenticated;

create or replace function banto_order_payment_record(p_shop_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype;
begin
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_o.payment_status = 'paid' then return jsonb_build_object('order_id', v_o.id, 'paid_at', v_o.paid_at, 'already', true); end if;
  if v_o.status::text not in ('pending', 'shipped') then raise exception 'not_payable' using detail = v_o.status::text; end if;
  perform set_config('banto.payment_record', 'on', true);
  -- 受付（pending）のままなら「お支払い済みで受付」（paid）に。発送の後なら shipped のまま
  update orders set payment_status = 'paid', paid_at = now(), updated_at = now(),
         status = case when status::text = 'pending' then 'paid'::order_status else status end
   where id = v_o.id returning * into v_o;
  -- 確定のときの order.paid と同じ項目（小計・送料・値引き・明細の商品と値引き）に、入金の記録の項目を足す
  perform banto_enqueue_hook_internal(p_shop_id, 'order.paid',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status,
                       'subtotal_jpy', (select coalesce(sum(oi.qty * oi.unit_price_jpy), 0) from order_items oi where oi.order_id = v_o.id),
                       'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', coalesce(v_o.discount_jpy, 0),
                       'payment_status', 'paid', 'paid_at', v_o.paid_at, 'recorded_payment', true, 'payment_provider', v_o.payment_provider, 'customer_id', v_o.customer_id,
                       'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', oi.sku_id, 'product_id', k.product_id, 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                                              'discount_jpy', coalesce(oi.discount_jpy, 0)) order by oi.id), '[]'::jsonb)
                                   from order_items oi left join skus k on k.id = oi.sku_id where oi.order_id = v_o.id)));
  return jsonb_build_object('order_id', v_o.id, 'paid_at', v_o.paid_at, 'already', false);
end;
$$;
revoke execute on function banto_order_payment_record(uuid, uuid) from public, anon, authenticated, service_role;

-- AI 用 API（orders:write）
create or replace function api_order_payment_record(p_token_hash text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  perform banto_order_payment_record(v_tok.shop_id, p_order_id);
  select * into v_o from orders where id = p_order_id and shop_id = v_tok.shop_id;
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;
revoke execute on function api_order_payment_record(text, uuid) from public, anon, authenticated;
grant execute on function api_order_payment_record(text, uuid) to service_role;

-- 会員ページの注文の一覧: お支払いの状態を足す（領収書のリンクを入金の後だけ出す。0050 を差し替え）
create or replace function member_get(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_with_orders boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_get: service_role only' using errcode = '42501';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return null; end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'shop_id', v_c.shop_id, 'email', v_c.email, 'name', v_c.name, 'default_address', v_c.default_address,
                                   'marketing_consent', v_c.marketing_consent,
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null,
                                   'providers', coalesce((select jsonb_agg(provider order by provider) from member_identities
                                                           where shop_id = p_shop_id and customer_id = v_c.id), '[]'::jsonb)),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at, payment_status
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;


-- 監査ログ: 入金の記録も残す（発送の後の入金は状態が変わらないので、0051 の状態のトリガーでは残らない）
create or replace function banto_audit_order_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'order.payment_recorded', 'order', new.id::text,
                      jsonb_build_object('number', new.number, 'status', new.status::text));
  return new;
end;
$$;
revoke execute on function banto_audit_order_payment() from public, anon, authenticated;
drop trigger if exists orders_audit_payment on orders;
create trigger orders_audit_payment after update of payment_status on orders
  for each row when (old.payment_status = 'unpaid' and new.payment_status = 'paid') execute function banto_audit_order_payment();

insert into banto_migrations (version) values ('0156_order_payment_status');
