-- Banto 0101_page_layouts: 固定ページを「ひな形」として割り当てる（段 C1。メンテナの決定 2026-11-03、docs/pages.md「ひな形の割り当て」）。前方専用。
--   - shops.settings.page_layouts = { "home": <ページの id>, "articles": { <ブログの id>: <ページの id> } }
--     home: お店のトップ（一覧の絞り込みの無いとき）をそのページで描く。articles: そのブログの記事をそのページで描く（`::: current part=…` が今の記事の部品）
--   - 割り当てを変えるのは page_layouts_set だけ（項目 content。ページ・ブログはそのショップのものだけ。ページは消したもの以外ならよい。
--     公開中か・会員限定でないかは、お客様の画面が匿名の読み取りで確かめ、見えなければ今までの画面に戻す）
--   - 公開の settings（banto_shop_public_settings、0069 を差し替え）に page_layouts を足す（キャッシュ済みのショップ行で判定し、DB に問い合わせない）

create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent', 'page_layouts')), '{}'::jsonb)
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb))
                                                || case when jsonb_typeof(p->'headless'->'order_page_url') = 'string'
                                                        then jsonb_build_object('order_page_url', p->'headless'->'order_page_url') else '{}'::jsonb end
                                                || case when jsonb_typeof(p->'headless'->'account_page_url') = 'string'
                                                        then jsonb_build_object('account_page_url', p->'headless'->'account_page_url') else '{}'::jsonb end)
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

-- 割り当てを置き換える（p_layouts は { home?: uuid|null, articles?: { <ブログ id>: <ページ id> } }。null・空は外す）
create or replace function page_layouts_set(p_shop_id uuid, p_layouts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_articles jsonb := '{}'::jsonb;
  v_home text;
  e record;
begin
  if not banto_shop_perm(p_shop_id, 'content') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_layouts) <> 'object' then raise exception 'invalid_page_layouts'; end if;
  if exists (select 1 from jsonb_object_keys(p_layouts) k where k not in ('home', 'articles')) then raise exception 'invalid_page_layouts'; end if;
  -- トップ
  if jsonb_typeof(p_layouts->'home') = 'string' and p_layouts->>'home' <> '' then
    v_home := p_layouts->>'home';
    if v_home !~ '^[0-9a-f-]{36}$' or not exists (select 1 from pages where id = v_home::uuid and shop_id = p_shop_id and deleted_at is null) then
      raise exception 'invalid_page_layouts';
    end if;
    v_out := v_out || jsonb_build_object('home', v_home);
  elsif p_layouts ? 'home' and jsonb_typeof(p_layouts->'home') not in ('null', 'string') then
    raise exception 'invalid_page_layouts';
  end if;
  -- ブログごとの記事のひな形（ブログは 20 まで、0081）
  if p_layouts ? 'articles' then
    if jsonb_typeof(p_layouts->'articles') <> 'object' then raise exception 'invalid_page_layouts'; end if;
    for e in select * from jsonb_each(p_layouts->'articles') loop
      if jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = '') then continue; end if;
      if e.key !~ '^[0-9a-f-]{36}$' or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from blogs where id = e.key::uuid and shop_id = p_shop_id)
         or not exists (select 1 from pages where id = (e.value #>> '{}')::uuid and shop_id = p_shop_id and deleted_at is null) then
        raise exception 'invalid_page_layouts';
      end if;
      v_articles := v_articles || jsonb_build_object(e.key, e.value);
    end loop;
    if v_articles <> '{}'::jsonb then v_out := v_out || jsonb_build_object('articles', v_articles); end if;
  end if;
  update shops set settings = case when v_out = '{}'::jsonb then coalesce(settings, '{}'::jsonb) - 'page_layouts'
                                   else coalesce(settings, '{}'::jsonb) || jsonb_build_object('page_layouts', v_out) end
   where id = p_shop_id;
  return v_out;
end;
$$;
revoke execute on function page_layouts_set(uuid, jsonb) from public, anon;
grant execute on function page_layouts_set(uuid, jsonb) to authenticated, service_role;

insert into banto_migrations (version) values ('0101_page_layouts');
