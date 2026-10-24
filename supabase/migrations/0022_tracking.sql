-- 0022_tracking: 送り状番号（お問い合わせ番号）の取り込み・注文メールの税率ごとの内訳・WooCommerce の税区分・バックアップの復元の続き
--
-- - orders.tracking_carrier / tracking_number … 発送したときの運送会社とお問い合わせ番号（docs/shipping-labels.md §5）。
--   ship_orders（authenticated、所有を検証）が注文番号で突き合わせて入れ、支払い済みの注文は発送済みにして order.shipped を送る。
--   hooks のペイロードには載せない（届け先の地域が分かるため）。購入者には注文照会（lookup_order）とメールで見せる。
-- - order_contact（メール通知）に税率・端数の扱い・明細の値引き・お問い合わせ番号を足す（計算は src/commerce/tax.ts）。
-- - import_tax_classes … WooCommerce の取り込みで、商品の税区分（0017）を slug で入れる（import_catalog は 0017 の列を知らない）。
-- - restore_commerce … バックアップからの復元の続き: クーポン（キャンペーン・使用済みの数・発行済み）、注文の値引き・配送の指定・
--   お問い合わせ番号、明細の値引き。1 人あたりの使用回数（coupon_redemptions）は予約に紐づくので戻さない（docs/backup.md）。

alter table orders add column if not exists tracking_carrier text check (tracking_carrier is null or tracking_carrier in ('yamato', 'sagawa', 'japanpost', 'other'));
alter table orders add column if not exists tracking_number text check (tracking_number is null or tracking_number ~ '^[0-9A-Za-z]{4,40}$');

-- ---------- 送り状番号の取り込み ----------
-- p_items: [{ number, carrier, tracking }]。番号の区切り（- と空白）は外す。
-- 支払い済み → 発送済みにして order.shipped。発送済み → 番号だけ入れ直す（通知はしない）。それ以外（キャンセル等）・見つからない注文は飛ばす。
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
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items'; end if;
  for v_row in select e from jsonb_array_elements(p_items) e loop
    v_num := btrim(coalesce(v_row->>'number', ''));
    v_carrier := v_row->>'carrier';
    v_tracking := regexp_replace(coalesce(v_row->>'tracking', ''), '[\s-]', '', 'g');
    if v_num !~ '^[0-9]{1,9}$' or v_carrier is null or v_carrier not in ('yamato', 'sagawa', 'japanpost', 'other') or v_tracking !~ '^[0-9A-Za-z]{4,40}$' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    select * into v_o from orders where shop_id = p_shop_id and number = v_num::integer and status in ('paid', 'shipped') for update;
    if not found then
      if jsonb_array_length(v_missing) < 50 then v_missing := v_missing || to_jsonb(v_num::integer); end if;
      continue;
    end if;
    if v_o.status = 'paid' then
      update orders set status = 'shipped', shipped_at = now(), tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now()
       where id = v_o.id returning * into v_o;
      perform enqueue_hook(p_shop_id, 'order.shipped',
        jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status,
                           'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id));
      v_shipped := v_shipped + 1;
    else
      update orders set tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now() where id = v_o.id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('shipped', v_shipped, 'updated', v_updated, 'invalid', v_invalid, 'missing', v_missing);
end;
$$;

-- ---------- 購入者向けの注文照会（0017 を差し替え: お問い合わせ番号を足す。住所は返さない） ----------
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
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;

-- ---------- メール通知の連絡先（0015 を差し替え: 税率・端数・明細の値引き・ショップの税の設定・お問い合わせ番号） ----------
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
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'shipping_tax_rate', v_o.shipping_tax_rate, 'tax_rounding', v_o.tax_rounding,
    'tracking', case when v_o.tracking_number is not null then jsonb_build_object('carrier', v_o.tracking_carrier, 'number', v_o.tracking_number) end,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy,
                               'tax', jsonb_build_object('tax_rate', v_s.settings->'tax_rate', 'tax_rate_reduced', v_s.settings->'tax_rate_reduced', 'tax_rounding', v_s.settings->'tax_rounding')),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                           'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

