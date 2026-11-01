-- 0090_security_hardening_4: 守りの締め直し 4（docs/upgrade.md「変更ごとの注意」）。
--
-- 1. 会員のセッションに「ログインを確かめた時刻」（member_sessions.authenticated_at）を持つ。ログインしてから 15 分以内の判定
--    （banto_member_recent_auth）はこの列で行い、パスワードの変更などで Worker がセッションを作り直すときは前の値を引き継ぐ
--    （member_session_start の p_authenticated_at）。作り直すたびに 15 分の起点が若返らない
-- 2. 退会・LINE / Google の連携の解除・パスキーの削除・全端末ログアウトは、ログインしてから 15 分以内のセッションだけ
--    （p_session_id を渡したとき。満たさなければ reauth_required）。退会は本人に知らせるために email と送信元を返す
-- 3. ログインのコードの発行（member_login_start）: 宛先ごと 1 日 30 通に達していても、その宛先にまだ出していない IP からの
--    最初の 1 通は 1 日 5 通まで通す（他人が 3 つの IP で本人の枠を使い切っても、本人の端末からは入れる）
-- 4. 注文の確定（confirm_reservation）: 支払額と通貨は必ず受け取り、整数でない・通貨が無いときは確定しない（amount_mismatch）。
--    0 円の確定（payment_provider = 'free'）は合計が 0 のときだけ。決済の口座（orders.payment_account）を注文に残す。
--    解放済みの予約を確定するとき、同じ quote の生きた予約があれば quote_superseded、クーポンの枠が取れなければ
--    coupon_exhausted_after_release（どちらも Worker が返金する。在庫の insufficient_stock_after_release と同じ扱い）
-- 5. お店で試着: 申し込んだまま（requested）店が扱わずに 14 日（settings.store_tryon.request_days）過ぎたものは Cron の
--    tryon_expire が expired にして在庫を EC に戻す（匿名が在庫を押さえ続けられない）

-- ---------- 1. member_sessions.authenticated_at ----------
alter table member_sessions add column if not exists authenticated_at timestamptz not null default now();
update member_sessions set authenticated_at = created_at where authenticated_at > created_at;

