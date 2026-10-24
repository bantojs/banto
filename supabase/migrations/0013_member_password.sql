-- Banto 0013_member_password: 会員のパスワード（店ごとに選べる）と、WordPress のパスワードの取り込み
-- 前方専用。設計は docs/knowledge/10-members-identity.md §13。
--
-- - パスワードでのログインは店ごとの設定（shops.settings.members_password = true）。コードとリンクはいつでも使える（忘れたときの入口）。
-- - 照合は pgcrypto の bcrypt（crypt）。Worker の CPU（Workers 無料プランは 10ms）を使わない。
--   回数の制限は重い計算の「前」に数える（総当たりで DB の CPU を使い切られないように）。
-- - WordPress のパスワードは bcrypt の形式だけを取り込む: `$wp$2y$…`（6.8 以降。パスワードを HMAC-SHA384（鍵 wp-sha384）にかけて
--   base64 にしたものを bcrypt）と `$2y$…`（bcrypt にしているプラグイン）。`$P$…`（phpass、MD5 ベース）は取り込まない。
--   pgcrypto は `$2y$` / `$2b$` を読めない（DES と見なす）ので、`$2a$` に読み替えて照合する（同じ形式）。
--   初めてログインに成功した時点で Banto の bcrypt に保存し直し、元のハッシュは捨てる。180 日使われなければ消す。
-- Supabase では pgcrypto は extensions スキーマにある。素の PostgreSQL（テスト）では public にある。両方を search_path に入れる。

create schema if not exists extensions;
create extension if not exists pgcrypto;

alter table customers add column if not exists password_hash text;
alter table customers add column if not exists password_updated_at timestamptz;
alter table customers add column if not exists legacy_password_hash text;
alter table customers add column if not exists legacy_password_expires_at timestamptz;

