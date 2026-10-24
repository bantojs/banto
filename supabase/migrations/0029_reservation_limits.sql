-- Banto 0029_reservation_limits: セキュリティ監査（2026-10-18 のコード監査）の段階 2 のうち DB で閉じる分
-- 前方専用。
--
--  H2  決済せずに在庫を押さえ続けられる → quote は 1 回限り（同じ quote で未確定・確定済みの予約が既にあれば拒む）、
--      同じ人（メールの HMAC）・同じ IP の未確定の予約の数に上限。お店で試着の申し込みも同じ人・同じ IP で上限
--  M7  Webhook が支払額・通貨を予約と照合しない → confirm_reservation が照合し、違えば amount_mismatch（Worker が返金して解放）
--  M8  他人のアドレスのログインを止められる → 発行の枠を「同じ IP からの申込み」と「アドレス全体」に分け、
--      新しいコードを出しても直近 3 つまでは有効のまま。照合の失敗はアドレスごとに 1 日 50 回まで
--  M10 ログインのメールがショップ全体で無制限 → ショップ単位の上限（1 時間 100 通・1 日 500 通。settings.members_login_limits で変更）

-- ---------- 予約に quote・申込者・IP を残す ----------
alter table reservations add column if not exists quote_id text check (quote_id is null or length(quote_id) between 8 and 64);
alter table reservations add column if not exists subject_hash text check (subject_hash is null or subject_hash ~ '^[0-9a-f]{64}$');
alter table reservations add column if not exists ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$');
-- 同じ quote から 2 つ目の生きた予約は作れない（解放された後の出し直しは許す）
create unique index if not exists reservations_quote_live on reservations (shop_id, quote_id) where quote_id is not null and status in ('pending', 'confirmed');
create index if not exists reservations_pending_subject on reservations (shop_id, subject_hash) where status = 'pending' and subject_hash is not null;
create index if not exists reservations_pending_ip on reservations (shop_id, ip_hash) where status = 'pending' and ip_hash is not null;

alter table tryon_requests add column if not exists ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$');
create index if not exists tryon_requests_open_email on tryon_requests (shop_id, customer_email) where status in ('requested', 'sent', 'ready');
create index if not exists tryon_requests_open_ip on tryon_requests (shop_id, ip_hash) where status in ('requested', 'sent', 'ready') and ip_hash is not null;

-- ショップごとの上限（settings.checkout.max_pending_per_customer / max_pending_per_ip、settings.store_tryon.max_open_per_customer / max_open_per_ip）
create or replace function banto_shop_limit(p_shop_id uuid, p_section text, p_key text, p_default integer)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when (s.settings->p_section->>p_key) ~ '^[0-9]{1,4}$' then (s.settings->p_section->>p_key)::integer end from shops s where s.id = p_shop_id),
    p_default);
$$;
revoke execute on function banto_shop_limit(uuid, text, text, integer) from public, anon, authenticated;

