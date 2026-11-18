-- 0157_mod_cod: 代金引換（同梱モジュール cod、既定 OFF）。メンテナの決定 2026-11-18（docs/cod.md）。前方専用。
--   - 未入金の注文（0156）を作る口。確定は「Webhook のみ」の 3 つ目の例外（0 円・Amazon Pay に続く）: 代引きは支払いを待たずに
--     その場で受付（pending・未入金）として確定し、order.created だけを出す。order.paid は運営者が入金を記録したとき（0156）
--   - 代引き手数料はコアのお金の一本道（送料と同じ）: 予約と注文に fee_jpy、合計 = 小計 + 送料 + 手数料 - 値引き。税は標準税率
--   - 手数料の決まり・上限金額・会員だけは shops.settings.cod。確定のとき DB が引き直し（banto_cod_fee）、Worker の計算（src/modules/cod/）と
--     1 円でも違えば確定しない。TS と SQL は test/fixtures/cod-fee-cases.ts の答え合わせの表で縛る
--   - 同梱のメール・LINE は代引きの受付の知らせを order.created で送るので、今ある送信先の購読に order.created を足す

alter table reservations add column if not exists fee_jpy integer not null default 0 check (fee_jpy >= 0);
alter table orders add column if not exists fee_jpy integer not null default 0 check (fee_jpy >= 0);

-- 手数料（shops.settings をそのまま受ける。src/modules/cod/index.ts の codFee と同じ）。手数料の対象の金額（小計 + 送料 - 値引き）に対して、
-- 使えないとき（段のどれにも当たらない・段が無い）は null。上限金額は呼び出し側が合計で比べる
--   settings.cod.fee_type: 'tiers' なら段（fee_tiers: [{ upto, fee }] の有効なものを upto の小さい順に、最初に amount <= upto の段）、それ以外は一律（fee_jpy）
--   値の形: upto は 1〜10,000,000 の整数、fee・fee_jpy は 0〜100,000 の整数（形の違う値は捨てる。一律の値が無ければ 0）。段は 10 個まで
create or replace function banto_cod_fee(p_settings jsonb, p_amount integer)
returns integer
language plpgsql
immutable
as $$
declare v_cod jsonb; v_fee integer; v_t jsonb;
begin
  v_cod := case when jsonb_typeof(p_settings->'cod') = 'object' then p_settings->'cod' else '{}'::jsonb end;
  if p_amount is null or p_amount < 0 then return null; end if;
  if v_cod->>'fee_type' = 'tiers' then
    if jsonb_typeof(v_cod->'fee_tiers') <> 'array' then return null; end if;
    for v_t in
      select t from (select t, ord from jsonb_array_elements(v_cod->'fee_tiers') with ordinality x(t, ord) where ord <= 10) y
       where jsonb_typeof(t) = 'object'
         and jsonb_typeof(t->'upto') = 'number' and (t->>'upto')::numeric = trunc((t->>'upto')::numeric) and (t->>'upto')::numeric between 1 and 10000000
         and jsonb_typeof(t->'fee') = 'number' and (t->>'fee')::numeric = trunc((t->>'fee')::numeric) and (t->>'fee')::numeric between 0 and 100000
       order by (t->>'upto')::numeric, ord
    loop
      if p_amount <= (v_t->>'upto')::integer then return (v_t->>'fee')::integer; end if;
    end loop;
    return null;
  end if;
  v_fee := case when jsonb_typeof(v_cod->'fee_jpy') = 'number' and (v_cod->>'fee_jpy')::numeric = trunc((v_cod->>'fee_jpy')::numeric)
                      and (v_cod->>'fee_jpy')::numeric between 0 and 100000 then (v_cod->>'fee_jpy')::integer else 0 end;
  return v_fee;
end;
$$;
revoke execute on function banto_cod_fee(jsonb, integer) from public, anon, authenticated;

