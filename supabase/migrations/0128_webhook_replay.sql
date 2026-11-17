-- 0128_webhook_replay: Webhook の再配信で、返金済みの決済が注文にならないようにする（docs/upgrade.md「変更ごとの注意」）。
--
-- 今までは「処理に成功したイベントだけ record_webhook_event に記録する」だけで、記録済みかを処理の前に見ていなかった。
-- 解放済みの予約の確定に失敗して返金したイベントが再配信されると（Stripe の再送・KOMOJU の署名には時刻が無い）、そのあいだに
-- 在庫が戻っていれば confirm_reservation が通り、返金済みなのに注文（paid）ができた。
--
-- 1. webhook_event_seen: 記録済みのイベントか（Worker は処理の前に見て、記録済みなら何もしない）
-- 2. reservations.status に 'refunded' を足す。reservation_mark_refunded は「返金すると決めた」ことを返金の前に DB に残す
--    （pending なら在庫とクーポンの枠も戻す）。どのイベントで決めたか（refund_event = provider:event_id）も残す
-- 3. confirm_reservation は refunded の予約を reservation_refunded で拒む（detail に refund_event）。
--    Worker は同じイベントの再送なら返金をやり直し（冪等キーはイベント ID）、別のイベントなら何もしない

-- ---------- 1. 記録済みのイベントか ----------
create or replace function webhook_event_seen(p_provider text, p_event_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'webhook_event_seen: service_role only' using errcode = '42501';
  end if;
  return exists (select 1 from webhook_events where provider = p_provider and event_id = p_event_id);
end;
$$;
revoke execute on function webhook_event_seen(text, text) from public, anon, authenticated;
grant execute on function webhook_event_seen(text, text) to service_role;

-- ---------- 2. 返金すると決めた予約 ----------
alter type reservation_status add value if not exists 'refunded';
alter table reservations add column if not exists refund_event text check (refund_event is null or length(refund_event) between 3 and 300);

-- 返す値: marked（今決めた。呼び出し側が返金する）/ same_event（同じイベントで決めてある。返金をやり直してよい）/
-- other_event（別のイベントで決めてある。返金しない）。確定済みの予約は reservation_confirmed（呼び出し側は 500 で再送させ、次は確定が返る）
create or replace function reservation_mark_refunded(p_reservation_id uuid, p_shop_id uuid, p_provider text, p_event_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_event text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_mark_refunded: service_role only' using errcode = '42501';
  end if;
  if coalesce(p_provider, '') = '' or coalesce(p_event_id, '') = '' then
    raise exception 'invalid_event';
  end if;
  v_event := left(p_provider || ':' || p_event_id, 300);
  select * into v_res from reservations where id = p_reservation_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
  if v_res.status = 'refunded' then
    return case when v_res.refund_event = v_event then 'same_event' else 'other_event' end;
  end if;
  if v_res.status = 'confirmed' then
    raise exception 'reservation_confirmed' using detail = p_reservation_id::text;
  end if;
  -- 生きている予約なら在庫とクーポンの枠を戻す（支払額の不一致で返金するとき）
  if v_res.status = 'pending' then
    perform release_reservation(p_reservation_id, p_shop_id);
  end if;
  update reservations set status = 'refunded', refund_event = v_event, customer = null where id = p_reservation_id;
  return 'marked';
end;
$$;
revoke execute on function reservation_mark_refunded(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function reservation_mark_refunded(uuid, uuid, text, text) to service_role;

-- ---------- 3. confirm_reservation（0090 の差し替え: refunded を拒む） ----------
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
  v_total := greatest(0, v_subtotal + v_res.shipping_jpy - v_res.discount_jpy);
  if coalesce(p_order->>'amount_paid_jpy', '') !~ '^-?[0-9]{1,9}$' then
    raise exception 'amount_mismatch' using detail = format('paid=%s expected=%s', coalesce(p_order->>'amount_paid_jpy', 'null'), v_total);
  end if;
  v_paid := (p_order->>'amount_paid_jpy')::integer;
  if v_paid <> v_total then
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
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref, payment_account)
  values (p_shop_id, p_reservation_id, 'paid', v_total, v_res.shipping_jpy, v_res.discount_jpy, v_res.discounts,
          v_paid, v_number, v_res.customer_id,
          coalesce(v_res.customer->>'customer_email', p_order->>'customer_email'),
          coalesce(v_res.customer->>'customer_name', p_order->>'customer_name'),
          coalesce(v_res.customer->'shipping_address', p_order->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref',
          nullif(left(btrim(coalesce(p_order->>'payment_account', '')), 200), ''))
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer, coalesce((e->>'discount_jpy')::integer, 0)
    from jsonb_array_elements(v_res.items) e;

  update coupon_slots set status = 'used' where reservation_id = p_reservation_id and status = 'held';
  update coupon_redemptions set status = 'used', order_id = v_order_id where reservation_id = p_reservation_id and status = 'held';
  update reservations set status = 'confirmed', customer = null where id = p_reservation_id;

  v_payload := jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_number, 'shop_id', p_shop_id,
    'subtotal_jpy', v_subtotal, 'shipping_jpy', v_res.shipping_jpy, 'discount_jpy', v_res.discount_jpy, 'total_jpy', v_total,
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

insert into banto_migrations (version) values ('0128_webhook_replay');
