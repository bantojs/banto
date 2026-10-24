-- Banto 0028_security_hardening: セキュリティ監査（2026-10-18 のコード監査）の H1 / M3 / M4 / M5 / M6 / M11
-- 前方専用。方針: 権限の判定は SQL に置く（CLAUDE.md §7b）。0024 で足した「ショップごとの項目」に、表・列・関数の側を追従させる。
--
--  H1  AI 用トークンのスコープは、発行者がその項目を今も持つときだけ有効（発行時のトリガー + 使用時の api_require）
--  M3  orders は authenticated から status / shipped_at しか更新できず、状態の遷移は paid → shipped だけ（キャンセル・返金は cancel_order）
--  M4  customers のパスワードのハッシュ等は運営者・スタッフに見せない（列単位の権限）
--  M5  anon に見せる shops の列を絞り、ストアフロントは shop_public_get / shop_public_list で公開の settings だけを受け取る
--  M6  shop_payment_options は決済プラグインの表示に要る設定だけ返す
--  M11 enqueue_hook は管理画面から積めるイベントを項目ごとに限定する

-- ---------- 共通: 任意の利用者の項目を確かめる（banto_shop_perm の auth.uid() を引数にしたもの） ----------
create or replace function banto_user_shop_perm(p_user uuid, p_shop_id uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shops s
     where s.id = p_shop_id
       and ((s.org_id is null and s.owner_id = p_user)
            or (s.org_id is not null and (
                  exists (select 1 from org_members m where m.org_id = s.org_id and m.user_id = p_user and m.role in ('owner', 'admin'))
                  or exists (select 1 from org_member_shops ms
                              where ms.org_id = s.org_id and ms.shop_id = s.id and ms.user_id = p_user and p_perm = any(ms.perms))))));
$$;
revoke execute on function banto_user_shop_perm(uuid, uuid, text) from public, anon, authenticated;

-- ---------- H1: スコープ → 項目 ----------
-- shop:read は「トークンを発行できる人（integrations）なら誰でも」。それ以外は管理画面と同じ項目を求める。
create or replace function banto_scope_perm(p_scope text)
returns text language sql immutable as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

create or replace function banto_token_scope_ok(p_owner_id uuid, p_shop_id uuid, p_scope text)
returns boolean language sql stable security definer set search_path = public as $$
  select banto_scope_perm(p_scope) is not null
     and banto_user_shop_perm(p_owner_id, p_shop_id, 'integrations')
     and banto_user_shop_perm(p_owner_id, p_shop_id, banto_scope_perm(p_scope));
$$;
revoke execute on function banto_token_scope_ok(uuid, uuid, text) from public, anon, authenticated;

create or replace function banto_token_scopes_ok(p_owner_id uuid, p_shop_id uuid, p_scopes text[])
returns boolean language sql stable security definer set search_path = public as $$
  select banto_user_shop_perm(p_owner_id, p_shop_id, 'integrations')
     -- 語彙に無いスコープは CHECK（api_tokens_scopes_valid）に任せる
     and not exists (select 1 from unnest(coalesce(p_scopes, '{}'::text[])) s
                      where banto_scope_perm(s) is not null and not banto_token_scope_ok(p_owner_id, p_shop_id, s));
$$;
revoke execute on function banto_token_scopes_ok(uuid, uuid, text[]) from public, anon, authenticated;

-- 発行時: 発行者が持たない項目のスコープは付けられない（管理画面も PostgREST 直叩きも同じ）
create or replace function banto_api_tokens_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not banto_token_scopes_ok(new.owner_id, new.shop_id, new.scopes) then
    raise exception 'scope_not_permitted' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_api_tokens_guard() from public, anon, authenticated;
drop trigger if exists api_tokens_guard on api_tokens;
create trigger api_tokens_guard before insert or update of scopes, owner_id, shop_id on api_tokens
  for each row execute function banto_api_tokens_guard();

-- 使用時: そのスコープに対応する項目を発行者が今も持つときだけ（項目を外したら、そのスコープだけ効かなくなる）
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
  return v_tok;
end;
$$;

create or replace function api_has_scope(p_token_hash text, p_scope text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from api_tokens
     where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now())
       and p_scope = any(scopes) and banto_token_scope_ok(owner_id, shop_id, p_scope)
  );
$$;

