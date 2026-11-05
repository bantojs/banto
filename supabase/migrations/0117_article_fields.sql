-- Banto 0117_article_fields: ブログの記事の独自の項目。メンテナの決定 2026-11-05（docs/blog.md「記事の項目」）。前方専用。
--   - 定義はブログごと（blogs.article_fields）。スタッフ紹介と着こなしでは要る項目が違うため。20 まで
--     [{ "key", "label", "type": text | number | select | store | product | article, "options"（select）, "blog"（article が指すブログの id）, "multiple"（product / article） }]
--   - 値は記事（articles.fields = { <key>: 値 }）。書くときにトリガーが定義に合わせて整え、指す先を確かめる:
--     text は 500 字まで / number は数 / select は選択肢のどれか / store はこのショップで使う実店舗の id /
--     product はこのショップの商品の URL の名前（multiple なら配列、24 まで）/ article は定義のブログの記事の URL の名前（同じ）。
--     定義に無い鍵は捨てる。空は持たない。合わなければ article_field_invalid:<key>
--   - 記事はお客様に公開する読み物なので、項目もすべて公開（非公開の項目は持たない。秘密を書かない）
--   - 絞り込みは fields @> {…}（GIN の索引）。会員の一覧（articles_member_page）にも p_fields を足す
--   - AI 用 API: 記事の保存で fields、記事とブログの JSON に fields / article_fields

alter table blogs add column if not exists article_fields jsonb not null default '[]'::jsonb;
alter table articles add column if not exists fields jsonb not null default '{}'::jsonb;
alter table articles drop constraint if exists articles_fields_object;
alter table articles add constraint articles_fields_object check (jsonb_typeof(fields) = 'object');
create index if not exists articles_fields on articles using gin (fields jsonb_path_ops);

