-- Banto 0065_sku_option_axes: SKU を分ける軸（人間の決定 2026-10-28）。前方専用。
--   - 形: [{ "key": "カラー", "values": ["レッド", ...] }, ...]（3 つまで、鍵は重ならない）。[] = 品番だけ（SKU の options は空）。
--     null = 決めていない（今までどおり SKU の options は自由。既存の商品・取り込んだ商品）
--   - 決める場所はショップ → カテゴリー（親から子へ）→ 商品。上の段は「ひな形」で、商品を作ったとき・主カテゴリーを決めたとき
--     （SKU がまだ無く、商品で上書きしていないとき）に商品へ写す。あとで上の段を変えても、既存の商品は変わらない
--   - 守るのは DB: 軸を決めた商品の SKU は options の鍵が軸とちょうど同じで値が空でない・同じ組み合わせの SKU は 1 つだけ。
--     商品の軸を変えるときは、今の SKU が新しい軸に合わなければ断る
--   - 値の候補（values）は入力と一括作成のためで、守らない（候補に無い値も入れられる）

create or replace function banto_option_axes_ok(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 3
    and not exists (
      select 1 from jsonb_array_elements(p) a
       where jsonb_typeof(a) <> 'object'
          or jsonb_typeof(a->'key') <> 'string' or length(a->>'key') not between 1 and 40 or btrim(a->>'key') <> a->>'key'
          or exists (select 1 from jsonb_object_keys(a) k where k not in ('key', 'values'))
          or (a ? 'values' and (jsonb_typeof(a->'values') <> 'array' or jsonb_array_length(a->'values') > 100
              or exists (select 1 from jsonb_array_elements(a->'values') v where jsonb_typeof(v) <> 'string' or length(v #>> '{}') not between 1 and 60))))
    and (select count(distinct a->>'key') from jsonb_array_elements(p) a) = jsonb_array_length(p));
$$;
-- 列の CHECK で呼ぶので、行を書くロール（管理画面の authenticated）に EXECUTE が要る（中身は値の形を見るだけ）
revoke execute on function banto_option_axes_ok(jsonb) from public, anon;
grant execute on function banto_option_axes_ok(jsonb) to authenticated, service_role;

alter table shops add column if not exists option_axes jsonb;
alter table shops drop constraint if exists shops_option_axes_check;
alter table shops add constraint shops_option_axes_check check (banto_option_axes_ok(option_axes));
alter table categories add column if not exists option_axes jsonb;
alter table categories drop constraint if exists categories_option_axes_check;
alter table categories add constraint categories_option_axes_check check (banto_option_axes_ok(option_axes));
alter table products add column if not exists option_axes jsonb;
alter table products add column if not exists option_axes_custom boolean not null default false;
alter table products drop constraint if exists products_option_axes_check;
alter table products add constraint products_option_axes_check check (banto_option_axes_ok(option_axes));

-- SKU の options が軸に合うか（鍵がちょうど同じ・値が空でない）
create or replace function banto_sku_fits_axes(p_options jsonb, p_axes jsonb)
returns boolean language sql immutable as $$
  select (select coalesce(array_agg(k order by k), '{}'::text[]) from jsonb_object_keys(coalesce(p_options, '{}'::jsonb)) k)
       = (select coalesce(array_agg(a->>'key' order by a->>'key'), '{}'::text[]) from jsonb_array_elements(p_axes) a)
     and not exists (select 1 from jsonb_each(coalesce(p_options, '{}'::jsonb)) e where coalesce(btrim(e.value #>> '{}'), '') = '');
$$;
revoke execute on function banto_sku_fits_axes(jsonb, jsonb) from public, anon, authenticated;

-- 主カテゴリーから上へたどり、最初に決めてある軸。どこにも無ければショップの軸（null もありうる）
create or replace function banto_option_axes_resolve(p_shop_id uuid, p_category_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_cat uuid := p_category_id; v_axes jsonb; v_parent uuid; v_i integer := 0;
begin
  while v_cat is not null and v_i < 10 loop
    select option_axes, parent_id into v_axes, v_parent from categories where id = v_cat and shop_id = p_shop_id;
    if not found then exit; end if;
    if v_axes is not null then return v_axes; end if;
    v_cat := v_parent;
    v_i := v_i + 1;
  end loop;
  return (select option_axes from shops where id = p_shop_id);
end;
$$;
revoke execute on function banto_option_axes_resolve(uuid, uuid) from public, anon, authenticated;

-- 商品: 作ったとき・主カテゴリーを変えたとき（SKU がまだ無く、上書きしていない）に上の段の軸を写す。軸を変えるときは今の SKU を確かめる
create or replace function banto_product_option_axes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- WooCommerce の取り込み（import_catalog）は写さない（属性の鍵が軸と合わないと取り込みが止まるため）
    if new.option_axes is null and not new.option_axes_custom and coalesce(current_setting('banto.skip_option_axes', true), '') <> 'on' then
      new.option_axes := banto_option_axes_resolve(new.shop_id, new.category_id);
    end if;
    return new;
  end if;
  if new.category_id is distinct from old.category_id and not new.option_axes_custom and new.option_axes is not distinct from old.option_axes
     and not exists (select 1 from skus where product_id = new.id)
     and coalesce(current_setting('banto.skip_option_axes', true), '') <> 'on' then
    new.option_axes := banto_option_axes_resolve(new.shop_id, new.category_id);
  end if;
  if new.option_axes is distinct from old.option_axes and new.option_axes is not null then
    if exists (select 1 from skus k where k.product_id = new.id and not banto_sku_fits_axes(k.options, new.option_axes)) then
      raise exception 'option_axes_mismatch';
    end if;
    if jsonb_array_length(new.option_axes) > 0 and exists (select 1 from skus k where k.product_id = new.id group by k.options having count(*) > 1) then
      raise exception 'option_combination_exists';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function banto_product_option_axes() from public, anon, authenticated;
drop trigger if exists products_option_axes on products;
create trigger products_option_axes before insert or update of category_id, option_axes on products for each row execute function banto_product_option_axes();

-- SKU: 軸を決めた商品なら options が軸に合うこと・同じ組み合わせが無いこと（品番だけ [] の商品は組み合わせを確かめない）
create or replace function banto_sku_option_axes()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_axes jsonb;
begin
  -- 同じ商品の SKU を同時に足したときに、重なりの確かめをすり抜けないよう商品の行で順番にする
  select option_axes into v_axes from products where id = new.product_id for update;
  if v_axes is null then return new; end if;
  if not banto_sku_fits_axes(new.options, v_axes) then raise exception 'option_axes_mismatch'; end if;
  if jsonb_array_length(v_axes) > 0 and exists (select 1 from skus k where k.product_id = new.product_id and k.id <> new.id and k.options = new.options) then
    raise exception 'option_combination_exists';
  end if;
  return new;
end;
$$;
revoke execute on function banto_sku_option_axes() from public, anon, authenticated;
drop trigger if exists skus_option_axes on skus;
create trigger skus_option_axes before insert or update of options, product_id on skus for each row execute function banto_sku_option_axes();

-- 取り込み（0042 の import_catalog）を包み、取り込みの間は軸を写さない。中身は 0042 のまま
alter function import_catalog(uuid, jsonb) rename to banto_import_catalog_0042;
revoke execute on function banto_import_catalog_0042(uuid, jsonb) from public, anon, authenticated, service_role;
create or replace function import_catalog(p_shop_id uuid, p_batch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform set_config('banto.skip_option_axes', 'on', true);
  return banto_import_catalog_0042(p_shop_id, p_batch);
end;
$$;
revoke execute on function import_catalog(uuid, jsonb) from public, anon;
grant execute on function import_catalog(uuid, jsonb) to authenticated, service_role;

-- 上の段（ショップか、カテゴリーとその子孫）の軸を、上書きしていない商品に当てる（catalog の項目）。
-- 当てる軸は商品ごとに主カテゴリーから引き直す（子のカテゴリーで別の軸を決めていればそちら）。SKU が合わない商品は飛ばして返す
create or replace function option_axes_apply(p_shop_id uuid, p_category_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_p record; v_axes jsonb; v_applied integer := 0; v_same integer := 0; v_skipped jsonb := '[]'::jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_category_id is not null and not exists (select 1 from categories where id = p_category_id and shop_id = p_shop_id) then raise exception 'not_found'; end if;
  for v_p in
    with recursive tree(id) as (
      select id from categories where id = p_category_id
      union all select c.id from categories c join tree t on c.parent_id = t.id where c.shop_id = p_shop_id
    )
    select p.id, p.slug, p.category_id, p.option_axes from products p
     where p.shop_id = p_shop_id and not p.option_axes_custom
       and (p_category_id is null or p.category_id in (select id from tree))
     order by p.created_at
  loop
    v_axes := banto_option_axes_resolve(p_shop_id, v_p.category_id);
    if v_axes is not distinct from v_p.option_axes then v_same := v_same + 1; continue; end if;
    begin
      update products set option_axes = v_axes where id = v_p.id;
      v_applied := v_applied + 1;
    exception when raise_exception then
      if jsonb_array_length(v_skipped) < 100 then v_skipped := v_skipped || jsonb_build_object('slug', v_p.slug, 'reason', sqlerrm); end if;
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'unchanged', v_same, 'skipped', v_skipped);
end;
$$;
revoke execute on function option_axes_apply(uuid, uuid) from public, anon;
grant execute on function option_axes_apply(uuid, uuid) to authenticated, service_role;

-- ---------- AI 用 API ----------
-- 商品の JSON に軸を足す（0063 を差し替え。ほかは同じ）
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
    'option_axes', p_product.option_axes,
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order,
                                                             'options', i.options) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

-- 商品の軸を決める（products:write）。null で「決めない」（自由）に戻す。商品で上書きした扱いになる。返すのは商品
create or replace function api_product_set_option_axes(p_token_hash text, p_product_id uuid, p_axes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_axes jsonb := case when p_axes is null or jsonb_typeof(p_axes) = 'null' then null else p_axes end;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not banto_option_axes_ok(v_axes) then raise exception 'invalid_option_axes'; end if;
  update products set option_axes = v_axes, option_axes_custom = v_axes is not null where id = p_product_id and shop_id = v_tok.shop_id;
  if not found then raise exception 'not_found'; end if;
  return api_product_get(p_token_hash, p_product_id);
end;
$$;
revoke execute on function api_product_set_option_axes(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_product_set_option_axes(text, uuid, jsonb) to service_role;

-- ---------- 復元: restore_shop_data（0012）は軸を知らないので、あとから写す ----------
-- p_data = { shop: axes | null, categories: [{ slug, option_axes }], products: [{ slug, option_axes, option_axes_custom }] }。
-- 商品の軸は SKU を戻した後に当てる（合わない商品は飛ばす）
create or replace function restore_option_axes(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_item jsonb; v_c integer := 0; v_p integer := 0; v_skip integer := 0;
begin
  if jsonb_typeof(p_data) <> 'object' then raise exception 'invalid_items'; end if;
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
revoke execute on function restore_option_axes(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_option_axes(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0065_sku_option_axes');