-- 上限金額（合計、手数料込み）。1〜10,000,000 の整数、無ければ 300,000（代引きの一般的な上限）
create or replace function banto_cod_max_total(p_settings jsonb)
returns integer
language sql
immutable
as $$
  select case when jsonb_typeof(p_settings->'cod'->'max_total_jpy') = 'number'
                   and (p_settings->'cod'->>'max_total_jpy')::numeric = trunc((p_settings->'cod'->>'max_total_jpy')::numeric)
                   and (p_settings->'cod'->>'max_total_jpy')::numeric between 1 and 10000000
              then (p_settings->'cod'->>'max_total_jpy')::integer else 300000 end;
$$;
revoke execute on function banto_cod_max_total(jsonb) from public, anon, authenticated;

-- お客様の画面に渡す settings の鍵に cod（手数料の決まり・上限・会員だけ・確認画面の文。レジが手数料を出すため。0101 を差し替え）
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent', 'page_layouts', 'cod')), '{}'::jsonb)
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb))
                                                || case when jsonb_typeof(p->'headless'->'order_page_url') = 'string'
                                                        then jsonb_build_object('order_page_url', p->'headless'->'order_page_url') else '{}'::jsonb end
                                                || case when jsonb_typeof(p->'headless'->'account_page_url') = 'string'
                                                        then jsonb_build_object('account_page_url', p->'headless'->'account_page_url') else '{}'::jsonb end)
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

