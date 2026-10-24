-- Banto 0014_member_oauth: 外部のアカウントでのログイン（LINE・Google。同梱モジュール line_login / google_login、既定 OFF）
-- 前方専用。設計は docs/knowledge/10-members-identity.md §14。
--
-- - 会員と外部のアカウントの結びつきは、提供元の利用者 ID（sub）で持つ（メールアドレスでは結ばない）。
-- - 確認済みのメールアドレスが返ったときだけ、同じアドレスの既存会員に自動で結びつける。
--   ログイン中の会員が自分で「連携する」を押したときは、その会員に結びつける。
-- - ヘッドレスは、Banto が提供元から戻った後に 1 回限り・2 分の引き換え券（handoff）を連携側に渡し、連携側が /members/verify で
--   会員のトークンに引き換える（トークンを URL に載せない）。
-- - **提供元の秘密（LINE のチャネルシークレット・Google のクライアントシークレット）はショップごと**（人間の決定、2026-10-16。
--   複数のショップで同意画面にショップの名前を出すため）。CLAUDE.md §1-5 の例外: Worker がサイトの秘密から作った鍵で AES-GCM で暗号化し、
--   暗号文だけを shop_oauth_clients に置く。鍵は DB に無い。暗号文はショップと提供元に結びつける（行を入れ替えても読めない）。
--   運営者は暗号文の列を読めない（列の権限）。読むのは service_role の shop_oauth_client だけ。

create table member_identities (
  shop_id uuid not null,
  provider text not null check (provider in ('line', 'google')),
  subject text not null check (length(subject) between 1 and 200),
  customer_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, provider, subject),
  unique (shop_id, customer_id, provider),
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade
);
alter table member_identities enable row level security;
create policy member_identities_none on member_identities for select using (false);

