-- Banto 0057_member_reauth: 盗まれた会員のセッションから「永続的なログイン手段」を足せないようにする。前方専用。
--
-- 2026-10-25 の監査: 0046（パスキーの追加はログインしてから 15 分以内のセッションだけ）と同じ守りが、パスワードの設定と
-- LINE / Google の連携に無かった。Cookie か 15 分の access を手にした者が自分のパスワードや外部アカウントを足すと、本人が
-- 全端末からログアウトしても入り続けられる。さらにパスワードを変えると Worker が新しいセッションの行を作っていたため、
-- その行で 0046 の「15 分以内」も通ってしまった。
--   - member_set_password / member_oauth_login（link）は、ログインしてから 15 分以内のセッション（p_session_id）だけ。
--     過ぎていれば reauth（確かめのコードで入り直す）。
--   - パスワードを変えたとき、今のセッションの行を新しい世代に付け替える（新しい行を作らない。created_at = ログインの時刻が残る）。
--     ほかの端末は世代が変わって止まる。
--   - どちらも本人に知らせるメールの送信元（mail_from）を返す（送るのは Worker）。
--   - 運営者の二段階認証の登録・解除を監査ログに残す（org_member_mfa_self。GoTrue の表にはトリガーを張れないので Worker が呼ぶ）。

-- ログインしてから p_minutes 以内の、生きたセッションか
create or replace function banto_member_recent_auth(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_minutes integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_session_id is not null
     and banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id)
     and exists (select 1 from member_sessions where id = p_session_id and created_at > now() - make_interval(mins => p_minutes));
$$;
revoke execute on function banto_member_recent_auth(uuid, uuid, integer, uuid, integer) from public, anon, authenticated;

-- メール通知プラグインの送信元（無ければ null = 送らない）
create or replace function banto_member_mail_from(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(btrim(e.settings->>'from'), '') from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
$$;
revoke execute on function banto_member_mail_from(uuid) from public, anon, authenticated;

-- ---------- パスワードの設定（0013 を差し替え: セッションの確かめと知らせ） ----------
-- 戻り値: { ok: true, epoch, email, mail_from } / { ok: false, reason: 'session' | 'reauth' }
drop function if exists member_set_password(uuid, uuid, integer, text);
create or replace function member_set_password(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_password text, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_epoch integer; v_email text;
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
  -- この端末のセッションだけ新しい世代へ（ほかの端末は世代が合わなくなって止まる）
  update member_sessions set session_epoch = v_epoch where id = p_session_id;
  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'email', v_email, 'mail_from', banto_member_mail_from(p_shop_id));
end;
$$;
revoke execute on function member_set_password(uuid, uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function member_set_password(uuid, uuid, integer, text, uuid) to service_role;

-- ---------- LINE / Google の連携（0014 を差し替え: 連携はログインしてから 15 分以内のセッションだけ） ----------
drop function if exists member_oauth_login(uuid, text, text, text, boolean, uuid, integer);
create or replace function member_oauth_login(p_shop_id uuid, p_provider text, p_subject text, p_email text, p_email_verified boolean,
                                              p_link_customer_id uuid, p_link_epoch integer, p_link_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_customer_id uuid;
  v_c customers%rowtype;
  v_created boolean := false;
  v_linked boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_oauth_login: service_role only' using errcode = '42501';
  end if;
  if p_provider not in ('line', 'google') or p_subject is null or length(p_subject) not between 1 and 200 then raise exception 'invalid_identity'; end if;
  if not exists (select 1 from shops where id = p_shop_id
                  and coalesce(settings->>'members_enabled', 'false') = 'true'
                  and coalesce(settings->'modules'->>(p_provider || '_login'), 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then v_email := null; end if;
  perform pg_advisory_xact_lock(hashtextextended('member_oauth|' || p_shop_id::text || '|' || p_provider || '|' || p_subject, 0));

  select customer_id into v_customer_id from member_identities where shop_id = p_shop_id and provider = p_provider and subject = p_subject;

  if p_link_customer_id is not null then
    -- ログイン中の会員が自分で連携する（ログインしてから 15 分以内のセッションだけ。0057）
    if not exists (select 1 from customers where shop_id = p_shop_id and id = p_link_customer_id and session_epoch = coalesce(p_link_epoch, -1))
       or p_link_session_id is null or not banto_member_session_live(p_shop_id, p_link_customer_id, p_link_epoch, p_link_session_id) then
      return jsonb_build_object('ok', false, 'reason', 'session');
    end if;
    if not banto_member_recent_auth(p_shop_id, p_link_customer_id, p_link_epoch, p_link_session_id, 15) then
      return jsonb_build_object('ok', false, 'reason', 'reauth');
    end if;
    if v_customer_id is not null and v_customer_id <> p_link_customer_id then return jsonb_build_object('ok', false, 'reason', 'already_linked'); end if;
    if v_customer_id is null then
      if exists (select 1 from member_identities where shop_id = p_shop_id and customer_id = p_link_customer_id and provider = p_provider) then
        return jsonb_build_object('ok', false, 'reason', 'other_linked');
      end if;
      insert into member_identities (shop_id, provider, subject, customer_id) values (p_shop_id, p_provider, p_subject, p_link_customer_id);
      v_linked := true;
    end if;
    v_customer_id := p_link_customer_id;
  elsif v_customer_id is null then
    -- 確認済みのアドレスなら、同じアドレスの会員に結びつける（その会員に同じ提供元の別アカウントが無いときだけ）
    if v_email is not null and p_email_verified then
      select id into v_customer_id from customers c where c.shop_id = p_shop_id and lower(c.email) = v_email
         and not exists (select 1 from member_identities i where i.shop_id = p_shop_id and i.customer_id = c.id and i.provider = p_provider);
    end if;
    if v_customer_id is null then
      insert into customers (shop_id, email)
      values (p_shop_id, case when p_email_verified and v_email is not null
                               and not exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_email) then v_email end)
      returning id into v_customer_id;
      v_created := true;
    end if;
    insert into member_identities (shop_id, provider, subject, customer_id) values (p_shop_id, p_provider, p_subject, v_customer_id);
    v_linked := true;
  end if;

  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_customer_id returning * into v_c;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email,
                            'created', v_created, 'linked', v_linked,
                            'mail_from', case when p_link_customer_id is not null and v_linked then banto_member_mail_from(p_shop_id) end);
end;
$$;
revoke execute on function member_oauth_login(uuid, text, text, text, boolean, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_oauth_login(uuid, text, text, text, boolean, uuid, integer, uuid) to service_role;

-- ---------- 運営者の二段階認証の登録・解除を監査ログに ----------
-- GoTrue の auth.mfa_factors にはトリガーを張れない（Supabase の管理下）ので、Worker が登録・解除の直後に呼ぶ。
-- 書くのは自分の分だけ（target = auth.uid()）。属する組織ごとに 1 行
create or replace function org_member_mfa_self(p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_action not in ('enabled', 'disabled') then raise exception 'invalid_action'; end if;
  for v_org in select org_id from org_members where user_id = auth.uid() loop
    perform banto_audit(v_org, null, 'org_member.mfa_' || p_action, 'user', auth.uid()::text, '{}'::jsonb);
  end loop;
end;
$$;
revoke execute on function org_member_mfa_self(text) from public, anon;
grant execute on function org_member_mfa_self(text) to authenticated, service_role;

insert into banto_migrations (version) values ('0057_member_reauth');
