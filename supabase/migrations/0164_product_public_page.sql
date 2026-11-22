-- 0164_product_public_page: ゲストの商品ページを 1 回で読む（product_public_page）。前方専用。2026-11-22（依頼の 2 の 1）。
--   - 今までは product_public_get → 画像・SKU → 在庫（product_public_stock）・ゲストに見せる会員価格（product_public_member_prices）と
--     順に 3 往復していた。会員の経路（product_member_get、0098・0099）と同じ形 { product, images, skus } を 1 回で返す
--   - 見える範囲は今までと同じ: 商品は product_public_get（公開中・条件の無い商品と buy、検索用のキーワードは外す 0163）、
--     在庫は product_public_stock と同じく 0〜99 に頭打ち、会員価格は product_public_member_prices と同じく
--     同梱モジュール audiences が ON のショップだけ（いちばん安い会員価格、banto_sku_member_price_floor）
--   - 画像・SKU の行は今までの匿名の読み取り（select *）と同じ列（to_jsonb）。anon に grant していない列を足したら、ここも外すこと

create or replace function product_public_page(p_shop_id uuid, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product jsonb;
  v_id uuid;
  v_member boolean;
begin
  v_product := product_public_get(p_shop_id, p_slug);
  if v_product is null then return null; end if;
  v_id := (v_product->>'id')::uuid;
  select coalesce(s.settings->'modules'->>'audiences', 'false') = 'true' into v_member from shops s where s.id = p_shop_id;
  return jsonb_build_object(
    'product', v_product,
    'images', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.created_at, i.id) from product_images i where i.product_id = v_id), '[]'::jsonb),
    'skus', coalesce((
      select jsonb_agg(to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99))
                       || case when m.price is not null then jsonb_build_object('member_price_jpy', m.price) else '{}'::jsonb end
                       order by k.created_at, k.id)
        from skus k
        left join inventory inv on inv.sku_id = k.id
        left join lateral (select banto_sku_member_price_floor(k.id) as price where v_member) m on true
       where k.product_id = v_id and k.shop_id = p_shop_id), '[]'::jsonb)
  );
end;
$$;
revoke execute on function product_public_page(uuid, text) from public;
grant execute on function product_public_page(uuid, text) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0164_product_public_page');