-- ショップごとの提供元の設定。client_id は公開してよい値（ストアフロントのボタンにも使うので shops.settings.oauth にも写す）
create table shop_oauth_clients (
  shop_id uuid not null references shops(id) on delete cascade,
  provider text not null check (provider in ('line', 'google')),
  client_id text not null check (length(client_id) between 1 and 200),
  -- "v1.<iv>.<暗号文>"（base64url）。Worker の src/members/secret-box.ts
  secret_box text not null check (secret_box ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  updated_at timestamptz not null default now(),
  primary key (shop_id, provider)
);
alter table shop_oauth_clients enable row level security;
create policy shop_oauth_clients_owner on shop_oauth_clients for select using (banto_owns_shop(shop_id));
-- 運営者にも暗号文は見せない（書き込みは shop_oauth_client_save だけ）
revoke all on shop_oauth_clients from anon, authenticated;
grant select (shop_id, provider, client_id, updated_at) on shop_oauth_clients to authenticated;

-- 運営者が保存する（owner の JWT）。shops.settings.oauth.<provider>.client_id も一緒に書く
create or replace function shop_oauth_client_save(p_shop_id uuid, p_provider text, p_client_id text, p_secret_box text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if p_provider not in ('line', 'google') then raise exception 'invalid_provider'; end if;
  if p_client_id is null or length(btrim(p_client_id)) not between 1 and 200 or btrim(p_client_id) ~ '\s' then raise exception 'invalid_client_id'; end if;
  if p_secret_box is null then
    -- client_id だけ変える（シークレットは今のまま）
    update shop_oauth_clients set client_id = btrim(p_client_id), updated_at = now() where shop_id = p_shop_id and provider = p_provider;
    if not found then raise exception 'secret_required'; end if;
  else
    insert into shop_oauth_clients (shop_id, provider, client_id, secret_box) values (p_shop_id, p_provider, btrim(p_client_id), p_secret_box)
    on conflict (shop_id, provider) do update set client_id = excluded.client_id, secret_box = excluded.secret_box, updated_at = now();
  end if;
  update shops
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{oauth}',
                              coalesce(settings->'oauth', '{}'::jsonb) || jsonb_build_object(p_provider, jsonb_build_object('client_id', btrim(p_client_id))), true)
   where id = p_shop_id;
end;
$$;

create or replace function shop_oauth_client_delete(p_shop_id uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  delete from shop_oauth_clients where shop_id = p_shop_id and provider = p_provider;
  update shops set settings = settings #- array['oauth', p_provider] where id = p_shop_id;
end;
$$;

-- ログインの最中に Worker が読む（service_role）
create or replace function shop_oauth_client(p_shop_id uuid, p_provider text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.role() = 'service_role' then (
    select jsonb_build_object('client_id', client_id, 'secret_box', secret_box)
      from shop_oauth_clients where shop_id = p_shop_id and provider = p_provider) end;
$$;

create table member_handoffs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null,
  session_epoch integer not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
alter table member_handoffs enable row level security;
create policy member_handoffs_none on member_handoffs for select using (false);

-- 外部のアカウントでログインする（無ければ会員登録）。p_link_customer_id があれば、ログイン中のその会員に結びつける。
-- 戻り値: { ok: true, customer_id, session_epoch, email, created, linked } / { ok: false, reason }
--   reason: disabled（会員機能かモジュールが OFF）/ already_linked（その外部アカウントは別の会員に結びついている）/
--           other_linked（この会員には別の外部アカウントが結びついている）/ session（ログイン中の会員の世代が合わない）
create or replace function member_oauth_login(p_shop_id uuid, p_provider text, p_subject text, p_email text, p_email_verified boolean,
                                              p_link_customer_id uuid, p_link_epoch integer)
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
    -- ログイン中の会員が自分で連携する
    if not exists (select 1 from customers where shop_id = p_shop_id and id = p_link_customer_id and session_epoch = coalesce(p_link_epoch, -1)) then
      return jsonb_build_object('ok', false, 'reason', 'session');
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
                            'created', v_created, 'linked', v_linked);
end;
$$;

-- 連携を外す。ほかに入る方法（メールアドレスかパスワード）が無い会員は外せない（入れなくなるため）
create or replace function member_unlink_identity(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_provider text)
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
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return false; end if;
  if v_c.email is null then raise exception 'last_login_method'; end if;
  delete from member_identities where shop_id = p_shop_id and customer_id = p_customer_id and provider = p_provider;
  return found;
end;
$$;

-- ヘッドレスの引き換え券（2 分・1 回限り）。token は Worker が HMAC にしたもの
create or replace function member_handoff_create(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_handoff_create: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    raise exception 'member_session_invalid';
  end if;
  insert into member_handoffs (shop_id, customer_id, session_epoch, token_hash, expires_at)
  values (p_shop_id, p_customer_id, p_epoch, p_token_hash, now() + interval '2 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function member_handoff_redeem(p_shop_id uuid, p_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_h member_handoffs%rowtype; v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_handoff_redeem: service_role only' using errcode = '42501';
  end if;
  select * into v_h from member_handoffs where id = p_id and shop_id = p_shop_id for update;
  if not found or v_h.token_hash <> p_token_hash or v_h.consumed_at is not null or v_h.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  update member_handoffs set consumed_at = now() where id = v_h.id;
  select * into v_c from customers where shop_id = p_shop_id and id = v_h.customer_id and session_epoch = v_h.session_epoch;
  if not found then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email);
end;
$$;

-- 会員ページの表示（0013 を差し替え: 結びついた外部アカウントを足す）
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
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null,
                                   'providers', coalesce((select jsonb_agg(provider order by provider) from member_identities
                                                           where shop_id = p_shop_id and customer_id = v_c.id), '[]'::jsonb)),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

-- 片付け（0013 を差し替え: 引き換え券も消す）
create or replace function member_login_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer; v_m integer; v_h integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_cleanup: service_role only' using errcode = '42501';
  end if;
  delete from member_login_challenges where created_at < now() - interval '2 days';
  get diagnostics v_n = row_count;
  delete from member_login_failures where created_at < now() - interval '2 days';
  get diagnostics v_m = row_count;
  delete from member_handoffs where created_at < now() - interval '1 day';
  get diagnostics v_h = row_count;
  update customers set legacy_password_hash = null, legacy_password_expires_at = null
   where legacy_password_expires_at is not null and legacy_password_expires_at < now();
  return v_n + v_m + v_h;
end;
$$;

revoke execute on function shop_oauth_client_save(uuid, text, text, text) from public, anon;
revoke execute on function shop_oauth_client_delete(uuid, text) from public, anon;
revoke execute on function shop_oauth_client(uuid, text) from public, anon, authenticated;
grant execute on function shop_oauth_client_save(uuid, text, text, text) to authenticated;
grant execute on function shop_oauth_client_delete(uuid, text) to authenticated;
grant execute on function shop_oauth_client(uuid, text) to service_role;
revoke execute on function member_oauth_login(uuid, text, text, text, boolean, uuid, integer) from public, anon, authenticated;
revoke execute on function member_unlink_identity(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function member_handoff_create(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function member_handoff_redeem(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function member_get(uuid, uuid, integer, boolean) from public, anon, authenticated;
revoke execute on function member_login_cleanup() from public, anon, authenticated;
grant execute on function member_oauth_login(uuid, text, text, text, boolean, uuid, integer) to service_role;
grant execute on function member_unlink_identity(uuid, uuid, integer, text) to service_role;
grant execute on function member_handoff_create(uuid, uuid, integer, text) to service_role;
grant execute on function member_handoff_redeem(uuid, uuid, text) to service_role;
grant execute on function member_get(uuid, uuid, integer, boolean) to service_role;
grant execute on function member_login_cleanup() to service_role;

insert into banto_migrations (version) values ('0014_member_oauth');
