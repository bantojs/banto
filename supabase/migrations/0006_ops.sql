-- Banto 0006_ops: バックアップ JSON からの復元、Cron のハートビート
-- 前方専用。

-- ---------- Cron ハートビート ----------
-- 5 分ごとの Cron が最後に動いた時刻。/health が「Cron が止まっている」を検出するために使う（docs/monitoring.md）。
create table banto_heartbeats (
  name text primary key,
  ran_at timestamptz not null default now()
);
alter table banto_heartbeats enable row level security;
-- owner は閲覧のみ（ダッシュボード用）。書き込みは service_role の RPC だけ。
create policy heartbeats_owner_select on banto_heartbeats for select
  using (exists (select 1 from owners o where o.id = auth.uid()));

create or replace function record_heartbeat(p_name text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into banto_heartbeats (name, ran_at) values (p_name, now())
  on conflict (name) do update set ran_at = excluded.ran_at;
$$;
revoke all on function record_heartbeat(text) from public, anon, authenticated;
grant execute on function record_heartbeat(text) to service_role;

-- anon から呼べる唯一の読み取り: 経過秒数だけを返す（時刻や名前の一覧は返さない）。無ければ null。
create or replace function heartbeat_age_seconds(p_name text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select extract(epoch from now() - ran_at)::integer from banto_heartbeats where name = p_name;
$$;
revoke all on function heartbeat_age_seconds(text) from public;
grant execute on function heartbeat_age_seconds(text) to anon, authenticated, service_role;

-- ---------- バックアップからの復元 ----------
-- /admin/shops/:id/export.json の JSON（tables 以下）を、空のショップに流し込む。
-- Worker 側が owner JWT で shop の所有を確認してから service_role で呼ぶ（src/db/privileged.ts）。
-- id はすべて振り直す（同じプロジェクトに同じ id が残っている可能性があるため）。
-- 画像の実体（R2）は対象外。storage_key はそのまま引き継ぐので、同じバケットなら表示される。
-- 会員（customers）は auth.users に同じ id が残っている場合だけ戻す（別プロジェクトでは戻せない）。
create or replace function restore_shop_data(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_products jsonb := coalesce(p_data->'products', '[]'::jsonb);
  v_skus jsonb := coalesce(p_data->'skus', '[]'::jsonb);
  v_inventory jsonb := coalesce(p_data->'inventory', '[]'::jsonb);
  v_images jsonb := coalesce(p_data->'product_images', '[]'::jsonb);
  v_orders jsonb := coalesce(p_data->'orders', '[]'::jsonb);
  v_items jsonb := coalesce(p_data->'order_items', '[]'::jsonb);
  v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb);
  v_endpoints jsonb := coalesce(p_data->'hook_endpoints', '[]'::jsonb);
  v_row jsonb;
  v_new uuid;
  v_old uuid;
  v_product_map jsonb := '{}'::jsonb;
  v_sku_map jsonb := '{}'::jsonb;
  v_order_map jsonb := '{}'::jsonb;
  v_customer_ok jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  v_skipped_items integer := 0;
  v_skipped_customers integer := 0;
  v_max_number integer;
begin
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if exists (select 1 from products where shop_id = p_shop_id) or exists (select 1 from orders where shop_id = p_shop_id) then
    raise exception 'shop_not_empty';
  end if;
  if jsonb_typeof(v_products) <> 'array' or jsonb_typeof(v_orders) <> 'array' then raise exception 'invalid_export'; end if;

  -- 商品
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_products) loop
    v_old := (v_row->>'id')::uuid;
    insert into products (shop_id, slug, name, description, published, created_at, updated_at)
      values (p_shop_id, v_row->>'slug', v_row->>'name', v_row->>'description', coalesce((v_row->>'published')::boolean, false),
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
    v_product_map := v_product_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('products', v_n);

  -- SKU（inventory 行はトリガーで作られる）→ 在庫数を戻す
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_skus) loop
    if v_product_map ? (v_row->>'product_id') then
      v_old := (v_row->>'id')::uuid;
      insert into skus (shop_id, product_id, code, name, price_jpy, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'code', v_row->>'name', (v_row->>'price_jpy')::integer,
                coalesce((v_row->>'created_at')::timestamptz, now()))
        returning id into v_new;
      v_sku_map := v_sku_map || jsonb_build_object(v_old::text, v_new::text);
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('skus', v_n);
  for v_row in select * from jsonb_array_elements(v_inventory) loop
    if v_sku_map ? (v_row->>'sku_id') then
      update inventory set available = greatest(0, coalesce((v_row->>'available')::integer, 0))
        where sku_id = (v_sku_map->>(v_row->>'sku_id'))::uuid and shop_id = p_shop_id;
    end if;
  end loop;

  -- 画像（R2 のキーはそのまま）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_images) loop
    if v_product_map ? (v_row->>'product_id') then
      insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, sort_order, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'storage_key', v_row->>'thumb_key',
                (v_row->>'width')::integer, (v_row->>'height')::integer, coalesce((v_row->>'sort_order')::integer, 0),
                coalesce((v_row->>'created_at')::timestamptz, now()));
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('product_images', v_n);

  -- 会員: auth.users に同じ id がある場合だけ
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    v_old := (v_row->>'id')::uuid;
    if exists (select 1 from auth.users u where u.id = v_old) then
      insert into customers (id, shop_id, email, name, default_address, created_at)
        values (v_old, p_shop_id, v_row->>'email', v_row->>'name', v_row->'default_address', coalesce((v_row->>'created_at')::timestamptz, now()))
        on conflict (shop_id, id) do nothing;
      v_customer_ok := v_customer_ok || jsonb_build_object(v_old::text, true);
      v_n := v_n + 1;
    else
      v_skipped_customers := v_skipped_customers + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('customers', v_n, 'customers_skipped', v_skipped_customers);

  -- 注文（予約との紐づけは切る。番号は維持）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_orders) loop
    v_old := (v_row->>'id')::uuid;
    insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, number, customer_email, customer_name, shipping_address,
                        payment_provider, payment_ref, shipped_at, customer_id, created_at, updated_at)
      values (p_shop_id, null, coalesce((v_row->>'status')::order_status, 'paid'), coalesce((v_row->>'total_jpy')::integer, 0),
              coalesce((v_row->>'shipping_jpy')::integer, 0), (v_row->>'number')::integer, v_row->>'customer_email', v_row->>'customer_name',
              v_row->'shipping_address', v_row->>'payment_provider', v_row->>'payment_ref', (v_row->>'shipped_at')::timestamptz,
              case when v_customer_ok ? (v_row->>'customer_id') then (v_row->>'customer_id')::uuid else null end,
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
    v_order_map := v_order_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('orders', v_n);
  select max(number) into v_max_number from orders where shop_id = p_shop_id;
  if v_max_number is not null then
    update shops set order_seq = greatest(order_seq, v_max_number) where id = p_shop_id;
  end if;

  -- 明細（SKU が復元されていない行は飛ばす: skus.id への FK があるため）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_items) loop
    if v_order_map ? (v_row->>'order_id') and v_sku_map ? (v_row->>'sku_id') then
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
        values (p_shop_id, (v_order_map->>(v_row->>'order_id'))::uuid, (v_sku_map->>(v_row->>'sku_id'))::uuid,
                (v_row->>'qty')::integer, (v_row->>'unit_price_jpy')::integer);
      v_n := v_n + 1;
    else
      v_skipped_items := v_skipped_items + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('order_items', v_n, 'order_items_skipped', v_skipped_items);

  -- 連携先（id は振り直す = 署名シークレットも変わる。外部プラグイン側の再設定が要る）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_endpoints) loop
    insert into hook_endpoints (shop_id, name, url, events, enabled, manifest, settings, created_at)
      values (p_shop_id, v_row->>'name', v_row->>'url',
              coalesce((select array_agg(e) from jsonb_array_elements_text(coalesce(v_row->'events', '[]'::jsonb)) e), '{}'),
              coalesce((v_row->>'enabled')::boolean, true), v_row->'manifest', coalesce(v_row->'settings', '{}'::jsonb),
              coalesce((v_row->>'created_at')::timestamptz, now()));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('hook_endpoints', v_n);

  return v_counts;
end;
$$;
revoke all on function restore_shop_data(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_shop_data(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0006_ops');
