-- 0025_store_tryon: 実店舗（組織の正本）と同梱モジュール「お店で試着」（docs/store-tryon.md、docs/knowledge/11-organizations.md）
--
-- お客様がネットで選んだ商品を、実店舗で試着できるよう取り置く。決済はしない（購入は店舗のレジ）。
-- - stores … 組織の実店舗（正本。店頭受け取りなどでも使う汎用の器）。営業時間（曜日ごと）と臨時休業・臨時営業を持つ。
--     hours        … {"0": [["10:00","20:00"]], …, "6": []}。キーは曜日（0 = 日曜）、空の配列は定休日。1 日に時間帯を 2 つまで（昼休み）
--     special_days … [{ "date": "2026-12-31", "closed": true, "note": "年末休業" } | { "date": …, "hours": [["11:00","17:00"]], "note": "臨時営業" }]
--     購入者（anon）には表を読ませない。お客様の画面は shop_store_list（公開の列だけ）で読む
-- - shop_stores … ショップで使う実店舗（試着を受けるか・並び順）。ショップと実店舗は同じ組織のものだけ
-- - org_member_stores … member に実店舗ごとの項目を割り当てる（tryon = 試着の申し込みを扱う、hours = 営業時間・臨時休業を直す）。
--     実店舗のスタッフは連絡先は見えるが、在庫を EC に戻すことはできない（人間の決定 2026-10-17）
-- - tryon_requests / tryon_items … 試着の申し込みと明細。書くのは下の関数だけ。
--     読めるのは、ショップの stores の項目を持つ人と、その実店舗の tryon の項目を持つ人
-- - 在庫は申し込みの時点で減らす（tryon_request、条件付き UPDATE。CLAUDE.md §1-7）。戻すのはショップの stores の項目を持つ人が選んだときだけ（tryon_restock）
-- - hooks: tryon.requested（申し込み）・tryon.updated（状態が変わった）。ペイロードに個人情報は載せない

alter table shops add column if not exists tryon_seq integer not null default 0;

create or replace function banto_store_perms_all()
returns text[]
language sql
immutable
as $$ select array['tryon', 'hours'] $$;

create table stores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  postal_code text check (postal_code is null or length(postal_code) <= 10),
  address text check (address is null or length(address) <= 200),
  phone text check (phone is null or length(phone) <= 20),
  email text check (email is null or (length(email) <= 254 and position('@' in email) > 1)),
  hours jsonb not null default '{}'::jsonb check (jsonb_typeof(hours) = 'object'),
  special_days jsonb not null default '[]'::jsonb check (jsonb_typeof(special_days) = 'array' and jsonb_array_length(special_days) <= 400),
  note text check (note is null or length(note) <= 500),
  notify_email boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on stores(org_id, sort_order);

create table shop_stores (
  shop_id uuid not null references shops(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  tryon boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (shop_id, store_id)
);
create index on shop_stores(store_id);

create table org_member_stores (
  org_id uuid not null,
  user_id uuid not null,
  store_id uuid not null references stores(id) on delete cascade,
  perms text[] not null default '{}' check (perms <@ array['tryon', 'hours']),
  primary key (user_id, store_id),
  foreign key (org_id, user_id) references org_members(org_id, user_id) on delete cascade
);
create index on org_member_stores(store_id);

-- ---------- 判定の関数 ----------
-- その実店舗の項目: 組織の owner / admin なら常に true、member ならその実店舗の perms
create or replace function banto_store_perm(p_store_id uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from stores st
     where st.id = p_store_id
       and (banto_org_admin(st.org_id)
            or exists (select 1 from org_member_stores ms where ms.store_id = st.id and ms.org_id = st.org_id and ms.user_id = auth.uid() and p_perm = any(ms.perms))));
$$;

-- 実店舗を読めるか: owner / admin、その実店舗の項目を持つ人、同じ組織のショップで stores の項目を持つ人（ショップで使う店舗を選ぶため）
create or replace function banto_store_visible(p_store_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from stores st
     where st.id = p_store_id
       and (banto_org_admin(st.org_id)
            or exists (select 1 from org_member_stores ms where ms.store_id = st.id and ms.org_id = st.org_id and ms.user_id = auth.uid() and cardinality(ms.perms) > 0)
            or exists (select 1 from org_member_shops ms where ms.org_id = st.org_id and ms.user_id = auth.uid() and 'stores' = any(ms.perms))));
$$;

-- ショップと実店舗は同じ組織のものだけ結べる
create or replace function banto_shop_stores_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from shops s join stores st on st.org_id = s.org_id where s.id = new.shop_id and st.id = new.store_id) then
    raise exception 'store_not_in_org' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger shop_stores_guard before insert or update on shop_stores for each row execute function banto_shop_stores_guard();

