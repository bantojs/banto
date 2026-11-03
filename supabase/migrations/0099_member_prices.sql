-- 0099_member_prices: 会員価格（同梱モジュール audiences の段 D。メンテナの決定 2026-11-02、docs/audiences.md「会員価格」）
--   - 価格の決まり（price_rules）: 会員の条件・対象（商品・SKU を直接か、カテゴリー・タグ・ブランド・商品の独自項目の条件）・
--     価格（固定の価格か何 % 引き）・期間・有効。会員の条件は表示用（URL のパラメータ）を使えない
--   - **単価を決めるのは DB だけ**（banto_sku_member_price）。当てはまる決まりのうち **いちばん安い単価**、通常の価格より高くしない。
--     会員の判定は DB の最新の独自項目（Cookie の値ではない）。ゲストは通常の価格
--   - 会員の読み取りの経路（0098 の product_member_get / _skus）が SKU の price_jpy をこの会員の単価で返し、カートの値付け・最終確認・
--     決済の額はそこから。予約の単価は reserve_stock の直後に apply_reservation_member_prices が同じ関数で写し直す（クーポンの値引きはその後）
--   - ゲストにも「会員価格 ¥8,000」を見せる（どの条件の価格かは出さない。当てはまる決まりのうちいちばん安いもの、product_public_member_prices）
--   - モジュールが OFF のショップでは決まりは効かない

create table if not exists price_rules (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  audience_id uuid not null,
  product_ids uuid[] not null default '{}',
  sku_ids uuid[] not null default '{}',
  product_condition jsonb,
  price_jpy integer check (price_jpy is null or price_jpy between 0 and 99999999),
  percent_off integer check (percent_off is null or percent_off between 1 and 99),
  starts_at timestamptz,
  ends_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_rules_price_check check ((price_jpy is null) <> (percent_off is null)),
  constraint price_rules_period_check check (starts_at is null or ends_at is null or starts_at < ends_at),
  constraint price_rules_target_check check (cardinality(product_ids) > 0 or cardinality(sku_ids) > 0 or product_condition is not null),
  constraint price_rules_size_check check (cardinality(product_ids) <= 500 and cardinality(sku_ids) <= 500),
  constraint price_rules_audience_fkey foreign key (audience_id, shop_id) references audiences (id, shop_id) on delete restrict
);
create index if not exists price_rules_shop_idx on price_rules (shop_id) where enabled;
alter table price_rules enable row level security;
drop policy if exists price_rules_read on price_rules;
create policy price_rules_read on price_rules for select using (banto_shop_perm(shop_id, 'marketing') or banto_shop_perm(shop_id, 'catalog'));
drop policy if exists price_rules_insert on price_rules;
create policy price_rules_insert on price_rules for insert with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists price_rules_update on price_rules;
create policy price_rules_update on price_rules for update using (banto_shop_perm(shop_id, 'marketing')) with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists price_rules_delete on price_rules;
create policy price_rules_delete on price_rules for delete using (banto_shop_perm(shop_id, 'marketing'));
revoke all on price_rules from anon;
grant select, insert, update, delete on price_rules to authenticated;