-- ---------- WooCommerce の取り込み: 税区分 ----------
-- p_items: [{ slug, tax_class }]。区分の値が違う行・見つからない商品は飛ばす。入れた件数を返す
create or replace function import_tax_classes(p_shop_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer; v_total integer := 0;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then raise exception 'invalid_items'; end if;
  for v_row in select e from jsonb_array_elements(p_items) e loop
    if v_row->>'tax_class' in ('standard', 'reduced', 'exempt') then
      update products set tax_class = v_row->>'tax_class', updated_at = now()
       where shop_id = p_shop_id and slug = v_row->>'slug' and tax_class is distinct from v_row->>'tax_class';
      get diagnostics v_n = row_count; v_total := v_total + v_n;
    end if;
  end loop;
  return v_total;
end;
$$;

-- ---------- バックアップからの復元の続き ----------
-- restore_shop_data（0012）・restore_catalog（0008）・restore_tax（0017）の後に呼ぶ。p_data は書き出しの tables そのまま。
-- 商品は slug、カテゴリーは slug、注文は注文番号、SKU は品番で突き合わせる（id は振り直されているため）。会員は同じ id で戻っている。
create or replace function restore_commerce(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_new uuid; v_n integer;
  v_product_map jsonb := '{}'::jsonb;
  v_category_map jsonb := '{}'::jsonb;
  v_campaign_map jsonb := '{}'::jsonb;
  v_order_num jsonb := '{}'::jsonb;
  v_sku_code jsonb := '{}'::jsonb;
  v_cond jsonb; v_key text; v_used integer;
  v_campaigns integer := 0; v_grants integer := 0; v_grants_skipped integer := 0; v_orders integer := 0; v_items integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_commerce: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;

  -- 旧 id → 新 id（slug で）
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'products', '[]'::jsonb)) e loop
    select id into v_new from products where shop_id = p_shop_id and slug = v_row->>'slug';
    if v_new is not null and v_row ? 'id' then v_product_map := v_product_map || jsonb_build_object(v_row->>'id', v_new::text); end if;
  end loop;
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'categories', '[]'::jsonb)) e loop
    select id into v_new from categories where shop_id = p_shop_id and slug = v_row->>'slug';
    if v_new is not null and v_row ? 'id' then v_category_map := v_category_map || jsonb_build_object(v_row->>'id', v_new::text); end if;
  end loop;

  -- クーポン（キャンペーンがまだ無いショップにだけ。2 回目の呼び出しで二重にしない）
  if not exists (select 1 from coupon_campaigns where shop_id = p_shop_id) then
    for v_row in select e from jsonb_array_elements(coalesce(p_data->'coupon_campaigns', '[]'::jsonb)) e loop
      -- 対象の商品・カテゴリーの id を振り直す（戻らなかったものは外す）
      v_cond := case when jsonb_typeof(v_row->'conditions') = 'object' then v_row->'conditions' else '{}'::jsonb end;
      foreach v_key in array array['product_ids', 'exclude_product_ids'] loop
        if jsonb_typeof(v_cond->v_key) = 'array' then
          v_cond := jsonb_set(v_cond, array[v_key], coalesce((select jsonb_agg(v_product_map->(x #>> '{}')) from jsonb_array_elements(v_cond->v_key) x where v_product_map ? (x #>> '{}')), '[]'::jsonb));
        end if;
      end loop;
      foreach v_key in array array['category_ids', 'exclude_category_ids'] loop
        if jsonb_typeof(v_cond->v_key) = 'array' then
          v_cond := jsonb_set(v_cond, array[v_key], coalesce((select jsonb_agg(v_category_map->(x #>> '{}')) from jsonb_array_elements(v_cond->v_key) x where v_category_map ? (x #>> '{}')), '[]'::jsonb));
        end if;
      end loop;
      insert into coupon_campaigns (shop_id, name, code, kind, value, starts_at, ends_at, usage_limit, per_customer_limit, combinable, audience,
                                    conditions, active, grant_valid_days, auto_grant, claimable, created_at, updated_at)
      values (p_shop_id, v_row->>'name', v_row->>'code', v_row->>'kind', coalesce((v_row->>'value')::integer, 0),
              (v_row->>'starts_at')::timestamptz, (v_row->>'ends_at')::timestamptz, (v_row->>'usage_limit')::integer, (v_row->>'per_customer_limit')::integer,
              coalesce((v_row->>'combinable')::boolean, false), coalesce(v_row->>'audience', 'public'), v_cond, coalesce((v_row->>'active')::boolean, true),
              (v_row->>'grant_valid_days')::integer, v_row->>'auto_grant', coalesce((v_row->>'claimable')::boolean, false),
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
      v_campaign_map := v_campaign_map || jsonb_build_object(v_row->>'id', v_new::text);
      v_campaigns := v_campaigns + 1;
      -- 全体の上限の使用済みの数（書き出しの coupon_slots は使用済みの行だけ）
      select count(*) into v_used from jsonb_array_elements(coalesce(p_data->'coupon_slots', '[]'::jsonb)) s
       where s->>'campaign_id' = v_row->>'id' and s->>'status' = 'used';
      if v_used > 0 then
        update coupon_slots set status = 'used'
         where id in (select id from coupon_slots where campaign_id = v_new and status = 'free' order by id limit v_used);
      end if;
    end loop;

    -- 発行済みのクーポン。会員に発行したもので、その会員が戻っていないものは飛ばす（誰でも使えるコードにしない）
    for v_row in select e from jsonb_array_elements(coalesce(p_data->'coupon_grants', '[]'::jsonb)) e loop
      if not (v_campaign_map ? (v_row->>'campaign_id'))
         or (nullif(v_row->>'customer_id', '') is not null and not exists (select 1 from customers where shop_id = p_shop_id and id = (v_row->>'customer_id')::uuid)) then
        v_grants_skipped := v_grants_skipped + 1;
        continue;
      end if;
      insert into coupon_grants (shop_id, campaign_id, code, customer_id, status, expires_at, created_at, used_at)
      values (p_shop_id, (v_campaign_map->>(v_row->>'campaign_id'))::uuid, v_row->>'code', nullif(v_row->>'customer_id', '')::uuid,
              case when v_row->>'status' in ('used', 'revoked') then v_row->>'status' else 'available' end,
              (v_row->>'expires_at')::timestamptz, coalesce((v_row->>'created_at')::timestamptz, now()),
              case when v_row->>'status' = 'used' then (v_row->>'used_at')::timestamptz end)
      on conflict (shop_id, code) do nothing;
      get diagnostics v_n = row_count;
      if v_n = 1 then v_grants := v_grants + 1; else v_grants_skipped := v_grants_skipped + 1; end if;
    end loop;
  end if;

  -- 注文: 値引き・配送の指定・お問い合わせ番号（restore_shop_data は 0010 以降の列を知らない）
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'orders', '[]'::jsonb)) e loop
    if coalesce(v_row->>'number', '') !~ '^[0-9]{1,9}$' then continue; end if;
    if v_row ? 'id' then v_order_num := v_order_num || jsonb_build_object(v_row->>'id', v_row->'number'); end if;
    update orders set
      discount_jpy = greatest(0, coalesce((v_row->>'discount_jpy')::integer, discount_jpy)),
      discounts = case when jsonb_typeof(v_row->'discounts') = 'array' then v_row->'discounts' else discounts end,
      amount_paid_jpy = coalesce((v_row->>'amount_paid_jpy')::integer, amount_paid_jpy),
      delivery = case when jsonb_typeof(v_row->'delivery') = 'object' then v_row->'delivery' else delivery end,
      tracking_carrier = case when v_row->>'tracking_carrier' in ('yamato', 'sagawa', 'japanpost', 'other') and coalesce(v_row->>'tracking_number', '') ~ '^[0-9A-Za-z]{4,40}$'
                              then v_row->>'tracking_carrier' else tracking_carrier end,
      tracking_number = case when v_row->>'tracking_carrier' in ('yamato', 'sagawa', 'japanpost', 'other') and coalesce(v_row->>'tracking_number', '') ~ '^[0-9A-Za-z]{4,40}$'
                             then v_row->>'tracking_number' else tracking_number end
     where shop_id = p_shop_id and number = (v_row->>'number')::integer;
    get diagnostics v_n = row_count; v_orders := v_orders + v_n;
  end loop;

  -- 明細の値引き（注文番号 + SKU の品番で）
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'skus', '[]'::jsonb)) e loop
    if v_row ? 'id' and v_row ? 'code' then v_sku_code := v_sku_code || jsonb_build_object(v_row->>'id', v_row->>'code'); end if;
  end loop;
  for v_row in select e from jsonb_array_elements(coalesce(p_data->'order_items', '[]'::jsonb)) e loop
    if coalesce((v_row->>'discount_jpy')::integer, 0) > 0 and v_order_num ? (v_row->>'order_id') and v_sku_code ? (v_row->>'sku_id') then
      update order_items oi set discount_jpy = (v_row->>'discount_jpy')::integer
        from orders o, skus k
       where o.shop_id = p_shop_id and o.number = (v_order_num->>(v_row->>'order_id'))::integer
         and k.shop_id = p_shop_id and k.code = v_sku_code->>(v_row->>'sku_id')
         and oi.order_id = o.id and oi.sku_id = k.id and oi.qty = coalesce((v_row->>'qty')::integer, oi.qty);
      get diagnostics v_n = row_count; v_items := v_items + v_n;
    end if;
  end loop;

  return jsonb_build_object('coupon_campaigns', v_campaigns, 'coupon_grants', v_grants, 'coupon_grants_skipped', v_grants_skipped,
                            'order_discounts', v_orders, 'item_discounts', v_items);
end;
$$;

revoke execute on function ship_orders(uuid, jsonb) from public, anon;
grant execute on function ship_orders(uuid, jsonb) to authenticated, service_role;
revoke execute on function lookup_order(uuid, integer, text) from public;
grant execute on function lookup_order(uuid, integer, text) to anon, authenticated, service_role;
revoke execute on function order_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function order_contact(uuid, uuid) to service_role;
revoke execute on function import_tax_classes(uuid, jsonb) from public, anon;
grant execute on function import_tax_classes(uuid, jsonb) to authenticated, service_role;
revoke execute on function restore_commerce(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_commerce(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0022_tracking');
