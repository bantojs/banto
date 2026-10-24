-- Banto 0010_coupons: クーポン（値引き）の器と、在庫と同じ一本道での回数の予約。docs/knowledge/09-coupons.md
-- 前方専用。
--
-- 値引きはお金に関わるので判定はコア（CLAUDE.md §7 の基準 (1)）。計算は src/commerce/discounts.ts の 1 か所、
-- 回数（全体の上限・1 人あたり）は予約と同じく Postgres の中で原子的に数える。管理画面は同梱モジュール coupons（既定 OFF）。
--
--   coupon_campaigns   キャンペーン（値引きの内容と条件。条件は宣言型の JSON）
--   coupon_slots       全体の上限の「枠」。上限の数だけ行を作り、空き枠を FOR UPDATE SKIP LOCKED で取り合う
--                      （1 つのカウンターを全員で書き換えないので、先着のキャンペーンでも順番待ちが起きない）
--   coupon_redemptions 使用の記録。予約中 held → 確定 used、決済ページの期限切れ・キャンセルで released
--
-- 1 人あたりの回数は subject（会員なら 'c:<会員 ID>'、ゲストなら 'e:<メールアドレスの SHA-256>'）で数える。
-- メールアドレスそのものは持たない（個人情報を増やさない）。

-- ---------- キャンペーン ----------
create table coupon_campaigns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  -- 公開コード（大文字に正規化）。null ならコードでは使えない（会員への発行など、後で足す使い方のため）
  code text check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  kind text not null check (kind in ('percent', 'fixed', 'free_shipping')),
  -- percent: 1〜100（%）、fixed: 円、free_shipping: 0
  value integer not null default 0 check (value >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  -- 全体の上限（null なら無制限）。この数だけ coupon_slots を作る
  usage_limit integer check (usage_limit between 1 and 100000),
  -- 1 人あたりの上限（null なら無制限）
  per_customer_limit integer check (per_customer_limit between 1 and 1000),
  -- 他のクーポンと併用できるか（併用できないクーポンは 1 注文に 1 枚だけ）
  combinable boolean not null default false,
  -- public: 誰でも / members: ログイン中の会員だけ
  audience text not null default 'public' check (audience in ('public', 'members')),
  -- 対象と条件（src/commerce/discounts.ts の Conditions）。任意のコードは動かさない
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'percent' or value between 1 and 100),
  check (kind <> 'fixed' or value >= 1),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
create unique index coupon_campaigns_code on coupon_campaigns(shop_id, code) where code is not null;
create index on coupon_campaigns(shop_id);
create trigger coupon_campaigns_updated_at before update on coupon_campaigns for each row execute function banto_set_updated_at();

-- ---------- 全体の上限の枠 ----------
create table coupon_slots (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references coupon_campaigns(id) on delete cascade,
  shop_id uuid not null references shops(id) on delete cascade,
  status text not null default 'free' check (status in ('free', 'held', 'used')),
  reservation_id uuid references reservations(id) on delete set null
);
-- 空き枠だけの部分索引（使われた枠が増えても、空き枠を探す速さは変わらない）
create index coupon_slots_free on coupon_slots(campaign_id) where status = 'free';
create index on coupon_slots(reservation_id) where reservation_id is not null;

-- ---------- 使用の記録 ----------
create table coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  campaign_id uuid not null references coupon_campaigns(id) on delete cascade,
  reservation_id uuid not null references reservations(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  subject text not null check (subject ~ '^(c|e):[0-9a-f-]{32,64}$'),
  slot_id bigint references coupon_slots(id) on delete set null,
  amount_jpy integer not null default 0 check (amount_jpy >= 0),
  status text not null default 'held' check (status in ('held', 'used', 'released')),
  created_at timestamptz not null default now()
);
-- 1 人あたりの回数: そのキャンペーン × その人の、戻していない行だけを索引で引く
create index coupon_redemptions_subject on coupon_redemptions(campaign_id, subject) where status <> 'released';
create index on coupon_redemptions(reservation_id);
create index on coupon_redemptions(order_id) where order_id is not null;
create index on coupon_redemptions(shop_id, campaign_id);

