-- Banto 0119_api_layouts_media: AI 用 API でひな形を割り当てる・アイキャッチなどの画像をメディアライブラリに取り込む。
-- メンテナの決定 2026-11-05（テーマ作りからの相談。docs/ai-access.md §9）。前方専用。
--   - ひな形の割り当ての中身（0114 の page_layouts_set）を banto_page_layouts_apply に移し、管理画面（page_layouts_set、項目 content）と
--     AI 用 API（api_page_layouts_set、content:write）の両方がそれを通る。決まりは同じ（ページ・ブログ・カテゴリーはこのショップのものだけ）
--   - API は読みやすい形: ページは URL の名前（id でもよい）、ブログは URL の名前、カテゴリーはスラッグ。
--     PATCH の形（送った鍵だけ変える。null か "" で外す。ブログ・カテゴリー・法務のページごとの表は鍵ごとに混ぜる）
--   - 画像の取り込み: Worker が URL から取って（商品の画像と同じ決まり。src/media/fetch-image.ts）pages/<ショップ>/ に置き、
--     api_page_media_add がメディアライブラリ（page_media）に記録する。置き場の鍵はこのショップの場所だけ

create or replace function banto_page_layouts_apply(p_shop_id uuid, p_layouts jsonb)
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
revoke execute on function banto_page_layouts_apply(uuid, jsonb) from public, anon, authenticated;

