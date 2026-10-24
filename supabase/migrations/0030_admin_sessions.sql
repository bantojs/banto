-- Banto 0030_admin_sessions: セキュリティ監査（2026-10-18 のコード監査）の段階 3（運営者側の入口）
-- 前方専用。
--
--  M1  最初の運営者の Auth ユーザーを消すと owners が空になり、セットアップの運営者登録が匿名に再び開く
--      → 「運営者がいない」は owners・org_members・shops のどれも空のときだけ（RLS のゲートと setup_state の両方）
--  M2  管理者ログインに Banto 側の回数制限が無い → admin_login_attempts に失敗を記録し、計算（Supabase への問い合わせ）の前に判定する
--  M13 ログアウトしても Cookie が 1 時間有効・全端末からログアウトできない → 運営者ごとの世代（admin_users.session_epoch）。
--      Cookie に世代を入れ、毎リクエストの運営者の確認（banto_admin_me）で照合する。ログアウトで世代を上げる（全端末が切れる）

-- ---------- M1 ----------
-- 最初の運営者の Auth ユーザーを消すと、owners の行が消え（cascade）、0001 では shops.owner_id の外部キーも cascade だったので
-- その人のショップと注文・商品までまとめて消えていた。ショップは組織のもの（0024）なので、owner_id を空にするだけにする
alter table shops drop constraint if exists shops_owner_id_fkey;
alter table shops add constraint shops_owner_id_fkey foreign key (owner_id) references owners(id) on delete set null;

create or replace function banto_owner_signup_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from owners) and not exists (select 1 from org_members) and not exists (select 1 from shops);
$$;

create or replace function banto_setup_state()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'has_owner', exists (select 1 from owners) or exists (select 1 from org_members) or exists (select 1 from shops),
    'shop_count', (select count(*) from shops),
    'migrations', (select coalesce(jsonb_agg(version order by version), '[]'::jsonb) from banto_migrations)
  );
$$;

-- ---------- M13: 運営者のセッションの世代 ----------
create table if not exists admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_epoch integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table admin_users enable row level security;
-- 表は誰にも見せない（関数からだけ触る）
create policy admin_users_none on admin_users for select using (false);

-- 毎リクエストの確認: どこかの組織のメンバーか、その人の世代。メンバーでなければ { member: false }
create or replace function banto_admin_me()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_epoch integer;
begin
  if auth.uid() is null then return jsonb_build_object('member', false); end if;
  if not exists (select 1 from org_members where user_id = auth.uid()) then return jsonb_build_object('member', false); end if;
  select session_epoch into v_epoch from admin_users where user_id = auth.uid();
  if not found then
    insert into admin_users (user_id) values (auth.uid()) on conflict (user_id) do nothing;
    v_epoch := 0;
  end if;
  return jsonb_build_object('member', true, 'epoch', v_epoch);
end;
$$;
revoke execute on function banto_admin_me() from public, anon;
grant execute on function banto_admin_me() to authenticated;

-- ログアウト（全端末）・パスワードの変更のとき: 世代を上げる。戻り値は新しい世代
create or replace function admin_session_bump()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_epoch integer;
begin
  if auth.uid() is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  insert into admin_users (user_id, session_epoch, updated_at) values (auth.uid(), 1, now())
  on conflict (user_id) do update set session_epoch = admin_users.session_epoch + 1, updated_at = now()
  returning session_epoch into v_epoch;
  return v_epoch;
end;
$$;
revoke execute on function admin_session_bump() from public, anon;
grant execute on function admin_session_bump() to authenticated;

-- ---------- M2: 管理者ログインの回数の制限 ----------
-- メールアドレス・IP は Worker が HMAC（サイトの秘密）にしてから渡す（会員のログインと同じ）。
create table if not exists admin_login_attempts (
  id bigserial primary key,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists admin_login_attempts_email on admin_login_attempts (email_hash, created_at);
create index if not exists admin_login_attempts_ip on admin_login_attempts (ip_hash, created_at) where ip_hash is not null;
alter table admin_login_attempts enable row level security;
create policy admin_login_attempts_none on admin_login_attempts for select using (false);

-- 同じアドレスは 15 分に 5 回、同じ IP は 15 分に 20 回まで失敗できる。超えていれば allowed=false（Supabase には問い合わせない）
create or replace function admin_login_check(p_email_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_email integer; v_ip integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'admin_login_check: service_role only' using errcode = '42501';
  end if;
  select count(*) into v_email from admin_login_attempts where email_hash = p_email_hash and not success and created_at > now() - interval '15 minutes';
  if p_ip_hash is not null then
    select count(*) into v_ip from admin_login_attempts where ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes';
  end if;
  return jsonb_build_object('allowed', v_email < 5 and v_ip < 20, 'retry_after_seconds', 900);
end;
$$;
revoke execute on function admin_login_check(text, text) from public, anon, authenticated;
grant execute on function admin_login_check(text, text) to service_role;

-- 結果を記録する。成功したらそのアドレスの失敗を消す（本人が入れたのだから鍵を開ける）。1 日より古い行は捨てる
create or replace function admin_login_record(p_email_hash text, p_ip_hash text, p_success boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'admin_login_record: service_role only' using errcode = '42501';
  end if;
  delete from admin_login_attempts where created_at < now() - interval '1 day';
  if p_success then
    delete from admin_login_attempts where email_hash = p_email_hash and not success;
  end if;
  insert into admin_login_attempts (email_hash, ip_hash, success) values (p_email_hash, p_ip_hash, coalesce(p_success, false));
end;
$$;
revoke execute on function admin_login_record(text, text, boolean) from public, anon, authenticated;
grant execute on function admin_login_record(text, text, boolean) to service_role;

insert into banto_migrations (version) values ('0030_admin_sessions');