-- ---------- 予約・注文に値引きを残す ----------
-- discount_jpy は値引きの合計（商品の値引き + 送料の値引き）。合計 = 小計 + 送料 - discount_jpy
-- discounts は適用したクーポンのスナップショット [{campaign_id, code, name, kind, amount_jpy}]
-- 商品ごとの値引き（税率ごとの区分に使う）は予約の items の discount_jpy と order_items.discount_jpy
alter table reservations add column discount_jpy integer not null default 0 check (discount_jpy >= 0);
alter table reservations add column discounts jsonb;
alter table orders add column discount_jpy integer not null default 0 check (discount_jpy >= 0);
alter table orders add column discounts jsonb;
-- 決済事業者が受け取った額（照合用。Banto の計算と違えば管理画面で知らせる）
alter table orders add column amount_paid_jpy integer;
alter table order_items add column discount_jpy integer not null default 0 check (discount_jpy >= 0);

-- ---------- RLS ----------
alter table coupon_campaigns enable row level security;
alter table coupon_slots enable row level security;
alter table coupon_redemptions enable row level security;
-- owner は自ショップのキャンペーンを管理する。購入者（anon / 会員）は直接読めない（判定は service_role の RPC 経由）
create policy coupon_campaigns_owner on coupon_campaigns for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy coupon_slots_owner_select on coupon_slots for select using (banto_owns_shop(shop_id));
create policy coupon_redemptions_owner_select on coupon_redemptions for select using (banto_owns_shop(shop_id));

-- ---------- 枠の数を上限に合わせる ----------
-- owner がキャンペーンを作る・上限を変えると、空き枠を足す / 減らす。使用中・使用済みの枠より少なくはできない。
-- 上限を後から付けた場合、それまでの使用は数えない（上限は設定した時点からの数）
create or replace function banto_sync_coupon_slots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_taken integer; v_have integer;
begin
  if new.usage_limit is null then
    delete from coupon_slots where campaign_id = new.id and status = 'free';
    return new;
  end if;
  select count(*) filter (where status <> 'free'), count(*) into v_taken, v_have from coupon_slots where campaign_id = new.id;
  if new.usage_limit < v_taken then
    raise exception 'usage_limit_below_used' using detail = v_taken::text;
  end if;
  if v_have < new.usage_limit then
    insert into coupon_slots (campaign_id, shop_id)
    select new.id, new.shop_id from generate_series(1, new.usage_limit - v_have);
  elsif v_have > new.usage_limit then
    delete from coupon_slots where id in (
      select id from coupon_slots where campaign_id = new.id and status = 'free' limit v_have - new.usage_limit
    );
  end if;
  return new;
end;
$$;
create trigger coupon_campaigns_slots after insert or update of usage_limit on coupon_campaigns
  for each row execute function banto_sync_coupon_slots();
revoke execute on function banto_sync_coupon_slots() from public, anon, authenticated;

-- ---------- 判定の材料（service_role） ----------
-- コードからキャンペーンを引く（索引で 1 件ずつ）。subject があれば、その人の使用回数も返す。
-- 全体の上限は「空き枠が 1 つでもあるか」だけを見る（数えない）
create or replace function coupon_lookup(p_shop_id uuid, p_codes text[], p_subject text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'coupon_lookup: service_role only' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'code', c.code, 'kind', c.kind, 'value', c.value,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'usage_limit', c.usage_limit, 'per_customer_limit', c.per_customer_limit,
      'combinable', c.combinable, 'audience', c.audience, 'conditions', c.conditions, 'active', c.active,
      'used_by_subject', case when p_subject is null or c.per_customer_limit is null then 0 else (
        select count(*) from coupon_redemptions r where r.campaign_id = c.id and r.subject = p_subject and r.status <> 'released') end,
      'available', c.usage_limit is null or exists (select 1 from coupon_slots s where s.campaign_id = c.id and s.status = 'free')
    )), '[]'::jsonb)
    into v_out
    from coupon_campaigns c
   where c.shop_id = p_shop_id and c.code = any (select upper(btrim(x)) from unnest(coalesce(p_codes, '{}'::text[])) x limit 5);
  return v_out;
