-- Banto 0046_mod_passkey: パスキーでのログイン（同梱モジュール passkey、既定 OFF。docs/knowledge/10-members-identity.md §18）。前方専用。
--
-- 人間の決定（2026-10-23）: RP ID はショップのドメインそのもの。独自ドメイン（shops.domain）の無いショップには出さない
-- （Banto の URL にパスで同居するショップ同士で RP ID を共有しないため）。ヘッドレスは Banto の画面でパスキーを使い、引き換え券で戻す。
--   - 署名の検証は Worker（src/members/webauthn.ts、WebCrypto）。ここは「challenge は 1 回限り・5 分・誰のものか」と
--     「署名の回数が戻っていないか」と「パスキーは誰のものか」を確かめる。
--   - challenge は Worker が HMAC（サイトの秘密）にしてから渡す。生の値は DB に来ない。
--   - パスキーの追加は、ログインしてから 15 分以内のセッション（0045 の member_sessions）だけ。盗まれた Cookie でパスキーを
--     足されると、セッションを取り消しても入れてしまうため。追加したら本人にメールで知らせる（Worker）。
--   - パスキーはログインの入口の 1 つ。なくしてもメールのコードで入れる。全端末からログアウト（世代）では消さない。
-- すべて service_role だけ。呼び出しは src/db/privileged.ts から。

create table member_passkeys (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null,
  -- base64url（PostgreSQL の正規表現の繰り返しは 255 回までなので、長さは別に確かめる）
  credential_id text not null check (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 22 and 1364),
  -- COSE の公開鍵（base64url）
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]+$' and char_length(public_key) between 20 and 2048),
  alg integer not null check (alg in (-7, -8, -257)),
  -- 登録したときのショップのドメイン。ドメインが変わったら使えない（ログインのときに今のドメインと比べる）
  rp_id text not null check (char_length(rp_id) between 1 and 253),
  sign_count bigint not null default 0 check (sign_count between 0 and 4294967295),
  backed_up boolean not null default false,
  label text check (char_length(label) <= 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (shop_id, credential_id),
  -- 退会（customers 行の削除）で消える
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade
);
create index member_passkeys_customer_idx on member_passkeys (shop_id, customer_id);
alter table member_passkeys enable row level security;
-- 誰にも見せない（service_role は RLS を通らない。関数からだけ触る）
create policy member_passkeys_none on member_passkeys for select using (false);

create table member_passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  purpose text not null check (purpose in ('login', 'register')),
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  -- register だけ: 誰の・どのセッションの追加か
  customer_id uuid,
  session_id uuid,
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index member_passkey_challenges_ip_idx on member_passkey_challenges (shop_id, ip_hash, created_at) where ip_hash is not null;
create index member_passkey_challenges_created_idx on member_passkey_challenges (shop_id, created_at);
alter table member_passkey_challenges enable row level security;
create policy member_passkey_challenges_none on member_passkey_challenges for select using (false);

