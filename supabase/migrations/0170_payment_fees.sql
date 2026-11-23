-- 0170_payment_fees: 支払い方法の手数料（KOMOJU の種類ごと）。メンテナの決定 2026-11-23（docs/plugins.md「KOMOJU」・docs/knowledge/02-decisions.md）。前方専用。
--   - コアのお金の一本道（基準 (1)）: 代引き手数料（0157）と同じ予約と注文の fee_jpy、合計に含める、標準税率、値引きの対象外
--   - 決まりは shops.settings.payment_fees.<種類>（{ fee_type, fee_jpy, fee_tiers }、代引きの settings.cod と同じ形）。
--     読み方は banto_fee_rule 1 つ（代引きの banto_cod_fee もこれを通す）。Worker の src/commerce/payment-fees.ts と答え合わせの表で縛る
--   - お客様は確認画面で KOMOJU の種類を選び（予約の payment_method = 'komoju:<種類>'）、決済ページはその種類だけに絞る。
--     手数料は値引きを付けた後に reservation_payment_fee_check がショップの決まりで確かめ（fee_checked）、確定はそれを見る
--     （コンビニ払いは確定まで日数がかかるので、確定のときに決まりで引き直すと、あいだに決まりを変えたときに払った人を返金にしてしまう）
--   - 確定のとき、KOMOJU が知らせた種類（payment_details.type）が選んだ種類と違えば確定しない（返金）

alter table reservations add column if not exists payment_method text check (payment_method is null or payment_method ~ '^[a-z_]{1,40}(:[a-z_]{1,40})?$');
alter table reservations add column if not exists fee_checked boolean not null default false;

-- 手数料の決まり（{ fee_type, fee_jpy, fee_tiers }）と手数料の対象の金額（小計 + 送料 - 値引き）から手数料。src/commerce/payment-fees.ts の feeOfRule と同じ。
-- 使えないとき（段のどれにも当たらない・段が無い・金額が負）は null
--   fee_type: 'tiers' なら段（fee_tiers: [{ upto, fee }] の有効なものを upto の小さい順に、最初に amount <= upto の段）、それ以外は一律（fee_jpy）
--   値の形: upto は 1〜10,000,000 の整数、fee・fee_jpy は 0〜100,000 の整数（形の違う値は捨てる。一律の値が無ければ 0）。段は 10 個まで
create or replace function banto_fee_rule(p_rule jsonb, p_amount integer)
returns integer
language plpgsql
immutable
as $$
declare v_r jsonb; v_t jsonb;
begin
  v_r := case when jsonb_typeof(p_rule) = 'object' then p_rule else '{}'::jsonb end;
  if p_amount is null or p_amount < 0 then return null; end if;
  if v_r->>'fee_type' = 'tiers' then
    if jsonb_typeof(v_r->'fee_tiers') is distinct from 'array' then return null; end if;
    for v_t in
      select t from (select t, ord from jsonb_array_elements(v_r->'fee_tiers') with ordinality x(t, ord) where ord <= 10) y
       where jsonb_typeof(t) = 'object'
         and jsonb_typeof(t->'upto') = 'number' and (t->>'upto')::numeric = trunc((t->>'upto')::numeric) and (t->>'upto')::numeric between 1 and 10000000
         and jsonb_typeof(t->'fee') = 'number' and (t->>'fee')::numeric = trunc((t->>'fee')::numeric) and (t->>'fee')::numeric between 0 and 100000
       order by (t->>'upto')::numeric, ord
    loop
      if p_amount <= (v_t->>'upto')::integer then return (v_t->>'fee')::integer; end if;
    end loop;
    return null;
  end if;
  return case when jsonb_typeof(v_r->'fee_jpy') = 'number' and (v_r->>'fee_jpy')::numeric = trunc((v_r->>'fee_jpy')::numeric)
                   and (v_r->>'fee_jpy')::numeric between 0 and 100000 then (v_r->>'fee_jpy')::integer else 0 end;
end;
$$;
revoke execute on function banto_fee_rule(jsonb, integer) from public, anon, authenticated;

-- 代引き手数料（0157 を差し替え。読み方は banto_fee_rule と共通、答えは変えない）
create or replace function banto_cod_fee(p_settings jsonb, p_amount integer)
returns integer
language sql
immutable
as $$
  select banto_fee_rule(p_settings->'cod', p_amount);
