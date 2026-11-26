-- 0180: KOMOJU の支払いに戻る（メンテナの決定 2026-11-26、docs/plugins.md「KOMOJU のお支払いに戻る」）。
--   KOMOJU の決済ページ（Session）から手続きをせずに戻ったお客様が、完了画面・会員ページからお支払いに戻れるように、
--   予約に決済ページの ID を残す。決済ページは最長 24 時間で期限が切れ、予約（既定 72 時間）より短いので、期限が切れていれば
--   Worker が同じ予約・同じ金額・同じ種類で作り直し、ここで入れ替える（前の値と同じときだけ。二度押しで 2 つの決済ページを生かさない）。
--   - reservations.payment_session: {provider: 'komoju', id, types}（決済ページの ID と、作ったときの支払いの種類。URL は持たない、押したときに引き直す）
--   - reservation_set_payment_session: 書くのは service_role だけ。未確定（pending）の予約だけ
--   - reservation_payment_get: 照会トークンの quote か、会員（世代を確かめる）の予約 id で引く。金額は予約から計算する
--   - checkout_status: 戻れるか（resumable）を足す
--   - member_get: 会員ページの「お支払いが済んでいないお申し込み」（pending_payments）を足す（往復を増やさない）

alter table reservations add column if not exists payment_session jsonb
  check (payment_session is null or (
    jsonb_typeof(payment_session) = 'object'
    and payment_session->>'provider' = 'komoju'
    and coalesce(payment_session->>'id', '') ~ '^[A-Za-z0-9_-]{1,100}$'
    and (payment_session->'types' is null or jsonb_typeof(payment_session->'types') = 'array')
  ));

-- 会員ページの一覧（member_get の pending_payments）を、ショップの未確定の予約をなめずに会員で引く
create index if not exists reservations_customer_pending_idx on reservations (shop_id, customer_id) where status = 'pending' and payment_session is not null;

-- 予約の支払い総額。confirm_reservation（0170）が支払われた額と比べる額と同じ式（品目の単価 × 数量 + 送料 − 値引き、0 未満にしない、+ 手数料）。
-- 見せる額と、決済ページを作り直すときの額に使う
create or replace function banto_reservation_total(r reservations)
returns integer
language sql
stable
as $$
  select greatest(0, coalesce((select sum((i->>'qty')::integer * (i->>'unit_price_jpy')::integer) from jsonb_array_elements(r.items) i), 0)::integer
                     + coalesce(r.shipping_jpy, 0) - coalesce(r.discount_jpy, 0)) + coalesce(r.fee_jpy, 0);
$$;
revoke execute on function banto_reservation_total(reservations) from public, anon, authenticated;