-- 予約に配送先・送料と代引き手数料（0157）を付ける（0012 を差し替え）
create or replace function attach_reservation_customer(p_reservation_id uuid, p_shop_id uuid, p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shipping integer; v_customer_id uuid; v_fee integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'attach_reservation_customer: service_role only' using errcode = '42501';
  end if;
  v_shipping := coalesce((p_customer->>'shipping_jpy')::integer, 0);
  if v_shipping < 0 then raise exception 'invalid_shipping'; end if;
  -- 代引き手数料（0157）。確定のとき confirm_reservation がショップの設定から引き直して確かめる
  v_fee := coalesce((p_customer->>'fee_jpy')::integer, 0);
  if v_fee < 0 then raise exception 'invalid_fee'; end if;
  v_customer_id := nullif(p_customer->>'customer_id', '')::uuid;
  if v_customer_id is not null and not exists (
       select 1 from customers where shop_id = p_shop_id and id = v_customer_id
          and session_epoch = coalesce(nullif(p_customer->>'customer_epoch', '')::integer, -1)) then
    raise exception 'member_session_invalid';
  end if;
  update reservations
     set customer = p_customer - 'shipping_jpy' - 'fee_jpy' - 'customer_id' - 'customer_epoch',
         shipping_jpy = v_shipping,
         fee_jpy = v_fee,
         customer_id = v_customer_id
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending';
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
end;
$$;

-- 注文の確定: 代引き手数料を合計に・代金引換は受付（未入金）で確定して order.created だけ（0128 を差し替え）
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
  v_total integer;
  v_number integer;
  v_threshold integer;
  v_available integer;
  v_payload jsonb;
  v_r record;
  v_slot bigint;
  v_paid integer;
  v_cod boolean := coalesce(p_order->>'payment_provider', '') = 'cod';
  v_settings jsonb;
  v_fee integer;
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

  -- 返金すると決めた予約（reservation_mark_refunded、0128）は二度と確定しない。Worker は detail（provider:event_id）で
  -- 「同じイベントの再送（返金の前に落ちた）なら返金をやり直す、別のイベントなら何もしない」を決める
  if v_res.status = 'refunded' then
    raise exception 'reservation_refunded' using detail = coalesce(v_res.refund_event, '');
  end if;

  -- 決済事業者が受け取った額・通貨が Banto の計算と違えば確定しない（在庫は動かさない。Worker が返金して解放する）。
  -- 額が無い・整数でない・通貨が無いときも確定しない（照合を素通りさせない）
  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0)
    into v_subtotal
    from jsonb_array_elements(v_res.items) e;
  v_total := greatest(0, v_subtotal + v_res.shipping_jpy - v_res.discount_jpy) + v_res.fee_jpy;
  -- 代金引換（0157）: 支払いを待たずに受付で確定する（「確定は Webhook のみ」の例外）。モジュールが ON・手数料がショップの決まりと同じ・
  -- 合計が上限以下・会員だけのショップなら会員の予約。受け取る額は 0（お金は配達のときに集める）
  if v_res.fee_jpy <> 0 and not v_cod then
    raise exception 'amount_mismatch' using detail = 'fee_only_for_cod';
  end if;
  if v_cod then
    select settings into v_settings from shops where id = p_shop_id;
    if v_settings->'modules'->'cod' is distinct from 'true'::jsonb then raise exception 'cod_unavailable' using detail = 'module'; end if;
    v_fee := banto_cod_fee(v_settings, greatest(0, v_subtotal + v_res.shipping_jpy - v_res.discount_jpy));
    if v_fee is null then raise exception 'cod_unavailable' using detail = 'fee'; end if;
    if v_fee <> v_res.fee_jpy then raise exception 'amount_mismatch' using detail = format('cod_fee=%s expected=%s', v_res.fee_jpy, v_fee); end if;
    if v_total <= 0 then raise exception 'cod_unavailable' using detail = 'zero'; end if;
    if v_total > banto_cod_max_total(v_settings) then raise exception 'cod_unavailable' using detail = 'max_total'; end if;
    if v_settings->'cod'->'members_only' = 'true'::jsonb and v_res.customer_id is null then raise exception 'cod_unavailable' using detail = 'members_only'; end if;
    if coalesce(p_order->>'amount_paid_jpy', '') <> '0' then raise exception 'amount_mismatch' using detail = 'cod_paid_must_be_0'; end if;
  end if;
  if coalesce(p_order->>'amount_paid_jpy', '') !~ '^-?[0-9]{1,9}$' then
    raise exception 'amount_mismatch' using detail = format('paid=%s expected=%s', coalesce(p_order->>'amount_paid_jpy', 'null'), v_total);
  end if;
  v_paid := (p_order->>'amount_paid_jpy')::integer;
  if v_paid <> v_total and not v_cod then
    raise exception 'amount_mismatch' using detail = format('paid=%s expected=%s', v_paid, v_total);
  end if;
  if coalesce(btrim(p_order->>'currency'), '') !~* '^jpy$' then
    raise exception 'amount_mismatch' using detail = format('currency=%s', coalesce(p_order->>'currency', 'null'));
  end if;
  -- 支払いの無い確定（0 円の注文）は合計が 0 のときだけ
  if p_order->>'payment_provider' = 'free' and v_total <> 0 then
    raise exception 'amount_mismatch' using detail = format('free expected=%s', v_total);
  end if;

  if v_res.status = 'released' then
    -- 解放の後に同じ quote で出し直した予約が生きていれば、こちらは古い（Worker が返金する）
    if v_res.quote_id is not null and exists (
         select 1 from reservations r where r.shop_id = p_shop_id and r.quote_id = v_res.quote_id and r.id <> v_res.id and r.status in ('pending', 'confirmed')) then
      raise exception 'quote_superseded' using detail = v_res.quote_id;
    end if;
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
    -- クーポンの枠も取り直す。全体の上限のあるキャンペーンで枠が残っていなければ確定しない（先着枠を超えない）
    for v_r in select r.id, r.campaign_id, c.usage_limit
                 from coupon_redemptions r join coupon_campaigns c on c.id = r.campaign_id
                where r.reservation_id = p_reservation_id and r.status = 'released' loop
      v_slot := null;
      if v_r.usage_limit is not null then
        update coupon_slots set status = 'held', reservation_id = p_reservation_id
         where id = (select id from coupon_slots where campaign_id = v_r.campaign_id and status = 'free' limit 1 for update skip locked)
        returning id into v_slot;
        if v_slot is null then
          raise exception 'coupon_exhausted_after_release' using detail = v_r.campaign_id::text;
        end if;
      end if;
      update coupon_redemptions set status = 'held', slot_id = v_slot where id = v_r.id;
    end loop;
  end if;

  update shops set order_seq = order_seq + 1 where id = p_shop_id returning order_seq into v_number;

  insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, discount_jpy, discounts, amount_paid_jpy, number, customer_id,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref, payment_account,
                      fee_jpy, payment_status)
  values (p_shop_id, p_reservation_id, case when v_cod then 'pending'::order_status else 'paid'::order_status end,
          v_total, v_res.shipping_jpy, v_res.discount_jpy, v_res.discounts,
          case when v_cod then null else v_paid end, v_number, v_res.customer_id,
          coalesce(v_res.customer->>'customer_email', p_order->>'customer_email'),
          coalesce(v_res.customer->>'customer_name', p_order->>'customer_name'),
          coalesce(v_res.customer->'shipping_address', p_order->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref',
          nullif(left(btrim(coalesce(p_order->>'payment_account', '')), 200), ''),
          v_res.fee_jpy, case when v_cod then 'unpaid' else 'paid' end)
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer, coalesce((e->>'discount_jpy')::integer, 0)
    from jsonb_array_elements(v_res.items) e;

  update coupon_slots set status = 'used' where reservation_id = p_reservation_id and status = 'held';
  update coupon_redemptions set status = 'used', order_id = v_order_id where reservation_id = p_reservation_id and status = 'held';
  update reservations set status = 'confirmed', customer = null where id = p_reservation_id;

  v_payload := jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_number, 'shop_id', p_shop_id,
    'subtotal_jpy', v_subtotal, 'shipping_jpy', v_res.shipping_jpy, 'discount_jpy', v_res.discount_jpy, 'fee_jpy', v_res.fee_jpy, 'total_jpy', v_total,
    'status', case when v_cod then 'pending' else 'paid' end, 'payment_status', case when v_cod then 'unpaid' else 'paid' end,
    'payment_provider', p_order->>'payment_provider', 'customer_id', v_res.customer_id,
    'items', v_res.items
  );
  perform enqueue_hook(p_shop_id, 'order.created', v_payload);
  -- 代金引換の注文は未入金（order.paid は入金の記録のとき、0156）
  if not v_cod then
    perform enqueue_hook(p_shop_id, 'order.paid', v_payload);
  end if;

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