end;
$$;

-- ---------- 予約に値引きを付け、回数を予約する（service_role） ----------
-- placeOrder が reserve_stock → attach_reservation_customer の直後に呼ぶ。金額は Worker の discounts.ts が計算した値
-- （service_role からしか呼べない）。ここでは回数と期間・有効状態だけを確かめ直す。1 つでも取れなければ全体を取り消し、
-- 呼び出し側が予約ごと解放する。
--   p_discounts: { total_jpy, lines: [{sku_id, discount_jpy}], applied: [{campaign_id, code, name, kind, amount_jpy}] }
create or replace function apply_reservation_discounts(p_reservation_id uuid, p_shop_id uuid, p_subject text, p_discounts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_a jsonb;
  v_c coupon_campaigns%rowtype;
  v_used integer;
  v_slot bigint;
  v_total integer := coalesce((p_discounts->>'total_jpy')::integer, 0);
  v_lines jsonb := coalesce(p_discounts->'lines', '[]'::jsonb);
  v_subtotal integer;
  v_items jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'apply_reservation_discounts: service_role only' using errcode = '42501';
  end if;
  if p_subject is null or p_subject !~ '^(c|e):[0-9a-f-]{32,64}$' then raise exception 'invalid_subject'; end if;
  select * into v_res from reservations where id = p_reservation_id and shop_id = p_shop_id and status = 'pending' for update;
  if not found then raise exception 'reservation_not_found' using detail = p_reservation_id::text; end if;
  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0) into v_subtotal from jsonb_array_elements(v_res.items) e;
  if v_total < 0 or v_total > v_subtotal + v_res.shipping_jpy then raise exception 'invalid_discount'; end if;

  for v_a in select e from jsonb_array_elements(coalesce(p_discounts->'applied', '[]'::jsonb)) e loop
    select * into v_c from coupon_campaigns where id = (v_a->>'campaign_id')::uuid and shop_id = p_shop_id;
    if not found or not v_c.active or (v_c.starts_at is not null and v_c.starts_at > now()) or (v_c.ends_at is not null and v_c.ends_at < now()) then
      raise exception 'coupon_unavailable' using detail = coalesce(v_a->>'code', '');
    end if;
    -- 会員限定は会員の subject だけ（Worker 側でも判定済み。ここは念のための二重の確認）
    if v_c.audience = 'members' and p_subject !~ '^c:' then
      raise exception 'coupon_unavailable' using detail = coalesce(v_c.code, '');
    end if;
    -- 1 人あたり: 同じ人の同時の申込みだけを直列にする（他の人は待たない）
    if v_c.per_customer_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_c.id::text || '|' || p_subject, 0));
      select count(*) into v_used from coupon_redemptions where campaign_id = v_c.id and subject = p_subject and status <> 'released';
      if v_used >= v_c.per_customer_limit then raise exception 'coupon_limit_reached' using detail = coalesce(v_c.code, ''); end if;
    end if;
    -- 全体の上限: 誰も触っていない空き枠を 1 つ取る
    v_slot := null;
    if v_c.usage_limit is not null then
      update coupon_slots set status = 'held', reservation_id = p_reservation_id
       where id = (select id from coupon_slots where campaign_id = v_c.id and status = 'free' limit 1 for update skip locked)
      returning id into v_slot;
      if v_slot is null then raise exception 'coupon_exhausted' using detail = coalesce(v_c.code, ''); end if;
    end if;
    insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, slot_id, amount_jpy)
    values (p_shop_id, v_c.id, p_reservation_id, p_subject, v_slot, greatest(0, coalesce((v_a->>'amount_jpy')::integer, 0)));
  end loop;

  -- 商品ごとの値引きを予約の items に書き込む
  select jsonb_agg(e || jsonb_build_object('discount_jpy',
           least((e->>'qty')::integer * (e->>'unit_price_jpy')::integer,
                 greatest(0, coalesce((select (l->>'discount_jpy')::integer from jsonb_array_elements(v_lines) l where l->>'sku_id' = e->>'sku_id' limit 1), 0)))))
    into v_items from jsonb_array_elements(v_res.items) e;
  update reservations set discount_jpy = v_total, discounts = p_discounts->'applied', items = coalesce(v_items, items) where id = p_reservation_id;
  return jsonb_build_object('discount_jpy', v_total);
