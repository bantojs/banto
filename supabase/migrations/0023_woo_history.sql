-- 0023_woo_history: WooCommerce からの移行の続き（docs/woo-import.md）
--
-- - 過去の注文の取り込み（import_orders、authenticated・所有を検証）。WooCommerce の注文番号のまま入れ、ショップの連番はその続きから。
--   在庫・クーポンの回数・hooks・自動発行のクーポンには触らない（過去の記録として入れるだけ）。
--     orders.external_ref … 取り込み元の ID（'woocommerce:<ID>'）。同じ注文を二重に入れない
--     order_items.sku_id … null を許す（Banto に無い商品の明細）。item_name / item_variant … 取り込んだ時点の品名
-- - クーポンの 1 人ごとの使用回数（import_coupon_usage）: 予約に紐づかない「使用済み」の使用記録として入れる。
--   1 人あたりの上限の数え方（coupon_lookup・apply_reservation_discounts）は使用記録の行を数えるので、関数は変えない。
-- - メールアドレスで使える人を絞ったクーポン（coupon_grants_for_emails）: その人ごとに発行済みのクーポンにする（0019）。
--     coupon_campaigns.external_ref … 取り込み元の ID。コードを持たないキャンペーンでも二重に作らない
-- - restore_history … バックアップの復元で、取り込み元の ID と明細の品名、SKU の無い明細を戻す（0022 の restore_commerce の後）

alter table orders add column if not exists external_ref text check (external_ref is null or length(external_ref) between 1 and 100);
create unique index if not exists orders_external_ref on orders(shop_id, external_ref) where external_ref is not null;
alter table coupon_campaigns add column if not exists external_ref text check (external_ref is null or length(external_ref) between 1 and 100);
create unique index if not exists coupon_campaigns_external_ref on coupon_campaigns(shop_id, external_ref) where external_ref is not null;

alter table order_items alter column sku_id drop not null;
alter table order_items add column if not exists item_name text check (item_name is null or length(item_name) <= 200);
alter table order_items add column if not exists item_variant text check (item_variant is null or length(item_variant) <= 200);

-- 取り込んだ使用は予約を持たない（使用済みのまま。解放・キャンセルの対象にならない）
alter table coupon_redemptions alter column reservation_id drop not null;
alter table coupon_redemptions drop constraint if exists coupon_redemptions_imported_used;
alter table coupon_redemptions add constraint coupon_redemptions_imported_used check (reservation_id is not null or status = 'used');

-- 会員の注文の自動発行（0020 を差し替え）: 取り込んだ過去の注文では配らない
create or replace function banto_coupon_after_purchase()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_c coupon_campaigns%rowtype;
begin
  if new.customer_id is null or new.external_ref is not null then return new; end if;
  for v_c in select * from coupon_campaigns where shop_id = new.shop_id and auto_grant = 'after_purchase' loop
    if banto_campaign_live(v_c) and exists (select 1 from customers where shop_id = new.shop_id and id = new.customer_id) then
      perform banto_grant_to_customer(v_c, new.customer_id);
    end if;
  end loop;
  return new;
end;
$$;

-- クーポンの使用者の識別子（src/commerce/discounts.ts の couponSubject と同じ: メールアドレスは小文字にして SHA-256）
create or replace function banto_email_subject(p_email text)
returns text
language sql
immutable
set search_path = public
as $$
  select 'e:' || encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex');
$$;