-- 注文メールの材料: 代引き手数料とお支払いの状態（0066 を差し替え）
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
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'fee_jpy', v_o.fee_jpy, 'payment_status', v_o.payment_status, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'shipping_tax_rate', v_o.shipping_tax_rate, 'tax_rounding', v_o.tax_rounding,
    'tracking', case when v_o.tracking_number is not null then jsonb_build_object('carrier', v_o.tracking_carrier, 'number', v_o.tracking_number) end,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    -- 0066: 会員の注文か（メールのリンクの目印）と、注文照会のページ（連携サイト）。どちらも鍵ではない
    'member', v_o.customer_id is not null,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                               'order_page_url', v_s.settings->'headless'->>'order_page_url',
                               'return_origins', coalesce(v_s.settings->'headless'->'return_origins', '[]'::jsonb),
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy,
                               'tax', jsonb_build_object('tax_rate', v_s.settings->'tax_rate', 'tax_rate_reduced', v_s.settings->'tax_rate_reduced', 'tax_rounding', v_s.settings->'tax_rounding')),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                           'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

-- 注文照会・会員の注文・領収書の材料: 代引き手数料（0156 を差し替え）
create or replace function banto_order_view(p_o orders)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('number', p_o.number, 'status', p_o.status, 'created_at', p_o.created_at, 'shipped_at', p_o.shipped_at,
                            'total_jpy', p_o.total_jpy, 'shipping_jpy', p_o.shipping_jpy, 'discount_jpy', p_o.discount_jpy,
                            'shipping_tax_rate', p_o.shipping_tax_rate, 'tax_rounding', p_o.tax_rounding, 'payment_provider', p_o.payment_provider,
                            'payment_status', p_o.payment_status, 'paid_at', p_o.paid_at, 'fee_jpy', p_o.fee_jpy,
                            'tracking', case when p_o.tracking_number is not null then jsonb_build_object('carrier', p_o.tracking_carrier, 'number', p_o.tracking_number) end,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(p_o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'sku', coalesce(oi.item_variant, k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = p_o.id));
$$;
revoke execute on function banto_order_view(orders) from public, anon, authenticated;

-- AI 用 API の注文: 代引き手数料（0156 を差し替え）
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
    'payment_status', p_order.payment_status, 'paid_at', p_order.paid_at, 'cancel_reason', p_order.cancel_reason, 'fee_jpy', p_order.fee_jpy,
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

-- 入金の記録の order.paid: 代引き手数料（0156 を差し替え）
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
                       'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', coalesce(v_o.discount_jpy, 0), 'fee_jpy', v_o.fee_jpy,
                       'payment_status', 'paid', 'paid_at', v_o.paid_at, 'recorded_payment', true, 'payment_provider', v_o.payment_provider, 'customer_id', v_o.customer_id,
                       'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', oi.sku_id, 'product_id', k.product_id, 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                                              'discount_jpy', coalesce(oi.discount_jpy, 0)) order by oi.id), '[]'::jsonb)
                                   from order_items oi left join skus k on k.id = oi.sku_id where oi.order_id = v_o.id)));
  return jsonb_build_object('order_id', v_o.id, 'paid_at', v_o.paid_at, 'already', false);
