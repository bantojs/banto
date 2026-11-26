-- 0181: お支払いのお願い（メンテナの決定 2026-11-26、docs/plugins.md「KOMOJU のお支払いのお願い」）。
--   KOMOJU の決済ページのある未確定の予約（0180）に、作ってから 24 時間たってもお支払いが無ければ 1 回だけ「お支払いのお願い」を送る。
--   - ショップの設定 shops.settings.payment_reminder（true で送る、既定 OFF。鍵は項目 settings = banto_shop_settings_perm の既定）
--   - Cron の enqueue_payment_reminders が拾って reminded_at を付け、hooks checkout.payment_pending を積む（ペイロードは予約・会員の ID と期限だけ）
--   - 送るのは同梱の「メール通知」と「LINE で購入者に知らせる」（外部プラグインでもよい）。中身は service_role の reservation_reminder_contact /
--     reservation_line_recipient で読む（もう確定・解放した予約は null = 送らない）
--   - 「LINE だけ」を選んだ会員（0176）には LINE だけ（hooks を積むときの印）。届かなければメールへ配り直す仕組みもそのまま
--   - 文面はショップが直せる（0154 の知らせの種類 payment_reminder）。リンク（payment_link）は必ず入れる
--   - リンクの先は予約の id を署名した券（期限は予約の期限）の画面で、0180 の「お支払いに進む・取りやめる」と同じ判定。そのため reservation_payment_get に
--     予約の id だけで引く口を足す（Worker が券を確かめてから呼ぶ）

alter table reservations add column if not exists reminded_at timestamptz;

-- 知らせの種類に payment_reminder を足す
alter table shop_notice_texts drop constraint if exists shop_notice_texts_kind_check;
alter table shop_notice_texts add constraint shop_notice_texts_kind_check
  check (kind in ('order_paid', 'order_shipped', 'tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled', 'payment_reminder'));

-- 0179 と同じ。payment_reminder（メール・LINE）を足す
create or replace function banto_notice_spec(p_kind text, p_channel text)
returns jsonb
language sql
immutable
as $$
  select case
    when p_channel = 'mail' and p_kind in ('order_paid', 'order_shipped') then jsonb_build_object(
      'subject_allowed', '["shop_name","customer_name","number","total"]'::jsonb,
      'subject_required', '["number"]'::jsonb,
      'body_allowed', case when p_kind = 'order_shipped'
                           then '["shop_name","customer_name","number","total","order_details","tracking","return_policy","order_link","contact"]'::jsonb
                           else '["shop_name","customer_name","number","total","order_details","return_policy","order_link","contact"]'::jsonb end,
      'body_required', case when p_kind = 'order_shipped' then '["order_details","tracking"]'::jsonb else '["order_details"]'::jsonb end,
      'once', '["order_details","tracking"]'::jsonb)
    when p_channel = 'line' and p_kind in ('order_paid', 'order_shipped') then jsonb_build_object(
      'body_allowed', case when p_kind = 'order_shipped'
                           then '["shop_name","number","total","tracking","order_link"]'::jsonb
                           else '["shop_name","number","total","order_link"]'::jsonb end,
      'body_required', '["number"]'::jsonb,
      'once', case when p_kind = 'order_shipped' then '["tracking"]'::jsonb else '[]'::jsonb end)
    -- 0181: お支払いのお願い（KOMOJU の未払いの予約、翌日に 1 回）。リンク（payment_link）は必ず入れる。メールに氏名、LINE には載せない
    when p_channel = 'mail' and p_kind = 'payment_reminder' then jsonb_build_object(
      'subject_allowed', '["shop_name","customer_name","total","pay_until"]'::jsonb,
      'subject_required', '[]'::jsonb,
      'body_allowed', '["shop_name","customer_name","total","pay_until","items","payment_link","contact"]'::jsonb,
      'body_required', '["payment_link"]'::jsonb,
      'once', '["items","payment_link"]'::jsonb)
    when p_channel = 'line' and p_kind = 'payment_reminder' then jsonb_build_object(
      'body_allowed', '["shop_name","total","pay_until","payment_link"]'::jsonb,
      'body_required', '["payment_link"]'::jsonb,
      'once', '["payment_link"]'::jsonb)
    when p_channel = 'mail' and p_kind in ('tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled') then jsonb_build_object(
      'subject_allowed', case when p_kind in ('tryon_requested', 'tryon_cancelled')
                              then '["shop_name","customer_name","number","store_name"]'::jsonb
                              else '["shop_name","customer_name","number","store_name","hold_until"]'::jsonb end,
      'subject_required', '["number"]'::jsonb,
      'body_allowed', case p_kind
                        when 'tryon_requested' then '["shop_name","customer_name","number","store_name","visit","items","store_info","contact","shop_link"]'::jsonb
                        when 'tryon_cancelled' then '["shop_name","customer_name","number","store_name","contact","shop_link"]'::jsonb
                        else '["shop_name","customer_name","number","store_name","hold_until","items","store_info","contact","shop_link"]'::jsonb end,
      'body_required', case p_kind
                         when 'tryon_requested' then '["items","store_info"]'::jsonb
                         when 'tryon_cancelled' then '["number"]'::jsonb
                         else '["hold_until","items","store_info"]'::jsonb end,
      'once', '["items","store_info"]'::jsonb)
    when p_channel = 'line' and p_kind in ('tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled') then jsonb_build_object(
      'body_allowed', case when p_kind in ('tryon_requested', 'tryon_cancelled')
                           then '["shop_name","number","store_name"]'::jsonb
                           else '["shop_name","number","store_name","hold_until"]'::jsonb end,
      'body_required', case when p_kind in ('tryon_requested', 'tryon_cancelled') then '["number"]'::jsonb else '["number","hold_until"]'::jsonb end,
      'once', '[]'::jsonb)
  end;