-- 決済ページの ID を入れる・入れ替える。p_expected が今の ID と同じときだけ（最初は null）。入れたら true
create or replace function reservation_set_payment_session(p_reservation_id uuid, p_shop_id uuid, p_session jsonb, p_expected text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_set_payment_session: service_role only' using errcode = '42501';
  end if;
  update reservations set payment_session = p_session
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending'
     and (payment_session->>'id') is not distinct from p_expected;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke execute on function reservation_set_payment_session(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function reservation_set_payment_session(uuid, uuid, jsonb, text) to service_role;

-- 支払いに戻るための予約。照会トークンの quote（p_quote_id）か、会員の予約 id（p_reservation_id と会員・世代）で引く。
-- 返すのは状態・期限・決済ページ・金額・照会の quote だけ（個人情報は返さない）。見つからなければ null
create or replace function reservation_payment_get(p_shop_id uuid, p_quote_id text, p_reservation_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_payment_get: service_role only' using errcode = '42501';
  end if;
  if p_quote_id is not null then
    select * into v_r from reservations where shop_id = p_shop_id and quote_id = p_quote_id order by created_at desc limit 1;
  elsif p_reservation_id is not null and p_customer_id is not null then
    if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
    select * into v_r from reservations where shop_id = p_shop_id and id = p_reservation_id and customer_id = p_customer_id;
  end if;
  if v_r.id is null then return null; end if;
  return jsonb_build_object(
    'reservation_id', v_r.id,
    'status', case when exists (select 1 from orders where reservation_id = v_r.id) then 'confirmed'
                   when v_r.status::text = 'refunded' then 'released' else v_r.status::text end,
    'expires_at', v_r.expires_at,
    'quote_id', v_r.quote_id,
    'payment_session', v_r.payment_session,
    'payment_method', v_r.payment_method,
    'total_jpy', banto_reservation_total(v_r));
end;
$$;
revoke execute on function reservation_payment_get(uuid, text, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function reservation_payment_get(uuid, text, uuid, uuid, integer) to service_role;

-- 0142 と同じ。KOMOJU の決済ページのある未確定の予約は resumable（支払いに戻れる）
create or replace function checkout_status(p_shop_id uuid, p_quote_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r reservations%rowtype; v_o orders%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'checkout_status: service_role only' using errcode = '42501';
  end if;
  select * into v_r from reservations where shop_id = p_shop_id and quote_id = p_quote_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('status', 'not_found', 'order', null, 'expires_at', null); end if;
  select * into v_o from orders where reservation_id = v_r.id;
  if found then
    return jsonb_build_object('status', 'confirmed', 'expires_at', v_r.expires_at,
      'order', jsonb_build_object('number', v_o.number, 'status', v_o.status, 'total_jpy', v_o.total_jpy, 'payment_provider', v_o.payment_provider, 'created_at', v_o.created_at));
  end if;
  -- 返金して済んだ予約は、購入者には「成立しなかった」（released）と同じ
  return jsonb_build_object('status', case when v_r.status::text = 'refunded' then 'released' else v_r.status::text end, 'order', null, 'expires_at', v_r.expires_at,
    'resumable', v_r.status = 'pending' and v_r.payment_session is not null and v_r.expires_at > now());
end;
$$;
revoke execute on function checkout_status(uuid, text) from public, anon, authenticated;
grant execute on function checkout_status(uuid, text) to service_role;

-- 0176 と同じ。会員ページの「お支払いが済んでいないお申し込み」（pending_payments、KOMOJU の決済ページのある未確定の予約、新しい順に 10 件）を足す
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
                                   -- 0176: お知らせの受け取り方と、「LINE だけ」を選べるか（LINE と結びつき、ショップが LINE で知らせている）
                                   'notice_channel', v_c.notice_channel,
                                   'notice_line_available', banto_notice_line_ready(p_shop_id, v_c.id, null),
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null,
                                   'providers', coalesce((select jsonb_agg(provider order by provider) from member_identities
                                                           where shop_id = p_shop_id and customer_id = v_c.id), '[]'::jsonb)),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at, payment_status, fee_jpy, payment_provider
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end,
    'pending_payments', case when p_with_orders then coalesce((
      select jsonb_agg(p order by p.created_at desc) from (
        select r.id as reservation_id, r.created_at, r.expires_at, banto_reservation_total(r) as total_jpy, r.payment_method,
               (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(pr.name, '') || case when k.name is not null and k.name <> '' then ' / ' || k.name else '' end,
                                                             'qty', (i->>'qty')::integer)), '[]'::jsonb)
                  from jsonb_array_elements(r.items) i left join skus k on k.id = (i->>'sku_id')::uuid left join products pr on pr.id = k.product_id) as items
          from reservations r
         where r.shop_id = p_shop_id and r.customer_id = p_customer_id and r.status = 'pending'
           and r.payment_session is not null and r.expires_at > now()
           and not exists (select 1 from orders o where o.reservation_id = r.id)
         order by r.created_at desc limit 10) p), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;
revoke execute on function member_get(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function member_get(uuid, uuid, integer, boolean) to service_role;

insert into banto_migrations (version) values ('0180_payment_resume');
