-- Banto 0051_audit_log: 監査ログ（人間の決定 2026-10-23、docs/knowledge/02-decisions.md）。前方専用。
--
-- 「誰が・いつ・何を変えたか」を 1 つの表に残す。書くのはこのファイルのトリガーだけ（Worker からは insert しない）。
-- 記録する出来事（最小）:
--   customer.email_changed / customer.deleted           会員のメールアドレスの変更・会員の削除
--   order.status_changed                                 注文の状態（paid → shipped / cancelled / refunded）
--   org_member.added / role_changed / removed            組織のメンバー
--   org_member.shop_perms / store_perms                  ショップ・実店舗ごとの項目
--   api_token.issued / revoked                           AI 用トークン
--   shop.domain_changed / stripe_account_changed / published_changed
-- 誰が（actor_kind / actor_id）は banto_audit_actor() が決める（優先順）:
--   1. banto.actor … api_require が同じトランザクションに置く（AI 用トークン）
--   2. service_role のリクエストの X-Banto-Actor ヘッダ（PostgREST の request.headers。Worker の特権経路が名乗る。
--      利用者の JWT では読まないので偽れない）。形は "user:<uuid>" / "api_token:<uuid>"
--   3. auth.uid()（管理画面の JWT）
--   4. system（Webhook・Cron）
-- 個人情報は入れない: メールアドレスは小文字の SHA-256 の先頭 16 桁だけ。注文は番号、人とトークンは id。
-- 読めるのは組織の owner / admin（RLS）。insert / update / delete のポリシーは無い。
-- ショップを消しても行は残す（shop_id に外部キーを張らない）。組織を消せば一緒に消える。保持は prune_audit_log（Cron、既定 365 日）。

-- ---------- 表 ----------
create table audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  shop_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'api_token', 'system')),
  actor_id uuid,
  action text not null check (length(action) between 1 and 60),
  target_type text not null check (length(target_type) between 1 and 40),
  target_id text check (length(target_id) <= 100),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (org_id, id desc);
create index audit_log_shop_idx on audit_log (shop_id, id desc) where shop_id is not null;

alter table audit_log enable row level security;
create policy audit_log_org_admin_select on audit_log for select using (banto_org_admin(org_id));
revoke all on audit_log from public, anon, authenticated;
grant select on audit_log to authenticated;

