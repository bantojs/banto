-- Banto 0139_shop_home: ショップのホームの「今やること」を 1 回で数える（管理画面の作り直し、メンテナの決定 2026-11-08）。前方専用。
--
-- shop_home(p_shop_id): 見る人の項目にある分だけを数えて返す（項目の無いものは鍵ごと返さない。出荷の担当に売上の数字を出さない）。
--   orders  : 発送待ち（支払い済み）の注文の数                         … 項目 orders
--   sales   : 直近 30 日の注文の数と売上（支払い済み・発送済み）          … 項目 reports
--   catalog : 公開中の商品の在庫切れの SKU の数・非公開の商品の数         … 項目 catalog
--   support : 返事を待っているお問い合わせの数（確かめていないゲストの分は数えない） … 項目 support
--   content : 予約公開を待っているページ・記事の数・下書きの数            … 項目 content
--   setup   : 開店の準備（法定表記・公開中の商品・ショップの公開）        … 組織の owner / admin
-- どれもインデックスのある shop_id で絞った数だけで、行そのものは返さない。触れないショップは shop_not_found。

create or replace function shop_home(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := '{}'::jsonb;
  v_shop shops;
begin
  select * into v_shop from shops where id = p_shop_id;
  if v_shop.id is null or not (banto_owns_shop(p_shop_id) or exists (select 1 from org_member_shops ms where ms.shop_id = p_shop_id and ms.user_id = auth.uid() and ms.org_id = v_shop.org_id)) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if banto_shop_perm(p_shop_id, 'orders') then
    v := v || jsonb_build_object('orders', jsonb_build_object('to_ship', (select count(*) from orders where shop_id = p_shop_id and status = 'paid')));
  end if;
  if banto_shop_perm(p_shop_id, 'reports') then
    v := v || jsonb_build_object('sales', (select jsonb_build_object('orders', count(*), 'revenue_jpy', coalesce(sum(total_jpy), 0))
                                             from orders where shop_id = p_shop_id and status in ('paid', 'shipped') and created_at >= now() - interval '30 days'));
  end if;
  if banto_shop_perm(p_shop_id, 'catalog') then
    v := v || jsonb_build_object('catalog', jsonb_build_object(
      'out_of_stock', (select count(*) from inventory i join skus k on k.id = i.sku_id join products p on p.id = k.product_id
                        where i.shop_id = p_shop_id and p.published and i.available = 0),
      'drafts', (select count(*) from products where shop_id = p_shop_id and not published),
      'products', (select count(*) from products where shop_id = p_shop_id)));
  end if;
  if banto_shop_perm(p_shop_id, 'support') then
    v := v || jsonb_build_object('support', jsonb_build_object('waiting', (select count(*) from inquiries
      where shop_id = p_shop_id and status = 'waiting_shop' and not (origin = 'form' and email_verified_at is null))));
  end if;
  if banto_shop_perm(p_shop_id, 'content') then
    v := v || jsonb_build_object('content', jsonb_build_object(
      'scheduled', (select count(*) from pages where shop_id = p_shop_id and deleted_at is null and published and published_at > now())
                 + (select count(*) from articles where shop_id = p_shop_id and deleted_at is null and published and published_at > now()),
      'drafts', (select count(*) from pages where shop_id = p_shop_id and deleted_at is null and not published)
              + (select count(*) from articles where shop_id = p_shop_id and deleted_at is null and not published)));
  end if;
  if banto_owns_shop(p_shop_id) then
    v := v || jsonb_build_object('setup', jsonb_build_object(
      'legal', nullif(btrim(coalesce(v_shop.legal_notice, '')), '') is not null and nullif(btrim(coalesce(v_shop.privacy_policy, '')), '') is not null and nullif(btrim(coalesce(v_shop.return_policy, '')), '') is not null,
      'product', exists (select 1 from products where shop_id = p_shop_id and published),
      'published', v_shop.published));
  end if;
  return v;
end;
$$;
revoke execute on function shop_home(uuid) from public, anon;
grant execute on function shop_home(uuid) to authenticated;

insert into banto_migrations (version) values ('0139_shop_home');