create or replace function page_layouts_set(p_shop_id uuid, p_layouts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not banto_shop_perm(p_shop_id, 'content') then raise exception 'forbidden' using errcode = '42501'; end if;
  return banto_page_layouts_apply(p_shop_id, p_layouts);
end;
$$;
revoke execute on function page_layouts_set(uuid, jsonb) from public, anon;
grant execute on function page_layouts_set(uuid, jsonb) to authenticated, service_role;

-- id の形の割り当て → API の形（ページは URL の名前、ブログは URL の名前、カテゴリーはスラッグ。消えた指す先は出さない）
create or replace function banto_page_layouts_readable(p_shop_id uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb := '{}'::jsonb; v_map jsonb; e record; k text; h text; h2 text;
begin
  p := coalesce(p, '{}'::jsonb);
  foreach k in array array['home', 'product', 'collection', 'legal'] loop
    if jsonb_typeof(p->k) = 'string' then
      select handle into h from pages where shop_id = p_shop_id and id::text = p->>k and deleted_at is null;
      if h is not null then v_out := v_out || jsonb_build_object(k, h); end if;
    end if;
  end loop;
  foreach k in array array['articles', 'blogs', 'product_categories', 'collection_categories', 'legal_pages'] loop
    v_map := '{}'::jsonb;
    if jsonb_typeof(p->k) = 'object' then
      for e in select * from jsonb_each_text(p->k) loop
        select handle into h from pages where shop_id = p_shop_id and id::text = e.value and deleted_at is null;
        h2 := case when k in ('articles', 'blogs') then (select b.handle from blogs b where b.shop_id = p_shop_id and b.id::text = e.key)
                   when k in ('product_categories', 'collection_categories') then (select c.slug from categories c where c.shop_id = p_shop_id and c.id::text = e.key)
                   else e.key end;
        if h is not null and h2 is not null then v_map := v_map || jsonb_build_object(h2, h); end if;
      end loop;
    end if;
    if v_map <> '{}'::jsonb then v_out := v_out || jsonb_build_object(k, v_map); end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_page_layouts_readable(uuid, jsonb) from public, anon, authenticated;

create or replace function api_page_layouts_get(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'pages');
  return banto_page_layouts_readable(v_tok.shop_id, (select settings->'page_layouts' from shops where id = v_tok.shop_id));
end;
$$;
revoke execute on function api_page_layouts_get(text) from public, anon, authenticated;
grant execute on function api_page_layouts_get(text) to service_role;

-- API の形の変更 → id の形にして今の割り当てに混ぜ、banto_page_layouts_apply に通す
create or replace function api_page_layouts_set(p_token_hash text, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_cur jsonb; v_map jsonb; e record; k text; v_page text; v_key text;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'pages');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_page_layouts'; end if;
  if exists (select 1 from jsonb_object_keys(p_changes) x where x not in ('home', 'articles', 'product', 'product_categories', 'collection', 'collection_categories', 'legal', 'legal_pages', 'blogs')) then
    raise exception 'invalid_page_layouts:unknown_key';
  end if;
  v_cur := coalesce((select settings->'page_layouts' from shops where id = v_tok.shop_id), '{}'::jsonb);
  foreach k in array array['home', 'product', 'collection', 'legal'] loop
    if p_changes ? k then
      if jsonb_typeof(p_changes->k) = 'null' or coalesce(p_changes->>k, '') = '' then v_cur := v_cur - k;
      else
        select id::text into v_page from pages where shop_id = v_tok.shop_id and deleted_at is null and (handle = p_changes->>k or id::text = p_changes->>k);
        if v_page is null then raise exception 'invalid_page_layouts:%', k; end if;
        v_cur := v_cur || jsonb_build_object(k, v_page);
      end if;
    end if;
  end loop;
  foreach k in array array['articles', 'blogs', 'product_categories', 'collection_categories', 'legal_pages'] loop
    if p_changes ? k then
      if jsonb_typeof(p_changes->k) <> 'object' then raise exception 'invalid_page_layouts:%', k; end if;
      v_map := case when jsonb_typeof(v_cur->k) = 'object' then v_cur->k else '{}'::jsonb end;
      for e in select * from jsonb_each(p_changes->k) loop
        v_key := case when k in ('articles', 'blogs') then (select b.id::text from blogs b where b.shop_id = v_tok.shop_id and (b.handle = e.key or b.id::text = e.key))
                      when k in ('product_categories', 'collection_categories') then (select c.id::text from categories c where c.shop_id = v_tok.shop_id and (c.slug = e.key or c.id::text = e.key))
                      when e.key in ('legal', 'privacy', 'returns') then e.key end;
        if v_key is null then raise exception 'invalid_page_layouts:%', k; end if;
        if jsonb_typeof(e.value) = 'null' or coalesce(e.value #>> '{}', '') = '' then v_map := v_map - v_key;
        else
          v_page := null;
          if jsonb_typeof(e.value) = 'string' then
            select id::text into v_page from pages where shop_id = v_tok.shop_id and deleted_at is null and (handle = e.value #>> '{}' or id::text = e.value #>> '{}');
          end if;
          if v_page is null then raise exception 'invalid_page_layouts:%', k; end if;
          v_map := v_map || jsonb_build_object(v_key, v_page);
        end if;
      end loop;
      v_cur := v_cur || jsonb_build_object(k, v_map);
    end if;
  end loop;
  return banto_page_layouts_readable(v_tok.shop_id, banto_page_layouts_apply(v_tok.shop_id, v_cur));
end;
$$;
revoke execute on function api_page_layouts_set(text, jsonb) from public, anon, authenticated;
grant execute on function api_page_layouts_set(text, jsonb) to service_role;

-- 取り込んだ画像をメディアライブラリに記録する（Worker が置き場に置いた後）。鍵はこのショップの pages/ の下だけ
create or replace function api_page_media_add(p_token_hash text, p_storage_key text, p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_id uuid;
begin
  v_tok := api_require(p_token_hash, 'content:write');
  if not exists (select 1 from shops where id = v_tok.shop_id and (settings->'modules'->'pages' = 'true'::jsonb or settings->'modules'->'blog' = 'true'::jsonb)) then
    raise exception 'module_disabled';
  end if;
  if p_storage_key is null or p_storage_key !~ ('^pages/' || v_tok.shop_id::text || '/[A-Za-z0-9._-]{1,100}$') then raise exception 'invalid_storage_key'; end if;
  insert into page_media (shop_id, storage_key, url) values (v_tok.shop_id, p_storage_key, p_url) returning id into v_id;
  return jsonb_build_object('id', v_id, 'url', p_url);
end;
$$;
revoke execute on function api_page_media_add(text, text, text) from public, anon, authenticated;
grant execute on function api_page_media_add(text, text, text) to service_role;

insert into banto_migrations (version) values ('0119_api_layouts_media');
