-- Banto 0124_article_field_dates: 記事の項目に日付（date）と日時（datetime）の種類を足す。メンテナの決定 2026-11-07（docs/blog.md「記事の項目」）。前方専用。
--   - date は YYYY-MM-DD、datetime は時差つきで受けて UTC の YYYY-MM-DDTHH:MI:SSZ にそろえて置く（文字のまま比べて順になる）
--   - 並べ替え（::: articles sort=field:<キー>、早い順）と「今日以降だけ」（from=today）は、匿名の経路は PostgREST の order / gte、会員の経路は articles_member_page
--   - ブログの並び順（0116 の article_order）に field:<キー>（日付・日時の項目の早い順）と、blogs.article_from_today（今日以降だけ一覧に出す）を足す。
--     一覧・ページ送り・一覧のひな形の記事の並び・::: articles の既定・ヘッドレスがこの順。フィードはいつも新しい順のまま
--   - 0120 の banto_blog_article_fields_guard と banto_article_fields_norm を定義し直す（ガードは article_order の変更でも動くようにする）

alter table blogs drop constraint if exists blogs_article_order_check;
alter table blogs add constraint blogs_article_order_check check (article_order in ('new', 'title', 'manual') or article_order ~ '^field:[a-z][a-z0-9_]{0,39}$');
alter table blogs add column if not exists article_from_today boolean not null default false;

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
create trigger blogs_article_fields before insert or update of article_fields, article_order on blogs
  for each row execute function banto_blog_article_fields_guard();

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
    elsif v_type = 'image' then
      -- 画像の URL（Worker がこのショップの画像の置き場のものに整えてから書く。ここは形だけ: /media/ か http(s)、空白・引用符・山かっこ・.. なし）
      if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 2000
         or (v #>> '{}') !~ '^(/media/|https?://)[^[:space:]"''<>`\\]+$' or position('..' in (v #>> '{}')) > 0 then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    elsif v_type = 'date' then
      -- 日付（YYYY-MM-DD。ありえない日付は断る）。文字のまま比べても日付の順になる
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      begin
        if to_char((v #>> '{}')::date, 'YYYY-MM-DD') <> (v #>> '{}') then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    elsif v_type = 'datetime' then
      -- 日時（時差つきの ISO 8601 だけ。時差の無いものは断る）。UTC の YYYY-MM-DDTHH:MI:SSZ にそろえて置く（文字のまま比べても時刻の順になる）
      if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 40
         or (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      begin
        v_out := v_out || jsonb_build_object(v_key, to_char((v #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end;
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

-- 会員の読み取りの記事の一覧（0117）に、日付の項目での並べ替え（p_sort = 'field:<キー>'、早い順、値の無い記事は後ろ）と
-- 「その値以降だけ」（p_field_from。Worker が今日の始まりを日付か UTC の日時の文字で渡す）を足す。匿名の経路（PostgREST）と同じ並び
drop function if exists articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb);
create or replace function articles_member_page(p_shop_id uuid, p_blog_id uuid, p_offset integer, p_limit integer, p_tag text,
  p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sort text default null, p_fields jsonb default null, p_field_from text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_sort text; v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_page: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  if p_sort is not null and p_sort not in ('new', 'title', 'manual') and p_sort !~ '^field:[a-z][a-z0-9_]{0,39}$' then raise exception 'invalid_sort' using errcode = '22023'; end if;
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then raise exception 'invalid_fields' using errcode = '22023'; end if;
  if p_field_from is not null and (p_sort is null or p_sort !~ '^field:' or char_length(p_field_from) > 40) then raise exception 'invalid_field_from' using errcode = '22023'; end if;
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
       and (p_field_from is null or a.fields->>v_key >= p_field_from)
     order by n
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text, jsonb, text) to service_role;

-- AI 用 API（0118）: 並び順に field:<キー>、article_from_today を読み書き
create or replace function api_blog_json(b blogs)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'handle', b.handle, 'title', b.title, 'description', b.description, 'nav', b.nav, 'sort_order', b.sort_order,
                            'seo_title', b.seo_title, 'seo_description', b.seo_description, 'template_suffix', b.template_suffix,
                            'article_order', b.article_order, 'article_from_today', b.article_from_today, 'feed', b.feed, 'article_fields', b.article_fields,
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
  if p_values ? 'feed' and jsonb_typeof(p_values->'feed') <> 'boolean' then raise exception 'invalid_feed'; end if;
  if p_values ? 'template_suffix' and not (jsonb_typeof(p_values->'template_suffix') = 'null' or (jsonb_typeof(p_values->'template_suffix') = 'string' and p_values->>'template_suffix' ~ '^[a-z0-9_-]{1,40}$')) then raise exception 'invalid_template_suffix'; end if;
  if exists (select 1 from jsonb_object_keys(p_values) k where k not in ('title', 'description', 'nav', 'sort_order', 'seo_title', 'seo_description', 'template_suffix', 'article_order', 'article_from_today', 'feed', 'article_fields')) then
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
    feed = case when p_values ? 'feed' then (p_values->>'feed')::boolean else feed end,
    article_fields = coalesce(v_fields, article_fields)
  where id = v_b.id
  returning * into v_b;
  return api_blog_json(v_b);
end;
$$;
revoke execute on function api_blog_update(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_blog_update(text, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0124_article_field_dates');
