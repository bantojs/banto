-- Banto 0001_init: コアスキーマ + RLS + 在庫 RPC
-- 前方専用マイグレーション。ロールバックは書かない（CLAUDE.md §11）。
-- すべてのテーブルに RLS を有効化し、最低1つのポリシーを付ける（CLAUDE.md §1-4、scripts/check-rls.mjs で検査）。
--
-- 実行主体のロール:
--   anon          … ストアフロント（セッションなし）。published なものだけ SELECT。
--   authenticated … 管理画面（owner の JWT）。自分の shop 配下だけ CRUD。
--   service_role  … src/db/privileged.ts からのみ。在庫 RPC・注文確定・Webhook。

create extension if not exists "pgcrypto";

-- ---------- バージョン追跡（Step 7 の未適用マイグレーション検出に使う） ----------
-- 各マイグレーションは末尾で自分の version を insert する。
create table banto_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- ---------- owner / shop ----------
create table owners (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (length(name) between 1 and 200),
  published boolean not null default false,
  -- 公開前チェック用（特商法表記・プライバシーポリシー・返品ポリシー）。
  -- 未入力のあいだは公開できない（CLAUDE.md §9）。アプリ層だけでなく DB でも保証する。
  legal_notice text,
  privacy_policy text,
  return_policy text,
  stripe_account_id text,          -- Stripe Connect の接続済みアカウント ID のみ保持（シークレットは持たない）
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shops_publish_requires_legal check (
    not published or (
      nullif(btrim(legal_notice), '') is not null
      and nullif(btrim(privacy_policy), '') is not null
      and nullif(btrim(return_policy), '') is not null
    )
  )
);
create index on shops(owner_id);

-- ---------- 商品 / SKU / 在庫 ----------
create table products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (length(name) between 1 and 200),
  description text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, slug)
);
create index on products(shop_id);

create table skus (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  code text not null check (length(code) between 1 and 100),
  name text,
  price_jpy integer not null check (price_jpy >= 0),
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create index on skus(product_id);

-- 在庫の正はこの1行のみ（CLAUDE.md §6）。商品テーブルに在庫数を複製しない。
-- 行は skus への insert 時にトリガーで自動生成する（available = 0）。
create table inventory (
  sku_id uuid primary key references skus(id) on delete cascade,
  shop_id uuid not null references shops(id) on delete cascade,
  available integer not null default 0 check (available >= 0),
  updated_at timestamptz not null default now()
);
create index on inventory(shop_id);

create table product_images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  storage_key text not null,      -- StorageAdapter のキー。URL は MEDIA_BASE_URL + key
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index on product_images(product_id, sort_order);

-- ---------- 予約 / 注文 ----------
create type reservation_status as enum ('pending', 'confirmed', 'released');
create table reservations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  status reservation_status not null default 'pending',
  items jsonb not null,            -- [{sku_id, qty, unit_price_jpy}] 予約時点の価格スナップショット
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on reservations(shop_id, status, expires_at);

create type order_status as enum ('paid', 'shipped', 'cancelled', 'refunded');
create table orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  reservation_id uuid references reservations(id),
  status order_status not null default 'paid',
  total_jpy integer not null check (total_jpy >= 0),
  -- 個人情報。発送完了から一定期間後に mask_shipped_orders() でマスキング（CLAUDE.md §8）
  customer_email text,
  customer_name text,
  shipping_address jsonb,
  payment_provider text,           -- 'stripe' | 'komoju'
  payment_ref text,                -- 決済事業者側の ID
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orders(shop_id, created_at desc);
-- 1予約 = 1注文（confirm_reservation の冪等性を DB でも保証する）
create unique index orders_reservation_unique on orders(reservation_id) where reservation_id is not null;

create table order_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  sku_id uuid not null references skus(id),
  qty integer not null check (qty > 0),
  unit_price_jpy integer not null check (unit_price_jpy >= 0)
);
create index on order_items(order_id);

-- Webhook 冪等化（provider + event_id が主キー）
create table webhook_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

-- ---------- トリガー ----------
create or replace function banto_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger shops_updated_at before update on shops for each row execute function banto_set_updated_at();
create trigger products_updated_at before update on products for each row execute function banto_set_updated_at();
create trigger orders_updated_at before update on orders for each row execute function banto_set_updated_at();