end;
$$;
revoke execute on function banto_order_payment_record(uuid, uuid) from public, anon, authenticated, service_role;

-- 復元: 代引き手数料も戻す（0156 を差し替え）
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
                        payment_provider, payment_ref, shipped_at, customer_id, created_at, updated_at, payment_status, paid_at, cancel_reason, fee_jpy)
      values (p_shop_id, null, coalesce((v_row->>'status')::order_status, 'paid'), coalesce((v_row->>'total_jpy')::integer, 0),
              coalesce((v_row->>'shipping_jpy')::integer, 0), (v_row->>'number')::integer, v_row->>'customer_email', v_row->>'customer_name',
              v_row->'shipping_address', v_row->>'payment_provider', v_row->>'payment_ref', (v_row->>'shipped_at')::timestamptz,
              case when v_customer_ok ? (v_row->>'customer_id') then (v_row->>'customer_id')::uuid else null end,
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()),
              v_pay, case when v_pay = 'paid' then coalesce((v_row->>'paid_at')::timestamptz, (v_row->>'created_at')::timestamptz, now()) end,
              case when v_pay = 'unpaid' and v_row->>'cancel_reason' = 'refused' then 'refused' end,
              greatest(0, coalesce((v_row->>'fee_jpy')::integer, 0)))
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

-- モジュール cod の ON/OFF と設定の鍵 cod は項目 settings だけでよい（banto_shop_settings_perm の表に無い鍵は null = settings。差し替えない）

-- 同梱のメール・LINE のプラグインの送信先: 代引き（未入金）の注文の受付の知らせは order.created で送るので購読に足す
-- （プラグインは order.created のうち payment_status = 'unpaid' のものだけを扱う）
update hook_endpoints set events = array_append(events, 'order.created')
 where url in ('https://banto.invalid/plugins/email_resend', 'https://banto.invalid/plugins/line_buyer_notify', 'https://banto.invalid/plugins/line_notify')
   and not ('order.created' = any(events));

insert into banto_migrations (version) values ('0157_mod_cod');
