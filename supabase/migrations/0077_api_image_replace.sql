-- Banto 0077_api_image_replace: AI 用 API で、商品の画像のファイルだけを差し替える（docs/ai-access.md）。前方専用。
-- 画像を WebP にする外部プラグインなどが、行（id・並び順・SKU への結び付け・作った日時）を変えずに本画像とサムネイルだけを入れ替えるため。
-- 足してから消すと、並びの最後に回って 1 枚目（メインの画像）が入れ替わり、SKU への結び付けも付け直しになる。
--   - api_image_target: 差し替える画像の商品の id（Worker がファイルを置く場所を決めるため。products:write）
--   - api_image_replace_file: キーと寸法を差し替え、前のキーを返す（Worker が前のファイルを消す）。キーの形は 0037 / 0063 と同じ検査

create or replace function api_image_target(p_token_hash text, p_image_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_product uuid;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select product_id into v_product from product_images where id = p_image_id and shop_id = v_tok.shop_id;
  if v_product is null then raise exception 'not_found'; end if;
  return jsonb_build_object('shop_id', v_tok.shop_id, 'product_id', v_product);
end;
$$;
revoke execute on function api_image_target(text, uuid) from public, anon, authenticated;
grant execute on function api_image_target(text, uuid) to service_role;

create or replace function api_image_replace_file(p_token_hash text, p_image_id uuid, p_storage_key text,
                                                  p_thumb_key text default null, p_width integer default null, p_height integer default null)
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
  update product_images set storage_key = p_storage_key, thumb_key = p_thumb_key, width = p_width, height = p_height where id = v_row.id;
  return jsonb_build_object(
    'image_id', v_row.id,
    'previous', jsonb_build_object('storage_key', v_row.storage_key, 'thumb_key', v_row.thumb_key),
    'product', (select api_product_json(p) from products p where p.id = v_row.product_id));
end;
$$;
revoke execute on function api_image_replace_file(text, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_image_replace_file(text, uuid, text, text, integer, integer) to service_role;

insert into banto_migrations (version) values ('0077_api_image_replace');