-- ---------- 過去の注文の取り込み ----------
-- p_orders: [{ ref, number, status, created_at, shipped_at, total_jpy, shipping_jpy, discount_jpy, shipping_tax_rate,
--              customer_email, customer_name, shipping_address, payment_ref,
--              items: [{ sku, name, variant, qty, unit_price_jpy, discount_jpy, tax_rate }] }]
-- 会員はメールアドレスで結ぶ。SKU は品番で結び、無ければ品名だけの明細にする。
create or replace function import_orders(p_shop_id uuid, p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_it jsonb; v_id uuid; v_num integer; v_ref text; v_status text; v_cid uuid; v_sku uuid; v_rate numeric;
  v_created integer := 0; v_existing integer := 0; v_items integer := 0; v_no_sku integer := 0; v_invalid integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_max integer;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) > 100 then raise exception 'invalid_orders'; end if;
  for v_row in select e from jsonb_array_elements(p_orders) e loop
    v_ref := left(btrim(coalesce(v_row->>'ref', '')), 100);
    v_status := v_row->>'status';
    if v_ref = '' or coalesce(v_row->>'number', '') !~ '^[0-9]{1,9}$' or v_status is null or v_status not in ('paid', 'shipped', 'cancelled', 'refunded')
       or coalesce(v_row->>'total_jpy', '') !~ '^[0-9]{1,9}$' or jsonb_typeof(v_row->'items') <> 'array' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if exists (select 1 from orders where shop_id = p_shop_id and external_ref = v_ref) then
      v_existing := v_existing + 1;
      continue;
    end if;
    v_num := (v_row->>'number')::integer;
    if exists (select 1 from orders where shop_id = p_shop_id and number = v_num) then
      if jsonb_array_length(v_conflicts) < 50 then v_conflicts := v_conflicts || to_jsonb(v_num); end if;
      continue;
    end if;
    v_cid := null;
    if nullif(btrim(coalesce(v_row->>'customer_email', '')), '') is not null then
      select id into v_cid from customers where shop_id = p_shop_id and lower(email) = lower(btrim(v_row->>'customer_email')) limit 1;
    end if;
    v_rate := case when coalesce(v_row->>'shipping_tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (v_row->>'shipping_tax_rate')::numeric end;
    insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, discount_jpy, amount_paid_jpy, number, customer_id,
                        customer_email, customer_name, shipping_address, payment_provider, payment_ref, shipped_at, shipping_tax_rate,
                        external_ref, created_at, updated_at)
    values (p_shop_id, null, v_status::order_status, (v_row->>'total_jpy')::integer, greatest(0, coalesce((v_row->>'shipping_jpy')::integer, 0)),
            greatest(0, coalesce((v_row->>'discount_jpy')::integer, 0)), (v_row->>'total_jpy')::integer, v_num, v_cid,
            nullif(lower(btrim(coalesce(v_row->>'customer_email', ''))), ''), left(nullif(btrim(coalesce(v_row->>'customer_name', '')), ''), 200),
            case when jsonb_typeof(v_row->'shipping_address') = 'object' then v_row->'shipping_address' end,
            'woocommerce', left(nullif(v_row->>'payment_ref', ''), 200),
            case when v_status = 'shipped' then coalesce((v_row->>'shipped_at')::timestamptz, (v_row->>'created_at')::timestamptz, now()) end,
            v_rate, v_ref, coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'created_at')::timestamptz, now()))
    returning id into v_id;
    v_created := v_created + 1;
    for v_it in select e from jsonb_array_elements(v_row->'items') e loop
      if coalesce(v_it->>'qty', '') !~ '^[0-9]{1,6}$' or (v_it->>'qty')::integer <= 0 or coalesce(v_it->>'unit_price_jpy', '') !~ '^[0-9]{1,9}$' then continue; end if;
      v_sku := null;
      if nullif(btrim(coalesce(v_it->>'sku', '')), '') is not null then
        select id into v_sku from skus where shop_id = p_shop_id and code = btrim(v_it->>'sku');
      end if;
      if v_sku is null then v_no_sku := v_no_sku + 1; end if;
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy, tax_rate, item_name, item_variant)
      values (p_shop_id, v_id, v_sku, (v_it->>'qty')::integer, (v_it->>'unit_price_jpy')::integer, greatest(0, coalesce((v_it->>'discount_jpy')::integer, 0)),
              case when coalesce(v_it->>'tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (v_it->>'tax_rate')::numeric end,
              left(nullif(btrim(coalesce(v_it->>'name', '')), ''), 200), left(nullif(btrim(coalesce(v_it->>'variant', '')), ''), 200));
      v_items := v_items + 1;
    end loop;
  end loop;
  -- 新しい注文の番号は、取り込んだ番号の続きから
  select max(number) into v_max from orders where shop_id = p_shop_id;
  if v_max is not null then update shops set order_seq = greatest(order_seq, v_max) where id = p_shop_id; end if;
  return jsonb_build_object('created', v_created, 'existing', v_existing, 'invalid', v_invalid, 'items', v_items, 'items_without_sku', v_no_sku, 'conflicts', v_conflicts);
end;
$$;

-- ---------- クーポンの 1 人ごとの使用回数 ----------
-- p_emails は使った人のメールアドレス（使った回数だけ並ぶ）。p_reset なら、そのキャンペーンに取り込んだ使用を入れ直す（何度流しても重ならない）。
-- メールアドレスの識別子（ゲストの購入）と、同じアドレスの会員の識別子の両方に入れる（どちらで買っても数に入る）
create or replace function import_coupon_usage(p_shop_id uuid, p_code text, p_emails text[], p_reset boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_campaign uuid; v_email text; v_cid uuid; v_n integer := 0;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if coalesce(array_length(p_emails, 1), 0) > 5000 then raise exception 'too_many'; end if;
  select id into v_campaign from coupon_campaigns where shop_id = p_shop_id and code = upper(btrim(p_code));
  if v_campaign is null then return jsonb_build_object('found', false, 'uses', 0); end if;
  if p_reset then delete from coupon_redemptions where campaign_id = v_campaign and reservation_id is null; end if;
  foreach v_email in array coalesce(p_emails, '{}'::text[]) loop
    if position('@' in coalesce(v_email, '')) = 0 then continue; end if;
    insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status) values (p_shop_id, v_campaign, null, banto_email_subject(v_email), 'used');
    select id into v_cid from customers where shop_id = p_shop_id and lower(email) = lower(btrim(v_email)) limit 1;
    if v_cid is not null then
      insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status) values (p_shop_id, v_campaign, null, 'c:' || v_cid::text, 'used');
    end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('found', true, 'uses', v_n);
