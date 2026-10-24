-- Banto 0005_images: 商品画像のサムネイルと寸法
-- 前方専用。管理画面がブラウザ側で縮小した本画像（長辺 1600px）とサムネイル（長辺 400px）を R2 に置き、
-- 行に thumb_key と寸法を残す。既存行・AI 経由で URL から取り込んだ画像は thumb_key が null のまま
-- （テーマは本画像にフォールバックする）。サーバー側では画像処理をしない（Workers の CPU 制限と可搬性のため）。

alter table product_images
  add column thumb_key text,
  add column width integer check (width is null or (width > 0 and width <= 20000)),
  add column height integer check (height is null or (height > 0 and height <= 20000));

-- AI 用 API の商品 JSON にサムネイルと寸法を載せる
create or replace function api_product_json(p_product products, p_with_skus boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_product.id, 'slug', p_product.slug, 'name', p_product.name, 'description', p_product.description,
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

-- 画像削除はサムネイルのキーも返す（Worker が両方をストレージから消す）。戻り値の型が変わるので作り直す。
drop function api_image_delete(text, uuid);
create function api_image_delete(p_token_hash text, p_image_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_row product_images;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  delete from product_images where id = p_image_id and shop_id = v_tok.shop_id returning * into v_row;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('storage_key', v_row.storage_key, 'thumb_key', v_row.thumb_key);
end;
$$;
revoke all on function api_image_delete(text, uuid) from public, anon, authenticated;
grant execute on function api_image_delete(text, uuid) to service_role;

insert into banto_migrations (version) values ('0005_images');