end;
$$;

-- ---------- 枠と使用の記録を戻す（解放・キャンセルで共通） ----------
create or replace function banto_release_coupons(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update coupon_slots set status = 'free', reservation_id = null where reservation_id = p_reservation_id;
  update coupon_redemptions set status = 'released' where reservation_id = p_reservation_id and status <> 'released';
end;
$$;
revoke execute on function banto_release_coupons(uuid) from public, anon, authenticated;

-- ---------- 解放（0002 を差し替え: クーポンの枠と使用の記録も戻す） ----------
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
  perform banto_release_coupons(p_reservation_id);
  update reservations set status = 'released', customer = null where id = p_reservation_id;
  return true;
end;
$$;

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
    perform banto_release_coupons(v_res.id);
    update reservations set status = 'released', customer = null where id = v_res.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------- 注文確定（0004 を差し替え: 値引き・決済額・クーポンの確定） ----------
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
  v_subtotal integer;
  v_total integer;
  v_number integer;
  v_threshold integer;
  v_available integer;
  v_payload jsonb;
  v_r record;
  v_slot bigint;
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
    -- 決済は値引き後の額で済んでいるので、値引きはそのまま有効にする。戻した枠は空いていれば取り直す
    -- （空きが無ければ枠なしで使用済みにする。上限を 1 回超えることがあるが、購入者はもう支払っている）
    for v_r in select id, campaign_id from coupon_redemptions where reservation_id = p_reservation_id and status = 'released' loop
      update coupon_slots set status = 'held', reservation_id = p_reservation_id
       where id = (select id from coupon_slots where campaign_id = v_r.campaign_id and status = 'free' limit 1 for update skip locked)
      returning id into v_slot;
      update coupon_redemptions set status = 'held', slot_id = v_slot where id = v_r.id;
    end loop;
  end if;

  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0)
    into v_subtotal
    from jsonb_array_elements(v_res.items) e;
  v_total := greatest(0, v_subtotal + v_res.shipping_jpy - v_res.discount_jpy);

  -- ショップごとの注文番号（shops の行ロックで直列化）
  update shops set order_seq = order_seq + 1 where id = p_shop_id returning order_seq into v_number;

  insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, discount_jpy, discounts, amount_paid_jpy, number, customer_id,
                      customer_email, customer_name, shipping_address, payment_provider, payment_ref)
  values (p_shop_id, p_reservation_id, 'paid', v_total, v_res.shipping_jpy, v_res.discount_jpy, v_res.discounts,
          nullif(p_order->>'amount_paid_jpy', '')::integer, v_number, v_res.customer_id,
          -- Banto のフォームで集めた値を優先し、無ければ決済事業者からの値
          coalesce(v_res.customer->>'customer_email', p_order->>'customer_email'),
          coalesce(v_res.customer->>'customer_name', p_order->>'customer_name'),
          coalesce(v_res.customer->'shipping_address', p_order->'shipping_address'),
          p_order->>'payment_provider', p_order->>'payment_ref')
  returning id into v_order_id;

  insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy)
  select p_shop_id, v_order_id, (e->>'sku_id')::uuid, (e->>'qty')::integer, (e->>'unit_price_jpy')::integer, coalesce((e->>'discount_jpy')::integer, 0)
    from jsonb_array_elements(v_res.items) e;

  update coupon_slots set status = 'used' where reservation_id = p_reservation_id and status = 'held';
  update coupon_redemptions set status = 'used', order_id = v_order_id where reservation_id = p_reservation_id and status = 'held';
  update reservations set status = 'confirmed', customer = null where id = p_reservation_id;

  v_payload := jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_number, 'shop_id', p_shop_id,
    'subtotal_jpy', v_subtotal, 'shipping_jpy', v_res.shipping_jpy, 'discount_jpy', v_res.discount_jpy, 'total_jpy', v_total,
    'status', 'paid', 'payment_provider', p_order->>'payment_provider', 'customer_id', v_res.customer_id,
    'items', v_res.items
  );
  perform enqueue_hook(p_shop_id, 'order.created', v_payload);
  perform enqueue_hook(p_shop_id, 'order.paid', v_payload);

  select coalesce((s.settings->>'low_stock_threshold')::integer, 3) into v_threshold from shops s where s.id = p_shop_id;
  for v_item in select e from jsonb_array_elements(v_res.items) e loop
    select available into v_available from inventory where sku_id = (v_item->>'sku_id')::uuid;
    if v_available is not null and v_available <= v_threshold then
      perform enqueue_hook(p_shop_id, 'inventory.low',
        jsonb_build_object('shop_id', p_shop_id, 'sku_id', v_item->>'sku_id', 'available', v_available, 'threshold', v_threshold));
    end if;
  end loop;

  return v_order_id;