-- ---------- RLS ----------
alter table stores enable row level security;
alter table shop_stores enable row level security;
alter table org_member_stores enable row level security;
-- 実店舗の追加・変更・削除は組織の owner / admin。営業時間だけは hours の項目を持つ人も（store_set_hours・stores_set_special_days）
create policy stores_select on stores for select using (banto_store_visible(id));
create policy stores_admin on stores for all using (banto_org_admin(org_id)) with check (banto_org_admin(org_id));
create policy shop_stores_perm on shop_stores for all using (banto_shop_perm(shop_id, 'stores')) with check (banto_shop_perm(shop_id, 'stores'));
create policy org_member_stores_select on org_member_stores for select using (user_id = auth.uid() or banto_org_admin(org_id));
revoke all on stores, shop_stores, org_member_stores from anon;

create table tryon_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  store_id uuid not null references stores(id),
  number integer not null,
  status text not null default 'requested' check (status in ('requested', 'sent', 'ready', 'purchased', 'not_purchased', 'expired', 'cancelled')),
  -- 来店予定日（お客様が選ぶ形のとき）と、取り置きの期限（店舗に届いたときに決まる）。ショップの時間帯の日付
  visit_date date,
  hold_until date,
  customer_id uuid,
  -- 個人情報。終わった申し込みは mask_tryon_requests で一定期間後に消す（CLAUDE.md §8 と同じ扱い）
  customer_email text,
  customer_name text,
  customer_phone text,
  note text check (note is null or length(note) <= 500),
  -- 減らした在庫を EC に戻したか
  restocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (shop_id, customer_id) references customers(shop_id, id) on delete set null (customer_id)
);
create unique index tryon_requests_number on tryon_requests(shop_id, number);
create index on tryon_requests(shop_id, status, created_at desc);
create index on tryon_requests(store_id, status, created_at desc);
alter table tryon_requests enable row level security;
create policy tryon_requests_select on tryon_requests for select using (banto_shop_perm(shop_id, 'stores') or banto_store_perm(store_id, 'tryon'));

create table tryon_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  request_id uuid not null references tryon_requests(id) on delete cascade,
  sku_id uuid not null references skus(id),
  qty integer not null check (qty between 1 and 99),
  unit_price_jpy integer not null check (unit_price_jpy >= 0)
);
create index on tryon_items(request_id);
alter table tryon_items enable row level security;
create policy tryon_items_select on tryon_items for select
  using (banto_shop_perm(shop_id, 'stores') or exists (select 1 from tryon_requests r where r.id = tryon_items.request_id and banto_store_perm(r.store_id, 'tryon')));

-- ---------- hooks（試着の関数から。権限は呼び出し元の関数で確かめてある） ----------
-- enqueue_hook（0024）は orders / catalog の項目を求めるので、実店舗のスタッフの操作から積めない。ここは関数の中からだけ使う
create or replace function banto_enqueue_tryon_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns void language sql security definer set search_path = public as $$
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events);
$$;

-- ---------- お客様の画面の実店舗（anon。公開中のショップで使っている、営業中の店舗の公開の列だけ） ----------
create or replace function shop_store_list(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'shop_id', ss.shop_id, 'name', st.name, 'postal_code', st.postal_code, 'address', st.address,
                                               'phone', st.phone, 'hours', st.hours, 'special_days', st.special_days, 'note', st.note,
                                               'tryon', ss.tryon, 'active', st.active, 'sort_order', ss.sort_order)
                            order by ss.sort_order, st.sort_order, st.name), '[]'::jsonb)
    from shop_stores ss join stores st on st.id = ss.store_id join shops s on s.id = ss.shop_id
   where ss.shop_id = p_shop_id and s.published and st.active;
$$;