$$;
revoke execute on function banto_cod_fee(jsonb, integer) from public, anon, authenticated;

-- 支払い方法の手数料。p_method が 'komoju:<種類>' で settings.payment_fees.<種類> に決まりがあればその手数料（使えなければ null）、
-- それ以外（決まりの無い種類・KOMOJU 以外）は 0。src/commerce/payment-fees.ts の komojuFee と同じ
create or replace function banto_payment_fee(p_settings jsonb, p_method text, p_amount integer)
returns integer
language plpgsql
immutable
as $$
declare v_rule jsonb;
begin
  if p_amount is null or p_amount < 0 then return null; end if;
  if p_method is null or p_method !~ '^komoju:[a-z_]{1,40}$' then return 0; end if;
  if jsonb_typeof(p_settings->'payment_fees') is distinct from 'object' then return 0; end if;
  v_rule := p_settings->'payment_fees'->substr(p_method, 8);
  if jsonb_typeof(v_rule) is distinct from 'object' then return 0; end if;
  return banto_fee_rule(v_rule, p_amount);
end;
$$;
revoke execute on function banto_payment_fee(jsonb, text, integer) from public, anon, authenticated;

-- 予約の手数料をショップの決まりで確かめる（値引きを付けた後、決済ページを作る前に Worker が呼ぶ）。違えば amount_mismatch
create or replace function reservation_payment_fee_check(p_reservation_id uuid, p_shop_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_res reservations%rowtype; v_settings jsonb; v_amount integer; v_fee integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_payment_fee_check: service_role only' using errcode = '42501';
  end if;
  select * into v_res from reservations where id = p_reservation_id and shop_id = p_shop_id and status = 'pending' for update;
  if not found then raise exception 'reservation_not_found' using detail = p_reservation_id::text; end if;
  if coalesce(v_res.payment_method, '') !~ '^komoju:[a-z_]{1,40}$' then
    raise exception 'amount_mismatch' using detail = 'payment_method';
  end if;
  select settings into v_settings from shops where id = p_shop_id;
  select greatest(0, coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0) + v_res.shipping_jpy - v_res.discount_jpy)
    into v_amount from jsonb_array_elements(v_res.items) e;
  v_fee := banto_payment_fee(v_settings, v_res.payment_method, v_amount);
  if v_fee is null or v_fee <> v_res.fee_jpy then
    raise exception 'amount_mismatch' using detail = format('payment_fee=%s expected=%s', v_res.fee_jpy, coalesce(v_fee::text, 'unavailable'));
  end if;
  update reservations set fee_checked = true where id = p_reservation_id;
  return v_fee;
end;
$$;
revoke execute on function reservation_payment_fee_check(uuid, uuid) from public, anon, authenticated;
grant execute on function reservation_payment_fee_check(uuid, uuid) to service_role;

-- お客様の画面に渡す settings の鍵に payment_fees（レジが手数料を出すため。0165 を差し替え）
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent', 'page_layouts', 'cod',
                                'checkout_members_only', 'payment_fees')), '{}'::jsonb)
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