-- ---------- 商品の条件（価格の決まりの対象） ----------
--   all / any / not、{ category: [id…] }（主・追加カテゴリーのどれか。子孫のカテゴリーの商品も）、{ tag: [...] }、{ brand: [...] }、
--   { attr: 鍵, in | gte | lte | set }（商品の独自項目 products.attributes）。深さ 4・条件 20 まで
create or replace function banto_product_condition_normalize(p jsonb, p_shop_id uuid, p_depth integer default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_op text; v_out jsonb := '[]'::jsonb; v_child jsonb; v_vals jsonb := '[]'::jsonb; v_v jsonb; v_keys int;
begin
  if p_depth > 4 then raise exception 'invalid_product_condition_depth'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_product_condition'; end if;
  select count(*) into v_keys from jsonb_object_keys(p);
  if p ? 'all' or p ? 'any' then
    v_op := case when p ? 'all' then 'all' else 'any' end;
    if v_keys <> 1 or jsonb_typeof(p->v_op) <> 'array' or jsonb_array_length(p->v_op) not between 1 and 20 then raise exception 'invalid_product_condition'; end if;
    for v_child in select e from jsonb_array_elements(p->v_op) e loop
      v_out := v_out || jsonb_build_array(banto_product_condition_normalize(v_child, p_shop_id, p_depth + 1));
    end loop;
    return jsonb_build_object(v_op, v_out);
  end if;
  if p ? 'not' then
    if v_keys <> 1 then raise exception 'invalid_product_condition'; end if;
    return jsonb_build_object('not', banto_product_condition_normalize(p->'not', p_shop_id, p_depth + 1));
  end if;
  if p ? 'category' then
    if v_keys <> 1 or jsonb_typeof(p->'category') <> 'array' or jsonb_array_length(p->'category') not between 1 and 50 then raise exception 'invalid_product_condition'; end if;
    for v_v in select e from jsonb_array_elements(p->'category') e loop
      if jsonb_typeof(v_v) <> 'string' or (v_v #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from categories c where c.id = (v_v #>> '{}')::uuid and c.shop_id = p_shop_id) then
        raise exception 'invalid_product_condition_category';
      end if;
      v_vals := v_vals || v_v;
    end loop;
    return jsonb_build_object('category', v_vals);
  end if;
  if p ? 'tag' or p ? 'brand' then
    v_op := case when p ? 'tag' then 'tag' else 'brand' end;
    if v_keys <> 1 or jsonb_typeof(p->v_op) <> 'array' or jsonb_array_length(p->v_op) not between 1 and 100 then raise exception 'invalid_product_condition'; end if;
    for v_v in select e from jsonb_array_elements(p->v_op) e loop
      if jsonb_typeof(v_v) <> 'string' or char_length(btrim(v_v #>> '{}')) not between 1 and 100 then raise exception 'invalid_product_condition'; end if;
      v_vals := v_vals || to_jsonb(btrim(v_v #>> '{}'));
    end loop;
    return jsonb_build_object(v_op, v_vals);
  end if;
  if p ? 'attr' then
    if jsonb_typeof(p->'attr') <> 'string' or (p->>'attr') !~ '^[a-z][a-z0-9_]{0,39}$' or v_keys <> 2 then raise exception 'invalid_product_condition'; end if;
    if p ? 'in' then
      if jsonb_typeof(p->'in') <> 'array' or jsonb_array_length(p->'in') not between 1 and 100 then raise exception 'invalid_product_condition'; end if;
      for v_v in select e from jsonb_array_elements(p->'in') e loop
        if jsonb_typeof(v_v) not in ('string', 'number') or char_length(btrim(v_v #>> '{}')) not between 1 and 200 then raise exception 'invalid_product_condition'; end if;
        v_vals := v_vals || to_jsonb(btrim(v_v #>> '{}'));
      end loop;
      return jsonb_build_object('attr', p->>'attr', 'in', v_vals);
    end if;
    if p ? 'gte' or p ? 'lte' then
      v_op := case when p ? 'gte' then 'gte' else 'lte' end;
      if jsonb_typeof(p->v_op) <> 'number' then raise exception 'invalid_product_condition'; end if;
      return jsonb_build_object('attr', p->>'attr', v_op, p->v_op);
    end if;
    if p ? 'set' and p->'set' = 'true'::jsonb then return jsonb_build_object('attr', p->>'attr', 'set', true); end if;
  end if;
  raise exception 'invalid_product_condition';
end;
$$;
revoke execute on function banto_product_condition_normalize(jsonb, uuid, integer) from public, anon, authenticated;

-- 商品のカテゴリー（主・追加）と、その祖先
create or replace function banto_product_category_set(p_category_id uuid, p_extra uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive up(id) as (
    select c from unnest(array_remove(array[p_category_id] || coalesce(p_extra, '{}'), null)) c
    union
    select k.parent_id from categories k join up on k.id = up.id where k.parent_id is not null
  )
  select coalesce(array_agg(id), '{}') from up;
$$;
revoke execute on function banto_product_category_set(uuid, uuid[]) from public, anon, authenticated;

-- 商品の条件に合うか（p_cats は banto_product_category_set の結果）
create or replace function banto_product_match(p jsonb, p_tags text[], p_brand text, p_attrs jsonb, p_cats uuid[])
returns boolean language plpgsql immutable as $$
declare v_child jsonb; v_val jsonb; v_num numeric;
begin
  if p is null then return false; end if;
  if p ? 'all' then
    for v_child in select e from jsonb_array_elements(p->'all') e loop
      if not banto_product_match(v_child, p_tags, p_brand, p_attrs, p_cats) then return false; end if;
    end loop;
    return true;
  end if;
  if p ? 'any' then
    for v_child in select e from jsonb_array_elements(p->'any') e loop
      if banto_product_match(v_child, p_tags, p_brand, p_attrs, p_cats) then return true; end if;
    end loop;
    return false;
  end if;
  if p ? 'not' then return not banto_product_match(p->'not', p_tags, p_brand, p_attrs, p_cats); end if;
  if p ? 'category' then return exists (select 1 from jsonb_array_elements_text(p->'category') e where e::uuid = any(p_cats)); end if;
  if p ? 'tag' then return exists (select 1 from jsonb_array_elements_text(p->'tag') e where e = any(coalesce(p_tags, '{}'))); end if;
  if p ? 'brand' then return p_brand is not null and exists (select 1 from jsonb_array_elements_text(p->'brand') e where lower(e) = lower(btrim(p_brand))); end if;
  if p ? 'attr' then
    v_val := case when jsonb_typeof(p_attrs) = 'object' then p_attrs->(p->>'attr') end;
    if v_val is null or jsonb_typeof(v_val) not in ('string', 'number', 'boolean') or btrim(v_val #>> '{}') = '' then return false; end if;
    if p ? 'set' then return true; end if;
    if p ? 'in' then return exists (select 1 from jsonb_array_elements(p->'in') e where lower(btrim(e #>> '{}')) = lower(btrim(v_val #>> '{}'))); end if;
    if btrim(v_val #>> '{}') !~* '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)(e[+-]?[0-9]+)?$' then return false; end if;
    v_num := btrim(v_val #>> '{}')::numeric;
    if p ? 'gte' then return v_num >= (p->>'gte')::numeric; end if;
    if p ? 'lte' then return v_num <= (p->>'lte')::numeric; end if;
  end if;
  return false;
end;
$$;
revoke execute on function banto_product_match(jsonb, text[], text, jsonb, uuid[]) from public, anon, authenticated;

-- 書くときの確かめ: 表示用の条件は使えない・対象の商品と SKU は同じショップのもの・商品の条件を組み直す
create or replace function banto_price_rules_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.shop_id is distinct from old.shop_id then raise exception 'shop_immutable' using errcode = '42501'; end if;
  new.name := btrim(new.name);
  if exists (select 1 from audiences a where a.id = new.audience_id and banto_audience_display_only(a.condition)) then
    raise exception 'audience_display_only' using errcode = '22023';
  end if;
  new.product_ids := coalesce((select array_agg(distinct x) from unnest(new.product_ids) x), '{}');
  new.sku_ids := coalesce((select array_agg(distinct x) from unnest(new.sku_ids) x), '{}');
  if exists (select 1 from unnest(new.product_ids) x where not exists (select 1 from products p where p.id = x and p.shop_id = new.shop_id)) then
    raise exception 'price_rule_product_not_found' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(new.sku_ids) x where not exists (select 1 from skus k where k.id = x and k.shop_id = new.shop_id)) then
    raise exception 'price_rule_sku_not_found' using errcode = '22023';
  end if;
  if new.product_condition is not null then
    new.product_condition := banto_product_condition_normalize(new.product_condition, new.shop_id);
    if (select count(*) from jsonb_path_query(new.product_condition, 'strict $.**') x(v)
         where jsonb_typeof(x.v) = 'object' and (x.v ? 'category' or x.v ? 'tag' or x.v ? 'brand' or x.v ? 'attr')) > 20 then
      raise exception 'invalid_product_condition_size';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function banto_price_rules_guard() from public, anon, authenticated;
drop trigger if exists price_rules_guard on price_rules;
create trigger price_rules_guard before insert or update on price_rules for each row execute function banto_price_rules_guard();

-- 会員の条件を表示用（URL のパラメータ）にするのは、商品（0098）に加えて価格の決まりに使われていても断る
create or replace function banto_audiences_display_only_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if banto_audience_display_only(new.condition)
     and (exists (select 1 from products p where p.audience_id = new.id) or exists (select 1 from price_rules r where r.audience_id = new.id)) then
    raise exception 'audience_display_only_in_use' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------- 単価（正） ----------
-- p_aud: この会員が合う会員の条件（banto_member_audience_ids）。null なら p_customer_id から求める。ゲスト（会員 null）は通常の価格
create or replace function banto_sku_member_price(p_sku_id uuid, p_customer_id uuid, p_aud uuid[] default null)
returns integer language plpgsql stable security definer set search_path = public as $$
declare
  v_base integer; v_shop uuid; v_p products%rowtype; v_aud uuid[]; v_best integer; v_cats uuid[];
begin
  select k.price_jpy, k.shop_id into v_base, v_shop from skus k where k.id = p_sku_id;
  if v_base is null then return null; end if;
  if p_customer_id is null then return v_base; end if;
  if not exists (select 1 from shops s where s.id = v_shop and coalesce(s.settings->'modules'->>'audiences', 'false') = 'true') then return v_base; end if;
  if not exists (select 1 from price_rules r where r.shop_id = v_shop and r.enabled) then return v_base; end if;
  v_aud := coalesce(p_aud, banto_member_audience_ids(v_shop, p_customer_id));
  if cardinality(v_aud) = 0 then return v_base; end if;
  select p.* into v_p from products p join skus k on k.product_id = p.id where k.id = p_sku_id;
  v_cats := banto_product_category_set(v_p.category_id, v_p.extra_category_ids);
  select min(case when r.price_jpy is not null then r.price_jpy else floor(v_base * (100 - r.percent_off) / 100.0)::integer end) into v_best
    from price_rules r
   where r.shop_id = v_shop and r.enabled and r.audience_id = any(v_aud)
     and (r.starts_at is null or r.starts_at <= now()) and (r.ends_at is null or r.ends_at > now())
     and (p_sku_id = any(r.sku_ids) or v_p.id = any(r.product_ids)
          or (r.product_condition is not null and banto_product_match(r.product_condition, v_p.tags, v_p.brand, v_p.attributes, v_cats)));
  return least(v_base, coalesce(v_best, v_base));
end;
$$;
revoke execute on function banto_sku_member_price(uuid, uuid, uuid[]) from public, anon, authenticated;

-- ゲストに見せる「会員価格」: 当てはまる決まりのうち、いちばん安いもの（どの会員の条件でも）。通常の価格より安くなければ null
create or replace function banto_sku_member_price_floor(p_sku_id uuid)
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_base integer; v_shop uuid; v_p products%rowtype; v_best integer; v_cats uuid[];
begin
  select k.price_jpy, k.shop_id into v_base, v_shop from skus k where k.id = p_sku_id;
  if v_base is null or not exists (select 1 from price_rules r where r.shop_id = v_shop and r.enabled) then return null; end if;
  select p.* into v_p from products p join skus k on k.product_id = p.id where k.id = p_sku_id;
  v_cats := banto_product_category_set(v_p.category_id, v_p.extra_category_ids);
  select min(case when r.price_jpy is not null then r.price_jpy else floor(v_base * (100 - r.percent_off) / 100.0)::integer end) into v_best
    from price_rules r
   where r.shop_id = v_shop and r.enabled
     and (r.starts_at is null or r.starts_at <= now()) and (r.ends_at is null or r.ends_at > now())
     and (p_sku_id = any(r.sku_ids) or v_p.id = any(r.product_ids)
          or (r.product_condition is not null and banto_product_match(r.product_condition, v_p.tags, v_p.brand, v_p.attributes, v_cats)));
  return case when v_best is not null and v_best < v_base then v_best end;
end;
$$;
revoke execute on function banto_sku_member_price_floor(uuid) from public, anon, authenticated;

-- 匿名: 公開中で見える商品の SKU の「会員価格」（モジュールが ON のショップだけ。会員の条件・決まりの中身は返さない）
create or replace function product_public_member_prices(p_shop_id uuid, p_sku_ids uuid[])
returns table (sku_id uuid, member_price_jpy integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_sku_ids is null then return; end if;
  if cardinality(p_sku_ids) > 200 then raise exception 'too_many_skus'; end if;
  if not exists (select 1 from shops s where s.id = p_shop_id and s.published and coalesce(s.settings->'modules'->>'audiences', 'false') = 'true') then return; end if;
  return query
    select k.id, banto_sku_member_price_floor(k.id)
      from skus k join products p on p.id = k.product_id
     where k.shop_id = p_shop_id and k.id = any(p_sku_ids) and p.published and (p.audience_id is null or p.audience_mode = 'buy')
       and banto_sku_member_price_floor(k.id) is not null;
end;
$$;
revoke execute on function product_public_member_prices(uuid, uuid[]) from public;
grant execute on function product_public_member_prices(uuid, uuid[]) to anon, authenticated, service_role;

-- ---------- 会員の読み取りの経路: SKU の price_jpy をこの会員の単価に（0098 の形に足す） ----------
create or replace function product_member_get(p_shop_id uuid, p_slug text, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_aud uuid[] := '{}';
  v_p products%rowtype;
  v_settings jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_get: service_role only' using errcode = '42501';
  end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  select p.* into v_p from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
     and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))
   limit 1;
  if not found then return null; end if;
  select settings into v_settings from shops where id = p_shop_id;
  return jsonb_build_object(
    'product', to_jsonb(v_p) - 'attributes'
               || jsonb_build_object('attributes', banto_public_product_attributes(v_settings, v_p.attributes), 'app_data', banto_public_app_data(v_p.id),
                                     'size_chart', case when v_settings->'modules'->'size_charts' = 'true'::jsonb then banto_size_chart_resolve(v_p.shop_id, v_p.category_id, v_p.id) end),
    'images', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from product_images i where i.product_id = v_p.id), '[]'::jsonb),
    -- 0099: price_jpy はこの会員の単価（会員価格が安ければそれ）、regular_price_jpy は通常の価格
    'skus', coalesce((select jsonb_agg(to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99),
                                                         'price_jpy', banto_sku_member_price(k.id, p_customer_id, v_aud), 'regular_price_jpy', k.price_jpy)
                             order by k.created_at)
                        from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = v_p.id), '[]'::jsonb),
    'purchasable', v_p.audience_id is null or v_p.audience_id = any(v_aud)
  );
end;
$$;

create or replace function product_member_skus(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sku_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_skus: service_role only' using errcode = '42501';
  end if;
  if p_sku_ids is null then return '[]'::jsonb; end if;
  if cardinality(p_sku_ids) > 100 then raise exception 'too_many_skus'; end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'sku', to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99),
                                                      'price_jpy', banto_sku_member_price(k.id, p_customer_id, v_aud), 'regular_price_jpy', k.price_jpy),
             'product', jsonb_build_object('id', p.id, 'shop_id', p.shop_id, 'slug', p.slug, 'name', p.name, 'description', p.description, 'published', p.published,
                                           'created_at', p.created_at, 'updated_at', p.updated_at, 'tags', p.tags, 'category_id', p.category_id, 'brand', p.brand,
                                           'tax_class', p.tax_class, 'extra_category_ids', p.extra_category_ids, 'audience_id', p.audience_id, 'audience_mode', p.audience_mode),
             'purchasable', p.audience_id is null or p.audience_id = any(v_aud)))
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
      left join inventory inv on inv.sku_id = k.id
     where k.shop_id = p_shop_id and k.id = any(p_sku_ids) and p.published and s.published
       and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))), '[]'::jsonb);
end;
$$;

-- ---------- 予約の単価を会員価格に写し直す（reserve_stock・attach_reservation_customer の直後、クーポンの前） ----------
-- 会員の予約（customer_id あり）だけ。返すのは写した後の品目（呼び出し側が最終確認の単価と突き合わせる）
create or replace function apply_reservation_member_prices(p_reservation_id uuid, p_shop_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res reservations%rowtype; v_items jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'apply_reservation_member_prices: service_role only' using errcode = '42501';
  end if;
  select * into v_res from reservations where id = p_reservation_id and shop_id = p_shop_id and status = 'pending' for update;
  if not found then raise exception 'reservation_not_found' using detail = p_reservation_id::text; end if;
  if v_res.customer_id is null then return v_res.items; end if;
  select coalesce(jsonb_agg(e || jsonb_build_object('unit_price_jpy', banto_sku_member_price((e->>'sku_id')::uuid, v_res.customer_id)) order by n), '[]'::jsonb)
    into v_items from jsonb_array_elements(v_res.items) with ordinality as x(e, n);
  update reservations set items = v_items where id = p_reservation_id;
  return v_items;
end;
$$;
revoke execute on function apply_reservation_member_prices(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_reservation_member_prices(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0099_member_prices');