-- 自分が項目を持つ実店舗（スタッフの最初の画面）
create or replace function banto_my_stores()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'org_id', st.org_id, 'name', st.name, 'perms', to_jsonb(ms.perms)) order by st.sort_order, st.name), '[]'::jsonb)
    from org_member_stores ms join stores st on st.id = ms.store_id and st.org_id = ms.org_id
   where ms.user_id = auth.uid() and cardinality(ms.perms) > 0;
$$;

-- ---------- 営業時間（組織の owner / admin と hours の項目を持つ人） ----------
create or replace function store_set_hours(p_store_id uuid, p_hours jsonb, p_special_days jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not banto_store_perm(p_store_id, 'hours') then raise exception 'store_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_hours) <> 'object' or jsonb_typeof(p_special_days) <> 'array' then raise exception 'invalid_hours'; end if;
  update stores set hours = p_hours, special_days = p_special_days, updated_at = now() where id = p_store_id;
  return true;
end;
$$;

-- 臨時休業・臨時営業をまとめて登録する（全店舗 / 選んだ店舗に「12/31〜1/3 年末年始休業」など）。
-- p_days: [{ date, closed, hours, note } | { date, remove: true }]。同じ日付は置き換え、remove は消す。30 日より前の日付は掃除する。
-- 項目を持たない店舗は飛ばす。戻り値: 書き換えた店舗の数
create or replace function stores_set_special_days(p_org_id uuid, p_store_ids uuid[], p_days jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_store stores%rowtype; v_n integer := 0; v_dates text[]; v_next jsonb;
begin
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 or jsonb_array_length(p_days) > 400 then raise exception 'invalid_days'; end if;
  if exists (select 1 from jsonb_array_elements(p_days) d where coalesce(d->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'invalid_days'; end if;
  select array_agg(d->>'date') into v_dates from jsonb_array_elements(p_days) d;
  for v_store in select * from stores where org_id = p_org_id and id = any(p_store_ids) for update loop
    if not banto_store_perm(v_store.id, 'hours') then continue; end if;
    select coalesce(jsonb_agg(e order by e->>'date'), '[]'::jsonb) into v_next from (
      select e from jsonb_array_elements(v_store.special_days) e
       where not (e->>'date' = any(v_dates)) and e->>'date' >= to_char(current_date - 30, 'YYYY-MM-DD')
      union all
      select d - 'remove' from jsonb_array_elements(p_days) d where coalesce((d->>'remove')::boolean, false) = false
    ) x(e);
    if jsonb_array_length(v_next) > 400 then raise exception 'too_many_days'; end if;
    update stores set special_days = v_next, updated_at = now() where id = v_store.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------- メンバーの割り当て（0024 を差し替え: [{ store_id, perms }] も受け取る） ----------
-- p_shops: [{ shop_id, perms: [...] } | { store_id, perms: ['tryon','hours'] }]。その組織のショップ・実店舗の、決まった項目だけ入れる
create or replace function banto_set_member_shops(p_org_id uuid, p_user_id uuid, p_shops jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_row jsonb;
begin
  delete from org_member_shops where org_id = p_org_id and user_id = p_user_id;
  delete from org_member_stores where org_id = p_org_id and user_id = p_user_id;
  for v_row in select e from jsonb_array_elements(coalesce(p_shops, '[]'::jsonb)) e loop
    if v_row ? 'store_id' then
      if exists (select 1 from stores where id = nullif(v_row->>'store_id', '')::uuid and org_id = p_org_id) then
        insert into org_member_stores (org_id, user_id, store_id, perms)
        values (p_org_id, p_user_id, (v_row->>'store_id')::uuid,
                coalesce((select array_agg(distinct p) from jsonb_array_elements_text(coalesce(v_row->'perms', '[]'::jsonb)) p where p = any(banto_store_perms_all())), '{}'))
        on conflict (user_id, store_id) do update set perms = excluded.perms;
      end if;
    elsif exists (select 1 from shops where id = nullif(v_row->>'shop_id', '')::uuid and org_id = p_org_id) then
      insert into org_member_shops (org_id, user_id, shop_id, perms)
      values (p_org_id, p_user_id, (v_row->>'shop_id')::uuid,
              coalesce((select array_agg(distinct p) from jsonb_array_elements_text(coalesce(v_row->'perms', '[]'::jsonb)) p where p = any(banto_shop_perms_all())), '{}'))
      on conflict (user_id, shop_id) do update set perms = excluded.perms;
    end if;
  end loop;
end;
$$;

-- メンバーの一覧（0024 を差し替え: 実店舗の割り当ても返す）
create or replace function org_members_list(p_org_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not banto_org_admin(p_org_id) then raise exception 'org_not_found' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'created_at', m.created_at,
                                                       'shops', (select coalesce(jsonb_agg(jsonb_build_object('shop_id', ms.shop_id, 'perms', to_jsonb(ms.perms))), '[]'::jsonb)
                                                                   from org_member_shops ms where ms.org_id = m.org_id and ms.user_id = m.user_id),
                                                       'stores', (select coalesce(jsonb_agg(jsonb_build_object('store_id', ms.store_id, 'perms', to_jsonb(ms.perms))), '[]'::jsonb)
                                                                    from org_member_stores ms where ms.org_id = m.org_id and ms.user_id = m.user_id))
                                    order by m.created_at), '[]'::jsonb)
            from org_members m join auth.users u on u.id = m.user_id where m.org_id = p_org_id);
end;
$$;

-- ---------- 申し込み（service_role。ストアフロントとヘッドレスから） ----------
-- p_items: [{ sku_id, qty }]、p_customer: { customer_email, customer_name, customer_phone, note, customer_id }。
-- 店舗がそのショップで試着を受けている営業中の店舗か・SKU が公開中かを確かめ、在庫を条件付きで減らす（1 行でも足りなければ全体を取り消す）
create or replace function tryon_request(p_shop_id uuid, p_store_id uuid, p_items jsonb, p_customer jsonb, p_visit_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it jsonb; v_sku skus%rowtype; v_qty integer; v_n integer; v_id uuid; v_number integer; v_cid uuid; v_total integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_request: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and published) then raise exception 'shop_not_found'; end if;
  if not exists (select 1 from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = p_shop_id and ss.store_id = p_store_id and ss.tryon and st.active) then
    raise exception 'store_not_available';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then raise exception 'invalid_items'; end if;
  if position('@' in coalesce(p_customer->>'customer_email', '')) < 2 then raise exception 'invalid_customer'; end if;
  v_cid := nullif(p_customer->>'customer_id', '')::uuid;
  if v_cid is not null and not exists (select 1 from customers where shop_id = p_shop_id and id = v_cid) then v_cid := null; end if;

  update shops set tryon_seq = tryon_seq + 1 where id = p_shop_id returning tryon_seq into v_number;
  insert into tryon_requests (shop_id, store_id, number, visit_date, customer_id, customer_email, customer_name, customer_phone, note)
  values (p_shop_id, p_store_id, v_number, p_visit_date, v_cid, lower(btrim(p_customer->>'customer_email')),
          left(nullif(btrim(coalesce(p_customer->>'customer_name', '')), ''), 100), left(nullif(btrim(coalesce(p_customer->>'customer_phone', '')), ''), 20),
          left(nullif(btrim(coalesce(p_customer->>'note', '')), ''), 500))
  returning id into v_id;

  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_qty := case when coalesce(v_it->>'qty', '') ~ '^[0-9]{1,2}$' then (v_it->>'qty')::integer else 0 end;
    if v_qty <= 0 then raise exception 'invalid_items'; end if;
    select k.* into v_sku from skus k join products p on p.id = k.product_id
     where k.id = nullif(v_it->>'sku_id', '')::uuid and k.shop_id = p_shop_id and p.published;
    if not found then raise exception 'sku_not_available'; end if;
    update inventory set available = available - v_qty where sku_id = v_sku.id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'insufficient_stock' using detail = v_sku.id::text; end if;
    insert into tryon_items (shop_id, request_id, sku_id, qty, unit_price_jpy) values (p_shop_id, v_id, v_sku.id, v_qty, v_sku.price_jpy);
    v_total := v_total + v_qty;
  end loop;
  if v_total > 20 then raise exception 'invalid_items'; end if;

  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.requested',
    jsonb_build_object('request_id', v_id, 'number', v_number, 'shop_id', p_shop_id, 'store_id', p_store_id, 'status', 'requested',
                       'visit_date', p_visit_date, 'customer_id', v_cid));
  return jsonb_build_object('id', v_id, 'number', v_number);
end;
$$;

-- ---------- 申し込み 1 件（管理画面。ショップの stores の項目か、その実店舗の tryon の項目） ----------
-- 実店舗のスタッフは商品の表を読めないので、明細の品名もここで返す
create or replace function tryon_request_detail(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_r tryon_requests%rowtype;
begin
  select * into v_r from tryon_requests where id = p_request_id;
  if not found or not (banto_shop_perm(v_r.shop_id, 'stores') or banto_store_perm(v_r.store_id, 'tryon')) then return null; end if;
  return jsonb_build_object(
    'request', to_jsonb(v_r),
    'store', (select jsonb_build_object('id', st.id, 'name', st.name, 'hours', st.hours, 'special_days', st.special_days) from stores st where st.id = v_r.store_id),
    'shop', (select jsonb_build_object('id', s.id, 'name', s.name, 'settings', jsonb_build_object('store_tryon', s.settings->'store_tryon')) from shops s where s.id = v_r.shop_id),
    'can_restock', banto_shop_perm(v_r.shop_id, 'stores'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', t.sku_id, 'code', k.code, 'product', p.name, 'sku', k.name, 'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = v_r.id));
end;
$$;

-- ---------- 状態を進める（ショップの stores の項目か、その実店舗の tryon の項目） ----------
-- 申し込み → 店舗へ発送済み → 取り置き中（期限） → 購入 / 購入なし / 期限切れ。終わる前ならキャンセルできる
create or replace function tryon_update(p_shop_id uuid, p_request_id uuid, p_status text, p_hold_until date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_ok boolean;
begin
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id for update;
  if not found or not (banto_shop_perm(p_shop_id, 'stores') or banto_store_perm(v_r.store_id, 'tryon')) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  v_ok := case p_status
    when 'sent' then v_r.status = 'requested'
    when 'ready' then v_r.status in ('requested', 'sent', 'ready')
    when 'purchased' then v_r.status in ('ready', 'expired')
    when 'not_purchased' then v_r.status in ('ready', 'expired')
    when 'expired' then v_r.status = 'ready'
    when 'cancelled' then v_r.status in ('requested', 'sent', 'ready')
    else false end;
  if not v_ok then raise exception 'invalid_transition' using detail = v_r.status || ' -> ' || coalesce(p_status, ''); end if;
  if p_status = 'ready' and p_hold_until is null then raise exception 'hold_until_required'; end if;
  update tryon_requests set status = p_status, updated_at = now(),
    hold_until = case when p_status = 'ready' then p_hold_until else hold_until end,
    closed_at = case when p_status in ('purchased', 'not_purchased', 'expired', 'cancelled') then now() end
   where id = v_r.id returning * into v_r;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.updated',
    jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', p_shop_id, 'store_id', v_r.store_id, 'status', v_r.status,
                       'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id));
  return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'hold_until', v_r.hold_until);
end;
$$;

-- ---------- 減らした在庫を EC に戻す（ショップの stores の項目を持つ人が選んだときだけ。実店舗のスタッフはできない） ----------
create or replace function tryon_restock(p_shop_id uuid, p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_n integer := 0;
begin
  if not banto_shop_perm(p_shop_id, 'stores') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_r.status not in ('not_purchased', 'expired', 'cancelled') then raise exception 'not_restockable'; end if;
  if v_r.restocked then return 0; end if;
  update inventory i set available = i.available + t.qty
    from (select sku_id, sum(qty)::integer as qty from tryon_items where request_id = v_r.id group by sku_id) t
   where i.sku_id = t.sku_id and i.shop_id = p_shop_id;
  get diagnostics v_n = row_count;
  update tryon_requests set restocked = true, updated_at = now() where id = v_r.id;
  return v_n;
end;
$$;

-- ---------- 取り置きの期限切れ（Cron。p_today はショップの時間帯の今日） ----------
create or replace function tryon_expire(p_today date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_n integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_expire: service_role only' using errcode = '42501';
  end if;
  for v_r in update tryon_requests set status = 'expired', closed_at = now(), updated_at = now()
              where status = 'ready' and hold_until < p_today returning * loop
    perform banto_enqueue_tryon_hook(v_r.shop_id, 'tryon.updated',
      jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', v_r.shop_id, 'store_id', v_r.store_id, 'status', 'expired',
                         'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------- 終わった申し込みの個人情報を消す（Cron。CLAUDE.md §8） ----------
create or replace function mask_tryon_requests(p_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_tryon_requests: service_role only' using errcode = '42501';
  end if;
  update tryon_requests set customer_email = null, customer_name = '[masked]', customer_phone = null, note = null
   where closed_at is not null and closed_at < now() - make_interval(days => greatest(p_days, 1)) and customer_email is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------- お知らせ用（メール通知・LINE のプラグインが読む。service_role） ----------
create or replace function tryon_contact(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_st stores%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_st from stores where id = v_r.store_id;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'request_id', v_r.id, 'number', v_r.number, 'status', v_r.status, 'visit_date', v_r.visit_date, 'hold_until', v_r.hold_until,
    'customer_email', v_r.customer_email, 'customer_name', v_r.customer_name, 'customer_phone', v_r.customer_phone, 'note', v_r.note,
    'store', jsonb_build_object('name', v_st.name, 'postal_code', v_st.postal_code, 'address', v_st.address, 'phone', v_st.phone,
                                'email', v_st.email, 'notify_email', v_st.notify_email, 'hours', v_st.hours, 'special_days', v_st.special_days),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain, 'contact_email', v_s.settings->>'contact_email', 'settings', v_s.settings->'store_tryon'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = v_r.id));
end;
$$;

create or replace function tryon_line_recipient(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_line_recipient: service_role only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('line_user_id', i.subject, 'number', r.number, 'status', r.status, 'hold_until', r.hold_until,
                              'store_name', st.name, 'shop_name', s.name)
      from tryon_requests r join shops s on s.id = r.shop_id join stores st on st.id = r.store_id
      join member_identities i on i.shop_id = r.shop_id and i.customer_id = r.customer_id and i.provider = 'line'
     where r.id = p_request_id and r.shop_id = p_shop_id and r.customer_id is not null
     limit 1);
end;
$$;

-- 同梱のメール通知・LINE 通知のプラグインを有効にしているショップは、試着のお知らせも受け取る（有効化の時点のイベントの一覧に足す）
update hook_endpoints
   set events = (select array_agg(distinct e) from unnest(events || array['tryon.requested', 'tryon.updated']) e)
 where url in ('https://banto.invalid/plugins/email_resend', 'https://banto.invalid/plugins/line_buyer_notify');

revoke execute on function banto_store_perms_all() from public;
grant execute on function banto_store_perms_all() to anon, authenticated, service_role;
grant execute on function banto_store_perm(uuid, text) to anon, authenticated, service_role;
grant execute on function banto_store_visible(uuid) to anon, authenticated, service_role;
revoke execute on function banto_shop_stores_guard() from public, anon, authenticated;
revoke execute on function banto_enqueue_tryon_hook(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function shop_store_list(uuid) from public;
grant execute on function shop_store_list(uuid) to anon, authenticated, service_role;
revoke execute on function banto_my_stores() from public, anon;
grant execute on function banto_my_stores() to authenticated;
revoke execute on function store_set_hours(uuid, jsonb, jsonb) from public, anon;
grant execute on function store_set_hours(uuid, jsonb, jsonb) to authenticated;
revoke execute on function stores_set_special_days(uuid, uuid[], jsonb) from public, anon;
grant execute on function stores_set_special_days(uuid, uuid[], jsonb) to authenticated;
revoke execute on function banto_set_member_shops(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function org_members_list(uuid) from public, anon;
grant execute on function org_members_list(uuid) to authenticated;
revoke execute on function tryon_request(uuid, uuid, jsonb, jsonb, date) from public, anon, authenticated;
grant execute on function tryon_request(uuid, uuid, jsonb, jsonb, date) to service_role;
revoke execute on function tryon_request_detail(uuid) from public, anon;
grant execute on function tryon_request_detail(uuid) to authenticated;
revoke execute on function tryon_update(uuid, uuid, text, date) from public, anon;
grant execute on function tryon_update(uuid, uuid, text, date) to authenticated;
revoke execute on function tryon_restock(uuid, uuid) from public, anon;
grant execute on function tryon_restock(uuid, uuid) to authenticated;
revoke execute on function tryon_expire(date) from public, anon, authenticated;
grant execute on function tryon_expire(date) to service_role;
revoke execute on function mask_tryon_requests(integer) from public, anon, authenticated;
grant execute on function mask_tryon_requests(integer) to service_role;
revoke execute on function tryon_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function tryon_contact(uuid, uuid) to service_role;
revoke execute on function tryon_line_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function tryon_line_recipient(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0025_store_tryon');