-- SKU を作ったら在庫行を必ず持たせる。owner は inventory に直接 INSERT できないため security definer。
create or replace function banto_init_inventory()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into inventory (sku_id, shop_id) values (new.id, new.shop_id);
  return new;
end;
$$;
create trigger skus_init_inventory after insert on skus for each row execute function banto_init_inventory();

-- ---------- RLS ----------
alter table banto_migrations enable row level security;
alter table owners enable row level security;
alter table shops enable row level security;
alter table products enable row level security;
alter table skus enable row level security;
alter table inventory enable row level security;
alter table product_images enable row level security;
alter table reservations enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table webhook_events enable row level security;

-- 「この shop は自分のものか」。ポリシーの共通部品。
create or replace function banto_owns_shop(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from shops s where s.id = p_shop_id and s.owner_id = auth.uid());
$$;

-- owner の自己登録は「まだ owner がいない」ときだけ許可する（乗っ取り防止）。
-- 1デプロイ = 1運営者（CLAUDE.md §3）。将来スタッフを増やすときは招待制の別経路を足す。
create or replace function banto_owner_signup_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from owners);
$$;

-- banto_migrations: owner は閲覧のみ（アップデート画面で使う）
create policy migrations_owner_select on banto_migrations for select
  using (auth.uid() is not null and exists (select 1 from owners o where o.id = auth.uid()));

-- owners: 自分自身のみ。insert は上記ゲート付き。
create policy owners_self_select on owners for select using (id = auth.uid());
create policy owners_self_insert on owners for insert with check (id = auth.uid() and banto_owner_signup_allowed());
create policy owners_self_delete on owners for delete using (id = auth.uid());

-- shops: owner はフル、匿名は published のみ閲覧
create policy shops_owner on shops for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy shops_public on shops for select using (published = true);

-- shop 配下のテーブル共通: owner はフル、匿名は shop と行が published のとき閲覧
create policy products_owner on products for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy products_public on products for select
  using (published = true and exists (select 1 from shops s where s.id = products.shop_id and s.published = true));

create policy skus_owner on skus for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy skus_public on skus for select
  using (exists (select 1 from products p join shops s on s.id = p.shop_id
                 where p.id = skus.product_id and p.published and s.published));

-- inventory: 閲覧のみ。変更は RPC（set_stock / reserve_stock / release）経由だけ。
create policy inventory_owner on inventory for select using (banto_owns_shop(shop_id));
create policy inventory_public on inventory for select
  using (exists (select 1 from skus k join products p on p.id = k.product_id join shops s on s.id = p.shop_id
                 where k.id = inventory.sku_id and p.published and s.published));

create policy images_owner on product_images for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy images_public on product_images for select
  using (exists (select 1 from products p join shops s on s.id = p.shop_id
                 where p.id = product_images.product_id and p.published and s.published));

-- orders: owner は閲覧と更新（発送済み・キャンセル等）。作成は confirm_reservation（service_role）のみ。
create policy orders_owner_select on orders for select using (banto_owns_shop(shop_id));
create policy orders_owner_update on orders for update
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy order_items_owner on order_items for select using (banto_owns_shop(shop_id));
create policy reservations_owner on reservations for select using (banto_owns_shop(shop_id));

-- webhook_events は service_role 専用。anon/authenticated からは見えない。
create policy webhook_events_none on webhook_events for select using (false);