-- パスキーが使えるショップか（会員機能・モジュールが ON・独自ドメインがある）
create or replace function banto_passkey_shop(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.domain from shops s
   where s.id = p_shop_id and s.domain is not null
     and coalesce(s.settings->>'members_enabled', 'false') = 'true'
     and coalesce(s.settings #>> '{modules,passkey}', 'false') = 'true';
$$;

-- 1 人の会員が持てるパスキーの数
create or replace function banto_passkey_limit() returns integer language sql immutable as $$ select 10 $$;

-- ---------- challenge を出す ----------
-- login: 誰でも（同じ IP から 10 分に 30 回、ショップ全体で 10 分に 3000 回まで）。
-- register: ログイン中の会員の、ログインしてから 15 分以内のセッション（p_session_id）だけ。
-- 戻り値: { ok: true, challenge_id, rp_id, exclude: [credential_id]（register）, user: { email, name }（register） }
--        / { ok: false, reason: 'disabled' | 'limited' | 'session' | 'reauth' | 'too_many' }
create or replace function member_passkey_begin(p_shop_id uuid, p_purpose text, p_challenge_hash text, p_ip_hash text, p_customer_id uuid default null, p_epoch integer default null, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_domain text; v_c customers; v_id uuid; v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_begin: service_role only' using errcode = '42501';
  end if;
  if p_purpose not in ('login', 'register') then raise exception 'invalid_purpose'; end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;

  if p_purpose = 'login' then
    if p_ip_hash is not null then
      select count(*) into v_n from member_passkey_challenges
       where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
      if v_n >= 30 then return jsonb_build_object('ok', false, 'reason', 'limited'); end if;
    end if;
    select count(*) into v_n from member_passkey_challenges where shop_id = p_shop_id and created_at > now() - interval '10 minutes';
    if v_n >= 3000 then return jsonb_build_object('ok', false, 'reason', 'limited'); end if;
    insert into member_passkey_challenges (shop_id, purpose, challenge_hash, ip_hash, expires_at)
    values (p_shop_id, 'login', p_challenge_hash, p_ip_hash, now() + interval '5 minutes')
    returning id into v_id;
    return jsonb_build_object('ok', true, 'challenge_id', v_id, 'rp_id', v_domain);
  end if;

  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found or p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not exists (select 1 from member_sessions where id = p_session_id and kind = 'web' and created_at > now() - interval '15 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  if (select count(*) from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id) >= banto_passkey_limit() then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  insert into member_passkey_challenges (shop_id, purpose, challenge_hash, customer_id, session_id, ip_hash, expires_at)
  values (p_shop_id, 'register', p_challenge_hash, p_customer_id, p_session_id, p_ip_hash, now() + interval '5 minutes')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'challenge_id', v_id, 'rp_id', v_domain,
    'user', jsonb_build_object('email', v_c.email, 'name', v_c.name),
    'exclude', coalesce((select jsonb_agg(credential_id order by created_at) from member_passkeys
                          where shop_id = p_shop_id and customer_id = p_customer_id and rp_id = v_domain), '[]'::jsonb));
end;
$$;

-- challenge を使う（1 回限り）。合わなければ null
create or replace function banto_passkey_consume(p_shop_id uuid, p_challenge_id uuid, p_challenge_hash text, p_purpose text)
returns member_passkey_challenges
language plpgsql
security definer
set search_path = public
as $$
declare v_ch member_passkey_challenges;
begin
  select * into v_ch from member_passkey_challenges
   where id = p_challenge_id and shop_id = p_shop_id and purpose = p_purpose
   for update;
  if not found or v_ch.consumed_at is not null or v_ch.expires_at <= now() or v_ch.challenge_hash <> p_challenge_hash then
    return null;
  end if;
  update member_passkey_challenges set consumed_at = now() where id = v_ch.id;
  return v_ch;
end;
$$;

-- ---------- 登録 ----------
-- Worker が応答を確かめた後に呼ぶ。戻り値: { ok: true, id, email, mail_from } / { ok: false, reason: 'expired' | 'session' | 'reauth' | 'duplicate' | 'too_many' | 'disabled' }
create or replace function member_passkey_register(
  p_shop_id uuid, p_challenge_id uuid, p_challenge_hash text, p_customer_id uuid, p_epoch integer, p_session_id uuid,
  p_credential_id text, p_public_key text, p_alg integer, p_sign_count bigint, p_rp_id text, p_backed_up boolean, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_ch member_passkey_challenges; v_domain text; v_id uuid; v_email text; v_from text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_register: service_role only' using errcode = '42501';
  end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null or v_domain <> p_rp_id then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  v_ch := banto_passkey_consume(p_shop_id, p_challenge_id, p_challenge_hash, 'register');
  if v_ch.id is null or v_ch.customer_id is distinct from p_customer_id or v_ch.session_id is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not exists (select 1 from member_sessions where id = p_session_id and kind = 'web' and created_at > now() - interval '20 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  perform 1 from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if (select count(*) from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id) >= banto_passkey_limit() then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if exists (select 1 from member_passkeys where shop_id = p_shop_id and credential_id = p_credential_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  insert into member_passkeys (shop_id, customer_id, credential_id, public_key, alg, rp_id, sign_count, backed_up, label)
  values (p_shop_id, p_customer_id, p_credential_id, p_public_key, p_alg, p_rp_id, coalesce(p_sign_count, 0), coalesce(p_backed_up, false),
          nullif(left(btrim(coalesce(p_label, '')), 60), ''))
  returning id into v_id;
  select email into v_email from customers where shop_id = p_shop_id and id = p_customer_id;
  -- 知らせのメールの送信元（メール通知プラグインの設定。無ければ null = 送らない）
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email, 'mail_from', v_from);
end;
$$;

-- ---------- ログイン ----------
-- 署名を確かめるための公開鍵を引く（読むだけ）。今のドメインで登録したものだけ。無ければ null
create or replace function member_passkey_lookup(p_shop_id uuid, p_credential_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_domain text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_lookup: service_role only' using errcode = '42501';
  end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null then return null; end if;
  return (select jsonb_build_object('id', id, 'customer_id', customer_id, 'public_key', public_key, 'alg', alg)
            from member_passkeys where shop_id = p_shop_id and credential_id = p_credential_id and rp_id = v_domain);
end;
$$;

-- Worker が署名を確かめた後に呼ぶ。challenge を使い、署名の回数を確かめて、会員としてログインさせる。
-- 戻り値: { ok: true, customer_id, session_epoch, email } / { ok: false, reason: 'expired' | 'invalid' | 'counter' | 'disabled' }
-- counter: 認証器の署名の回数が前より進んでいない（パスキーが複製された疑い）。どちらも 0 なら数えない認証器（同期するパスキー）
create or replace function member_passkey_login(p_shop_id uuid, p_challenge_id uuid, p_challenge_hash text, p_passkey_id uuid, p_sign_count bigint, p_backed_up boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_ch member_passkey_challenges; v_pk member_passkeys; v_c customers; v_domain text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_login: service_role only' using errcode = '42501';
  end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  v_ch := banto_passkey_consume(p_shop_id, p_challenge_id, p_challenge_hash, 'login');
  if v_ch.id is null then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into v_pk from member_passkeys where id = p_passkey_id and shop_id = p_shop_id and rp_id = v_domain for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if (coalesce(p_sign_count, 0) > 0 or v_pk.sign_count > 0) and coalesce(p_sign_count, 0) <= v_pk.sign_count then
    return jsonb_build_object('ok', false, 'reason', 'counter');
  end if;
  update member_passkeys set sign_count = coalesce(p_sign_count, 0), backed_up = coalesce(p_backed_up, backed_up), last_used_at = now()
   where id = v_pk.id;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_pk.customer_id returning * into v_c;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email);
end;
$$;

-- ---------- 会員の画面 ----------
-- 世代が合わなければ null。current はショップの今のドメインで使えるか
create or replace function member_passkeys_list(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_domain text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkeys_list: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return null;
  end if;
  select domain into v_domain from shops where id = p_shop_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'created_at', created_at, 'last_used_at', last_used_at,
                                        'backed_up', backed_up, 'usable', rp_id = v_domain) order by created_at)
      from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id), '[]'::jsonb);
end;
$$;

create or replace function member_passkey_delete(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_delete: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return false;
  end if;
  delete from member_passkeys where id = p_id and shop_id = p_shop_id and customer_id = p_customer_id;
  return found;
end;
$$;

-- ---------- 運営者: 会員のパスキーを全部消す（乗っ取られた会員の救済。メールアドレスの変更と組み合わせる） ----------
-- owner の JWT で呼ぶ（会員の項目 customers が要る）。戻り値は消した数
create or replace function member_passkeys_reset(p_shop_id uuid, p_customer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------- 片付け（Cron） ----------
create or replace function member_passkey_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_cleanup: service_role only' using errcode = '42501';
  end if;
  delete from member_passkey_challenges where created_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function banto_passkey_shop(uuid) from public, anon, authenticated;
revoke execute on function banto_passkey_limit() from public, anon, authenticated;
revoke execute on function banto_passkey_consume(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function member_passkey_begin(uuid, text, text, text, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function member_passkey_register(uuid, uuid, text, uuid, integer, uuid, text, text, integer, bigint, text, boolean, text) from public, anon, authenticated;
revoke execute on function member_passkey_lookup(uuid, text) from public, anon, authenticated;
revoke execute on function member_passkey_login(uuid, uuid, text, uuid, bigint, boolean) from public, anon, authenticated;
revoke execute on function member_passkeys_list(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function member_passkey_delete(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function member_passkeys_reset(uuid, uuid) from public, anon;
revoke execute on function member_passkey_cleanup() from public, anon, authenticated;
grant execute on function member_passkey_begin(uuid, text, text, text, uuid, integer, uuid) to service_role;
grant execute on function member_passkey_register(uuid, uuid, text, uuid, integer, uuid, text, text, integer, bigint, text, boolean, text) to service_role;
grant execute on function member_passkey_lookup(uuid, text) to service_role;
grant execute on function member_passkey_login(uuid, uuid, text, uuid, bigint, boolean) to service_role;
grant execute on function member_passkeys_list(uuid, uuid, integer) to service_role;
grant execute on function member_passkey_delete(uuid, uuid, integer, uuid) to service_role;
grant execute on function member_passkeys_reset(uuid, uuid) to authenticated;
grant execute on function member_passkey_cleanup() to service_role;

insert into banto_migrations (version) values ('0046_mod_passkey');
