-- Banto 0078_api_image_order: AI 用 API で、商品の画像の並び順を決める（docs/api.md「画像の並び順」）。前方専用。
-- 1 枚目が商品のメインの画像（一覧・商品フィード・OG）。外の道具（連携サイト・プラグイン）が並べ替える口がなかった。
--   - api_images_reorder: その商品の画像の id を、並べたい順にすべて受け取り、sort_order を 0 から振り直す。
--     1 枚でも足りない・余計・重なりがあれば何も変えない（image_ids_mismatch）。products:write。
--     product_images の更新なので、0075 のトリガーが product.updated を積む（1 商品 1 通）

create or replace function api_images_reorder(p_token_hash text, p_product_id uuid, p_image_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_current uuid[];
begin
  v_tok := api_require(p_token_hash, 'products:write');
  perform 1 from products where id = p_product_id and shop_id = v_tok.shop_id for update;
  if not found then raise exception 'not_found'; end if;
  select coalesce(array_agg(id order by id), '{}') into v_current from product_images where product_id = p_product_id;
  if p_image_ids is null or cardinality(p_image_ids) <> cardinality(v_current)
     or (select array_agg(x order by x) from unnest(p_image_ids) x) is distinct from nullif(v_current, '{}') then
    raise exception 'image_ids_mismatch';
  end if;
  update product_images i set sort_order = o.ord - 1
    from unnest(p_image_ids) with ordinality as o(id, ord)
   where i.id = o.id and i.product_id = p_product_id and i.sort_order is distinct from o.ord - 1;
  return (select api_product_json(p) from products p where p.id = p_product_id);
end;
$$;
revoke execute on function api_images_reorder(text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function api_images_reorder(text, uuid, uuid[]) to service_role;

insert into banto_migrations (version) values ('0078_api_image_order');
