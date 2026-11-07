-- Banto 0125_blog_date_order: ブログの並び順を日付の項目の順に・今日以降だけ・いつまで出すかの項目（終了日）。メンテナの決定 2026-11-07（docs/blog.md）。前方専用。
--   - blogs.article_order に field:<キー>（日付・日時の項目の早い順）、blogs.article_from_today（今日以降だけ一覧に出す）、
--     blogs.article_until（いつまで出すかの項目。何日も続くイベントの終了日。値の無い記事は並び順の項目で決める）
--   - 一覧・ページ送り・一覧のひな形の記事の並び・::: articles の既定・ヘッドレスがこの順。フィードはいつも新しい順のまま
--   - 会員の一覧（articles_member_page）に p_until_key・p_until_from、AI 用 API（api_blog_update / api_blog_json）に article_from_today・article_until
--   - どの文も繰り返して当てても同じ結果（if not exists・定義し直し）

alter table blogs drop constraint if exists blogs_article_order_check;
alter table blogs add constraint blogs_article_order_check check (article_order in ('new', 'title', 'manual') or article_order ~ '^field:[a-z][a-z0-9_]{0,39}$');
alter table blogs add column if not exists article_from_today boolean not null default false;
-- 今日以降だけのとき「いつまで出すか」の項目（終了日など。日付・日時の項目のキー）。値の無い記事は並び順の項目で決める
alter table blogs add column if not exists article_until text check (article_until is null or article_until ~ '^[a-z][a-z0-9_]{0,39}$');

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
       or v_type is null or v_type not in ('text', 'number', 'select', 'store', 'product', 'article', 'image', 'date', 'datetime')
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
  -- いつまで出すかの項目（0124）も日付・日時の項目だけ
  if new.article_until is not null and not exists (
       select 1 from jsonb_array_elements(new.article_fields) e
        where e->>'key' = new.article_until and e->>'type' in ('date', 'datetime')) then
    raise exception 'invalid_article_until' using errcode = '22023';
  end if;
  -- 並び順 field:<キー>（0124）は日付・日時の項目だけ
  if new.article_order like 'field:%' and not exists (
       select 1 from jsonb_array_elements(new.article_fields) e
        where e->>'key' = substr(new.article_order, 7) and e->>'type' in ('date', 'datetime')) then
    raise exception 'invalid_article_order' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function banto_blog_article_fields_guard() from public, anon, authenticated;
drop trigger if exists blogs_article_fields on blogs;
create trigger blogs_article_fields before insert or update of article_fields, article_order, article_until on blogs
  for each row execute function banto_blog_article_fields_guard();

