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

-- ---------- 部分一致の検索と大きな数え上げ（RLS の外で、権限は 1 回だけ確かめる） ----------
-- RLS の掛かった表では ilike（漏れうる演算子）を権限の判定より先に評価できないので、pg_trgm のインデックスが使われず
-- 全件を見る（10 万件で数百 ms、100 万件で数秒。test/db/scale.test.ts）。行ごとに権限の関数を呼ぶ数え上げも同じ。
-- そこで、権限を 1 回確かめてから id だけを探す関数を置き、行そのものは今までどおり RLS 越しに読む（src/routes/admin/paging.tsx）。

-- 管理画面の一覧の検索: 条件に合う行の id を新しい順（created_at desc, id desc）に p_limit 個（1,000 まで）、p_after より後ろから。
--   products（catalog）: q = 名前・スラッグの部分一致、filters.state = published | draft
--   orders（orders）: q = 注文番号・決済の参照の完全一致かメール・氏名の部分一致、filters.status
--   customers（customers）: q = メール・氏名の部分一致、filters.field / filters.value = 独自項目の値の部分一致、filters.consent = yes | no | none
create or replace function admin_search_ids(p_shop_id uuid, p_kind text, p_q text, p_filters jsonb, p_after_k timestamptz, p_after_id uuid, p_limit integer)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_like text;
  v_where text := 'shop_id = $1';
  v_table text;
  v_perm text;
  v_q text := nullif(btrim(left(coalesce(p_q, ''), 100)), '');
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_out uuid[];
begin
  case p_kind
    when 'products' then v_table := 'products'; v_perm := 'catalog';
    when 'orders' then v_table := 'orders'; v_perm := 'orders';
    when 'customers' then v_table := 'customers'; v_perm := 'customers';
    else raise exception 'invalid_kind' using errcode = '22023';
  end case;
  if not banto_shop_perm(p_shop_id, v_perm) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if p_kind = 'products' then
    if v_like is not null then v_where := v_where || ' and (name ilike $2 or slug ilike $2)'; end if;
    if v_f->>'state' = 'published' then v_where := v_where || ' and published'; end if;
    if v_f->>'state' = 'draft' then v_where := v_where || ' and not published'; end if;
  elsif p_kind = 'orders' then
    if v_like is not null then
      v_where := v_where || ' and (customer_email ilike $2 or customer_name ilike $2 or payment_ref = $3'
        || case when v_q ~ '^\d{1,9}$' then ' or number = $3::integer' else '' end || ')';
    end if;
    if v_f->>'status' in ('paid', 'shipped', 'cancelled', 'refunded') then v_where := v_where || format(' and status = %L', v_f->>'status'); end if;
  else
    if v_like is not null then v_where := v_where || ' and (email ilike $2 or name ilike $2)'; end if;
    if coalesce(v_f->>'field', '') ~ '^[a-z][a-z0-9_]{0,39}$' and nullif(v_f->>'value', '') is not null then
      v_where := v_where || format(' and attributes->>%L ilike $4', v_f->>'field');
    end if;
    if v_f->>'consent' = 'yes' then v_where := v_where || ' and marketing_consent is true'; end if;
    if v_f->>'consent' = 'no' then v_where := v_where || ' and marketing_consent is false'; end if;
    if v_f->>'consent' = 'none' then v_where := v_where || ' and marketing_consent is null'; end if;
  end if;
  if p_after_k is not null and p_after_id is not null then
    v_where := v_where || ' and (created_at < $5 or (created_at = $5 and id < $6))';
  end if;
  execute format('select coalesce(array_agg(id order by created_at desc, id desc), ''{}'') from (select id, created_at from %I where %s order by created_at desc, id desc limit %s) x',
                 v_table, v_where, least(greatest(coalesce(p_limit, 50), 1), 1000))
    into v_out
    using p_shop_id, v_like, v_q,
          '%' || replace(replace(replace(coalesce(v_f->>'value', ''), '\', '\\'), '%', '\%'), '_', '\_') || '%',
          p_after_k, p_after_id;
  return v_out;
end;
$$;
revoke execute on function admin_search_ids(uuid, text, text, jsonb, timestamptz, uuid, integer) from public, anon;
grant execute on function admin_search_ids(uuid, text, text, jsonb, timestamptz, uuid, integer) to authenticated, service_role;

-- 発行したクーポンの状態ごとの数（marketing の項目）。{ available, held, used, revoked }
create or replace function coupon_grant_counts(p_shop_id uuid, p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when banto_shop_perm(p_shop_id, 'marketing') then
    jsonb_build_object('available', 0, 'held', 0, 'used', 0, 'revoked', 0)
    || coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from coupon_grants
                  where shop_id = p_shop_id and campaign_id = p_campaign_id group by status) x), '{}'::jsonb) end;
$$;
revoke execute on function coupon_grant_counts(uuid, uuid) from public, anon;
grant execute on function coupon_grant_counts(uuid, uuid) to authenticated, service_role;

insert into banto_migrations (version) values ('0059_admin_lists');