-- キャンセル（返金）は管理画面と同じく orders_cancel の項目が要る（orders:write だけでは返金できない）
create or replace function api_order_payment_info(p_token_hash text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if not banto_user_shop_perm(v_tok.owner_id, v_tok.shop_id, 'orders_cancel') then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  v_r := order_payment_info(p_order_id, v_tok.shop_id);
  if v_r is null then raise exception 'not_found'; end if;
  return v_r;
end;
$$;

create or replace function api_order_cancel(p_token_hash text, p_order_id uuid, p_refunded boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if not banto_user_shop_perm(v_tok.owner_id, v_tok.shop_id, 'orders_cancel') then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  v_r := cancel_order(p_order_id, v_tok.shop_id, p_refunded);
  select * into v_o from orders where id = p_order_id;
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

-- ---------- M3: orders の直接更新は status / shipped_at だけ、遷移は paid → shipped だけ ----------
-- キャンセル・返金は cancel_order（service_role、返金の後）、送り状番号は ship_orders（SECURITY DEFINER）を通る。
revoke all on orders from anon;
revoke update on orders from authenticated;
grant update (status, shipped_at) on orders to authenticated;

create or replace function banto_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and new.status is distinct from old.status
     and not (old.status = 'paid' and new.status = 'shipped') then
    raise exception 'use_cancel_order' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_orders_guard() from public, anon, authenticated;
drop trigger if exists orders_guard on orders;
create trigger orders_guard before update on orders for each row execute function banto_orders_guard();

-- ---------- M4: customers のパスワードのハッシュ・世代は運営者・スタッフに見せない ----------
-- 会員の読み書きは service_role の member_* RPC（0012）。運営者・customers の項目は一覧（名前・メール・住所）と削除だけ。
revoke all on customers from anon;
revoke select on customers from authenticated;
grant select (id, shop_id, email, name, default_address, created_at, updated_at, last_login_at) on customers to authenticated;

-- ---------- M5: anon に見せる shops の列を絞る ----------
-- 公開ショップの行は anon だけに（他の組織の運営者にも見せない。管理画面は banto_admin_shop / banto_my_shops で引く）。
-- settings・stripe_account_id・order_seq・tryon_seq・owner_id・org_id は anon に渡さない。
drop policy if exists shops_public on shops;
create policy shops_public on shops for select to anon using (published = true);
revoke all on shops from anon;
grant select (id, slug, name, published, legal_notice, privacy_policy, return_policy, domain, created_at, updated_at) on shops to anon;

-- ストアフロントに要る settings の鍵だけ（allowlist）。足すときは src/storefront/data.ts の PUBLIC_SETTINGS_KEYS と test/fake-supabase.ts も揃える。
-- headless は戻り先の許可リストだけ、oauth は提供元ごとの client_id と bot_prompt だけ。
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt', 'product_fields',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding')), '{}'::jsonb)
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb)))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'settings', banto_shop_public_settings(s.settings));
$$;
revoke execute on function banto_shop_public_json(shops) from public, anon, authenticated;

-- スラッグか独自ドメインで公開中のショップを 1 件（無ければ null）
create or replace function shop_public_get(p_slug text default null, p_domain text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select banto_shop_public_json(s) from shops s
   where s.published
     and ((p_slug is not null and s.slug = p_slug) or (p_domain is not null and s.domain = p_domain))
   limit 1;
$$;
grant execute on function shop_public_get(text, text) to anon, authenticated, service_role;

create or replace function shop_public_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(banto_shop_public_json(s) order by s.created_at), '[]'::jsonb) from shops s where s.published;
$$;
grant execute on function shop_public_list() to anon, authenticated, service_role;

-- ---------- M6: 決済プラグインの表示に要る設定だけ（0002 を差し替え） ----------
create or replace function shop_payment_options(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', substr(e.url, length('https://banto.invalid/plugins/') + 1),
           'settings', coalesce((select jsonb_object_agg(k, v) from jsonb_each(e.settings) f(k, v) where k in ('payment_types', 'reservation_hours')), '{}'::jsonb))), '[]'::jsonb)
    from hook_endpoints e
    join shops s on s.id = e.shop_id
   where e.shop_id = p_shop_id and e.enabled and s.published
     and e.url in ('https://banto.invalid/plugins/stripe', 'https://banto.invalid/plugins/komoju');
$$;

-- ---------- M11: 管理画面から積めるイベントを項目ごとに限定（0024 を差し替え） ----------
-- catalog → product.updated、orders → order.shipped。それ以外（注文の確定・試着など）は DB の中（service_role）だけが積む。
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_perm text;
begin
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  if auth.role() is distinct from 'service_role' then
    v_perm := case p_event when 'product.updated' then 'catalog' when 'order.shipped' then 'orders' end;
    if v_perm is null then
      raise exception 'event_not_permitted' using errcode = '42501';
    end if;
    if not banto_shop_perm(p_shop_id, v_perm) then
      raise exception 'shop_not_found' using errcode = '42501';
    end if;
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

insert into banto_migrations (version) values ('0028_security_hardening');
