-- Banto 0009_catalog_import: 商品マスタの一括取り込み（コアの部品。WooCommerce インポーター等の同梱モジュールが使う）
-- 前方専用。docs/knowledge/08-woo-migration.md
--
-- import_catalog(p_shop_id, p_batch) は owner（authenticated）が呼び、ショップの所有を関数内で確かめる（set_stock と同じ）。
-- 1 回の呼び出しでカテゴリー・商品・SKU・在庫をまとめて書く（Workers の 1 リクエストあたりのサブリクエスト上限に当たらないように）。
-- 商品は slug、SKU は code、カテゴリーは slug で突き合わせるので、同じ内容を何度取り込んでも重複しない。
-- 商品ごとに例外を受け止め、1 件の不備で他の商品を巻き込まない（エラーは結果の errors に返す）。
--
-- p_batch:
--   { "categories": [{ "slug", "name", "parent_slug"?, "sort_order"? }],      親が先に来る順で並べる
--     "products":   [{ "slug", "name", "description"?, "published"?, "tags"?, "brand"?, "attributes"?, "category_slug"?,
--                      "skus": [{ "code", "name"?, "price_jpy", "compare_at_price_jpy"?, "gtin"?, "options"?, "available"? }] }],
--     "overwrite_stock": true | false }                                      false なら既存 SKU の在庫は変えない（新規 SKU には入れる）
-- 戻り値: { categories, products_created, products_updated, skus_created, skus_updated, errors: [{ slug, message }] }

create or replace function import_catalog(p_shop_id uuid, p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_sku jsonb; v_cat_id uuid; v_parent uuid; v_pid uuid; v_kid uuid; v_existing uuid; v_avail integer;
  v_price integer; v_compare integer; v_gtin text; v_created boolean;
  v_n_cat integer := 0; v_p_new integer := 0; v_p_upd integer := 0; v_k_new integer := 0; v_k_upd integer := 0;
  l_p_new integer; l_k_new integer; l_k_upd integer;
  v_errors jsonb := '[]'::jsonb;
  v_overwrite boolean := coalesce((p_batch->>'overwrite_stock')::boolean, true);
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;

  -- カテゴリー（親が先）
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'categories', '[]'::jsonb)) loop
    v_parent := null;
    if coalesce(v_row->>'parent_slug', '') <> '' then
      select id into v_parent from categories where shop_id = p_shop_id and slug = v_row->>'parent_slug';
    end if;
    insert into categories (shop_id, slug, name, parent_id, sort_order)
    values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 100), v_parent, coalesce((v_row->>'sort_order')::integer, 0))
    on conflict (shop_id, slug) do update set name = excluded.name, parent_id = excluded.parent_id;
    v_n_cat := v_n_cat + 1;
  end loop;

  -- 商品と SKU
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'products', '[]'::jsonb)) loop
    begin
      l_p_new := 0; l_k_new := 0; l_k_upd := 0;
      v_cat_id := null;
      if coalesce(v_row->>'category_slug', '') <> '' then
        select id into v_cat_id from categories where shop_id = p_shop_id and slug = v_row->>'category_slug';
      end if;
      select id into v_pid from products where shop_id = p_shop_id and slug = v_row->>'slug';
      if v_pid is null then
        insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id)
        values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 200), nullif(btrim(coalesce(v_row->>'description', '')), ''),
                coalesce((v_row->>'published')::boolean, false), banto_normalize_tags(v_row->'tags'),
                nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''), banto_clean_object(v_row->'attributes', 200), v_cat_id)
        returning id into v_pid;
        l_p_new := 1;
      else
        -- カスタム項目は既存の値に上書きでマージする（取り込み元に無い項目を消さない）
        update products set
          name = left(btrim(v_row->>'name'), 200),
          description = nullif(btrim(coalesce(v_row->>'description', '')), ''),
          published = coalesce((v_row->>'published')::boolean, published),
          tags = banto_normalize_tags(v_row->'tags'),
          brand = nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''),
          attributes = attributes || banto_clean_object(v_row->'attributes', 200),
          category_id = v_cat_id
        where id = v_pid;
      end if;

      for v_sku in select * from jsonb_array_elements(coalesce(v_row->'skus', '[]'::jsonb)) loop
        v_price := (v_sku->>'price_jpy')::integer;
        v_compare := (v_sku->>'compare_at_price_jpy')::integer;
        if v_compare is not null and v_compare <= v_price then v_compare := null; end if;
        v_gtin := nullif(btrim(coalesce(v_sku->>'gtin', '')), '');
        if v_gtin is not null and v_gtin !~ '^([0-9]{8}|[0-9]{12,14})$' then v_gtin := null; end if;
        select id, product_id into v_kid, v_existing from skus where shop_id = p_shop_id and code = v_sku->>'code';
        v_created := v_kid is null;
        if v_created then
          insert into skus (shop_id, product_id, code, name, price_jpy, compare_at_price_jpy, gtin, options)
          values (p_shop_id, v_pid, v_sku->>'code', nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), v_price, v_compare, v_gtin,
                  banto_clean_object(v_sku->'options', 5))
          returning id into v_kid;
          l_k_new := l_k_new + 1;
        else
          if v_existing <> v_pid then raise exception 'sku_belongs_to_other_product: %', v_sku->>'code'; end if;
          update skus set name = nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), price_jpy = v_price, compare_at_price_jpy = v_compare,
                          gtin = v_gtin, options = banto_clean_object(v_sku->'options', 5)
           where id = v_kid;
          l_k_upd := l_k_upd + 1;
        end if;
        -- 在庫（inventory 行は skus の insert でトリガーが作る）
        if v_sku ? 'available' and (v_created or v_overwrite) then
          v_avail := greatest(0, coalesce((v_sku->>'available')::integer, 0));
          update inventory set available = v_avail, updated_at = now() where sku_id = v_kid;
        end if;
      end loop;

      perform enqueue_hook(p_shop_id, 'product.updated', jsonb_build_object('product_id', v_pid, 'shop_id', p_shop_id, 'slug', v_row->>'slug'));
      -- 件数はこの商品が最後まで通ったときだけ数える（例外なら全部取り消されるため）
      v_p_new := v_p_new + l_p_new; v_p_upd := v_p_upd + (1 - l_p_new); v_k_new := v_k_new + l_k_new; v_k_upd := v_k_upd + l_k_upd;
    exception when others then
      -- この商品だけ取り消して続ける（plpgsql の例外ブロックはセーブポイントとして働く）
      v_errors := v_errors || jsonb_build_object('slug', v_row->>'slug', 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('categories', v_n_cat, 'products_created', v_p_new, 'products_updated', v_p_upd,
                            'skus_created', v_k_new, 'skus_updated', v_k_upd, 'errors', v_errors);
end;
$$;

revoke execute on function import_catalog(uuid, jsonb) from public, anon;
grant execute on function import_catalog(uuid, jsonb) to authenticated, service_role;

insert into banto_migrations (version) values ('0009_catalog_import');