drop function if exists articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb);
drop function if exists articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb, text);
create or replace function articles_member_page(p_shop_id uuid, p_blog_id uuid, p_offset integer, p_limit integer, p_tag text,
  p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sort text default null, p_fields jsonb default null, p_field_from text default null,
  p_until_key text default null, p_until_from text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_sort text; v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_page: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  if p_sort is not null and p_sort not in ('new', 'title', 'manual') and p_sort !~ '^field:[a-z][a-z0-9_]{0,39}$' then raise exception 'invalid_sort' using errcode = '22023'; end if;
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then raise exception 'invalid_fields' using errcode = '22023'; end if;
  if p_field_from is not null and (p_sort is null or p_sort !~ '^field:' or char_length(p_field_from) > 40) then raise exception 'invalid_field_from' using errcode = '22023'; end if;
  -- いつまで出すかの項目（終了日）: 値があればその値で、無ければ並び順の項目で「今日以降」を決める
  if (p_until_key is null) <> (p_until_from is null) or (p_until_key is not null and (p_field_from is null or p_until_key !~ '^[a-z][a-z0-9_]{0,39}$' or char_length(p_until_from) > 40)) then
    raise exception 'invalid_until' using errcode = '22023';
  end if;
  v_sort := coalesce(p_sort, (select b.article_order from blogs b where b.id = p_blog_id and b.shop_id = p_shop_id), 'new');
  v_key := case when v_sort like 'field:%' then substr(v_sort, 7) end;
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return coalesce((select jsonb_agg(t.x order by t.n) from (
    select jsonb_build_object('id', a.id, 'shop_id', a.shop_id, 'blog_id', a.blog_id, 'handle', a.handle, 'title', a.title, 'body', a.body, 'excerpt', a.excerpt,
      'tags', a.tags, 'image_url', a.image_url, 'author', a.author, 'published_at', a.published_at, 'updated_at', a.updated_at, 'audience_id', a.audience_id,
      'position', a.position, 'fields', a.fields) x,
      row_number() over (order by
        case when v_key is not null then a.fields->>v_key end asc nulls last,
        case when v_sort = 'manual' then a.position end asc,
        case when v_sort = 'title' then a.title end asc,
        a.published_at desc, a.id desc) n
      from articles a
     where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.published and a.deleted_at is null and a.published_at <= now()
       and banto_shop_module_public(p_shop_id, 'blog')
       and (a.audience_id is null or a.audience_id = any(v_aud))
       and (p_tag is null or a.tags @> array[p_tag])
       and (p_fields is null or a.fields @> p_fields)
       and (p_field_from is null or (case when p_until_key is not null and a.fields ? p_until_key then a.fields->>p_until_key >= p_until_from else a.fields->>v_key >= p_field_from end))
     order by n
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb, text, text, text) to service_role;

-- AI 用 API（0118）: 並び順に field:<キー>、article_from_today を読み書き
create or replace function api_blog_json(b blogs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'handle', b.handle, 'title', b.title, 'description', b.description, 'nav', b.nav, 'sort_order', b.sort_order,
                            'seo_title', b.seo_title, 'seo_description', b.seo_description, 'template_suffix', b.template_suffix,
                            'article_order', b.article_order, 'article_from_today', b.article_from_today, 'article_until', b.article_until, 'feed', b.feed, 'article_fields', b.article_fields,
                            'created_at', b.created_at, 'updated_at', b.updated_at);
$$;
revoke execute on function api_blog_json(blogs) from public, anon, authenticated;
create or replace function api_blog_update(p_token_hash text, p_blog text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_fields jsonb; d jsonb; v_target uuid;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_values'; end if;
  if p_values ? 'title' and (jsonb_typeof(p_values->'title') <> 'string' or char_length(btrim(p_values->>'title')) not between 1 and 200) then raise exception 'invalid_title'; end if;
  if p_values ? 'nav' and (jsonb_typeof(p_values->'nav') <> 'string' or p_values->>'nav' not in ('none', 'header', 'footer')) then raise exception 'invalid_nav'; end if;
  if p_values ? 'sort_order' and (jsonb_typeof(p_values->'sort_order') <> 'number' or (p_values->>'sort_order')::numeric <> trunc((p_values->>'sort_order')::numeric) or abs((p_values->>'sort_order')::numeric) > 1000) then raise exception 'invalid_sort_order'; end if;
  if p_values ? 'article_order' and (jsonb_typeof(p_values->'article_order') <> 'string' or (p_values->>'article_order' not in ('new', 'title', 'manual') and p_values->>'article_order' !~ '^field:[a-z][a-z0-9_]{0,39}$')) then raise exception 'invalid_article_order'; end if;
  if p_values ? 'article_from_today' and jsonb_typeof(p_values->'article_from_today') <> 'boolean' then raise exception 'invalid_article_from_today'; end if;
  if p_values ? 'article_until' and not (jsonb_typeof(p_values->'article_until') = 'null' or (jsonb_typeof(p_values->'article_until') = 'string' and p_values->>'article_until' ~ '^[a-z][a-z0-9_]{0,39}$')) then raise exception 'invalid_article_until'; end if;
  if p_values ? 'feed' and jsonb_typeof(p_values->'feed') <> 'boolean' then raise exception 'invalid_feed'; end if;
  if p_values ? 'template_suffix' and not (jsonb_typeof(p_values->'template_suffix') = 'null' or (jsonb_typeof(p_values->'template_suffix') = 'string' and p_values->>'template_suffix' ~ '^[a-z0-9_-]{1,40}$')) then raise exception 'invalid_template_suffix'; end if;
  if exists (select 1 from jsonb_object_keys(p_values) k where k not in ('title', 'description', 'nav', 'sort_order', 'seo_title', 'seo_description', 'template_suffix', 'article_order', 'article_from_today', 'article_until', 'feed', 'article_fields')) then
    raise exception 'invalid_values_unknown_key';
  end if;
  -- 記事の項目の定義: 指すブログは URL の名前か id → id に
  if p_values ? 'article_fields' then
    if jsonb_typeof(p_values->'article_fields') <> 'array' then raise exception 'article_fields_invalid'; end if;
    v_fields := '[]'::jsonb;
    for d in select * from jsonb_array_elements(p_values->'article_fields') loop
      if jsonb_typeof(d) = 'object' and d->>'type' = 'article' and d ? 'blog' then
        select b.id into v_target from blogs b where b.shop_id = v_tok.shop_id and (b.handle = d->>'blog' or b.id::text = d->>'blog');
        if v_target is null then raise exception 'article_fields_invalid:%', coalesce(d->>'key', '') using errcode = '22023'; end if;
        d := d || jsonb_build_object('blog', v_target);
      end if;
      v_fields := v_fields || jsonb_build_array(d);
    end loop;
  end if;
  update blogs set
    title = case when p_values ? 'title' then btrim(p_values->>'title') else title end,
    description = banto_jtext(p_values, 'description', description),
    nav = coalesce(p_values->>'nav', nav),
    sort_order = case when p_values ? 'sort_order' then (p_values->>'sort_order')::integer else sort_order end,
    seo_title = banto_jtext(p_values, 'seo_title', seo_title),
    seo_description = banto_jtext(p_values, 'seo_description', seo_description),
    template_suffix = banto_jtext(p_values, 'template_suffix', template_suffix),
    article_order = coalesce(p_values->>'article_order', article_order),
    article_from_today = case when p_values ? 'article_from_today' then (p_values->>'article_from_today')::boolean else article_from_today end,
    article_until = case when p_values ? 'article_until' then p_values->>'article_until' else article_until end,
    feed = case when p_values ? 'feed' then (p_values->>'feed')::boolean else feed end,
    article_fields = coalesce(v_fields, article_fields)
  where id = v_b.id
  returning * into v_b;
  return api_blog_json(v_b);
end;
$$;
revoke execute on function api_blog_update(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_blog_update(text, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0125_blog_date_order');
