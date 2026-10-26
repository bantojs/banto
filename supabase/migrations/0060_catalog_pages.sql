-- Banto 0060_catalog_pages: サイトマップと商品フィードを、商品の数に比例しない回数で作る（10 万〜100 万件。人間の決定 2026-10-26）。前方専用。
-- それまではサイトマップも商品フィードも、公開中の商品を全件読んでから組んでいた（サイトマップは 1,000 件で欠け、
-- フィードは 1,000 行ずつ全件を読むので Workers の 1 回あたりの問い合わせの上限に掛かる）。
--   - サイトマップ: /sitemap.xml を索引にし、商品は 1 ファイル 10,000 件ずつ（product_public_count / product_public_slugs）。
--   - 商品フィード: Cron が 1 回に数ページずつ（product_feed_page、id 順のキーセット、1 回 1,000 商品まで）作り、
--     R2 に分けて置き、配信のときにつないで返す（src/modules/product-feed/job.ts）。1 回に進める量は workers_plan（banto_site_plan）。
-- どれも anon（公開中のショップの公開中の商品だけ。説明・独自項目の非公開の値は返さない）。

create index if not exists products_public_id on products (shop_id, id) where published;

-- 公開中の商品の数（サイトマップのファイルの数を決める）
create or replace function product_public_count(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (select 1 from shops where id = p_shop_id and published)
              then (select count(*)::integer from products where shop_id = p_shop_id and published) else 0 end;
$$;

-- サイトマップの 1 ファイル分: [[slug, 更新日時], …]（id 順。p_limit は 10,000 まで）
create or replace function product_public_slugs(p_shop_id uuid, p_offset integer, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select jsonb_agg(jsonb_build_array(slug, updated_at) order by id)
                     from (select id, slug, updated_at from products
                            where shop_id = p_shop_id and published
                              and exists (select 1 from shops where id = p_shop_id and published)
                            order by id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 0), 0), 10000)) x), '[]'::jsonb);
$$;

-- 商品フィードの 1 ページ: id が p_after より後ろの公開中の商品を p_limit 件（1,000 まで）と、その SKU・在庫・画像。
-- { products: [...], skus: [...], inventory: [...], images: [...] }。products は説明つき（フィードの description）、attributes は返さない
create or replace function product_feed_page(p_shop_id uuid, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select id, shop_id, slug, name, description, tags, category_id, extra_category_ids, brand, tax_class, published, created_at, updated_at
      from products
     where shop_id = p_shop_id and published and (p_after is null or id > p_after)
       and exists (select 1 from shops where id = p_shop_id and published)
     order by id
     limit least(greatest(coalesce(p_limit, 0), 0), 1000)
  ),
  k as (select s.* from skus s where s.product_id in (select id from p))
  select jsonb_build_object(
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from p), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(to_jsonb(k) order by k.product_id, k.created_at) from k), '[]'::jsonb),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('sku_id', i.sku_id, 'available', i.available)) from inventory i where i.sku_id in (select id from k)), '[]'::jsonb),
    'images', coalesce((select jsonb_agg(to_jsonb(im) order by im.product_id, im.sort_order) from product_images im where im.product_id in (select id from p)), '[]'::jsonb)
  );
$$;

-- このデプロイの Workers のプラン（free / paid）。裏の処理が 1 回に進める量を決める（0038 の workers_plan。秘密ではない）
create or replace function banto_site_plan()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select settings->>'workers_plan' from banto_site_settings where id), 'free');
$$;

revoke execute on function product_public_count(uuid) from public;
grant execute on function product_public_count(uuid) to anon, authenticated, service_role;
revoke execute on function product_public_slugs(uuid, integer, integer) from public;
grant execute on function product_public_slugs(uuid, integer, integer) to anon, authenticated, service_role;
revoke execute on function product_feed_page(uuid, uuid, integer) from public;
grant execute on function product_feed_page(uuid, uuid, integer) to anon, authenticated, service_role;
revoke execute on function banto_site_plan() from public;
grant execute on function banto_site_plan() to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0060_catalog_pages');