$$;
revoke execute on function banto_notice_spec(text, text) from public, anon, authenticated;

-- 0176 と同じ。checkout.payment_pending も「LINE だけ」の印の対象（予約の会員）
create or replace function banto_notice_line_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_customer uuid;
begin
  if new.event not in ('order.created', 'order.paid', 'order.shipped', 'tryon.requested', 'tryon.updated', 'checkout.payment_pending')
     or new.payload ? 'notice_line_only' or new.payload ? 'fallback_of' then
    return new;
  end if;
  -- order.created で知らせるのは未入金の注文（代金引換）の受付だけ（入金済みは order.paid）
  if new.event = 'order.created' and coalesce(new.payload->>'payment_status', '') <> 'unpaid' then return new; end if;
  -- 先に安い確かめ: このショップの「LINE で購入者に知らせる」が有効でこの出来事を受け取るか（ほとんどのショップ・ゲストはここで終わる）
  if not exists (select 1 from hook_endpoints e where e.shop_id = new.shop_id and e.enabled
                  and e.url = 'https://banto.invalid/plugins/line_buyer_notify' and new.event = any(e.events)) then
    return new;
  end if;
  if new.event = 'checkout.payment_pending' then
    -- 0181: お支払いのお願い。予約の会員（ゲストは印を付けない）
    if coalesce(new.payload->>'reservation_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
    select r.customer_id into v_customer from reservations r where r.id = (new.payload->>'reservation_id')::uuid and r.shop_id = new.shop_id;
  elsif new.event like 'order.%' then
    if coalesce(new.payload->>'order_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
    select o.customer_id into v_customer from orders o where o.id = (new.payload->>'order_id')::uuid and o.shop_id = new.shop_id;
  else
    if coalesce(new.payload->>'request_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
    select r.customer_id into v_customer from tryon_requests r where r.id = (new.payload->>'request_id')::uuid and r.shop_id = new.shop_id;
  end if;
  if v_customer is not null and banto_notice_line_only(new.shop_id, v_customer, new.event) then
    new.payload := new.payload || jsonb_build_object('notice_line_only', true);
  end if;
  return new;
end;
$$;
revoke execute on function banto_notice_line_mark() from public, anon, authenticated, service_role;

-- Cron: 24 時間たった未払いの KOMOJU の予約に 1 回だけ checkout.payment_pending を積む。積んだ数を返す。
-- 予約の期限まで 1 時間を切ったものは送らない（開いたときにはもう払えない）
create or replace function enqueue_payment_reminders(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r record; v_n integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'enqueue_payment_reminders: service_role only' using errcode = '42501';
  end if;
  for v_r in
    select r.id, r.shop_id, r.customer_id, r.expires_at
      from reservations r join shops s on s.id = r.shop_id
     where r.status = 'pending' and r.payment_session is not null and r.reminded_at is null
       and r.created_at <= now() - interval '24 hours' and r.expires_at > now() + interval '1 hour'
       and s.settings->>'payment_reminder' = 'true'
       and not exists (select 1 from orders o where o.reservation_id = r.id)
     order by r.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 500))
       for update of r skip locked
  loop
    update reservations set reminded_at = now() where id = v_r.id;
    perform banto_enqueue_hook_internal(v_r.shop_id, 'checkout.payment_pending', jsonb_build_object(
      'reservation_id', v_r.id, 'shop_id', v_r.shop_id, 'expires_at', v_r.expires_at)
      || case when v_r.customer_id is not null then jsonb_build_object('customer_id', v_r.customer_id) else '{}'::jsonb end);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function enqueue_payment_reminders(integer) from public, anon, authenticated;
grant execute on function enqueue_payment_reminders(integer) to service_role;

-- メールで送る中身（予約がまだ払えるときだけ。確定・解放・期限切れは null = 送らない）。宛先は予約に一時保持したアドレス
create or replace function reservation_reminder_contact(p_reservation_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r reservations%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_reminder_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_r from reservations where id = p_reservation_id and shop_id = p_shop_id;
  if not found or v_r.status <> 'pending' or v_r.payment_session is null or v_r.expires_at <= now()
     or exists (select 1 from orders o where o.reservation_id = v_r.id)
     or coalesce(v_r.customer->>'customer_email', '') = '' then
    return null;
  end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'reservation_id', v_r.id, 'expires_at', v_r.expires_at, 'total_jpy', banto_reservation_total(v_r),
    'customer_email', v_r.customer->>'customer_email', 'customer_name', v_r.customer->>'customer_name',
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(pr.name, '') || case when k.name is not null and k.name <> '' then ' / ' || k.name else '' end,
                                                           'qty', (i->>'qty')::integer, 'unit_price_jpy', (i->>'unit_price_jpy')::integer)), '[]'::jsonb)
                from jsonb_array_elements(v_r.items) i left join skus k on k.id = (i->>'sku_id')::uuid left join products pr on pr.id = k.product_id),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain, 'contact_email', v_s.settings->>'contact_email'));
