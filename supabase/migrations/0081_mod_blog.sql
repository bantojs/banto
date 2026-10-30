-- Banto 0081_mod_blog: ブログと記事（同梱モジュール blog、既定 OFF。メンテナの決定 2026-10-30、docs/blog.md）。前方専用。
--   - ブログ（blogs）は記事の入れ物（「お知らせ」「読みもの」など、お店がいくつでも作り名前を決める）。URL は /blogs/<handle> が記事の一覧
--   - 記事（articles）はブログの中の 1 本。URL は /blogs/<ブログ>/<handle>。本文はページと同じ決まった書式（Markdown の一部、生の HTML なし）で、
--     HTML にするのは描くとき。下書き・予約公開（published_at）・ゴミ箱（deleted_at、30 日で Cron の articles_purge_trash）・
--     リビジョン（article_revisions、トリガーだけが書く。20 まで）・タグ・抜粋・アイキャッチはページ（0079・0080）と同じ作り
--   - published_at は公開した時点でトリガーが入れる（空なら今）。一覧は published_at の新しい順
--   - 扱えるのはページと同じ項目 content。お客様（anon）に見えるのは公開中のショップの、公開中・日時を過ぎた・ゴミ箱の外の記事だけ
--   - メニューに出すブログは banto_shop_public_json の blogs_nav（モジュール blog が ON のショップだけ。ショップ行と一緒にキャッシュ）
--   - 上限: 1 つのショップにブログ 20・記事 5,000。この Banto 全体の記事は plan_limits.articles（ホスティングで貸すとき）
--   - 画像はページのメディアライブラリ（page_media、pages/<ショップ>/）を一緒に使う