-- 定義の形（ブログの行を書くとき）。指すブログは同じショップのものだけ
create or replace function banto_blog_article_fields_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare d jsonb; v_keys text[] := '{}'; v_key text; v_type text;
begin
  if jsonb_typeof(new.article_fields) <> 'array' or jsonb_array_length(new.article_fields) > 20 then
    raise exception 'article_fields_invalid' using errcode = '22023';
  end if;
  for d in select * from jsonb_array_elements(new.article_fields) loop
    if jsonb_typeof(d) <> 'object' then raise exception 'article_fields_invalid' using errcode = '22023'; end if;
    v_key := d->>'key';
    v_type := d->>'type';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' or v_key = any(v_keys)
       or coalesce(char_length(btrim(d->>'label')), 0) not between 1 and 60
       or v_type is null or v_type not in ('text', 'number', 'select', 'store', 'product', 'article')
       or (d ? 'multiple' and jsonb_typeof(d->'multiple') <> 'boolean')
       or (coalesce((d->>'multiple')::boolean, false) and v_type not in ('product', 'article')) then
      raise exception 'article_fields_invalid:%', coalesce(v_key, '') using errcode = '22023';
    end if;
    if v_type = 'select' and not coalesce(
         jsonb_typeof(d->'options') = 'array' and jsonb_array_length(d->'options') between 1 and 50
         and not exists (select 1 from jsonb_array_elements(d->'options') o where jsonb_typeof(o) <> 'string' or char_length(btrim(o #>> '{}')) not between 1 and 60), false) then
      raise exception 'article_fields_invalid:%', v_key using errcode = '22023';
    end if;
    if v_type = 'article' and not coalesce(
         (d->>'blog') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and exists (select 1 from blogs b where b.id = (d->>'blog')::uuid and b.shop_id = new.shop_id), false) then
      raise exception 'article_fields_invalid:%', v_key using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
  end loop;
  return new;
end;
$$;
revoke execute on function banto_blog_article_fields_guard() from public, anon, authenticated;
drop trigger if exists blogs_article_fields on blogs;
create trigger blogs_article_fields before insert or update of article_fields on blogs
  for each row execute function banto_blog_article_fields_guard();

-- 値を定義に合わせて整える（記事を書くとき）
create or replace function banto_article_fields_norm()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_defs jsonb; d jsonb; v_key text; v_type text; v_multi boolean; v jsonb; v_out jsonb := '{}'::jsonb; v_list text[]; x text; n numeric; v_max integer;
begin
  if tg_op = 'UPDATE' and new.fields is not distinct from old.fields and new.blog_id is not distinct from old.blog_id then return new; end if;
  if new.fields is null or jsonb_typeof(new.fields) <> 'object' then raise exception 'article_fields_invalid' using errcode = '22023'; end if;
  select article_fields into v_defs from blogs where id = new.blog_id;
  for d in select * from jsonb_array_elements(coalesce(v_defs, '[]'::jsonb)) loop
    v_key := d->>'key';
    v_type := d->>'type';
    v_multi := coalesce((d->>'multiple')::boolean, false);
    v := new.fields->v_key;
    if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0) then
      continue;
    end if;
    if v_type = 'text' then
      if jsonb_typeof(v) not in ('string', 'number') or char_length(v #>> '{}') > 500 then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, btrim(v #>> '{}'));
    elsif v_type = 'number' then
      begin
        n := (v #>> '{}')::numeric;
      exception when others then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end;
      if jsonb_typeof(v) not in ('string', 'number') or abs(n) > 1e12 then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, n);
    elsif v_type = 'select' then
      if jsonb_typeof(v) <> 'string' or not (d->'options' ? (v #>> '{}')) then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    elsif v_type = 'store' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from shop_stores ss where ss.shop_id = new.shop_id and ss.store_id = (v #>> '{}')::uuid) then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    else
      -- product / article: URL の名前（multiple なら配列）。書いた順のまま、重なりは除く
      if jsonb_typeof(v) = 'string' then v_list := array[v #>> '{}'];
      elsif jsonb_typeof(v) = 'array' and not exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
        select array_agg(s order by o) into v_list from (select distinct on (e #>> '{}') e #>> '{}' as s, o from jsonb_array_elements(v) with ordinality t(e, o) order by e #>> '{}', o) q;
      else raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_max := case when v_multi then 24 else 1 end;
      if cardinality(v_list) > v_max then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      foreach x in array v_list loop
        if x !~ '^[a-z0-9][a-z0-9-]{0,62}$'
           or (v_type = 'product' and not exists (select 1 from products p where p.shop_id = new.shop_id and p.slug = x))
           or (v_type = 'article' and not exists (select 1 from articles a where a.blog_id = (d->>'blog')::uuid and a.shop_id = new.shop_id and a.handle = x and a.deleted_at is null)) then
          raise exception 'article_field_invalid:%', v_key using errcode = '22023';
        end if;
      end loop;
      v_out := v_out || jsonb_build_object(v_key, case when v_multi then to_jsonb(v_list) else to_jsonb(v_list[1]) end);
    end if;
  end loop;
  new.fields := v_out;
  return new;
end;
$$;
revoke execute on function banto_article_fields_norm() from public, anon, authenticated;
drop trigger if exists articles_fields_norm on articles;
create trigger articles_fields_norm before insert or update on articles
  for each row execute function banto_article_fields_norm();

-- 会員の一覧（0116）: 項目で絞る p_fields（fields @> p_fields）と、返す形に fields
drop function if exists articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text);
create or replace function articles_member_page(p_shop_id uuid, p_blog_id uuid, p_offset integer, p_limit integer, p_tag text,
  p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sort text default null, p_fields jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_sort text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_page: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  if p_sort is not null and p_sort not in ('new', 'title', 'manual') then raise exception 'invalid_sort' using errcode = '22023'; end if;
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then raise exception 'invalid_fields' using errcode = '22023'; end if;
  v_sort := coalesce(p_sort, (select b.article_order from blogs b where b.id = p_blog_id and b.shop_id = p_shop_id), 'new');
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return coalesce((select jsonb_agg(t.x order by t.n) from (
    select jsonb_build_object('id', a.id, 'shop_id', a.shop_id, 'blog_id', a.blog_id, 'handle', a.handle, 'title', a.title, 'body', a.body, 'excerpt', a.excerpt,
      'tags', a.tags, 'image_url', a.image_url, 'author', a.author, 'published_at', a.published_at, 'updated_at', a.updated_at, 'audience_id', a.audience_id,
      'position', a.position, 'fields', a.fields) x,
      row_number() over (order by
        case when v_sort = 'manual' then a.position end asc,
        case when v_sort = 'title' then a.title end asc,
        a.published_at desc, a.id desc) n
      from articles a
     where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.published and a.deleted_at is null and a.published_at <= now()
       and banto_shop_module_public(p_shop_id, 'blog')
       and (a.audience_id is null or a.audience_id = any(v_aud))
       and (p_tag is null or a.tags @> array[p_tag])
       and (p_fields is null or a.fields @> p_fields)
     order by n
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb) to service_role;

-- AI 用 API（0083）: ブログの定義・記事の項目を JSON に、記事の保存で fields
create or replace function api_blog_json(b blogs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'handle', b.handle, 'title', b.title, 'description', b.description, 'nav', b.nav, 'sort_order', b.sort_order,
                            'seo_title', b.seo_title, 'seo_description', b.seo_description, 'template_suffix', b.template_suffix,
                            'article_order', b.article_order, 'feed', b.feed, 'article_fields', b.article_fields,
                            'created_at', b.created_at, 'updated_at', b.updated_at);
$$;
create or replace function api_article_json(a articles, p_blog text, p_body boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'blog', p_blog, 'handle', a.handle, 'title', a.title, 'excerpt', a.excerpt, 'tags', to_jsonb(a.tags), 'author', a.author,
    'image_url', a.image_url, 'seo_title', a.seo_title, 'seo_description', a.seo_description, 'template_suffix', a.template_suffix,
    'published', a.published, 'published_at', a.published_at, 'deleted_at', a.deleted_at, 'fields', a.fields, 'position', a.position,
    'status', banto_content_status(a.published, a.published_at, a.deleted_at),
    'created_at', a.created_at, 'updated_at', a.updated_at)
    || case when p_body then jsonb_build_object('body', a.body) else '{}'::jsonb end;
$$;
create or replace function api_article_save(p_token_hash text, p_blog text, p_article jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_a articles%rowtype; v_found boolean := false; v_tags text[];
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  perform api_content_check(p_article, 'article');
  if p_article ? 'fields' and jsonb_typeof(p_article->'fields') <> 'object' then raise exception 'invalid_fields'; end if;
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
    insert into articles (shop_id, blog_id, handle, title, body, excerpt, tags, author, image_url, seo_title, seo_description, template_suffix, published, published_at, fields)
    values (v_tok.shop_id, v_b.id, p_article->>'handle', btrim(p_article->>'title'), coalesce(p_article->>'body', ''),
            banto_jtext(p_article, 'excerpt', null), coalesce(v_tags, '{}'), banto_jtext(p_article, 'author', null), banto_jtext(p_article, 'image_url', null),
            banto_jtext(p_article, 'seo_title', null), banto_jtext(p_article, 'seo_description', null), banto_jtext(p_article, 'template_suffix', null),
            coalesce((p_article->>'published')::boolean, false), banto_jtext(p_article, 'published_at', null)::timestamptz,
            coalesce(p_article->'fields', '{}'::jsonb))
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
      published_at = case when p_article ? 'published_at' then banto_jtext(p_article, 'published_at', null)::timestamptz else published_at end,
      fields = case when p_article ? 'fields' then p_article->'fields' else fields end
    where id = v_a.id
    returning * into v_a;
  end if;
  return api_article_json(v_a, v_b.handle, true);
end;
$$;

insert into banto_migrations (version) values ('0117_article_fields');
