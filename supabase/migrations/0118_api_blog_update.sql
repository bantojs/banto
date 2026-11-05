-- Banto 0118_api_blog_update: AI 用 API でブログの設定を変える（content:write）。メンテナの決定 2026-11-05（docs/ai-access.md §9）。前方専用。
--   - 変えられるのは題・説明・メニュー・並び・SEO・テンプレート・記事の並び順（0116）・フィード（0116）・記事の項目の定義（0117）だけ。
--     ブログを作る・消すのは今までどおり管理画面だけ
--   - 記事の項目の定義の「指すブログ」（blog）は URL の名前でも id でもよい（このショップのブログだけ。形はトリガー banto_blog_article_fields_guard が確かめる）
--   - 送らなかった鍵は今のまま

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
  if p_values ? 'article_order' and (jsonb_typeof(p_values->'article_order') <> 'string' or p_values->>'article_order' not in ('new', 'title', 'manual')) then raise exception 'invalid_article_order'; end if;
  if p_values ? 'feed' and jsonb_typeof(p_values->'feed') <> 'boolean' then raise exception 'invalid_feed'; end if;
  if p_values ? 'template_suffix' and not (jsonb_typeof(p_values->'template_suffix') = 'null' or (jsonb_typeof(p_values->'template_suffix') = 'string' and p_values->>'template_suffix' ~ '^[a-z0-9_-]{1,40}$')) then raise exception 'invalid_template_suffix'; end if;
  if exists (select 1 from jsonb_object_keys(p_values) k where k not in ('title', 'description', 'nav', 'sort_order', 'seo_title', 'seo_description', 'template_suffix', 'article_order', 'feed', 'article_fields')) then
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
    feed = case when p_values ? 'feed' then (p_values->>'feed')::boolean else feed end,
    article_fields = coalesce(v_fields, article_fields)
  where id = v_b.id
  returning * into v_b;
  return api_blog_json(v_b);
end;
$$;
revoke execute on function api_blog_update(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_blog_update(text, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0118_api_blog_update');
