-- Banto 0083_api_content: ページ・ブログの記事を AI 用トークンで読み書きする（メンテナの決定 2026-10-31、docs/ai-access.md §9）。前方専用。
--   - スコープ content:read（一覧・1 つ・下書きやゴミ箱も読める）と content:write（作る・直す・公開・予約・ゴミ箱へ）。
--     公開も content:write に含める（products:write が商品を公開できるのと同じ。本文に生の HTML は書けないので、書き込みで外に出るのは公開だけ）
--   - どちらも権限の項目 content（0079）。発行者が content を持つ間だけ効く（banto_token_scope_ok）
--   - ページはモジュール pages、ブログ・記事はモジュール blog が ON のショップだけ（OFF なら module_disabled。管理画面と同じ）
--   - ブログそのものを作る・消すのは管理画面だけ（API はブログの一覧と、ブログの中の記事）
--   - 消すのはゴミ箱へ移すだけ（0080 / 0081 の 30 日で消える仕組みのまま。戻すのは管理画面）
--   - アイキャッチの URL がショップの画像の置き場のものかは Worker が確かめる（管理画面と同じ shopImageUrl）。本文の画像は描くときに捨てる
--   - リビジョン（page_revisions / article_revisions）は今までどおりトリガーが書く

-- ---------- スコープ ----------
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write']::text[]
);

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
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
    when 'content:read' then 'content'
    when 'content:write' then 'content'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- ---------- 共通 ----------
-- トークンとモジュール（pages / blog）を確かめる
create or replace function api_content_require(p_token_hash text, p_scope text, p_module text)
returns api_tokens language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, p_scope);
  if not exists (select 1 from shops where id = v_tok.shop_id and settings->'modules'->p_module = 'true'::jsonb) then
    raise exception 'module_disabled';
  end if;
  return v_tok;
end;
$$;
revoke execute on function api_content_require(text, text, text) from public, anon, authenticated;

-- 状態（管理画面の一覧のタブと同じ: published / scheduled / draft / trash）
create or replace function banto_content_status(p_published boolean, p_published_at timestamptz, p_deleted_at timestamptz)
returns text language sql stable as $$
  select case when p_deleted_at is not null then 'trash'
              when not p_published then 'draft'
              when p_published_at is not null and p_published_at > now() then 'scheduled'
              else 'published' end;
$$;
revoke execute on function banto_content_status(boolean, timestamptz, timestamptz) from public, anon, authenticated;

-- 一覧の状態の絞り込み（all はゴミ箱の外すべて）
create or replace function banto_content_status_ok(p_status text, p_published boolean, p_published_at timestamptz, p_deleted_at timestamptz)
returns boolean language sql stable as $$
  select case coalesce(p_status, 'all')
           when 'all' then p_deleted_at is null
           else banto_content_status(p_published, p_published_at, p_deleted_at) = p_status end;
$$;
revoke execute on function banto_content_status_ok(text, boolean, timestamptz, timestamptz) from public, anon, authenticated;

