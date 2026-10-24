#!/bin/sh
# Banto を自前の PostgreSQL + PostgREST + GoTrue で動かすための下準備（docs/self-hosted-db.md）。
# 公式の postgres イメージは、初めて起動したときに /docker-entrypoint-initdb.d/ のこのファイルを superuser で 1 回だけ流す。
# 既存の PostgreSQL に入れるときは、環境変数を付けて手で流す:
#   AUTHENTICATOR_PASSWORD=... AUTH_ADMIN_PASSWORD=... POSTGRES_USER=postgres POSTGRES_DB=banto sh 00-roles.sh
#
# Supabase が用意しているもののうち、Banto が使うものだけを作る:
#   anon / authenticated / service_role … PostgREST が JWT の role で切り替えるロール（RLS が実際の境界）
#   authenticator … PostgREST が接続するロール（上の 3 つに切り替えるだけで、自分では何もできない）
#   supabase_auth_admin … GoTrue（運営者のログイン）が auth スキーマを作って使うロール
set -eu
: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD を設定してください}"
: "${AUTH_ADMIN_PASSWORD:?AUTH_ADMIN_PASSWORD を設定してください}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" \
  -v authenticator_password="$AUTHENTICATOR_PASSWORD" -v auth_admin_password="$AUTH_ADMIN_PASSWORD" <<'SQL'
-- ---------- ロール ----------
select format('create role %I nologin noinherit', r) from unnest(array['anon', 'authenticated']) r
 where not exists (select 1 from pg_roles where rolname = r) \gexec
select 'create role service_role nologin noinherit bypassrls' where not exists (select 1 from pg_roles where rolname = 'service_role') \gexec
select 'create role authenticator login noinherit' where not exists (select 1 from pg_roles where rolname = 'authenticator') \gexec
alter role authenticator with password :'authenticator_password';
grant anon, authenticated, service_role to authenticator;
select 'create role supabase_auth_admin login createrole noinherit' where not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') \gexec
alter role supabase_auth_admin with password :'auth_admin_password';

-- ---------- auth スキーマ（中身は GoTrue が起動時に作る）----------
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth;

-- ---------- public の既定の権限（Supabase と同じ。RLS が実際の境界になる）----------
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---------- マイグレーションのあと、PostgREST に表と関数を読み直させる ----------
create or replace function public.banto_pgrst_reload() returns event_trigger
language plpgsql as $$ begin notify pgrst, 'reload schema'; end; $$;
revoke all on function public.banto_pgrst_reload() from public, anon, authenticated, service_role;
drop event trigger if exists banto_pgrst_reload;
create event trigger banto_pgrst_reload on ddl_command_end execute function public.banto_pgrst_reload();
SQL