end;
$$;

-- ---------- メールアドレスで絞ったクーポン → その人ごとの発行済みクーポン ----------
-- 会員がいればその会員に（マイクーポンに出る）、いなければコードだけのものを発行して返す（運営者が渡す）。
-- 同じ会員に使える発行済みが既にあれば、それを返す。返すのは [{ email, code, member }]
create or replace function coupon_grants_for_emails(p_shop_id uuid, p_campaign_id uuid, p_emails text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c coupon_campaigns%rowtype; v_email text; v_cid uuid; v_code text; v_expires timestamptz;
  v_out jsonb := '[]'::jsonb;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if coalesce(array_length(p_emails, 1), 0) > 5000 then raise exception 'too_many'; end if;
  select * into v_c from coupon_campaigns where id = p_campaign_id and shop_id = p_shop_id;
  if not found then raise exception 'campaign_not_found'; end if;
  v_expires := case when v_c.grant_valid_days is not null then now() + make_interval(days => v_c.grant_valid_days) end;
  if v_c.ends_at is not null and (v_expires is null or v_expires > v_c.ends_at) then v_expires := v_c.ends_at; end if;
  for v_email in select distinct lower(btrim(e)) from unnest(coalesce(p_emails, '{}'::text[])) e where position('@' in coalesce(e, '')) > 0 and position('*' in e) = 0 order by 1 loop
    select id into v_cid from customers where shop_id = p_shop_id and lower(email) = v_email limit 1;
    v_code := null;
    if v_cid is not null then
      select code into v_code from coupon_grants where campaign_id = v_c.id and customer_id = v_cid and status in ('available', 'held') limit 1;
    end if;
    if v_code is null then
      loop
        v_code := banto_grant_code();
        begin
          insert into coupon_grants (shop_id, campaign_id, code, customer_id, expires_at) values (p_shop_id, v_c.id, v_code, v_cid, v_expires);
          exit;
        exception when unique_violation then null;
        end;
      end loop;
    end if;
    v_out := v_out || jsonb_build_object('email', v_email, 'code', v_code, 'member', v_cid is not null);
  end loop;
  return v_out;
end;
$$;

-- ---------- 購入者向けの注文照会・会員の注文 1 件（0022・0017 を差し替え: 取り込んだ明細の品名） ----------
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                            'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy, 'discount_jpy', o.discount_jpy,
                            'shipping_tax_rate', o.shipping_tax_rate, 'tax_rounding', o.tax_rounding, 'payment_provider', o.payment_provider,
                            'tracking', case when o.tracking_number is not null then jsonb_build_object('carrier', o.tracking_carrier, 'number', o.tracking_number) end,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'sku', coalesce(oi.item_variant, k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;

create or replace function member_order(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_number integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_order: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return (
    select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                              'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy, 'discount_jpy', o.discount_jpy,
                              'shipping_tax_rate', o.shipping_tax_rate, 'tax_rounding', o.tax_rounding, 'payment_provider', o.payment_provider,
                              'tracking', case when o.tracking_number is not null then jsonb_build_object('carrier', o.tracking_carrier, 'number', o.tracking_number) end,
                              'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                              from jsonb_array_elements(coalesce(o.discounts, '[]'::jsonb)) d),
                              'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'sku', coalesce(oi.item_variant, k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                          from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
      from orders o
     where o.shop_id = p_shop_id and o.customer_id = p_customer_id and o.number = p_number);
end;
$$;

-- ---------- バックアップからの復元の続き ----------
-- restore_commerce（0022）の後に呼ぶ。注文と明細の 0023 の列を注文番号・品番で戻し、SKU の無い明細（restore_shop_data が飛ばす）を入れる
create or replace function restore_history(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_n integer; v_order uuid;
  v_order_num jsonb := '{}'::jsonb; v_sku_code jsonb := '{}'::jsonb;
  v_orders integer := 0; v_items integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_history: service_role only' using errcode = '42501';
  end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'orders', '[]'::jsonb)) e loop
    if coalesce(v_row->>'number', '') !~ '^[0-9]{1,9}$' then continue; end if;
    if v_row ? 'id' then v_order_num := v_order_num || jsonb_build_object(v_row->>'id', v_row->'number'); end if;
    if nullif(v_row->>'external_ref', '') is not null then
      update orders set external_ref = left(v_row->>'external_ref', 100)
       where shop_id = p_shop_id and number = (v_row->>'number')::integer and external_ref is null
         and not exists (select 1 from orders x where x.shop_id = p_shop_id and x.external_ref = v_row->>'external_ref');
      get diagnostics v_n = row_count; v_orders := v_orders + v_n;
    end if;
  end loop;
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'skus', '[]'::jsonb)) e loop
    if v_row ? 'id' and v_row ? 'code' then v_sku_code := v_sku_code || jsonb_build_object(v_row->>'id', v_row->>'code'); end if;
  end loop;
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'order_items', '[]'::jsonb)) e loop
    if not (v_order_num ? (v_row->>'order_id')) or coalesce(v_row->>'qty', '') !~ '^[0-9]{1,6}$' or coalesce(v_row->>'unit_price_jpy', '') !~ '^[0-9]{1,9}$' then continue; end if;
    select id into v_order from orders where shop_id = p_shop_id and number = (v_order_num->>(v_row->>'order_id'))::integer;
    if v_order is null then continue; end if;
    if nullif(v_row->>'sku_id', '') is null then
      -- 2 回目の呼び出しで重ねない
      if exists (select 1 from order_items where order_id = v_order and sku_id is null and item_name is not distinct from left(v_row->>'item_name', 200) and qty = (v_row->>'qty')::integer) then continue; end if;
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy, item_name, item_variant)
      values (p_shop_id, v_order, null, (v_row->>'qty')::integer, (v_row->>'unit_price_jpy')::integer, greatest(0, coalesce((v_row->>'discount_jpy')::integer, 0)),
              left(v_row->>'item_name', 200), left(v_row->>'item_variant', 200));
      v_items := v_items + 1;
    elsif (nullif(v_row->>'item_name', '') is not null or nullif(v_row->>'item_variant', '') is not null) and v_sku_code ? (v_row->>'sku_id') then
      update order_items oi set item_name = left(v_row->>'item_name', 200), item_variant = left(v_row->>'item_variant', 200)
        from skus k
       where oi.order_id = v_order and k.shop_id = p_shop_id and k.code = v_sku_code->>(v_row->>'sku_id') and oi.sku_id = k.id
         and oi.qty = (v_row->>'qty')::integer and oi.item_name is null;
      get diagnostics v_n = row_count; v_items := v_items + v_n;
    end if;
  end loop;
  return jsonb_build_object('history_orders', v_orders, 'history_items', v_items);
end;
$$;

revoke execute on function banto_email_subject(text) from public, anon, authenticated;
revoke execute on function import_orders(uuid, jsonb) from public, anon;
grant execute on function import_orders(uuid, jsonb) to authenticated, service_role;
revoke execute on function import_coupon_usage(uuid, text, text[], boolean) from public, anon;
grant execute on function import_coupon_usage(uuid, text, text[], boolean) to authenticated, service_role;
revoke execute on function coupon_grants_for_emails(uuid, uuid, text[]) from public, anon;
grant execute on function coupon_grants_for_emails(uuid, uuid, text[]) to authenticated, service_role;
revoke execute on function lookup_order(uuid, integer, text) from public;
grant execute on function lookup_order(uuid, integer, text) to anon, authenticated, service_role;
revoke execute on function member_order(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function member_order(uuid, uuid, integer, integer) to service_role;
revoke execute on function restore_history(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_history(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0023_woo_history');
