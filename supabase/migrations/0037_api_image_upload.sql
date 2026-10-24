-- Banto 0037_api_image_upload: AI 用トークンで商品画像のファイルを送る（POST /api/v1/products/{id}/images/upload）。docs/api.md
-- 前方専用。URL からの取り込み（api_image_add、0003）と違い、サムネイルと寸法も一緒に登録できる。
-- Worker が中身を確かめて（先頭のバイトで種類を決め、5MB / サムネイル 1MB まで）ストレージに置いたあと、この関数で行を作る。
-- 置き場所のキーは Worker が作るが、ここでも「このショップのこの商品の下」であること・サムネイルが本画像の隣であることを確かめる。

-- 商品の JSON に画像のサムネイルと寸法を戻す（0005 で足したが、0008 の作り直しで落ちていた。ほかは 0008 と同じ）
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
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

create or replace function api_image_add_file(p_token_hash text, p_product_id uuid, p_storage_key text,
                                              p_thumb_key text default null, p_width integer default null, p_height integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_sort integer; v_prefix text; v_id uuid;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not exists (select 1 from products where id = p_product_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  v_prefix := 'shops/' || v_tok.shop_id::text || '/products/' || p_product_id::text || '/';
  if p_storage_key is null or left(p_storage_key, length(v_prefix)) <> v_prefix
     or substr(p_storage_key, length(v_prefix) + 1) !~ '^[0-9a-f]{24}\.(jpg|png|webp|gif|avif)$' then
    raise exception 'invalid_storage_key';
  end if;
  if p_thumb_key is not null and (left(p_thumb_key, length(v_prefix)) <> v_prefix
     or substr(p_thumb_key, length(v_prefix) + 1) !~ ('^' || substr(p_storage_key, length(v_prefix) + 1, 24) || '\.thumb\.(jpg|png|webp|gif|avif)$')) then
    raise exception 'invalid_thumb_key';
  end if;
  if (p_width is null) <> (p_height is null) or p_width not between 1 and 20000 or p_height not between 1 and 20000 then
    raise exception 'invalid_dimensions';
  end if;
  select coalesce(max(sort_order), -1) + 1 into v_sort from product_images where product_id = p_product_id;
  insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, sort_order)
  values (v_tok.shop_id, p_product_id, p_storage_key, p_thumb_key, p_width, p_height, v_sort)
  returning id into v_id;
  -- products:write だけのトークンでも結果を返せるよう、api_product_get（products:read）ではなく整形だけを使う
  return jsonb_build_object('image_id', v_id, 'product', (select api_product_json(p) from products p where p.id = p_product_id));
end;
$$;
revoke execute on function api_image_add_file(text, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_image_add_file(text, uuid, text, text, integer, integer) to service_role;

insert into banto_migrations (version) values ('0037_api_image_upload');