-- ---------- ブログ ----------
create table if not exists blogs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  handle text not null check (handle ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 1000),
  seo_title text check (seo_title is null or char_length(seo_title) <= 200),
  seo_description text check (seo_description is null or char_length(seo_description) <= 500),
  -- Liquid のテーマの templates/blog.<suffix>.json を選ぶ（null なら templates/blog）
  template_suffix text check (template_suffix is null or template_suffix ~ '^[a-z0-9_-]{1,40}$'),
  nav text not null default 'none' check (nav in ('none', 'header', 'footer')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create index if not exists blogs_shop on blogs (shop_id, sort_order, created_at);
alter table blogs enable row level security;
drop policy if exists blogs_content on blogs;
create policy blogs_content on blogs for all
  using (banto_shop_perm(shop_id, 'content')) with check (banto_shop_perm(shop_id, 'content'));
drop policy if exists blogs_public on blogs;
create policy blogs_public on blogs for select
  using (exists (select 1 from shops s where s.id = blogs.shop_id and s.published = true));
revoke insert, update, delete on blogs from anon;
grant select on blogs to anon;
grant select, insert, update, delete on blogs to authenticated;
drop trigger if exists blogs_updated_at on blogs;
create trigger blogs_updated_at before update on blogs for each row execute function banto_set_updated_at();

-- ---------- 記事 ----------
create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  blog_id uuid not null references blogs(id) on delete cascade,
  handle text not null check (handle ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' and handle <> 'feed'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 50000),
  -- 一覧に出す短い紹介（空ならテーマが本文の頭を使う）
  excerpt text check (excerpt is null or char_length(excerpt) <= 1000),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  image_url text check (image_url is null or (char_length(image_url) <= 2000 and image_url ~ '^(https?://|/)[^\s<>"''`]*$')),
  author text check (author is null or char_length(author) <= 100),
  seo_title text check (seo_title is null or char_length(seo_title) <= 200),
  seo_description text check (seo_description is null or char_length(seo_description) <= 500),
  template_suffix text check (template_suffix is null or template_suffix ~ '^[a-z0-9_-]{1,40}$'),
  published boolean not null default false,
  published_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- URL の名前の一意はブログの中の、ゴミ箱の外だけ
create unique index if not exists articles_blog_handle_live on articles (blog_id, handle) where deleted_at is null;
create index if not exists articles_blog_published on articles (blog_id, published_at desc) where published and deleted_at is null;
create index if not exists articles_shop on articles (shop_id);
create index if not exists articles_tags on articles using gin (tags);
create index if not exists articles_trash on articles (deleted_at) where deleted_at is not null;
alter table articles enable row level security;
drop policy if exists articles_content on articles;
create policy articles_content on articles for all
  using (banto_shop_perm(shop_id, 'content')) with check (banto_shop_perm(shop_id, 'content'));
drop policy if exists articles_public on articles;
create policy articles_public on articles for select
  using (published and deleted_at is null and published_at <= now()
         and exists (select 1 from shops s where s.id = articles.shop_id and s.published = true));
revoke insert, update, delete on articles from anon;
grant select on articles to anon;
grant select, insert, update, delete on articles to authenticated;
drop trigger if exists articles_updated_at on articles;
create trigger articles_updated_at before update on articles for each row execute function banto_set_updated_at();

-- 記事の形を整える: ブログと同じショップ、タグは空白を外して重ねない（50 文字まで）、公開したら published_at を入れる（空なら今）
create or replace function banto_article_shape()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_tags text[];
begin
  if not exists (select 1 from blogs b where b.id = new.blog_id and b.shop_id = new.shop_id) then
    raise exception 'article_blog_mismatch' using errcode = '23514';
  end if;
  select coalesce(array_agg(distinct t order by t), '{}') into v_tags
    from (select btrim(x) as t from unnest(new.tags) x) s where t <> '';
  if exists (select 1 from unnest(v_tags) t where char_length(t) > 50) then
    raise exception 'article_tag_too_long' using errcode = '23514';
  end if;
  new.tags := v_tags;
  if new.published and new.published_at is null then new.published_at := now(); end if;
  return new;
end;
$$;
revoke execute on function banto_article_shape() from public, anon, authenticated;
drop trigger if exists articles_shape on articles;
create trigger articles_shape before insert or update on articles for each row execute function banto_article_shape();

-- 1 つのショップに置けるブログと記事の数
create or replace function banto_blog_shop_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from shops where id = new.shop_id for update;
  if tg_table_name = 'blogs' and (select count(*) from blogs where shop_id = new.shop_id) >= 20 then
    raise exception 'blogs_full' using errcode = 'P0001';
  end if;
  if tg_table_name = 'articles' and (select count(*) from articles where shop_id = new.shop_id) >= 5000 then
    raise exception 'articles_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function banto_blog_shop_limit() from public, anon, authenticated;
drop trigger if exists blogs_shop_limit on blogs;
create trigger blogs_shop_limit before insert on blogs for each row execute function banto_blog_shop_limit();
drop trigger if exists articles_shop_limit on articles;
create trigger articles_shop_limit before insert on articles for each row execute function banto_blog_shop_limit();

-- ---------- リビジョン（0080 の page_revisions と同じ作り） ----------
create table if not exists article_revisions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  article_id uuid not null references articles(id) on delete cascade,
  title text not null,
  body text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists article_revisions_article on article_revisions (article_id, created_at desc);
alter table article_revisions enable row level security;
drop policy if exists article_revisions_content on article_revisions;
create policy article_revisions_content on article_revisions for select using (banto_shop_perm(shop_id, 'content'));
revoke all on article_revisions from anon;
revoke insert, update, delete on article_revisions from authenticated;
grant select on article_revisions to authenticated;

create or replace function banto_article_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.title is distinct from new.title or old.body is distinct from new.body then
    insert into article_revisions (shop_id, article_id, title, body, created_by) values (old.shop_id, old.id, old.title, old.body, auth.uid());
    delete from article_revisions r
     where r.article_id = old.id
       and r.id not in (select id from article_revisions where article_id = old.id order by created_at desc, id desc limit banto_page_revisions_max());
  end if;
  return new;
end;
$$;
revoke execute on function banto_article_revision() from public, anon, authenticated;
drop trigger if exists articles_revision on articles;
create trigger articles_revision after update on articles for each row execute function banto_article_revision();

-- ---------- ゴミ箱を空にする（Cron。service_role だけ） ----------
create or replace function articles_purge_trash(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v integer;
begin
  delete from articles where deleted_at is not null and deleted_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v = row_count;
  return v;
end;
$$;
revoke execute on function articles_purge_trash(integer) from public, anon, authenticated;
grant execute on function articles_purge_trash(integer) to service_role;

-- ---------- プランの上限（0079 の差し替え: articles を足す） ----------
create or replace function banto_plan_limits_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare v_key text; v_val jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  for v_key, v_val in select * from jsonb_each(p_value) loop
    if v_key not in ('shops', 'products', 'customers', 'members', 'mail_per_day', 'theme_versions', 'pages', 'articles') then return false; end if;
    if jsonb_typeof(v_val) <> 'number' then return false; end if;
    if (v_val #>> '{}') !~ '^[0-9]+$' then return false; end if;
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
    when 'articles' then select count(*) into v from articles;
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
      'pages', banto_plan_count('pages'),
      'articles', banto_plan_count('articles')));
end;
$$;
revoke execute on function banto_plan_usage() from public, anon;
grant execute on function banto_plan_usage() to authenticated, service_role;

drop trigger if exists articles_plan_limit on articles;
create trigger articles_plan_limit after insert on articles for each statement execute function banto_plan_limit_guard();

-- ---------- お客様の画面（anon）: メニューに出すブログを足す（0080 の差し替え、blogs_nav） ----------
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
         from pages p where p.shop_id = s.id and p.published and p.deleted_at is null
          and (p.published_at is null or p.published_at <= now()) and p.nav <> 'none')
      else '[]'::jsonb end,
    'blogs_nav', case when s.settings->'modules'->'blog' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', b.handle, 'title', b.title, 'nav', b.nav) order by b.sort_order, b.created_at), '[]'::jsonb)
         from blogs b where b.shop_id = s.id and b.nav <> 'none')
      else '[]'::jsonb end);
$$;

insert into banto_migrations (version) values ('0081_mod_blog');