-- ---------- reserve_stock（0001 を差し替え: quote・同じ人・同じ IP の上限） ----------
drop function if exists reserve_stock(uuid, jsonb, integer);
create or replace function reserve_stock(p_shop_id uuid, p_items jsonb, p_ttl_seconds integer default 900,
                                         p_quote_id text default null, p_subject_hash text default null, p_ip_hash text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku_id uuid;
  v_qty integer;
  v_price integer;
  v_updated integer;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reserve_stock: service_role only' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_items';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_ttl';
  end if;

  -- 同じ quote で生きた予約があれば拒む（決済ページを開かずに在庫だけ押さえ続けるのを止める）
  if p_quote_id is not null and exists (select 1 from reservations where shop_id = p_shop_id and quote_id = p_quote_id and status in ('pending', 'confirmed')) then
    raise exception 'quote_already_used';
  end if;
  -- 同じ人・同じ IP の未確定の予約の数（数えてから入れるまでを直列にする）
  if p_subject_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation|' || p_shop_id::text || '|' || p_subject_hash, 0));
    if (select count(*) from reservations where shop_id = p_shop_id and subject_hash = p_subject_hash and status = 'pending')
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_customer', 3) then
      raise exception 'too_many_reservations' using detail = 'customer';
    end if;
  end if;
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation-ip|' || p_shop_id::text || '|' || p_ip_hash, 0));
    if (select count(*) from reservations where shop_id = p_shop_id and ip_hash = p_ip_hash and status = 'pending')
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_ip', 20) then
      raise exception 'too_many_reservations' using detail = 'ip';
    end if;
  end if;

  -- sku_id 順に処理し、複数予約が同じ SKU 群を逆順でロックしてデッドロックするのを防ぐ
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku_id := (v_item->>'sku_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_sku_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'invalid_item' using detail = coalesce(v_item::text, 'null');
    end if;

    select k.price_jpy into v_price
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = k.shop_id
     where k.id = v_sku_id and k.shop_id = p_shop_id and p.published and s.published;
    if not found then
      raise exception 'sku_not_available' using detail = v_sku_id::text;
    end if;

    update inventory
       set available = available - v_qty, updated_at = now()
     where sku_id = v_sku_id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'insufficient_stock' using detail = v_sku_id::text;
    end if;

    v_items := v_items || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'unit_price_jpy', v_price);
  end loop;

  insert into reservations (shop_id, items, expires_at, quote_id, subject_hash, ip_hash)
  values (p_shop_id, v_items, now() + make_interval(secs => p_ttl_seconds), p_quote_id, p_subject_hash, p_ip_hash)
  returning id into v_reservation_id;

  return v_reservation_id;
end;
$$;
revoke execute on function reserve_stock(uuid, jsonb, integer, text, text, text) from public, anon, authenticated;
grant execute on function reserve_stock(uuid, jsonb, integer, text, text, text) to service_role;

-- ---------- confirm_reservation（0010 を差し替え: 支払額・通貨の照合） ----------
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

  -- 決済事業者が受け取った額・通貨が Banto の計算と違えば確定しない（在庫は動かさない。Worker が返金して解放する）
  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0)
    into v_subtotal
    from jsonb_array_elements(v_res.items) e;
  v_total := greatest(0, v_subtotal + v_res.shipping_jpy - v_res.discount_jpy);
  v_paid := case when (p_order->>'amount_paid_jpy') ~ '^-?[0-9]{1,9}$' then (p_order->>'amount_paid_jpy')::integer end;
  if v_paid is not null and v_paid <> v_total then
    raise exception 'amount_mismatch' using detail = format('paid=%s expected=%s', v_paid, v_total);
  end if;
  if coalesce(p_order->>'currency', 'jpy') !~* '^jpy$' then
    raise exception 'amount_mismatch' using detail = format('currency=%s', p_order->>'currency');
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
    for v_r in select id, campaign_id from coupon_redemptions where reservation_id = p_reservation_id and status = 'released' loop
      update coupon_slots set status = 'held', reservation_id = p_reservation_id
       where id = (select id from coupon_slots where campaign_id = v_r.campaign_id and status = 'free' limit 1 for update skip locked)
      returning id into v_slot;
      update coupon_redemptions set status = 'held', slot_id = v_slot where id = v_r.id;
    end loop;
  end if;

  update shops set order_seq = order_seq + 1 where id = p_shop_id returning order_seq into v_number;

  insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, discount_jpy, discounts, amount_paid_jpy, number, customer_id,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref)
  values (p_shop_id, p_reservation_id, 'paid', v_total, v_res.shipping_jpy, v_res.discount_jpy, v_res.discounts,
          v_paid, v_number, v_res.customer_id,
          coalesce(v_res.customer->>'customer_email', p_order->>'customer_email'),
          coalesce(v_res.customer->>'customer_name', p_order->>'customer_name'),
          coalesce(v_res.customer->'shipping_address', p_order->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref')
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

-- ---------- tryon_request（0025 を差し替え: 同じ人・同じ IP の開いている申し込みの上限。IP は p_customer.ip_hash で受ける） ----------
create or replace function tryon_request(p_shop_id uuid, p_store_id uuid, p_items jsonb, p_customer jsonb, p_visit_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it jsonb; v_sku skus%rowtype; v_qty integer; v_n integer; v_id uuid; v_number integer; v_cid uuid; v_total integer := 0;
  v_email text; v_ip text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_request: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and published) then raise exception 'shop_not_found'; end if;
  if not exists (select 1 from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = p_shop_id and ss.store_id = p_store_id and ss.tryon and st.active) then
    raise exception 'store_not_available';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then raise exception 'invalid_items'; end if;
  if position('@' in coalesce(p_customer->>'customer_email', '')) < 2 then raise exception 'invalid_customer'; end if;
  v_email := lower(btrim(p_customer->>'customer_email'));
  v_ip := case when (p_customer->>'ip_hash') ~ '^[0-9a-f]{64}$' then p_customer->>'ip_hash' end;
  v_cid := nullif(p_customer->>'customer_id', '')::uuid;
  if v_cid is not null and not exists (select 1 from customers where shop_id = p_shop_id and id = v_cid) then v_cid := null; end if;

  perform pg_advisory_xact_lock(hashtextextended('tryon|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from tryon_requests where shop_id = p_shop_id and customer_email = v_email and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_customer', 3) then
    raise exception 'too_many_requests' using detail = 'customer';
  end if;
  if v_ip is not null and (select count(*) from tryon_requests where shop_id = p_shop_id and ip_hash = v_ip and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_ip', 10) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;

  update shops set tryon_seq = tryon_seq + 1 where id = p_shop_id returning tryon_seq into v_number;
  insert into tryon_requests (shop_id, store_id, number, visit_date, customer_id, customer_email, customer_name, customer_phone, note, ip_hash)
  values (p_shop_id, p_store_id, v_number, p_visit_date, v_cid, v_email,
          left(nullif(btrim(coalesce(p_customer->>'customer_name', '')), ''), 100), left(nullif(btrim(coalesce(p_customer->>'customer_phone', '')), ''), 20),
          left(nullif(btrim(coalesce(p_customer->>'note', '')), ''), 500), v_ip)
  returning id into v_id;

  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_qty := case when coalesce(v_it->>'qty', '') ~ '^[0-9]{1,2}$' then (v_it->>'qty')::integer else 0 end;
    if v_qty <= 0 then raise exception 'invalid_items'; end if;
    select k.* into v_sku from skus k join products p on p.id = k.product_id
     where k.id = nullif(v_it->>'sku_id', '')::uuid and k.shop_id = p_shop_id and p.published;
    if not found then raise exception 'sku_not_available'; end if;
    update inventory set available = available - v_qty where sku_id = v_sku.id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'insufficient_stock' using detail = v_sku.id::text; end if;
    insert into tryon_items (shop_id, request_id, sku_id, qty, unit_price_jpy) values (p_shop_id, v_id, v_sku.id, v_qty, v_sku.price_jpy);
    v_total := v_total + v_qty;
  end loop;
  if v_total > 20 then raise exception 'invalid_items'; end if;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.requested',
    jsonb_build_object('request_id', v_id, 'number', v_number, 'shop_id', p_shop_id, 'store_id', p_store_id, 'status', 'requested',
                       'visit_date', p_visit_date, 'customer_id', v_cid));
  return jsonb_build_object('id', v_id, 'number', v_number);
end;
$$;

-- ---------- member_login_start（0012 を差し替え: 枠の分離・ショップ単位の上限・直近 3 つまで有効） ----------
create or replace function member_login_start(p_shop_id uuid, p_email text, p_code_hash text, p_link_hash text, p_ip_hash text, p_return_to text, p_ttl_seconds integer default 900)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_from text;
  v_id uuid;
  v_limited boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_start: service_role only' using errcode = '42501';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    raise exception 'members_disabled';
  end if;
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  if v_from is null then raise exception 'mail_not_configured'; end if;

  perform pg_advisory_xact_lock(hashtextextended('member_login|' || p_shop_id::text || '|' || v_email, 0));
  if p_ip_hash is not null then
    -- 同じ IP から同じアドレスへ: 15 分に 3 回・1 日 10 回（他人が被害者の枠を使い切れないように、IP ごとに分ける）
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 3
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '1 day') >= 10
              -- 同じ IP から誰へでも: 1 時間に 30 回
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30;
  else
    -- IP が分からない（Node でヘッダー未設定）: アドレスだけで数える
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5;
  end if;
  -- アドレス全体: 1 日 30 通（メール爆撃の上限）。ショップ全体: 1 時間・1 日の上限（送信元の評判と Resend の枠を守る）
  v_limited := v_limited
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '1 day') >= 30
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_hour', 100)
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and created_at > now() - interval '1 day')
       >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_day', 500);
  if v_limited then
    return jsonb_build_object('send', false, 'challenge_id', gen_random_uuid(), 'mail_from', v_from);
  end if;

  -- 直近 3 つまで有効（新しいコードを出しても、届いたばかりの前のコードが無効にならない）。それより古いものは無効にする
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email = v_email and consumed_at is null
     and id not in (select id from member_login_challenges where shop_id = p_shop_id and email = v_email and consumed_at is null order by created_at desc limit 2);
  insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, return_to, expires_at)
  values (p_shop_id, v_email, p_code_hash, p_link_hash, p_ip_hash, nullif(left(p_return_to, 500), ''),
          now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 900), 3600))))
  returning id into v_id;
  return jsonb_build_object('send', true, 'challenge_id', v_id, 'mail_from', v_from);