-- パスワードの失敗（回数の制限に使う。2 日で消す）
create table member_login_failures (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  email text not null,
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index member_login_failures_email_idx on member_login_failures (shop_id, email, created_at);
create index member_login_failures_ip_idx on member_login_failures (shop_id, ip_hash, created_at) where ip_hash is not null;
alter table member_login_failures enable row level security;
create policy member_login_failures_none on member_login_failures for select using (false);

-- WordPress の bcrypt 形式のハッシュと照合する（外からは呼ばない）
create or replace function banto_wp_password_matches(p_password text, p_hash text)
returns boolean
language plpgsql
stable
set search_path = public, extensions
as $$
declare v_hash text; v_input text;
begin
  if p_password is null or p_hash is null then return false; end if;
  if p_hash ~ '^\$wp\$2[aby]\$[0-9]{2}\$' then
    v_hash := '$2a$' || substr(p_hash, 8);
    v_input := encode(hmac(p_password, 'wp-sha384', 'sha384'), 'base64');
  elsif p_hash ~ '^\$2[aby]\$[0-9]{2}\$' then
    v_hash := '$2a$' || substr(p_hash, 5);
    v_input := p_password;
  else
    return false;
  end if;
  return crypt(v_input, v_hash) = v_hash;
end;
$$;

-- パスワードでログインする。戻り値: { ok: true, customer_id, session_epoch, email } /
-- { ok: false, reason: 'invalid' | 'locked' | 'disabled' }。失敗は例外にしない（失敗の記録まで取り消されるため）
-- 上限: 同じ人に 15 分で 5 回、同じ IP から 1 時間に 30 回の失敗で、しばらくパスワードでは入れない（コードでは入れる）
create or replace function member_password_login(p_shop_id uuid, p_email text, p_password text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_c customers%rowtype;
  v_ok boolean := false;
  v_found boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_password_login: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id
                  and coalesce(settings->>'members_enabled', 'false') = 'true'
                  and coalesce(settings->>'members_password', 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if p_password is null or length(p_password) = 0 or length(p_password) > 200 or length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member_password|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from member_login_failures where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5
     or (p_ip_hash is not null and (select count(*) from member_login_failures where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30) then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  select * into v_c from customers where shop_id = p_shop_id and lower(email) = v_email for update;
  v_found := found;
  if v_found and v_c.password_hash is not null then
    v_ok := crypt(p_password, v_c.password_hash) = v_c.password_hash;
  elsif v_found and v_c.legacy_password_hash is not null and (v_c.legacy_password_expires_at is null or v_c.legacy_password_expires_at > now()) then
    -- WordPress は保存するときに前後の空白を落としている
    v_ok := banto_wp_password_matches(p_password, v_c.legacy_password_hash)
            or (btrim(p_password) <> p_password and banto_wp_password_matches(btrim(p_password), v_c.legacy_password_hash));
    if v_ok then
      update customers set password_hash = crypt(p_password, gen_salt('bf', 10)), password_updated_at = now(),
                           legacy_password_hash = null, legacy_password_expires_at = null
       where shop_id = p_shop_id and id = v_c.id;
    end if;
  else
    -- 会員がいない・パスワードが無いときも同じくらいの時間をかける（応答の時間で登録の有無が分からないように）
    perform crypt(p_password, '$2a$10$' || repeat('a', 53));
  end if;
  if not v_ok then
    insert into member_login_failures (shop_id, email, ip_hash) values (p_shop_id, v_email, p_ip_hash);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_c.id;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email);
end;
$$;

-- パスワードを決める・変える（ログイン中の会員）。世代を上げてほかの端末をログアウトし、新しい世代を返す（合わなければ null）
create or replace function member_set_password(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_password text)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_epoch integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_set_password: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_password', 'false') = 'true') then
    raise exception 'password_disabled';
  end if;
  if p_password is null or length(p_password) < 8 or length(p_password) > 200 then raise exception 'weak_password'; end if;
  update customers
     set password_hash = crypt(p_password, gen_salt('bf', 10)), password_updated_at = now(),
         legacy_password_hash = null, legacy_password_expires_at = null,
         session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch
  returning session_epoch into v_epoch;
  return v_epoch;
end;
$$;

-- WordPress のパスワードの取り込み（運営者、同梱モジュール woo_import から）。p_rows: [{ email, hash }]（最大 100 件）
-- bcrypt の形式だけ。会員がいなければ作る。Banto のパスワードを決めた会員は上書きしない
create or replace function import_member_passwords(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_email text;
  v_hash text;
  v_id uuid;
  v_has boolean;
  v_imported integer := 0;
  v_created integer := 0;
  v_format integer := 0;
  v_has_password integer := 0;
  v_bad_email integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'import_member_passwords: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 100 then raise exception 'too_many_rows'; end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e loop
    v_email := lower(btrim(coalesce(v_row->>'email', '')));
    v_hash := btrim(coalesce(v_row->>'hash', ''));
    if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_bad_email := v_bad_email + 1; continue; end if;
    if v_hash !~ '^(\$wp)?\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' then v_format := v_format + 1; continue; end if;
    v_id := null;
    select id, password_hash is not null into v_id, v_has from customers where shop_id = p_shop_id and lower(email) = v_email;
    if v_id is null then
      insert into customers (shop_id, email) values (p_shop_id, v_email) returning id into v_id;
      v_created := v_created + 1;
      v_has := false;
    end if;
    if v_has then v_has_password := v_has_password + 1; continue; end if;
    update customers set legacy_password_hash = v_hash, legacy_password_expires_at = now() + interval '180 days'
     where shop_id = p_shop_id and id = v_id;
    v_imported := v_imported + 1;
  end loop;
  return jsonb_build_object('imported', v_imported, 'created', v_created, 'skipped_format', v_format,
                            'skipped_has_password', v_has_password, 'skipped_invalid_email', v_bad_email);
end;
$$;

-- 会員ページの表示（0012 を差し替え: パスワードの有無を足す）
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
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

-- 片付け（0012 を差し替え: 失敗の記録と、期限の切れた WordPress のハッシュも消す）
create or replace function member_login_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer; v_m integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_cleanup: service_role only' using errcode = '42501';
  end if;
  delete from member_login_challenges where created_at < now() - interval '2 days';
  get diagnostics v_n = row_count;
  delete from member_login_failures where created_at < now() - interval '2 days';
  get diagnostics v_m = row_count;
  update customers set legacy_password_hash = null, legacy_password_expires_at = null
   where legacy_password_expires_at is not null and legacy_password_expires_at < now();
  return v_n + v_m;
end;
$$;

revoke execute on function banto_wp_password_matches(text, text) from public, anon, authenticated;
revoke execute on function member_password_login(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function member_set_password(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function import_member_passwords(uuid, jsonb) from public, anon, authenticated;
revoke execute on function member_get(uuid, uuid, integer, boolean) from public, anon, authenticated;
revoke execute on function member_login_cleanup() from public, anon, authenticated;
grant execute on function member_password_login(uuid, text, text, text) to service_role;
grant execute on function member_set_password(uuid, uuid, integer, text) to service_role;
grant execute on function import_member_passwords(uuid, jsonb) to service_role;
grant execute on function member_get(uuid, uuid, integer, boolean) to service_role;
grant execute on function member_login_cleanup() to service_role;

insert into banto_migrations (version) values ('0013_member_password');