end;
$$;
revoke execute on function reservation_reminder_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function reservation_reminder_contact(uuid, uuid) to service_role;

-- LINE で送る相手（予約の会員が LINE と結びついていて、まだ払えるときだけ）。氏名・住所・メールアドレスは返さない
create or replace function reservation_line_recipient(p_reservation_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reservation_line_recipient: service_role only' using errcode = '42501';
  end if;
  select * into v_r from reservations where id = p_reservation_id and shop_id = p_shop_id;
  if not found or v_r.customer_id is null or v_r.status <> 'pending' or v_r.payment_session is null or v_r.expires_at <= now()
     or exists (select 1 from orders o where o.reservation_id = v_r.id) then
    return null;
  end if;
  return (select jsonb_build_object('line_user_id', i.subject, 'reservation_id', v_r.id, 'expires_at', v_r.expires_at, 'total_jpy', banto_reservation_total(v_r),
                                    'shop', jsonb_build_object('name', s.name, 'slug', s.slug, 'domain', s.domain))
            from member_identities i join shops s on s.id = v_r.shop_id
           where i.shop_id = v_r.shop_id and i.customer_id = v_r.customer_id and i.provider = 'line'
           limit 1);
end;
$$;
revoke execute on function reservation_line_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function reservation_line_recipient(uuid, uuid) to service_role;

-- 0180 と同じ。予約の id だけで引く口を足す（お支払いのお願いのリンクの券。Worker が署名を確かめてから呼ぶ）
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
  elsif p_reservation_id is not null then
    select * into v_r from reservations where shop_id = p_shop_id and id = p_reservation_id;
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

-- 同梱のメール・LINE のプラグインの送信先: お支払いのお願いを購読に足す（送るかはショップの設定 payment_reminder）
update hook_endpoints set events = array_append(events, 'checkout.payment_pending')
 where url in ('https://banto.invalid/plugins/email_resend', 'https://banto.invalid/plugins/line_buyer_notify')
   and not ('checkout.payment_pending' = any(events));

insert into banto_migrations (version) values ('0181_payment_reminder');
