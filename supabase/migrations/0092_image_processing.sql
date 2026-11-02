-- 商品画像の変換を外部プラグインに任せる（メンテナの決定 2026-11-02、docs/images.md「外部の変換プラグインに任せる」）。
-- ショップの設定 settings.images.processing = 'plugin' のとき、管理画面のブラウザは元の写真とサムネイルだけを送り、
-- 本画像・中間の段は外部プラグイン（docs/hooks.md、例: bantojs/banto-plugin-webp）が作って AI 用 API で差し替える。
--   - api_image_replace_file: 中間の段（variants）とサムネイルの横幅（thumb_width）も一緒に差し替える。
--     0091 より前の形のままだと、本画像のキーが変わったのに variants が前のまま残り、無いファイルを srcset に出してしまう
--   - api_product_json: 画像に variants・thumb_width を足す（プラグインが「まだ作っていない段」を見分ける）
--   - api_image_settings: プラグインが作る大きさ（ショップの設定）を読む（products:read）

drop function if exists api_image_replace_file(text, uuid, text, text, integer, integer);
create function api_image_replace_file(p_token_hash text, p_image_id uuid, p_storage_key text,
                                       p_thumb_key text default null, p_width integer default null, p_height integer default null,
                                       p_variants smallint[] default '{}', p_thumb_width smallint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_row product_images; v_prefix text;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_row from product_images where id = p_image_id and shop_id = v_tok.shop_id for update;
  if v_row.id is null then raise exception 'not_found'; end if;
  v_prefix := 'shops/' || v_tok.shop_id::text || '/products/' || v_row.product_id::text || '/';
  if p_storage_key is null or left(p_storage_key, length(v_prefix)) <> v_prefix
     or substr(p_storage_key, length(v_prefix) + 1) !~ '^[0-9a-f]{24}\.(jpg|png|webp|gif|avif)$' then
    raise exception 'invalid_storage_key';
  end if;
  if p_storage_key = v_row.storage_key then raise exception 'invalid_storage_key'; end if;
  if p_thumb_key is not null and (left(p_thumb_key, length(v_prefix)) <> v_prefix
     or substr(p_thumb_key, length(v_prefix) + 1) !~ ('^' || substr(p_storage_key, length(v_prefix) + 1, 24) || '\.thumb\.(jpg|png|webp|gif|avif)$')) then
    raise exception 'invalid_thumb_key';
  end if;
  if (p_width is null) <> (p_height is null) or p_width not between 1 and 20000 or p_height not between 1 and 20000 then
    raise exception 'invalid_dimensions';
  end if;
  -- 中間の段は本画像より狭いものだけ（形は 0091 の check が確かめる）。サムネイルの横幅はサムネイルがあるときだけ
  if exists (select 1 from unnest(coalesce(p_variants, '{}')) v where p_width is null or v >= p_width) then
    raise exception 'invalid_variants';
  end if;
  if p_thumb_width is not null and p_thumb_key is null then raise exception 'invalid_thumb_width'; end if;
  update product_images set storage_key = p_storage_key, thumb_key = p_thumb_key, width = p_width, height = p_height,
                            variants = coalesce(p_variants, '{}'), thumb_width = p_thumb_width
   where id = v_row.id;
  return jsonb_build_object(
    'image_id', v_row.id,
    'previous', jsonb_build_object('storage_key', v_row.storage_key, 'thumb_key', v_row.thumb_key, 'variants', v_row.variants),
    'product', (select api_product_json(p) from products p where p.id = v_row.product_id));
end;
$$;
revoke execute on function api_image_replace_file(text, uuid, text, text, integer, integer, smallint[], smallint) from public, anon, authenticated;
grant execute on function api_image_replace_file(text, uuid, text, text, integer, integer, smallint[], smallint) to service_role;

-- プラグインが作る大きさ（src/media/variants.ts と同じ値。ショップの設定が壊れていれば既定）
create or replace function api_image_settings(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_settings jsonb; v_max integer; v_processing text;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  select coalesce(settings, '{}'::jsonb) into v_settings from shops where id = v_tok.shop_id;
  v_max := case when v_settings->'images'->>'max_width' in ('1600', '2048', '2560', '3200') then (v_settings->'images'->>'max_width')::integer else 1600 end;
  v_processing := case when v_settings->'images'->>'processing' = 'plugin' then 'plugin' else 'browser' end;
  return jsonb_build_object('max_width', v_max, 'max_height', 4096, 'thumb_width', 400,
                            'variant_widths', jsonb_build_array(800, 1600, 2048, 2560), 'processing', v_processing);
end;
$$;
revoke execute on function api_image_settings(text) from public, anon, authenticated;
grant execute on function api_image_settings(text) to service_role;

-- 画像に variants・thumb_width を足す。ほかは 0065 と同じ
create or replace function api_product_json(p_product products, p_with_skus boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_product.id, 'slug', p_product.slug, 'name', p_product.name, 'description', p_product.description,
    'tags', to_jsonb(p_product.tags), 'brand', p_product.brand, 'attributes', p_product.attributes,
    'category', (select api_category_json(c) from categories c where c.id = p_product.category_id),
    'extra_categories', (select coalesce(jsonb_agg(api_category_json(c) order by x.ord), '[]'::jsonb)
                           from unnest(p_product.extra_category_ids) with ordinality x(id, ord) join categories c on c.id = x.id),
    'option_axes', p_product.option_axes,
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order,
                                                             'options', i.options, 'variants', i.variants, 'thumb_width', i.thumb_width) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

insert into banto_migrations (version) values ('0092_image_processing');