-- セッションを作る（0045 を差し替え: ログインを確かめた時刻を引き継げる。null なら今）
drop function if exists member_session_start(uuid, uuid, integer, text, text, integer);
create or replace function member_session_start(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_kind text, p_label text, p_ttl_seconds integer,
                                                p_authenticated_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_start: service_role only' using errcode = '42501';
  end if;
  if p_kind not in ('web', 'api') or p_ttl_seconds is null or p_ttl_seconds not between 60 and 366 * 86400 then
    raise exception 'invalid_session';
  end if;
  perform 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch for update;
  if not found then return null; end if;
  -- この会員の終わった行を片付ける
  delete from member_sessions
   where shop_id = p_shop_id and customer_id = p_customer_id
     and (expires_at < now() or revoked_at < now() - interval '1 day' or session_epoch <> p_epoch);
  insert into member_sessions (shop_id, customer_id, session_epoch, kind, label, expires_at, authenticated_at)
  values (p_shop_id, p_customer_id, p_epoch, p_kind, nullif(left(btrim(coalesce(p_label, '')), 60), ''), now() + make_interval(secs => p_ttl_seconds),
          least(coalesce(p_authenticated_at, now()), now()))
  returning id into v_id;
  update member_sessions set revoked_at = now(), revoked_reason = 'limit'
   where id in (
     select id from member_sessions
      where shop_id = p_shop_id and customer_id = p_customer_id and revoked_at is null
      order by created_at desc, id
      offset banto_member_session_limit());
  return v_id;
end;
$$;
revoke execute on function member_session_start(uuid, uuid, integer, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function member_session_start(uuid, uuid, integer, text, text, integer, timestamptz) to service_role;

-- ログインを確かめてから p_minutes 以内の、生きたセッションか（0057 を差し替え: created_at ではなく authenticated_at）
create or replace function banto_member_recent_auth(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_minutes integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_session_id is not null
     and banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id)
     and exists (select 1 from member_sessions where id = p_session_id and authenticated_at > now() - make_interval(mins => p_minutes));
$$;
revoke execute on function banto_member_recent_auth(uuid, uuid, integer, uuid, integer) from public, anon, authenticated;

-- パスワードの設定（0057 を差し替え: 戻り値に authenticated_at。Worker がセッションを作り直すときに引き継ぐ）
-- 戻り値: { ok: true, epoch, email, mail_from, authenticated_at } / { ok: false, reason: 'session' | 'reauth' }
create or replace function member_set_password(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_password text, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_epoch integer; v_email text; v_auth timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_set_password: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_password', 'false') = 'true') then
    raise exception 'password_disabled';
  end if;
  if p_password is null or length(p_password) < 8 or length(p_password) > 200 then raise exception 'weak_password'; end if;
  if p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  update customers
     set password_hash = crypt(p_password, gen_salt('bf', 10)), password_updated_at = now(),
         legacy_password_hash = null, legacy_password_expires_at = null,
         session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch
  returning session_epoch, email into v_epoch, v_email;
  if v_epoch is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  -- この端末のセッションだけ新しい世代へ（ほかの端末は世代が合わなくなって止まる）。ログインを確かめた時刻は変えない
  update member_sessions set session_epoch = v_epoch where id = p_session_id returning authenticated_at into v_auth;
  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'email', v_email, 'mail_from', banto_member_mail_from(p_shop_id), 'authenticated_at', v_auth);
end;
$$;
revoke execute on function member_set_password(uuid, uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function member_set_password(uuid, uuid, integer, text, uuid) to service_role;

-- ---------- 2. 再認証: 退会・連携の解除・パスキーの削除・全端末ログアウト ----------
-- p_session_id を渡したら、ログインを確かめてから 15 分以内の生きたセッションでなければ reauth_required。
-- null（古い Worker）なら従来どおり世代だけで確かめる。

-- 退会（0012 を差し替え）: customers 行を消す（注文は残る）。本人に知らせるために email と送信元を返す
-- 戻り値: { ok: true, email, mail_from } / { ok: false }（世代が合わない = セッションがもう無効）
drop function if exists member_withdraw(uuid, uuid, integer);
create or replace function member_withdraw(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_email text; v_found boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_withdraw: service_role only' using errcode = '42501';
  end if;
  if p_session_id is not null and not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  delete from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch returning email into v_email;
  v_found := found;
  if not v_found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'email', v_email, 'mail_from', banto_member_mail_from(p_shop_id));
end;
$$;
revoke execute on function member_withdraw(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_withdraw(uuid, uuid, integer, uuid) to service_role;

-- 全端末からログアウト（0012 を差し替え: 世代を上げる）
drop function if exists member_logout_all(uuid, uuid, integer);
create or replace function member_logout_all(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_logout_all: service_role only' using errcode = '42501';
  end if;
  if p_session_id is not null and not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  update customers set session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;
revoke execute on function member_logout_all(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_logout_all(uuid, uuid, integer, uuid) to service_role;

-- 連携を外す（0014 を差し替え）。ほかに入る方法（メールアドレスかパスワード）が無い会員は外せない（入れなくなるため）
drop function if exists member_unlink_identity(uuid, uuid, integer, text);
create or replace function member_unlink_identity(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_provider text, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_unlink_identity: service_role only' using errcode = '42501';
  end if;
  if p_session_id is not null and not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return false; end if;
  if v_c.email is null then raise exception 'last_login_method'; end if;
  delete from member_identities where shop_id = p_shop_id and customer_id = p_customer_id and provider = p_provider;
  return found;
end;
$$;
revoke execute on function member_unlink_identity(uuid, uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function member_unlink_identity(uuid, uuid, integer, text, uuid) to service_role;

-- パスキーを消す（0046 を差し替え）
drop function if exists member_passkey_delete(uuid, uuid, integer, uuid);
create or replace function member_passkey_delete(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_id uuid, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_delete: service_role only' using errcode = '42501';
  end if;
  if p_session_id is not null and not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return false;
  end if;
  delete from member_passkeys where id = p_id and shop_id = p_shop_id and customer_id = p_customer_id;
  return found;
end;
$$;
revoke execute on function member_passkey_delete(uuid, uuid, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function member_passkey_delete(uuid, uuid, integer, uuid, uuid) to service_role;

-- ---------- 3. member_login_start（0033 を差し替え: 宛先の 1 日の枠が埋まっても、新しい IP からの最初の 1 通は通す） ----------
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
  v_dest_day integer;
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
  -- 宛先ごと: 1 日 30 通（メール爆撃の上限）
  select count(*) into v_dest_day from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '1 day';
  if p_ip_hash is not null then
    -- 同じ IP から同じアドレスへ: 15 分に 3 回・1 日 10 回（他人が被害者の枠を使い切れないように、IP ごとに分ける）
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 3
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '1 day') >= 10
              -- 同じ IP から誰へでも: 1 時間に 30 回（0033: settings.members_login_limits.per_ip_per_hour。中継する構成では中継元の宣言のほうを使う）
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour')
                 >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_ip_per_hour', 30);
    -- 宛先の 1 日の枠（30 通）が埋まっていても、この宛先にまだ出していない IP からの最初の 1 通は通す（宛先ごと 1 日 5 通まで）。
    -- 他人が 3 つの IP で枠を使い切っても、本人の端末（別の IP）からは入れる
    if not v_limited and v_dest_day >= 30 then
      v_limited := v_dest_day >= 35
        or exists (select 1 from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '1 day');
    end if;
  else
    -- IP が分からない（Node でヘッダー未設定、中継元が申告しない）: アドレスだけで数える
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5
              or v_dest_day >= 30;
  end if;
  -- ショップ全体: 1 時間・1 日の上限（送信元の評判と Resend の枠を守る）
  v_limited := v_limited
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
revoke execute on function member_login_start(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function member_login_start(uuid, text, text, text, text, text, integer) to service_role;

-- ---------- 4. 注文の確定 ----------
-- 決済の口座（Stripe Connect の接続先のアカウント ID か、API キー方式の印）。返金はこの口座で行う（接続先を変えた後の旧注文も返金できる）
alter table orders add column if not exists payment_account text check (payment_account is null or char_length(payment_account) between 1 and 200);

-- confirm_reservation（0029 を差し替え: 支払額・通貨は必須、free は 0 円だけ、payment_account、解放済みの予約の quote_superseded / coupon_exhausted_after_release）
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
revoke execute on function confirm_reservation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function confirm_reservation(uuid, uuid, jsonb) to service_role;

-- ---------- 5. お店で試着の期限切れ（0025 を差し替え: 申し込んだまま扱われないものも期限切れにして在庫を戻す） ----------
-- p_today はショップの時間帯の今日（取り置きの期限 hold_until の判定）。申し込んだまま（requested）の期限は created_at から
-- settings.store_tryon.request_days 日（既定 14）。店が扱っていない申し込みなので、在庫はその場で EC に戻す（ready の期限切れは店が決める）
create or replace function tryon_expire(p_today date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_n integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_expire: service_role only' using errcode = '42501';
  end if;
  for v_r in update tryon_requests set status = 'expired', closed_at = now(), updated_at = now()
              where status = 'ready' and hold_until < p_today returning * loop
    perform banto_enqueue_tryon_hook(v_r.shop_id, 'tryon.updated',
      jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', v_r.shop_id, 'store_id', v_r.store_id, 'status', 'expired',
                         'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id));
    v_n := v_n + 1;
  end loop;
  for v_r in update tryon_requests set status = 'expired', closed_at = now(), updated_at = now()
              where status = 'requested'
                and created_at < now() - make_interval(days => greatest(1, banto_shop_limit(shop_id, 'store_tryon', 'request_days', 14)))
              returning * loop
    perform banto_tryon_restock(v_r.shop_id, v_r.id);
    perform banto_enqueue_tryon_hook(v_r.shop_id, 'tryon.updated',
      jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', v_r.shop_id, 'store_id', v_r.store_id, 'status', 'expired',
                         'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function tryon_expire(date) from public, anon, authenticated;
grant execute on function tryon_expire(date) to service_role;

insert into banto_migrations (version) values ('0090_security_hardening_4');
