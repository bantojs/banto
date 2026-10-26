-- Banto 0059_admin_lists: 管理画面の一覧を DB で検索・ページ送りする（10 万〜100 万件。人間の決定 2026-10-26）。前方専用。
-- 管理画面の一覧（商品・注文・会員・クーポン・発行したクーポン）は、新しい順のキーセット（created_at desc, id desc）で 1 ページずつ読み、
-- 名前・メールなどの部分一致は PostgREST の ilike で DB に寄せた（src/routes/admin/paging.tsx）。そのためのインデックスと、
-- キャンペーンの「使われた数」を表示する分だけ数える coupon_stats_for。インデックスが無くても結果は同じ（遅いだけ）なので、
-- コードは適用前の DB でもそのまま動く（coupon_stats_for だけ migrated() で分岐）。

-- ---------- 新しい順のページ送り ----------
create index if not exists products_admin_list on products (shop_id, created_at desc, id desc);
create index if not exists orders_admin_list on orders (shop_id, created_at desc, id desc);
create index if not exists customers_admin_list on customers (shop_id, created_at desc, id desc);
create index if not exists coupon_campaigns_admin_list on coupon_campaigns (shop_id, created_at desc, id desc);
create index if not exists coupon_grants_admin_list on coupon_grants (campaign_id, created_at desc, id desc);
create index if not exists coupon_grants_status on coupon_grants (campaign_id, status);

-- ---------- 部分一致（ilike）: pg_trgm の GIN（0058 で入れた拡張。演算子クラスの場所を引く） ----------
do $$
declare v_schema text;
begin
  select n.nspname into v_schema from pg_opclass o join pg_namespace n on n.oid = o.opcnamespace where o.opcname = 'gin_trgm_ops' limit 1;
  execute format('create index if not exists products_name_trgm on products using gin (name %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists products_slug_trgm on products using gin (slug %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists orders_email_trgm on orders using gin (customer_email %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists orders_name_trgm on orders using gin (customer_name %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists customers_email_trgm on customers using gin (email %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists customers_name_trgm on customers using gin (name %I.gin_trgm_ops)', v_schema);
end;
$$;
create index if not exists orders_payment_ref on orders (shop_id, payment_ref) where payment_ref is not null;

-- ---------- キャンペーンの使われた数（表示する分だけ） ----------
-- coupon_stats（0024）と同じ権限（marketing の項目）。p_campaign_ids は 200 個まで
create or replace function coupon_stats_for(p_shop_id uuid, p_campaign_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when banto_shop_perm(p_shop_id, 'marketing') and cardinality(p_campaign_ids) <= 200 then coalesce((
    select jsonb_object_agg(campaign_id, jsonb_build_object('used', used, 'held', held))
      from (select campaign_id, count(*) filter (where status = 'used') as used, count(*) filter (where status = 'held') as held
              from coupon_redemptions where shop_id = p_shop_id and campaign_id = any(p_campaign_ids) group by campaign_id) x), '{}'::jsonb) end;
$$;
revoke execute on function coupon_stats_for(uuid, uuid[]) from public, anon;
grant execute on function coupon_stats_for(uuid, uuid[]) to authenticated, service_role;

insert into banto_migrations (version) values ('0059_admin_lists');