-- ---------- 在庫 RPC（service_role 専用、CLAUDE.md §6）----------
-- p_items: [{"sku_id": uuid, "qty": int}, ...]
-- 条件付き UPDATE（available >= qty）で原子的に減算し、1行でも失敗したら例外で全体ロールバック。
-- 戻り値: reservation id。items には予約時点の単価スナップショットを保存する。
create or replace function reserve_stock(p_shop_id uuid, p_items jsonb, p_ttl_seconds integer default 900)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku_id uuid;
  v_qty integer;
  v_price integer;
  v_updated integer;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reserve_stock: service_role only' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_items';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_ttl';
  end if;

  -- sku_id 順に処理し、複数予約が同じ SKU 群を逆順でロックしてデッドロックするのを防ぐ
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku_id := (v_item->>'sku_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_sku_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'invalid_item' using detail = coalesce(v_item::text, 'null');
    end if;

    -- SKU が shop に属し、商品と shop が公開中であること
    select k.price_jpy into v_price
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = k.shop_id
     where k.id = v_sku_id and k.shop_id = p_shop_id and p.published and s.published;
    if not found then
      raise exception 'sku_not_available' using detail = v_sku_id::text;
    end if;

    update inventory
       set available = available - v_qty, updated_at = now()
     where sku_id = v_sku_id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'insufficient_stock' using detail = v_sku_id::text;
    end if;

    v_items := v_items || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'unit_price_jpy', v_price);
  end loop;

  insert into reservations (shop_id, items, expires_at)
  values (p_shop_id, v_items, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_reservation_id;

  return v_reservation_id;
end;
$$;

-- 決済 Webhook 受信時に予約を確定注文へ変換する。同じ reservation_id に対して冪等（同じ order id を返す）。
-- p_order: {"customer_email", "customer_name", "shipping_address": {...}, "payment_provider", "payment_ref"}
-- 予約が TTL 切れで released 済みなら同じ品目で再度在庫を引き、足りなければ例外（呼び出し側で返金する）。
create or replace function confirm_reservation(p_reservation_id uuid, p_shop_id uuid, p_order jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_order_id uuid;
  v_item jsonb;
  v_updated integer;
  v_total integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'confirm_reservation: service_role only' using errcode = '42501';
  end if;

  select * into v_res from reservations
   where id = p_reservation_id and shop_id = p_shop_id
   for update;
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;

  -- 冪等: すでに注文があればそれを返す
  select id into v_order_id from orders where reservation_id = p_reservation_id;
  if found then
    return v_order_id;
  end if;

  if v_res.status = 'released' then
    for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
      update inventory
         set available = available - (v_item->>'qty')::integer, updated_at = now()
       where sku_id = (v_item->>'sku_id')::uuid and shop_id = p_shop_id
         and available >= (v_item->>'qty')::integer;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'insufficient_stock_after_release' using detail = v_item->>'sku_id';
      end if;
    end loop;
  end if;

  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0)
    into v_total
    from jsonb_array_elements(v_res.items) e;

  insert into orders (shop_id, reservation_id, status, total_jpy,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref)
  values (p_shop_id, p_reservation_id, 'paid', v_total,
          p_order->>'customer_email', p_order->>'customer_name', p_order->'shipping_address',
          p_order->>'payment_provider', p_order->>'payment_ref')
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer
    from jsonb_array_elements(v_res.items) e;

  update reservations set status = 'confirmed' where id = p_reservation_id;

  return v_order_id;
end;
$$;

-- TTL 超過の未確定予約を在庫に戻す。Cron（SchedulerAdapter）から呼ぶ。戻り値は解放した予約数。
create or replace function release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res record;
  v_item jsonb;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_expired_reservations: service_role only' using errcode = '42501';
  end if;
  for v_res in
    select id, shop_id, items from reservations
     where status = 'pending' and expires_at < now()
     for update skip locked
  loop
    for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
      update inventory set available = available + (v_item->>'qty')::integer, updated_at = now()
       where sku_id = (v_item->>'sku_id')::uuid and shop_id = v_res.shop_id;
    end loop;
    update reservations set status = 'released' where id = v_res.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 特定の予約を明示的に解放する（決済セッションの期限切れ・キャンセル Webhook から呼ぶ）。
-- pending のときだけ在庫を戻す。confirmed / released なら何もしない（冪等）。戻り値: 解放したら true。
create or replace function release_reservation(p_reservation_id uuid, p_shop_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_item jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_reservation: service_role only' using errcode = '42501';
  end if;
  select * into v_res from reservations
   where id = p_reservation_id and shop_id = p_shop_id
   for update;
  if not found or v_res.status <> 'pending' then
    return false;
  end if;
  for v_item in select e from jsonb_array_elements(v_res.items) e order by e->>'sku_id' loop
    update inventory set available = available + (v_item->>'qty')::integer, updated_at = now()
     where sku_id = (v_item->>'sku_id')::uuid and shop_id = p_shop_id;
  end loop;
  update reservations set status = 'released' where id = p_reservation_id;
  return true;
end;
$$;

-- Webhook の冪等化。初見なら true、すでに処理済みなら false。
create or replace function record_webhook_event(p_provider text, p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'record_webhook_event: service_role only' using errcode = '42501';
  end if;
  insert into webhook_events (provider, event_id) values (p_provider, p_event_id)
  on conflict do nothing;
  return found;
end;
$$;

-- ---------- owner 用 RPC（authenticated、関数内で所有を検証） ----------
-- 在庫数を直接セットする（入荷・棚卸し）。減算の経路は reserve_stock に一本化するため、
-- owner にも inventory の UPDATE 権限は与えず、この関数だけを許す。
create or replace function set_stock(p_sku_id uuid, p_available integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if p_available is null or p_available < 0 then
    raise exception 'invalid_available';
  end if;
  select shop_id into v_shop_id from skus where id = p_sku_id;
  if not found or not banto_owns_shop(v_shop_id) then
    raise exception 'sku_not_found' using errcode = '42501';
  end if;
  update inventory set available = p_available, updated_at = now() where sku_id = p_sku_id;
  return p_available;
end;
$$;

-- 顧客単位の削除依頼への対応（CLAUDE.md §8）。該当メールの注文の個人情報をマスキングする。
create or replace function mask_customer(p_shop_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if not banto_owns_shop(p_shop_id) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where shop_id = p_shop_id and lower(customer_email) = lower(p_email);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- セットアップ状態（ウィザード用、anon から呼べる） ----------
-- owner の有無・shop 数・適用済みマイグレーションだけを返す。個人情報や設定値は含めない。
create or replace function banto_setup_state()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'has_owner', exists (select 1 from owners),
    'shop_count', (select count(*) from shops),
    'migrations', (select coalesce(jsonb_agg(version order by version), '[]'::jsonb) from banto_migrations)
  );
$$;

-- ---------- 個人情報の自動マスキング（CLAUDE.md §8、Cron から service_role で呼ぶ）----------
create or replace function mask_shipped_orders(p_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_shipped_orders: service_role only' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where status = 'shipped' and shipped_at < now() - make_interval(days => p_days)
     and (customer_name is distinct from '[masked]' or customer_email is not null or shipping_address is not null);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- 実行権限 ----------
-- PostgreSQL は関数の EXECUTE を既定で PUBLIC に与えるため、public からも剥奪する。
revoke execute on function reserve_stock(uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function confirm_reservation(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function release_expired_reservations() from public, anon, authenticated;
revoke execute on function release_reservation(uuid, uuid) from public, anon, authenticated;
revoke execute on function record_webhook_event(text, text) from public, anon, authenticated;
revoke execute on function mask_shipped_orders(integer) from public, anon, authenticated;
grant execute on function reserve_stock(uuid, jsonb, integer) to service_role;
grant execute on function confirm_reservation(uuid, uuid, jsonb) to service_role;
grant execute on function release_expired_reservations() to service_role;
grant execute on function release_reservation(uuid, uuid) to service_role;
grant execute on function record_webhook_event(text, text) to service_role;
grant execute on function mask_shipped_orders(integer) to service_role;

revoke execute on function set_stock(uuid, integer) from public, anon;
revoke execute on function mask_customer(uuid, text) from public, anon;
grant execute on function set_stock(uuid, integer) to authenticated, service_role;
grant execute on function mask_customer(uuid, text) to authenticated, service_role;

-- ポリシー内から呼ぶヘルパーは anon/authenticated にも実行を許す（security definer なので中身は見えない）
grant execute on function banto_owns_shop(uuid) to anon, authenticated, service_role;
grant execute on function banto_owner_signup_allowed() to anon, authenticated, service_role;
grant execute on function banto_setup_state() to anon, authenticated, service_role;

-- トリガー関数・内部関数は直接呼ばせない
revoke execute on function banto_init_inventory() from public, anon, authenticated;
revoke execute on function banto_set_updated_at() from public, anon, authenticated;

insert into banto_migrations (version) values ('0001_init');
