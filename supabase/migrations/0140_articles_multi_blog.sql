-- Banto 0140_articles_multi_blog: 「記事を並べる」（::: articles）でブログをまたぐ。メンテナの決定 2026-11-10（docs/pages.md「記事を並べる」）。前方専用。
--   - ::: articles blog=news,staff（10 個まで）・blog=*（ショップのすべてのブログ）。ゲストは今までどおり RLS（PostgREST の blog_id=in.(…)）で読む
--   - 会員の読み取りの経路に articles_member_multi を足す（articles_member_page のブログを配列で受ける形。会員限定の記事（0100）も混ぜる）
--   - またいだときの並びは新しい順（既定）・題の順・日付の項目の順（field:<キー>、0124）だけ。手で並べた順（manual）はブログごとの順なので受けない
--   - どの文も繰り返して当てても同じ結果（定義し直し）

create or replace function articles_member_multi(p_shop_id uuid, p_blog_ids uuid[], p_offset integer, p_limit integer, p_tag text,
  p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sort text default null, p_fields jsonb default null, p_field_from text default null,
  p_until_key text default null, p_until_from text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_sort text; v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_multi: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  if p_blog_ids is null or cardinality(p_blog_ids) not between 1 and 20 then raise exception 'invalid_blogs' using errcode = '22023'; end if;
  if p_sort is not null and p_sort not in ('new', 'title') and p_sort !~ '^field:[a-z][a-z0-9_]{0,39}$' then raise exception 'invalid_sort' using errcode = '22023'; end if;
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then raise exception 'invalid_fields' using errcode = '22023'; end if;
  if p_field_from is not null and (p_sort is null or p_sort !~ '^field:' or char_length(p_field_from) > 40) then raise exception 'invalid_field_from' using errcode = '22023'; end if;
  if (p_until_key is null) <> (p_until_from is null) or (p_until_key is not null and (p_field_from is null or p_until_key !~ '^[a-z][a-z0-9_]{0,39}$' or char_length(p_until_from) > 40)) then
    raise exception 'invalid_until' using errcode = '22023';
  end if;
  v_sort := coalesce(p_sort, 'new');
  v_key := case when v_sort like 'field:%' then substr(v_sort, 7) end;
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return coalesce((select jsonb_agg(t.x order by t.n) from (
    select jsonb_build_object('id', a.id, 'shop_id', a.shop_id, 'blog_id', a.blog_id, 'handle', a.handle, 'title', a.title, 'body', a.body, 'excerpt', a.excerpt,
      'tags', a.tags, 'image_url', a.image_url, 'author', a.author, 'published_at', a.published_at, 'updated_at', a.updated_at, 'audience_id', a.audience_id,
      'position', a.position, 'fields', a.fields) x,
      row_number() over (order by
        case when v_key is not null then a.fields->>v_key end asc nulls last,
        case when v_sort = 'title' then a.title end asc,
        a.published_at desc, a.id desc) n
      from articles a
     where a.shop_id = p_shop_id and a.blog_id = any(p_blog_ids) and a.published and a.deleted_at is null and a.published_at <= now()
       and banto_shop_module_public(p_shop_id, 'blog')
       and (a.audience_id is null or a.audience_id = any(v_aud))
       and (p_tag is null or a.tags @> array[p_tag])
       and (p_fields is null or a.fields @> p_fields)
       and (p_field_from is null or (case when p_until_key is not null and a.fields ? p_until_key then a.fields->>p_until_key >= p_until_from else a.fields->>v_key >= p_field_from end))
     order by n
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_multi(uuid, uuid[], integer, integer, text, uuid, integer, uuid, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function articles_member_multi(uuid, uuid[], integer, integer, text, uuid, integer, uuid, text, jsonb, text, text, text) to service_role;
