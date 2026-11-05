-- Banto 0114_page_layouts_blogs: ブログの一覧（/blogs/<ブログ>）のひな形（段 C5。メンテナの決定 2026-11-05、docs/pages.md「ひな形の割り当て」）。前方専用。
--   - shops.settings.page_layouts.blogs = { <ブログの id>: <ページの id> }（ブログごと。記事のひな形 articles と同じ形）
--   - 0104 の page_layouts_set に blogs を足しただけ（ほかの鍵の確かめは同じ）。ブログ・ページはそのショップのものだけ

create or replace function page_layouts_set(p_shop_id uuid, p_layouts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_articles jsonb := '{}'::jsonb;
  v_home text;
  v_product text;
  v_cats jsonb := '{}'::jsonb;
  v_collection text;
  v_ccats jsonb := '{}'::jsonb;
  v_legal text;
  v_lpages jsonb := '{}'::jsonb;
  v_blogs jsonb := '{}'::jsonb;
  e record;
begin
  if not banto_shop_perm(p_shop_id, 'content') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_layouts) <> 'object' then raise exception 'invalid_page_layouts'; end if;
  if exists (select 1 from jsonb_object_keys(p_layouts) k where k not in ('home', 'articles', 'product', 'product_categories', 'collection', 'collection_categories', 'legal', 'legal_pages', 'blogs')) then raise exception 'invalid_page_layouts'; end if;
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
  -- 商品詳細（ショップ全体）
  if jsonb_typeof(p_layouts->'product') = 'string' and p_layouts->>'product' <> '' then
    v_product := p_layouts->>'product';
    if v_product !~ '^[0-9a-f-]{36}$' or not exists (select 1 from pages where id = v_product::uuid and shop_id = p_shop_id and deleted_at is null) then
      raise exception 'invalid_page_layouts';
    end if;
    v_out := v_out || jsonb_build_object('product', v_product);
  elsif p_layouts ? 'product' and jsonb_typeof(p_layouts->'product') not in ('null', 'string') then
    raise exception 'invalid_page_layouts';
  end if;
  -- 商品詳細（カテゴリーごとの上書き。そのショップのカテゴリーだけ）
  if p_layouts ? 'product_categories' then
    if jsonb_typeof(p_layouts->'product_categories') <> 'object' then raise exception 'invalid_page_layouts'; end if;
    for e in select * from jsonb_each(p_layouts->'product_categories') loop
      if jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = '') then continue; end if;
      if e.key !~ '^[0-9a-f-]{36}$' or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from categories where id = e.key::uuid and shop_id = p_shop_id)
         or not exists (select 1 from pages where id = (e.value #>> '{}')::uuid and shop_id = p_shop_id and deleted_at is null) then
        raise exception 'invalid_page_layouts';
      end if;
      v_cats := v_cats || jsonb_build_object(e.key, e.value);
    end loop;
    if v_cats <> '{}'::jsonb then v_out := v_out || jsonb_build_object('product_categories', v_cats); end if;
  end if;
  -- 商品一覧（すべての一覧とカテゴリーの一覧に共通）
  if jsonb_typeof(p_layouts->'collection') = 'string' and p_layouts->>'collection' <> '' then
    v_collection := p_layouts->>'collection';
    if v_collection !~ '^[0-9a-f-]{36}$' or not exists (select 1 from pages where id = v_collection::uuid and shop_id = p_shop_id and deleted_at is null) then
      raise exception 'invalid_page_layouts';
    end if;
    v_out := v_out || jsonb_build_object('collection', v_collection);
  elsif p_layouts ? 'collection' and jsonb_typeof(p_layouts->'collection') not in ('null', 'string') then
    raise exception 'invalid_page_layouts';
  end if;
  -- 商品一覧（カテゴリーごとの上書き。そのショップのカテゴリーだけ）
  if p_layouts ? 'collection_categories' then
    if jsonb_typeof(p_layouts->'collection_categories') <> 'object' then raise exception 'invalid_page_layouts'; end if;
    for e in select * from jsonb_each(p_layouts->'collection_categories') loop
      if jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = '') then continue; end if;
      if e.key !~ '^[0-9a-f-]{36}$' or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from categories where id = e.key::uuid and shop_id = p_shop_id)
         or not exists (select 1 from pages where id = (e.value #>> '{}')::uuid and shop_id = p_shop_id and deleted_at is null) then
        raise exception 'invalid_page_layouts';
      end if;
      v_ccats := v_ccats || jsonb_build_object(e.key, e.value);
    end loop;
    if v_ccats <> '{}'::jsonb then v_out := v_out || jsonb_build_object('collection_categories', v_ccats); end if;
  end if;
  -- 法務の 3 つのページ（共通）
  if jsonb_typeof(p_layouts->'legal') = 'string' and p_layouts->>'legal' <> '' then
    v_legal := p_layouts->>'legal';
    if v_legal !~ '^[0-9a-f-]{36}$' or not exists (select 1 from pages where id = v_legal::uuid and shop_id = p_shop_id and deleted_at is null) then
      raise exception 'invalid_page_layouts';
    end if;
    v_out := v_out || jsonb_build_object('legal', v_legal);
  elsif p_layouts ? 'legal' and jsonb_typeof(p_layouts->'legal') not in ('null', 'string') then
    raise exception 'invalid_page_layouts';
  end if;
  -- 法務のページごとの上書き（鍵は legal・privacy・returns だけ）
  if p_layouts ? 'legal_pages' then
    if jsonb_typeof(p_layouts->'legal_pages') <> 'object' then raise exception 'invalid_page_layouts'; end if;
    for e in select * from jsonb_each(p_layouts->'legal_pages') loop
      if jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = '') then continue; end if;
      if e.key not in ('legal', 'privacy', 'returns') or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from pages where id = (e.value #>> '{}')::uuid and shop_id = p_shop_id and deleted_at is null) then
        raise exception 'invalid_page_layouts';
      end if;
      v_lpages := v_lpages || jsonb_build_object(e.key, e.value);
    end loop;
    if v_lpages <> '{}'::jsonb then v_out := v_out || jsonb_build_object('legal_pages', v_lpages); end if;
  end if;
  -- ブログの一覧のひな形（ブログごと、0114）
  if p_layouts ? 'blogs' then
    if jsonb_typeof(p_layouts->'blogs') <> 'object' then raise exception 'invalid_page_layouts'; end if;
    for e in select * from jsonb_each(p_layouts->'blogs') loop
      if jsonb_typeof(e.value) = 'null' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = '') then continue; end if;
      if e.key !~ '^[0-9a-f-]{36}$' or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from blogs where id = e.key::uuid and shop_id = p_shop_id)
         or not exists (select 1 from pages where id = (e.value #>> '{}')::uuid and shop_id = p_shop_id and deleted_at is null) then
        raise exception 'invalid_page_layouts';
      end if;
      v_blogs := v_blogs || jsonb_build_object(e.key, e.value);
    end loop;
    if v_blogs <> '{}'::jsonb then v_out := v_out || jsonb_build_object('blogs', v_blogs); end if;
  end if;
  update shops set settings = case when v_out = '{}'::jsonb then coalesce(settings, '{}'::jsonb) - 'page_layouts'
                                   else coalesce(settings, '{}'::jsonb) || jsonb_build_object('page_layouts', v_out) end
   where id = p_shop_id;
  return v_out;
end;
$$;
revoke execute on function page_layouts_set(uuid, jsonb) from public, anon;
grant execute on function page_layouts_set(uuid, jsonb) to authenticated, service_role;

insert into banto_migrations (version) values ('0114_page_layouts_blogs');
