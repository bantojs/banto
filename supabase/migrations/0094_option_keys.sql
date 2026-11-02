-- Banto 0094_option_keys: SKU の選択肢の鍵を英字の key と表示名に分ける（メンテナの決定 2026-11-02、docs/knowledge/02-decisions.md）。前方専用。
--   - ショップごとの名前の表 shops.option_names（{ "size": "サイズ", "color": "カラー" }）。key は ^[a-z][a-z0-9_]{0,31}$ で一度決めたら変えない。
--     name は 1〜40 文字、ショップの中で重ならない（大文字小文字を区別しない）。名前を変えるのは option_names_set だけ（項目 catalog）
--   - 鍵の置き場所（skus.options・product_images.options・product_image_hints.options・shops / categories / products の option_axes）はすべて key。値は文字のまま
--   - 書き込みは名前でも key でもよい。BEFORE のトリガーが banto_option_key で key に直す（無ければ表に足す）。
--     よくある名前は決まった key（サイズ → size、カラー・色 → color …）、英字の名前はそのまま、ほかは opt1・opt2…。
--     決まった key がもう別の名前で使われていれば size_2 のように分ける（同じ SKU に「色」と「カラー」があっても重ねない）
--   - 既存のデータは下で書き換える（意味は変わらないので、0065 の確かめ・updated_at・hooks のトリガーは止めて書く）