end;
$$;

-- ---------- キャンセル（0004 を差し替え: クーポンの回数も戻す。WooCommerce と同じ） ----------
create or replace function cancel_order(p_order_id uuid, p_shop_id uuid, p_refunded boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_item record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cancel_order: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_o.status in ('cancelled', 'refunded') then
    return jsonb_build_object('order_id', v_o.id, 'status', v_o.status, 'already', true);
  end if;
  if v_o.status <> 'paid' then raise exception 'not_cancellable' using detail = v_o.status::text; end if;
  for v_item in select sku_id, qty from order_items where order_id = p_order_id loop
    update inventory set available = available + v_item.qty, updated_at = now()
     where sku_id = v_item.sku_id and shop_id = p_shop_id;
  end loop;
  if v_o.reservation_id is not null then perform banto_release_coupons(v_o.reservation_id); end if;
  update orders set status = case when p_refunded then 'refunded'::order_status else 'cancelled'::order_status end
   where id = p_order_id;
  perform enqueue_hook(p_shop_id, 'order.cancelled',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy,
                       'status', case when p_refunded then 'refunded' else 'cancelled' end, 'refunded', p_refunded, 'customer_id', v_o.customer_id));
  return jsonb_build_object('order_id', v_o.id, 'status', case when p_refunded then 'refunded' else 'cancelled' end, 'already', false,
                            'payment_provider', v_o.payment_provider, 'payment_ref', v_o.payment_ref);
end;
$$;

-- ---------- 注文の表示に値引きを足す（0004 を差し替え） ----------
-- 値引きは、コード・名前・額だけを出す（キャンペーンの条件は出さない）
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                            'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy, 'discount_jpy', o.discount_jpy,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;

create or replace function order_contact(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'created_at', v_o.created_at,
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug,
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'total_jpy', p_order.total_jpy, 'shipping_jpy', p_order.shipping_jpy,
    'discount_jpy', p_order.discount_jpy,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_order.discounts, '[]'::jsonb)) d),
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref, 'customer_id', p_order.customer_id,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  );
$$;

-- ---------- 管理画面の集計（owner） ----------
-- キャンペーンごとの使用済み・予約中の回数。所有していないショップなら null
create or replace function coupon_stats(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when banto_owns_shop(p_shop_id) then coalesce((
    select jsonb_object_agg(campaign_id, jsonb_build_object('used', used, 'held', held))
      from (select campaign_id, count(*) filter (where status = 'used') as used, count(*) filter (where status = 'held') as held
              from coupon_redemptions where shop_id = p_shop_id group by campaign_id) x), '{}'::jsonb) end;
$$;
revoke execute on function coupon_stats(uuid) from public, anon;
grant execute on function coupon_stats(uuid) to authenticated, service_role;

revoke execute on function coupon_lookup(uuid, text[], text) from public, anon, authenticated;
revoke execute on function apply_reservation_discounts(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function coupon_lookup(uuid, text[], text) to service_role;
grant execute on function apply_reservation_discounts(uuid, uuid, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0010_coupons');