-- 予約に選んだ支払い方法を付ける（0170。0157 を差し替え）
create or replace function attach_reservation_customer(p_reservation_id uuid, p_shop_id uuid, p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shipping integer; v_customer_id uuid; v_fee integer; v_method text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'attach_reservation_customer: service_role only' using errcode = '42501';
  end if;
  v_shipping := coalesce((p_customer->>'shipping_jpy')::integer, 0);
  if v_shipping < 0 then raise exception 'invalid_shipping'; end if;
  -- 代引き手数料（0157）。確定のとき confirm_reservation がショップの設定から引き直して確かめる
  v_fee := coalesce((p_customer->>'fee_jpy')::integer, 0);
  if v_fee < 0 then raise exception 'invalid_fee'; end if;
  -- 選んだ支払い方法（0170。KOMOJU は komoju か komoju:<種類>）。手数料の確かめ（reservation_payment_fee_check）は値引きを付けた後
  v_method := nullif(btrim(coalesce(p_customer->>'payment_method', '')), '');
  if v_method is not null and v_method !~ '^[a-z_]{1,40}(:[a-z_]{1,40})?$' then raise exception 'invalid_payment_method'; end if;
  v_customer_id := nullif(p_customer->>'customer_id', '')::uuid;
  if v_customer_id is not null and not exists (
       select 1 from customers where shop_id = p_shop_id and id = v_customer_id
          and session_epoch = coalesce(nullif(p_customer->>'customer_epoch', '')::integer, -1)) then
    raise exception 'member_session_invalid';
  end if;
  update reservations
     set customer = p_customer - 'shipping_jpy' - 'fee_jpy' - 'payment_method' - 'customer_id' - 'customer_epoch',
         shipping_jpy = v_shipping,
         fee_jpy = v_fee,
         payment_method = v_method,
         fee_checked = false,
         customer_id = v_customer_id
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending';
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
end;
$$;

-- 注文の確定: 支払い方法の手数料（0170。0157 を差し替え）
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
  -- 支払い方法の手数料（0170）: 代金引換のほかは、KOMOJU の種類（komoju:<種類>）を選んで、値引きを付けた後に
  -- reservation_payment_fee_check がショップの決まりで確かめた予約だけ（確定までのあいだに決まりを変えても、払った人を返金にしない）
  if v_res.fee_jpy <> 0 and not v_cod then
    if coalesce(p_order->>'payment_provider', '') <> 'komoju' or coalesce(v_res.payment_method, '') !~ '^komoju:[a-z_]{1,40}$' or not v_res.fee_checked then
      raise exception 'amount_mismatch' using detail = 'fee_unchecked';
    end if;
  end if;
  -- 種類を選んだ予約（komoju:<種類>）は、手数料が 0 でも確かめた予約だけ（Worker の古い設定で 0 と計算したあいだに手数料を足したとき）
  if not v_cod and coalesce(v_res.payment_method, '') ~ '^komoju:[a-z_]{1,40}$' and not v_res.fee_checked then
    raise exception 'amount_mismatch' using detail = 'fee_unchecked';
  end if;
  -- 決済ページは選んだ種類だけに絞って作る（0170）。決済事業者が知らせた種類（KOMOJU の payment_details.type）が違えば確定しない
  if coalesce(p_order->>'payment_provider', '') = 'komoju' and coalesce(v_res.payment_method, '') ~ '^komoju:[a-z_]{1,40}$'
     and coalesce(p_order->>'payment_type', '') <> '' and p_order->>'payment_type' <> substr(v_res.payment_method, 8) then
    raise exception 'amount_mismatch' using detail = format('payment_type=%s expected=%s', left(p_order->>'payment_type', 40), substr(v_res.payment_method, 8));
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
    -- 同じ人・同じ IP の未入金の代金引換の注文の数（直近 30 日、取り消しを除く）。代金引換はその場で確定して予約が pending で残らず、
    -- reserve_stock の上限（未確定の予約の数）が効かないので、ここで数える（数えてから入れるまでを直列にする）。
    -- 上限は settings.checkout.max_cod_unpaid_per_customer（既定 3）/ max_cod_unpaid_per_ip（既定 10）
    if v_res.subject_hash is not null then
      perform pg_advisory_xact_lock(hashtextextended('cod|' || p_shop_id::text || '|' || v_res.subject_hash, 0));
      if (select count(*) from orders o join reservations r on r.id = o.reservation_id
           where o.shop_id = p_shop_id and r.subject_hash = v_res.subject_hash and o.payment_provider = 'cod'
             and o.payment_status = 'unpaid' and o.status::text <> 'cancelled' and o.created_at > now() - interval '30 days')
         >= banto_shop_limit(p_shop_id, 'checkout', 'max_cod_unpaid_per_customer', 3) then
        raise exception 'too_many_reservations' using detail = 'cod_customer';
      end if;
    end if;
    if v_res.ip_hash is not null then
      perform pg_advisory_xact_lock(hashtextextended('cod-ip|' || p_shop_id::text || '|' || v_res.ip_hash, 0));
      if (select count(*) from orders o join reservations r on r.id = o.reservation_id
           where o.shop_id = p_shop_id and r.ip_hash = v_res.ip_hash and o.payment_provider = 'cod'
             and o.payment_status = 'unpaid' and o.status::text <> 'cancelled' and o.created_at > now() - interval '30 days')
         >= banto_shop_limit(p_shop_id, 'checkout', 'max_cod_unpaid_per_ip', 10) then
        raise exception 'too_many_reservations' using detail = 'cod_ip';
      end if;
    end if;
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

-- 設定の鍵 payment_fees は項目 settings（banto_shop_settings_perm の表に無い鍵は null = settings。差し替えない）

insert into banto_migrations (version) values ('0170_payment_fees');