end;
$$;

-- 全体で 1 日の照合の失敗がアドレスごとに 50 回を超えたら、どのチャレンジも通らない（有効なチャレンジが 3 つになった分の歯止め）
create index if not exists member_login_challenges_email_day on member_login_challenges (shop_id, email, created_at) include (attempts);

create or replace function member_login_verify(p_shop_id uuid, p_challenge_id uuid, p_code_hash text, p_link_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch member_login_challenges%rowtype;
  v_customer customers%rowtype;
  v_created boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_verify: service_role only' using errcode = '42501';
  end if;
  select * into v_ch from member_login_challenges where id = p_challenge_id and shop_id = p_shop_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_ch.consumed_at is not null or v_ch.expires_at < now() or v_ch.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if (select coalesce(sum(attempts), 0) from member_login_challenges where shop_id = p_shop_id and email = v_ch.email and created_at > now() - interval '1 day') >= 50 then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not ((p_code_hash is not null and v_ch.code_hash = p_code_hash) or (p_link_hash is not null and v_ch.link_hash = p_link_hash)) then
    update member_login_challenges
       set attempts = attempts + 1,
           consumed_at = case when attempts + 1 >= 5 then now() else consumed_at end
     where id = v_ch.id;
    return jsonb_build_object('ok', false, 'reason', case when v_ch.attempts + 1 >= 5 then 'expired' else 'invalid' end);
  end if;
  update member_login_challenges set consumed_at = now() where id = v_ch.id;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select * into v_customer from customers where shop_id = p_shop_id and lower(email) = v_ch.email;
  if not found then
    insert into customers (shop_id, email) values (p_shop_id, v_ch.email)
    on conflict (shop_id, lower(email)) where email is not null do nothing
    returning * into v_customer;
    if v_customer.id is null then
      select * into v_customer from customers where shop_id = p_shop_id and lower(email) = v_ch.email;
    else
      v_created := true;
    end if;
  end if;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_customer.id;
  return jsonb_build_object('ok', true, 'customer_id', v_customer.id, 'session_epoch', v_customer.session_epoch,
                            'email', v_customer.email, 'created', v_created, 'return_to', v_ch.return_to);
end;
$$;

insert into banto_migrations (version) values ('0029_reservation_limits');