-- 送られた値の形（ページと記事で共通の鍵。無い鍵は見ない）。誤りは invalid_<鍵> で返す
create or replace function api_content_check(p jsonb, p_kind text)
returns void language plpgsql stable as $$
declare v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_values'; end if;
  if p ? 'handle' then
    if jsonb_typeof(p->'handle') <> 'string' then raise exception 'invalid_handle'; end if;
    v := p->>'handle';
    if p_kind = 'page' and not banto_page_handle_ok(v) then raise exception 'invalid_handle'; end if;
    if p_kind = 'article' and (v !~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' or v = 'feed') then raise exception 'invalid_handle'; end if;
  end if;
  if p ? 'title' and (jsonb_typeof(p->'title') <> 'string' or char_length(btrim(p->>'title')) not between 1 and 200) then raise exception 'invalid_title'; end if;
  if p ? 'body' and (jsonb_typeof(p->'body') <> 'string' or char_length(p->>'body') > 50000) then raise exception 'invalid_content_body'; end if;
  if p ? 'seo_title' and not (jsonb_typeof(p->'seo_title') = 'null' or (jsonb_typeof(p->'seo_title') = 'string' and char_length(p->>'seo_title') <= 200)) then raise exception 'invalid_seo_title'; end if;
  if p ? 'seo_description' and not (jsonb_typeof(p->'seo_description') = 'null' or (jsonb_typeof(p->'seo_description') = 'string' and char_length(p->>'seo_description') <= 500)) then raise exception 'invalid_seo_description'; end if;
  if p ? 'template_suffix' and not (jsonb_typeof(p->'template_suffix') = 'null' or (jsonb_typeof(p->'template_suffix') = 'string' and p->>'template_suffix' ~ '^[a-z0-9_-]{1,40}$')) then raise exception 'invalid_template_suffix'; end if;
  if p ? 'image_url' and not (jsonb_typeof(p->'image_url') = 'null' or (jsonb_typeof(p->'image_url') = 'string' and char_length(p->>'image_url') <= 2000 and p->>'image_url' ~ '^(https?://|/)[^\s<>"''`]*$')) then raise exception 'invalid_image_url'; end if;
  if p ? 'published' and jsonb_typeof(p->'published') <> 'boolean' then raise exception 'invalid_published'; end if;
  if p ? 'published_at' and jsonb_typeof(p->'published_at') <> 'null' then
    if jsonb_typeof(p->'published_at') <> 'string' then raise exception 'invalid_published_at'; end if;
    begin
      perform (p->>'published_at')::timestamptz;
    exception when others then
      raise exception 'invalid_published_at';
    end;
  end if;
  if p_kind = 'page' then
    if p ? 'nav' and (jsonb_typeof(p->'nav') <> 'string' or p->>'nav' not in ('none', 'header', 'footer')) then raise exception 'invalid_nav'; end if;
    if p ? 'sort_order' and (jsonb_typeof(p->'sort_order') <> 'number' or (p->>'sort_order')::numeric <> trunc((p->>'sort_order')::numeric) or abs((p->>'sort_order')::numeric) > 1000000) then raise exception 'invalid_sort_order'; end if;
  else
    if p ? 'excerpt' and not (jsonb_typeof(p->'excerpt') = 'null' or (jsonb_typeof(p->'excerpt') = 'string' and char_length(p->>'excerpt') <= 1000)) then raise exception 'invalid_excerpt'; end if;
    if p ? 'author' and not (jsonb_typeof(p->'author') = 'null' or (jsonb_typeof(p->'author') = 'string' and char_length(p->>'author') <= 100)) then raise exception 'invalid_author'; end if;
    if p ? 'tags' and (jsonb_typeof(p->'tags') <> 'array' or jsonb_array_length(p->'tags') > 20
                       or exists (select 1 from jsonb_array_elements(p->'tags') t where jsonb_typeof(t) <> 'string' or char_length(btrim(t #>> '{}')) > 50)) then
      raise exception 'invalid_tags';
    end if;
  end if;
end;
$$;
revoke execute on function api_content_check(jsonb, text) from public, anon, authenticated;

-- 値を取り出す（鍵が無ければ今の値のまま）
create or replace function banto_jtext(p jsonb, k text, cur text)
returns text language sql immutable as $$
  select case when p ? k then (case when jsonb_typeof(p->k) = 'null' then null else p->>k end) else cur end;
$$;
revoke execute on function banto_jtext(jsonb, text, text) from public, anon, authenticated;

-- ---------- ページ ----------
create or replace function api_page_json(p pages, p_body boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'handle', p.handle, 'title', p.title, 'nav', p.nav, 'sort_order', p.sort_order, 'template_suffix', p.template_suffix,
    'seo_title', p.seo_title, 'seo_description', p.seo_description, 'image_url', p.image_url,
    'published', p.published, 'published_at', p.published_at, 'deleted_at', p.deleted_at,
    'status', banto_content_status(p.published, p.published_at, p.deleted_at),
    'created_at', p.created_at, 'updated_at', p.updated_at)
    || case when p_body then jsonb_build_object('body', p.body) else '{}'::jsonb end;
$$;
revoke execute on function api_page_json(pages, boolean) from public, anon, authenticated;

-- 一覧（並び順。本文は持たない）。p_status: all（既定・ゴミ箱の外）/ published / scheduled / draft / trash
create or replace function api_pages_list(p_token_hash text, p_status text, p_query text, p_limit integer, p_offset integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'pages');
  if coalesce(p_status, 'all') not in ('all', 'published', 'scheduled', 'draft', 'trash') then raise exception 'invalid_status'; end if;
  return (
    with m as (
      select * from pages p
       where p.shop_id = v_tok.shop_id
         and banto_content_status_ok(p_status, p.published, p.published_at, p.deleted_at)
         and (nullif(btrim(p_query), '') is null or p.title ilike '%' || btrim(p_query) || '%' or p.handle ilike '%' || btrim(p_query) || '%')
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(api_page_json(x, false) order by x.sort_order, x.created_at, x.id)
                           from (select * from m order by sort_order, created_at, id limit v_limit offset v_offset) x), '[]'::jsonb),
      'total', (select count(*) from m), 'limit', v_limit, 'offset', v_offset)
  );
end;
$$;

-- 1 つ（id か handle。handle はゴミ箱の外から）
create or replace function api_page_get(p_token_hash text, p_page text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_p pages%rowtype;
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'pages');
  if p_page ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_p from pages where id = p_page::uuid and shop_id = v_tok.shop_id;
  else
    select * into v_p from pages where handle = p_page and shop_id = v_tok.shop_id and deleted_at is null;
  end if;
  if not found then raise exception 'not_found'; end if;
  return api_page_json(v_p, true);
end;
$$;

-- 作る・直す。id があればそのページ、無ければ handle が同じゴミ箱の外のページを直し、無ければ作る（作るときは handle と title が要る）。
-- 送らなかった鍵は今のまま。ゴミ箱の中のページは直せない（not_found）
create or replace function api_page_save(p_token_hash text, p_page jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_p pages%rowtype; v_found boolean := false;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'pages');
  perform api_content_check(p_page, 'page');
  if p_page ? 'id' then
    if coalesce(p_page->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'not_found'; end if;
    select * into v_p from pages where id = (p_page->>'id')::uuid and shop_id = v_tok.shop_id and deleted_at is null for update;
    if not found then raise exception 'not_found'; end if;
    v_found := true;
  elsif p_page ? 'handle' then
    select * into v_p from pages where shop_id = v_tok.shop_id and handle = p_page->>'handle' and deleted_at is null for update;
    v_found := found;
  end if;
  if p_page ? 'handle' and exists (select 1 from pages where shop_id = v_tok.shop_id and handle = p_page->>'handle' and deleted_at is null and (not v_found or id <> v_p.id)) then
    raise exception 'handle_taken';
  end if;
  if not v_found then
    if not (p_page ? 'handle' and p_page ? 'title') then raise exception 'invalid_values_handle_title_required'; end if;
    insert into pages (shop_id, handle, title, body, seo_title, seo_description, template_suffix, nav, sort_order, published, published_at, image_url)
    values (v_tok.shop_id, p_page->>'handle', btrim(p_page->>'title'), coalesce(p_page->>'body', ''),
            banto_jtext(p_page, 'seo_title', null), banto_jtext(p_page, 'seo_description', null), banto_jtext(p_page, 'template_suffix', null),
            coalesce(p_page->>'nav', 'none'), coalesce((p_page->>'sort_order')::integer, 0), coalesce((p_page->>'published')::boolean, false),
            banto_jtext(p_page, 'published_at', null)::timestamptz, banto_jtext(p_page, 'image_url', null))
    returning * into v_p;
  else
    update pages set
      handle = banto_jtext(p_page, 'handle', handle),
      title = case when p_page ? 'title' then btrim(p_page->>'title') else title end,
      body = case when p_page ? 'body' then p_page->>'body' else body end,
      seo_title = banto_jtext(p_page, 'seo_title', seo_title),
      seo_description = banto_jtext(p_page, 'seo_description', seo_description),
      template_suffix = banto_jtext(p_page, 'template_suffix', template_suffix),
      nav = case when p_page ? 'nav' then p_page->>'nav' else nav end,
      sort_order = case when p_page ? 'sort_order' then (p_page->>'sort_order')::integer else sort_order end,
      published = case when p_page ? 'published' then (p_page->>'published')::boolean else published end,
      published_at = case when p_page ? 'published_at' then banto_jtext(p_page, 'published_at', null)::timestamptz else published_at end,
      image_url = banto_jtext(p_page, 'image_url', image_url),
      updated_at = now()
    where id = v_p.id
    returning * into v_p;
  end if;
  return api_page_json(v_p, true);
end;
$$;

-- ゴミ箱へ（30 日で消える。戻すのは管理画面）
create or replace function api_page_trash(p_token_hash text, p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_p pages%rowtype;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'pages');
  update pages set deleted_at = coalesce(deleted_at, now()) where id = p_page_id and shop_id = v_tok.shop_id returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  return api_page_json(v_p, false);
end;
$$;

-- ---------- ブログ・記事 ----------
create or replace function api_blog_json(b blogs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'handle', b.handle, 'title', b.title, 'description', b.description, 'nav', b.nav, 'sort_order', b.sort_order,
                            'seo_title', b.seo_title, 'seo_description', b.seo_description, 'template_suffix', b.template_suffix,
                            'created_at', b.created_at, 'updated_at', b.updated_at);
$$;
revoke execute on function api_blog_json(blogs) from public, anon, authenticated;

create or replace function api_article_json(a articles, p_blog text, p_body boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'blog', p_blog, 'handle', a.handle, 'title', a.title, 'excerpt', a.excerpt, 'tags', to_jsonb(a.tags), 'author', a.author,
    'image_url', a.image_url, 'seo_title', a.seo_title, 'seo_description', a.seo_description, 'template_suffix', a.template_suffix,
    'published', a.published, 'published_at', a.published_at, 'deleted_at', a.deleted_at,
    'status', banto_content_status(a.published, a.published_at, a.deleted_at),
    'created_at', a.created_at, 'updated_at', a.updated_at)
    || case when p_body then jsonb_build_object('body', a.body) else '{}'::jsonb end;
$$;
revoke execute on function api_article_json(articles, text, boolean) from public, anon, authenticated;

-- ブログ（handle）を自分のショップから引く
create or replace function api_blog_of(p_shop_id uuid, p_blog text)
returns blogs language plpgsql stable security definer set search_path = public as $$
declare v_b blogs%rowtype;
begin
  select * into v_b from blogs where shop_id = p_shop_id and handle = p_blog;
  if not found then raise exception 'not_found'; end if;
  return v_b;
end;
$$;
revoke execute on function api_blog_of(uuid, text) from public, anon, authenticated;

create or replace function api_blogs_list(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'blog');
  return jsonb_build_object('items', coalesce((select jsonb_agg(api_blog_json(b) || jsonb_build_object('articles', (select count(*) from articles a where a.blog_id = b.id and a.deleted_at is null))
                                                                order by b.sort_order, b.created_at, b.id)
                                                 from blogs b where b.shop_id = v_tok.shop_id), '[]'::jsonb));
end;
$$;

-- 記事の一覧（公開した日時の新しい順。下書きは作った日時）。本文は持たない
create or replace function api_articles_list(p_token_hash text, p_blog text, p_status text, p_query text, p_tag text, p_limit integer, p_offset integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  if coalesce(p_status, 'all') not in ('all', 'published', 'scheduled', 'draft', 'trash') then raise exception 'invalid_status'; end if;
  return (
    with m as (
      select * from articles a
       where a.blog_id = v_b.id and a.shop_id = v_tok.shop_id
         and banto_content_status_ok(p_status, a.published, a.published_at, a.deleted_at)
         and (nullif(btrim(p_query), '') is null or a.title ilike '%' || btrim(p_query) || '%' or a.handle ilike '%' || btrim(p_query) || '%')
         and (nullif(btrim(p_tag), '') is null or btrim(p_tag) = any(a.tags))
    )
    select jsonb_build_object(
      'blog', api_blog_json(v_b),
      'items', coalesce((select jsonb_agg(api_article_json(x, v_b.handle, false) order by coalesce(x.published_at, x.created_at) desc, x.id desc)
                           from (select * from m order by coalesce(published_at, created_at) desc, id desc limit v_limit offset v_offset) x), '[]'::jsonb),
      'total', (select count(*) from m), 'limit', v_limit, 'offset', v_offset)
  );
end;
$$;

create or replace function api_article_get(p_token_hash text, p_blog text, p_article text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_a articles%rowtype;
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  if p_article ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_a from articles where id = p_article::uuid and blog_id = v_b.id;
  else
    select * into v_a from articles where handle = p_article and blog_id = v_b.id and deleted_at is null;
  end if;
  if not found then raise exception 'not_found'; end if;
  return api_article_json(v_a, v_b.handle, true);
end;
$$;

-- 作る・直す（ページと同じ決まり。ブログは handle で指す。公開して published_at が無ければトリガーが今を入れる）
create or replace function api_article_save(p_token_hash text, p_blog text, p_article jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_a articles%rowtype; v_found boolean := false; v_tags text[];
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  perform api_content_check(p_article, 'article');
  if p_article ? 'id' then
    if coalesce(p_article->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'not_found'; end if;
    select * into v_a from articles where id = (p_article->>'id')::uuid and blog_id = v_b.id and deleted_at is null for update;
    if not found then raise exception 'not_found'; end if;
    v_found := true;
  elsif p_article ? 'handle' then
    select * into v_a from articles where blog_id = v_b.id and handle = p_article->>'handle' and deleted_at is null for update;
    v_found := found;
  end if;
  if p_article ? 'handle' and exists (select 1 from articles where blog_id = v_b.id and handle = p_article->>'handle' and deleted_at is null and (not v_found or id <> v_a.id)) then
    raise exception 'handle_taken';
  end if;
  if p_article ? 'tags' then
    select coalesce(array_agg(t #>> '{}'), '{}') into v_tags from jsonb_array_elements(p_article->'tags') t;
  end if;
  if not v_found then
    if not (p_article ? 'handle' and p_article ? 'title') then raise exception 'invalid_values_handle_title_required'; end if;
    insert into articles (shop_id, blog_id, handle, title, body, excerpt, tags, author, image_url, seo_title, seo_description, template_suffix, published, published_at)
    values (v_tok.shop_id, v_b.id, p_article->>'handle', btrim(p_article->>'title'), coalesce(p_article->>'body', ''),
            banto_jtext(p_article, 'excerpt', null), coalesce(v_tags, '{}'), banto_jtext(p_article, 'author', null), banto_jtext(p_article, 'image_url', null),
            banto_jtext(p_article, 'seo_title', null), banto_jtext(p_article, 'seo_description', null), banto_jtext(p_article, 'template_suffix', null),
            coalesce((p_article->>'published')::boolean, false), banto_jtext(p_article, 'published_at', null)::timestamptz)
    returning * into v_a;
  else
    update articles set
      handle = banto_jtext(p_article, 'handle', handle),
      title = case when p_article ? 'title' then btrim(p_article->>'title') else title end,
      body = case when p_article ? 'body' then p_article->>'body' else body end,
      excerpt = banto_jtext(p_article, 'excerpt', excerpt),
      tags = case when p_article ? 'tags' then v_tags else tags end,
      author = banto_jtext(p_article, 'author', author),
      image_url = banto_jtext(p_article, 'image_url', image_url),
      seo_title = banto_jtext(p_article, 'seo_title', seo_title),
      seo_description = banto_jtext(p_article, 'seo_description', seo_description),
      template_suffix = banto_jtext(p_article, 'template_suffix', template_suffix),
      published = case when p_article ? 'published' then (p_article->>'published')::boolean else published end,
      published_at = case when p_article ? 'published_at' then banto_jtext(p_article, 'published_at', null)::timestamptz else published_at end
    where id = v_a.id
    returning * into v_a;
  end if;
  return api_article_json(v_a, v_b.handle, true);
end;
$$;

create or replace function api_article_trash(p_token_hash text, p_blog text, p_article_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_a articles%rowtype;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  update articles set deleted_at = coalesce(deleted_at, now()) where id = p_article_id and blog_id = v_b.id returning * into v_a;
  if not found then raise exception 'not_found'; end if;
  return api_article_json(v_a, v_b.handle, false);
end;
$$;

revoke execute on function api_pages_list(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_pages_list(text, text, text, integer, integer) to service_role;
revoke execute on function api_page_get(text, text) from public, anon, authenticated;
grant execute on function api_page_get(text, text) to service_role;
revoke execute on function api_page_save(text, jsonb) from public, anon, authenticated;
grant execute on function api_page_save(text, jsonb) to service_role;
revoke execute on function api_page_trash(text, uuid) from public, anon, authenticated;
grant execute on function api_page_trash(text, uuid) to service_role;
revoke execute on function api_blogs_list(text) from public, anon, authenticated;
grant execute on function api_blogs_list(text) to service_role;
revoke execute on function api_articles_list(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_articles_list(text, text, text, text, text, integer, integer) to service_role;
revoke execute on function api_article_get(text, text, text) from public, anon, authenticated;
grant execute on function api_article_get(text, text, text) to service_role;
revoke execute on function api_article_save(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_article_save(text, text, jsonb) to service_role;
revoke execute on function api_article_trash(text, text, uuid) from public, anon, authenticated;
grant execute on function api_article_trash(text, text, uuid) to service_role;

insert into banto_migrations (version) values ('0083_api_content');
