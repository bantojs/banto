-- Banto 0079_mod_pages: ショップのページ（「私たちについて」など。同梱モジュール pages、既定 OFF。メンテナの決定 2026-10-30、docs/pages.md）。前方専用。
--   - 1 ページ 1 行（pages）。URL は /pages/<handle>。並び（セクション）はテーマのテンプレート（templates/page.<suffix>.json）が持ち、
--     ページはどのテンプレートを使うかを選ぶだけ
--   - 本文は決まった書式（Markdown の一部）の文字だけを持つ。HTML にするのはお客様の画面を描くとき（src/pages/markdown.ts）。
--     HTML を DB に置かないので、本文を書ける人がショップのドメインに任意の HTML・スクリプトを入れる道が無い
--   - 扱えるのは新しい権限の項目 content（組織の owner / admin を含む）。お客様の画面（anon）は公開中のショップの公開中のページだけ
--   - ヘッダー・フッターに出すページ（nav）は banto_shop_public_json の pages_nav で返す（ショップ行と一緒にキャッシュされ、
--     ページを描くたびに一覧を引かない）。モジュールが OFF のショップには出さない
--   - 上限: 1 つのショップに 100、この Banto 全体は plan_limits.pages（ホスティングで貸すとき）

-- ---------- 権限の項目に content を足す（0024・0061・0071） ----------
create or replace function banto_shop_perms_all()
returns text[]
language sql
immutable
as $$ select array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design', 'content'] $$;

alter table org_member_shops drop constraint if exists org_member_shops_perms_check;
alter table org_member_shops add constraint org_member_shops_perms_check
  check (perms <@ array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design', 'content']);

-- ---------- 表 ----------
-- ハンドルに使えない名前（Banto の決まったページと紛らわしいもの）
create or replace function banto_page_handle_ok(p_handle text)
returns boolean language sql immutable as $$
  select p_handle ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
     and p_handle not in ('legal', 'privacy', 'returns', 'shipping', 'cart', 'checkout', 'account', 'search', 'orders', 'inquiries');
$$;
-- pages.handle の CHECK（書き込む authenticated が呼ぶ。値の形を見るだけ）
revoke execute on function banto_page_handle_ok(text) from public, anon;
grant execute on function banto_page_handle_ok(text) to authenticated;

create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  handle text not null check (banto_page_handle_ok(handle)),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- 運営者が書いた本文（決まった書式。docs/pages.md）。HTML にするのは描くとき
  body text not null default '' check (char_length(body) <= 50000),
  seo_title text check (seo_title is null or char_length(seo_title) <= 200),
  seo_description text check (seo_description is null or char_length(seo_description) <= 500),
  -- Liquid のテーマの templates/page.<suffix>.json を選ぶ（null なら templates/page）
  template_suffix text check (template_suffix is null or template_suffix ~ '^[a-z0-9_-]{1,40}$'),
  -- ヘッダー・フッターのメニューに出すか
  nav text not null default 'none' check (nav in ('none', 'header', 'footer')),
  sort_order integer not null default 0,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create index if not exists pages_shop on pages (shop_id, sort_order, created_at);
alter table pages enable row level security;

drop policy if exists pages_content on pages;
create policy pages_content on pages for all
  using (banto_shop_perm(shop_id, 'content')) with check (banto_shop_perm(shop_id, 'content'));
drop policy if exists pages_public on pages;
create policy pages_public on pages for select
  using (published and exists (select 1 from shops s where s.id = pages.shop_id and s.published = true));

revoke insert, update, delete on pages from anon;
grant select on pages to anon;
grant select, insert, update, delete on pages to authenticated;

drop trigger if exists pages_updated_at on pages;
create trigger pages_updated_at before update on pages for each row execute function banto_set_updated_at();

-- 1 つのショップに置けるページの数
create or replace function banto_pages_max() returns integer language sql immutable as $$ select 100 $$;
revoke execute on function banto_pages_max() from public, anon, authenticated;

create or replace function banto_pages_shop_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 同じショップへの同時の追加でも上限を越えないように、ショップの行で直列にする
  perform 1 from shops where id = new.shop_id for update;
  if (select count(*) from pages where shop_id = new.shop_id) >= banto_pages_max() then
    raise exception 'pages_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function banto_pages_shop_limit() from public, anon, authenticated;
drop trigger if exists pages_shop_limit on pages;
create trigger pages_shop_limit before insert on pages for each row execute function banto_pages_shop_limit();

-- ---------- プランの上限（0073 の差し替え: pages を足す） ----------
create or replace function banto_plan_limits_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare v_key text; v_val jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  for v_key, v_val in select * from jsonb_each(p_value) loop
    if v_key not in ('shops', 'products', 'customers', 'members', 'mail_per_day', 'theme_versions', 'pages') then return false; end if;
    if jsonb_typeof(v_val) <> 'number' then return false; end if;
    if (v_val #>> '{}') !~ '^[0-9]+$' then return false; end if;
    -- テーマの版だけは 0（使わせない）を許す
    if (v_val #>> '{}')::bigint < (case when v_key = 'theme_versions' then 0 else 1 end) or (v_val #>> '{}')::bigint > 1000000 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke execute on function banto_plan_limits_valid(jsonb) from public, anon, authenticated;

create or replace function banto_plan_count(p_kind text)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare v bigint;
begin
  case p_kind
    when 'shops' then select count(*) into v from shops;
    when 'products' then select count(*) into v from products;
    when 'customers' then select count(*) into v from customers;
    when 'members' then select count(*) into v from org_members;
    when 'mail_per_day' then v := banto_plan_mail_count();
    when 'theme_versions' then select count(*) into v from theme_versions;
    when 'pages' then select count(*) into v from pages;
    else v := 0;
  end case;
  return v;
end;
$$;
revoke execute on function banto_plan_count(text) from public, anon, authenticated;

create or replace function banto_plan_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_limits jsonb := banto_plan_limits();
begin
  if auth.role() is distinct from 'service_role'
     and not exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'limits', v_limits,
    'usage', jsonb_build_object(
      'shops', banto_plan_count('shops'),
      'products', banto_plan_count('products'),
      'customers', banto_plan_count('customers'),
      'members', banto_plan_count('members'),
      'mail_per_day', banto_plan_count('mail_per_day'),
      'theme_versions', banto_plan_count('theme_versions'),
      'pages', banto_plan_count('pages')));
end;
$$;
revoke execute on function banto_plan_usage() from public, anon;
grant execute on function banto_plan_usage() to authenticated, service_role;

drop trigger if exists pages_plan_limit on pages;
create trigger pages_plan_limit after insert on pages for each statement execute function banto_plan_limit_guard();

-- ---------- お客様の画面（anon）: メニューに出すページを shop_public_get に足す ----------
-- 0071 の banto_shop_public_json に pages_nav を足しただけ。モジュール pages が ON のショップの、公開中で nav が header / footer のもの
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null),
    'pages_nav', case when s.settings->'modules'->'pages' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'title', p.title, 'nav', p.nav) order by p.sort_order, p.created_at), '[]'::jsonb)
         from pages p where p.shop_id = s.id and p.published and p.nav <> 'none')
      else '[]'::jsonb end);
$$;

insert into banto_migrations (version) values ('0079_mod_pages');