-- ---------- 誰が ----------
create or replace function banto_audit_actor()
returns table (kind text, id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_raw text; v_headers jsonb; v_kind text; v_id uuid;
begin
  -- 1. 同じトランザクションの中で api_require が置いた AI 用トークン
  v_raw := nullif(current_setting('banto.actor', true), '');
  -- 2. service_role のリクエストだけ、Worker が名乗ったヘッダ
  if v_raw is null and auth.role() = 'service_role' then
    begin
      v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    exception when others then
      v_headers := null;
    end;
    v_raw := v_headers->>'x-banto-actor';
  end if;
  if v_raw is not null and v_raw ~ '^(user|api_token):[0-9a-fA-F-]{36}$' then
    v_kind := split_part(v_raw, ':', 1);
    begin
      v_id := split_part(v_raw, ':', 2)::uuid;
    exception when others then
      v_id := null;
    end;
    if v_id is not null then return query select v_kind, v_id; return; end if;
  end if;
  -- 3. 管理画面の JWT
  if auth.uid() is not null then return query select 'user'::text, auth.uid(); return; end if;
  -- 4. Webhook・Cron
  return query select 'system'::text, null::uuid;
end;
$$;
revoke execute on function banto_audit_actor() from public, anon, authenticated;

-- ---------- 書く ----------
-- 組織が無い（消えた・まだ入っていない）ときは書かない（組織の削除の連鎖の途中で外部キーに当たらないため）
create or replace function banto_audit(p_org_id uuid, p_shop_id uuid, p_action text, p_target_type text, p_target_id text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_actor record;
begin
  if p_org_id is null or not exists (select 1 from organizations where id = p_org_id) then return; end if;
  select * into v_actor from banto_audit_actor() limit 1;
  insert into audit_log (org_id, shop_id, actor_kind, actor_id, action, target_type, target_id, detail)
  values (p_org_id, p_shop_id, v_actor.kind, v_actor.id, p_action, p_target_type, left(p_target_id, 100), coalesce(p_detail, '{}'::jsonb));
end;
$$;
revoke execute on function banto_audit(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;

-- メールアドレスの突き合わせ用の値（個人情報を残さない）
create or replace function banto_audit_email_hash(p_email text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case when p_email is null or btrim(p_email) = '' then null
              else left(encode(digest(lower(btrim(p_email)), 'sha256'), 'hex'), 16) end;
$$;
revoke execute on function banto_audit_email_hash(text) from public, anon, authenticated;

create or replace function banto_shop_org(p_shop_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from shops where id = p_shop_id;
$$;
revoke execute on function banto_shop_org(uuid) from public, anon, authenticated;

-- ---------- 会員 ----------
create or replace function banto_audit_customers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'customer.email_changed', 'customer', new.id::text,
                        jsonb_build_object('old_email_hash', banto_audit_email_hash(old.email), 'new_email_hash', banto_audit_email_hash(new.email)));
    return new;
  end if;
  perform banto_audit(banto_shop_org(old.shop_id), old.shop_id, 'customer.deleted', 'customer', old.id::text,
                      jsonb_build_object('email_hash', banto_audit_email_hash(old.email)));
  return old;
end;
$$;
revoke execute on function banto_audit_customers() from public, anon, authenticated;
drop trigger if exists customers_audit_email on customers;
create trigger customers_audit_email after update of email on customers
  for each row when (old.email is distinct from new.email) execute function banto_audit_customers();
drop trigger if exists customers_audit_delete on customers;
create trigger customers_audit_delete after delete on customers for each row execute function banto_audit_customers();

-- ---------- 注文の状態 ----------
create or replace function banto_audit_orders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'order.status_changed', 'order', new.id::text,
                      jsonb_build_object('number', new.number, 'from', old.status::text, 'to', new.status::text));
  return new;
end;
$$;
revoke execute on function banto_audit_orders() from public, anon, authenticated;
drop trigger if exists orders_audit_status on orders;
create trigger orders_audit_status after update of status on orders
  for each row when (old.status is distinct from new.status) execute function banto_audit_orders();

-- ---------- 組織のメンバー ----------
create or replace function banto_audit_org_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform banto_audit(new.org_id, null, 'org_member.added', 'user', new.user_id::text, jsonb_build_object('role', new.role));
    return new;
  elsif tg_op = 'UPDATE' then
    perform banto_audit(new.org_id, null, 'org_member.role_changed', 'user', new.user_id::text, jsonb_build_object('from', old.role, 'to', new.role));
    return new;
  end if;
  perform banto_audit(old.org_id, null, 'org_member.removed', 'user', old.user_id::text, jsonb_build_object('role', old.role));
  return old;
end;
$$;
revoke execute on function banto_audit_org_members() from public, anon, authenticated;
drop trigger if exists org_members_audit_insert on org_members;
create trigger org_members_audit_insert after insert on org_members for each row execute function banto_audit_org_members();
drop trigger if exists org_members_audit_role on org_members;
create trigger org_members_audit_role after update of role on org_members
  for each row when (old.role is distinct from new.role) execute function banto_audit_org_members();
drop trigger if exists org_members_audit_delete on org_members;
create trigger org_members_audit_delete after delete on org_members for each row execute function banto_audit_org_members();

-- ショップごと・実店舗ごとの項目（org_member_set は消して入れ直すので、消えた分と入った分がそれぞれ残る）
create or replace function banto_audit_member_perms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_user uuid; v_shop uuid; v_store uuid; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'INSERT' then
    v_org := new.org_id; v_user := new.user_id; v_old := null; v_new := to_jsonb(new.perms);
  elsif tg_op = 'UPDATE' then
    if old.perms = new.perms then return new; end if;
    v_org := new.org_id; v_user := new.user_id; v_old := to_jsonb(old.perms); v_new := to_jsonb(new.perms);
  else
    v_org := old.org_id; v_user := old.user_id; v_old := to_jsonb(old.perms); v_new := null;
  end if;
  if tg_table_name = 'org_member_shops' then
    v_shop := case when tg_op = 'DELETE' then old.shop_id else new.shop_id end;
    perform banto_audit(v_org, v_shop, 'org_member.shop_perms', 'user', v_user::text, jsonb_build_object('from', v_old, 'to', v_new));
  else
    v_store := case when tg_op = 'DELETE' then old.store_id else new.store_id end;
    perform banto_audit(v_org, null, 'org_member.store_perms', 'user', v_user::text, jsonb_build_object('store_id', v_store, 'from', v_old, 'to', v_new));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke execute on function banto_audit_member_perms() from public, anon, authenticated;
drop trigger if exists org_member_shops_audit on org_member_shops;
create trigger org_member_shops_audit after insert or update or delete on org_member_shops for each row execute function banto_audit_member_perms();
drop trigger if exists org_member_stores_audit on org_member_stores;
create trigger org_member_stores_audit after insert or update or delete on org_member_stores for each row execute function banto_audit_member_perms();

-- ---------- AI 用トークン ----------
create or replace function banto_audit_api_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'api_token.issued', 'api_token', new.id::text,
                        jsonb_build_object('name', new.name, 'prefix', new.prefix, 'scopes', to_jsonb(new.scopes), 'expires_at', new.expires_at));
    return new;
  end if;
  perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'api_token.revoked', 'api_token', new.id::text,
                      jsonb_build_object('name', new.name, 'prefix', new.prefix));
  return new;
end;
$$;
revoke execute on function banto_audit_api_tokens() from public, anon, authenticated;
drop trigger if exists api_tokens_audit_insert on api_tokens;
create trigger api_tokens_audit_insert after insert on api_tokens for each row execute function banto_audit_api_tokens();
drop trigger if exists api_tokens_audit_revoke on api_tokens;
create trigger api_tokens_audit_revoke after update of revoked_at on api_tokens
  for each row when (old.revoked_at is null and new.revoked_at is not null) execute function banto_audit_api_tokens();

-- ---------- ショップ（独自ドメイン・Stripe の接続先・公開） ----------
create or replace function banto_audit_shops()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.domain is distinct from new.domain then
    perform banto_audit(new.org_id, new.id, 'shop.domain_changed', 'shop', new.id::text, jsonb_build_object('from', old.domain, 'to', new.domain));
  end if;
  if old.stripe_account_id is distinct from new.stripe_account_id then
    perform banto_audit(new.org_id, new.id, 'shop.stripe_account_changed', 'shop', new.id::text, jsonb_build_object('from', old.stripe_account_id, 'to', new.stripe_account_id));
  end if;
  if old.published is distinct from new.published then
    perform banto_audit(new.org_id, new.id, 'shop.published_changed', 'shop', new.id::text, jsonb_build_object('published', new.published));
  end if;
  return new;
end;
$$;
revoke execute on function banto_audit_shops() from public, anon, authenticated;
drop trigger if exists shops_audit on shops;
create trigger shops_audit after update of domain, stripe_account_id, published on shops for each row execute function banto_audit_shops();

-- ---------- AI 用トークンを actor として残す ----------
-- 0028 の api_require に「同じトランザクションのあいだだけ banto.actor を置く」を足しただけ。判定は変えない
create or replace function api_require(p_token_hash text, p_scope text)
returns api_tokens
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_require: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash
     and revoked_at is null
     and (expires_at is null or expires_at > now());
  if not found or not (p_scope = any(v_tok.scopes)) or not banto_token_scope_ok(v_tok.owner_id, v_tok.shop_id, p_scope) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  -- 最終利用は1分に1回だけ更新（書き込みを減らす）
  if v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute' then
    update api_tokens set last_used_at = now() where id = v_tok.id;
  end if;
  perform set_config('banto.actor', 'api_token:' || v_tok.id::text, true);
  return v_tok;
end;
$$;

-- ---------- 保持 ----------
create or replace function prune_audit_log(p_days integer default 365)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'prune_audit_log: service_role only' using errcode = '42501';
  end if;
  delete from audit_log where created_at < now() - make_interval(days => greatest(coalesce(p_days, 365), 30));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function prune_audit_log(integer) from public, anon, authenticated;
grant execute on function prune_audit_log(integer) to service_role;

insert into banto_migrations (version) values ('0051_audit_log');