-- ---------- 1. 名前の表 ----------
create or replace function banto_option_names_ok(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) <= 200
     and not exists (select 1 from jsonb_each(p) e
                      where e.key !~ '^[a-z][a-z0-9_]{0,31}$' or jsonb_typeof(e.value) <> 'string'
                         or char_length(e.value #>> '{}') not between 1 and 40 or btrim(e.value #>> '{}') <> e.value #>> '{}')
     and (select count(distinct lower(e.value #>> '{}')) from jsonb_each(p) e) = (select count(*) from jsonb_object_keys(p));
$$;
revoke execute on function banto_option_names_ok(jsonb) from public, anon;
grant execute on function banto_option_names_ok(jsonb) to authenticated, service_role;

alter table shops add column if not exists option_names jsonb not null default '{}'::jsonb;
alter table shops drop constraint if exists shops_option_names_check;
alter table shops add constraint shops_option_names_check check (banto_option_names_ok(option_names));

-- 名前（か key）→ 表にある key。無ければ null
create or replace function banto_option_key_find(p_names jsonb, p_label text)
returns text language sql immutable as $$
  select case when p_names ? p_label then p_label
              else (select e.key from jsonb_each_text(p_names) e where lower(e.value) = lower(p_label) limit 1) end;
$$;
revoke execute on function banto_option_key_find(jsonb, text) from public, anon, authenticated;

-- 新しい key を決める（表に無い名前）。よくある名前は決まった key、英字の名前はそのまま、ほかは opt1・opt2…
create or replace function banto_option_key_new(p_names jsonb, p_label text)
returns text language plpgsql immutable as $$
declare v_l text := lower(btrim(p_label)); v_base text; v_k text; v_n integer := 2;
begin
  v_base := case
    when v_l in ('サイズ', 'size', 'sizes', 'サイズ展開') then 'size'
    when v_l in ('カラー', '色', 'いろ', 'color', 'colour', 'カラ') then 'color'
    when v_l in ('素材', 'material', '材質') then 'material'
    when v_l in ('長さ', '丈', 'length') then 'length'
    when v_l in ('幅', 'width') then 'width'
    when v_l in ('柄', '模様', 'pattern') then 'pattern'
    when v_l in ('タイプ', '種類', 'type') then 'type'
    when v_l in ('スタイル', 'style') then 'style'
    when v_l in ('味', 'フレーバー', 'flavor', 'flavour') then 'flavor'
    when v_l in ('容量', 'capacity', 'volume') then 'capacity'
    when v_l in ('重さ', '重量', 'weight') then 'weight'
    when v_l in ('号数', '号', 'ring size', 'ring_size') then 'ring_size'
    when v_l ~ '^[a-z][a-z0-9_]{0,29}$' then v_l
    else null end;
  if v_base is not null then
    v_k := v_base;
    while p_names ? v_k loop
      v_k := v_base || '_' || v_n;
      v_n := v_n + 1;
    end loop;
    return v_k;
  end if;
  v_n := 1;
  while p_names ? ('opt' || v_n) loop v_n := v_n + 1; end loop;
  return 'opt' || v_n;
end;
$$;
revoke execute on function banto_option_key_new(jsonb, text) from public, anon, authenticated;

-- 名前（か key）→ key。表に無ければ足す（ショップの行を押さえて、同時に足しても重ねない）
create or replace function banto_option_key(p_shop_id uuid, p_label text)
returns text language plpgsql security definer set search_path = public as $$
declare v_label text := btrim(coalesce(p_label, '')); v_names jsonb; v_k text;
begin
  if v_label = '' or char_length(v_label) > 40 then raise exception 'invalid_option_key'; end if;
  select option_names into v_names from shops where id = p_shop_id;
  v_k := banto_option_key_find(coalesce(v_names, '{}'::jsonb), v_label);
  if v_k is not null then return v_k; end if;
  select option_names into v_names from shops where id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  v_k := banto_option_key_find(v_names, v_label);
  if v_k is not null then return v_k; end if;
  v_k := banto_option_key_new(v_names, v_label);
  update shops set option_names = v_names || jsonb_build_object(v_k, v_label) where id = p_shop_id;
  return v_k;
end;
$$;
revoke execute on function banto_option_key(uuid, text) from public, anon, authenticated;

-- options（{ 名前か key: 値 }）→ { key: 値 }。名前と key が同じ key に重なったら断る
create or replace function banto_option_keys_object(p_shop_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb := '{}'::jsonb; e record; v_k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then return p; end if;
  for e in select * from jsonb_each(p) loop
    v_k := banto_option_key(p_shop_id, e.key);
    if v_out ? v_k then raise exception 'option_key_conflict' using detail = e.key; end if;
    v_out := v_out || jsonb_build_object(v_k, e.value);
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_option_keys_object(uuid, jsonb) from public, anon, authenticated;

-- 軸（[{ key: 名前か key, values? }]）→ key の軸
create or replace function banto_option_keys_axes(p_shop_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb := '[]'::jsonb; a jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return p; end if;
  for a in select x from jsonb_array_elements(p) x loop
    if jsonb_typeof(a) = 'object' and jsonb_typeof(a->'key') = 'string' then
      a := jsonb_set(a, '{key}', to_jsonb(banto_option_key(p_shop_id, a->>'key')));
    end if;
    v_out := v_out || jsonb_build_array(a);
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_option_keys_axes(uuid, jsonb) from public, anon, authenticated;

-- 軸に表示名を足す（AI 用 API の商品の JSON）
create or replace function banto_option_axes_named(p_shop_id uuid, p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when p is null or jsonb_typeof(p) <> 'array' then p else
    (select coalesce(jsonb_agg(case when jsonb_typeof(a) = 'object'
                                    then a || jsonb_build_object('name', coalesce(s.option_names->>(a->>'key'), a->>'key')) else a end
                               order by ord), '[]'::jsonb)
       from jsonb_array_elements(p) with ordinality x(a, ord), shops s where s.id = p_shop_id) end;
$$;
revoke execute on function banto_option_axes_named(uuid, jsonb) from public, anon, authenticated;

-- 表に名前を重ねる（復元）。知らない key は足し、名前が重なるものは飛ばす
create or replace function banto_option_names_merge(p_shop_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_names jsonb; e record;
begin
  select option_names into v_names from shops where id = p_shop_id for update;
  for e in select * from jsonb_each(p) loop
    if banto_option_names_ok(jsonb_build_object(e.key, e.value))
       and not exists (select 1 from jsonb_each_text(v_names) x where x.key <> e.key and lower(x.value) = lower(e.value #>> '{}')) then
      v_names := v_names || jsonb_build_object(e.key, e.value);
    end if;
  end loop;
  update shops set option_names = v_names where id = p_shop_id;
end;
$$;
revoke execute on function banto_option_names_merge(uuid, jsonb) from public, anon, authenticated;

-- 名前を変える（管理画面、項目 catalog）。p_names は { key: 新しい名前 }。表にある key だけ
create or replace function option_names_set(p_shop_id uuid, p_names jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_names jsonb; e record;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_names) <> 'object' then raise exception 'invalid_option_names'; end if;
  select option_names into v_names from shops where id = p_shop_id for update;
  for e in select * from jsonb_each(p_names) loop
    if not v_names ? e.key or jsonb_typeof(e.value) <> 'string' then raise exception 'invalid_option_names'; end if;
    v_names := v_names || jsonb_build_object(e.key, btrim(e.value #>> '{}'));
  end loop;
  if not banto_option_names_ok(v_names) then raise exception 'invalid_option_names'; end if;
  update shops set option_names = v_names where id = p_shop_id;
  return v_names;
end;
$$;
revoke execute on function option_names_set(uuid, jsonb) from public, anon;
grant execute on function option_names_set(uuid, jsonb) to authenticated, service_role;

-- ---------- 2. 書き込みを key に直すトリガー ----------
create or replace function banto_options_to_keys()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.options := banto_option_keys_object(new.shop_id, new.options);
  return new;
end;
$$;
revoke execute on function banto_options_to_keys() from public, anon, authenticated;

create or replace function banto_axes_to_keys()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.option_axes := banto_option_keys_axes(new.shop_id, new.option_axes);
  return new;
end;
$$;
revoke execute on function banto_axes_to_keys() from public, anon, authenticated;

-- ショップの行は自分の表で直す（同じ行を関数から更新しない）
create or replace function banto_shop_axes_to_keys()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_out jsonb := '[]'::jsonb; a jsonb; v_k text;
begin
  if new.option_axes is null or jsonb_typeof(new.option_axes) <> 'array' then return new; end if;
  for a in select x from jsonb_array_elements(new.option_axes) x loop
    if jsonb_typeof(a) = 'object' and jsonb_typeof(a->'key') = 'string' and btrim(a->>'key') <> '' then
      v_k := banto_option_key_find(new.option_names, btrim(a->>'key'));
      if v_k is null then
        v_k := banto_option_key_new(new.option_names, btrim(a->>'key'));
        new.option_names := new.option_names || jsonb_build_object(v_k, btrim(a->>'key'));
      end if;
      a := jsonb_set(a, '{key}', to_jsonb(v_k));
    end if;
    v_out := v_out || jsonb_build_array(a);
  end loop;
  new.option_axes := v_out;
  return new;
end;
$$;
revoke execute on function banto_shop_axes_to_keys() from public, anon, authenticated;

-- ---------- 3. 既存のデータを key に書き換える ----------
alter table skus disable trigger skus_option_axes;
alter table skus disable trigger skus_product_updated;
alter table products disable trigger products_option_axes;
alter table products disable trigger products_updated_at;
alter table product_images disable trigger product_images_product_updated;
alter table shops disable trigger shops_updated_at;

-- 1 つのショップの鍵を key に書き換える（このマイグレーションで全ショップに 1 回。テストからも呼ぶ）。トリガーは呼ぶ側が止める
create or replace function banto_option_keys_convert_shop(p_shop_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v jsonb;
begin
  select option_axes into v from shops where id = p_shop_id;
  if v is not null then
    v := banto_option_keys_axes(p_shop_id, v);
    update shops set option_axes = v where id = p_shop_id;
  end if;
  for r in select id, option_axes from categories where shop_id = p_shop_id and option_axes is not null order by created_at loop
    update categories set option_axes = banto_option_keys_axes(p_shop_id, r.option_axes) where id = r.id;
  end loop;
  for r in select id, option_axes from products where shop_id = p_shop_id and option_axes is not null order by created_at loop
    update products set option_axes = banto_option_keys_axes(p_shop_id, r.option_axes) where id = r.id;
  end loop;
  for r in select id, options from skus where shop_id = p_shop_id and options <> '{}'::jsonb order by created_at loop
    update skus set options = banto_option_keys_object(p_shop_id, r.options) where id = r.id;
  end loop;
  for r in select id, options from product_images where shop_id = p_shop_id and options <> '{}'::jsonb loop
    update product_images set options = banto_option_keys_object(p_shop_id, r.options) where id = r.id;
  end loop;
  for r in select product_id, tag, options from product_image_hints where shop_id = p_shop_id and options <> '{}'::jsonb loop
    update product_image_hints set options = banto_option_keys_object(p_shop_id, r.options) where product_id = r.product_id and tag = r.tag;
  end loop;
end;
$$;
revoke execute on function banto_option_keys_convert_shop(uuid) from public, anon, authenticated, service_role;

do $$
declare s record;
begin
  for s in select id from shops order by created_at loop
    perform banto_option_keys_convert_shop(s.id);
  end loop;
end;
$$;

alter table skus enable trigger skus_option_axes;
alter table skus enable trigger skus_product_updated;
alter table products enable trigger products_option_axes;
alter table products enable trigger products_updated_at;
alter table product_images enable trigger product_images_product_updated;
alter table shops enable trigger shops_updated_at;

-- 0065 の確かめ（skus_option_axes・products_option_axes）より前、WooCommerce の目印（product_images_hint）より後に走る名前
drop trigger if exists skus_00_option_keys on skus;
create trigger skus_00_option_keys before insert or update of options on skus for each row execute function banto_options_to_keys();
drop trigger if exists product_images_zz_option_keys on product_images;
create trigger product_images_zz_option_keys before insert or update of options on product_images for each row execute function banto_options_to_keys();
drop trigger if exists product_image_hints_option_keys on product_image_hints;
create trigger product_image_hints_option_keys before insert or update of options on product_image_hints for each row execute function banto_options_to_keys();
drop trigger if exists products_00_option_keys on products;
create trigger products_00_option_keys before insert or update of option_axes on products for each row execute function banto_axes_to_keys();
drop trigger if exists categories_option_keys on categories;
create trigger categories_option_keys before insert or update of option_axes on categories for each row execute function banto_axes_to_keys();
drop trigger if exists shops_option_keys on shops;
create trigger shops_option_keys before insert or update of option_axes on shops for each row execute function banto_shop_axes_to_keys();

-- ---------- 4. 出口 ----------
-- お客様の画面（anon）: ショップの JSON に名前の表を足す。ほかは 0081 と同じ
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'option_names', s.option_names,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null),
    'pages_nav', case when s.settings->'modules'->'pages' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'title', p.title, 'nav', p.nav) order by p.sort_order, p.created_at), '[]'::jsonb)
         from pages p where p.shop_id = s.id and p.published and p.deleted_at is null
          and (p.published_at is null or p.published_at <= now()) and p.nav <> 'none')
      else '[]'::jsonb end,
    'blogs_nav', case when s.settings->'modules'->'blog' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', b.handle, 'title', b.title, 'nav', b.nav) order by b.sort_order, b.created_at), '[]'::jsonb)
         from blogs b where b.shop_id = s.id and b.nav <> 'none')
      else '[]'::jsonb end);
$$;


-- AI 用 API の商品: 軸に表示名（name）、ショップの名前の表（option_names）。ほかは 0092 と同じ
create or replace function api_product_json(p_product products, p_with_skus boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_product.id, 'slug', p_product.slug, 'name', p_product.name, 'description', p_product.description,
    'tags', to_jsonb(p_product.tags), 'brand', p_product.brand, 'attributes', p_product.attributes,
    'category', (select api_category_json(c) from categories c where c.id = p_product.category_id),
    'extra_categories', (select coalesce(jsonb_agg(api_category_json(c) order by x.ord), '[]'::jsonb)
                           from unnest(p_product.extra_category_ids) with ordinality x(id, ord) join categories c on c.id = x.id),
    'option_axes', banto_option_axes_named(p_product.shop_id, p_product.option_axes),
    'option_names', (select s.option_names from shops s where s.id = p_product.shop_id),
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order,
                                                             'options', i.options, 'variants', i.variants, 'thumb_width', i.thumb_width) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;


-- 復元: バックアップの名前の表も戻す。ほかは 0065 と同じ
create or replace function restore_option_axes(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_item jsonb; v_c integer := 0; v_p integer := 0; v_skip integer := 0;
begin
  if jsonb_typeof(p_data) <> 'object' then raise exception 'invalid_items'; end if;
  -- 選択肢の名前の表（0094）。復元した行のトリガーが key をそのまま名前として登録しているので、バックアップの名前で上書きする
  if jsonb_typeof(p_data->'option_names') = 'object' then
    perform banto_option_names_merge(p_shop_id, p_data->'option_names');
  end if;
  if p_data ? 'shop' and banto_option_axes_ok(case when jsonb_typeof(p_data->'shop') = 'null' then null else p_data->'shop' end) then
    update shops set option_axes = case when jsonb_typeof(p_data->'shop') = 'null' then null else p_data->'shop' end where id = p_shop_id;
  end if;
  for v_item in select e from jsonb_array_elements(case when jsonb_typeof(p_data->'categories') = 'array' then p_data->'categories' else '[]'::jsonb end) e limit 5000 loop
    if jsonb_typeof(v_item->'option_axes') is distinct from 'array' or not banto_option_axes_ok(v_item->'option_axes') then continue; end if;
    update categories set option_axes = v_item->'option_axes' where shop_id = p_shop_id and slug = v_item->>'slug';
    if found then v_c := v_c + 1; end if;
  end loop;
  for v_item in select e from jsonb_array_elements(case when jsonb_typeof(p_data->'products') = 'array' then p_data->'products' else '[]'::jsonb end) e limit 50000 loop
    if jsonb_typeof(v_item->'option_axes') is distinct from 'array' or not banto_option_axes_ok(v_item->'option_axes') then continue; end if;
    begin
      update products set option_axes = v_item->'option_axes', option_axes_custom = coalesce((v_item->>'option_axes_custom')::boolean, false)
       where shop_id = p_shop_id and slug = v_item->>'slug';
      if found then v_p := v_p + 1; end if;
    exception when raise_exception or invalid_text_representation then
      v_skip := v_skip + 1;
    end;
  end loop;
  return jsonb_build_object('option_axes_categories', v_c, 'option_axes_products', v_p, 'option_axes_skipped', v_skip);
end;
$$;

insert into banto_migrations (version) values ('0094_option_keys');
