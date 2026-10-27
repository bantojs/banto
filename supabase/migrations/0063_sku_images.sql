-- Banto 0063_sku_images: 画像を SKU の options の一部に結ぶ（品番・カラー・カラー × サイズ単位の画像。人間の決定 2026-10-27）。前方専用。
--   - product_images.options: 空 = 商品全体、{"color":"レッド"} = その値を持つ SKU すべて、{"color":"レッド","size":"M"} = その SKU だけ。
--     当てはまりの判定と並べ方は Worker の src/products/images.ts だけ（お店の画面・公開 API・商品フィードが同じ関数）
--   - 形は SKU の options と同じ（object、鍵 5 つまで、鍵 40 文字・値 60 文字まで、値は文字列）
--   - WooCommerce の取り込み: バリエーションの画像の URL の目印（/wc-<hash>.）に options を結んだ対応表（product_image_hints）を先に置き、
--     画像の行ができたとき（その場の取り込み・裏の取り込みのどちらでも）トリガーが options を写す

create or replace function banto_image_options_ok(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) <= 5
     and not exists (select 1 from jsonb_each(p) e
                      where length(e.key) = 0 or length(e.key) > 40 or jsonb_typeof(e.value) <> 'string'
                         or length(e.value #>> '{}') = 0 or length(e.value #>> '{}') > 60);
$$;
-- 列の CHECK で呼ぶので、画像の行を書くロール（管理画面の authenticated）に EXECUTE が要る（中身は値の形を見るだけ）
revoke execute on function banto_image_options_ok(jsonb) from public, anon;
grant execute on function banto_image_options_ok(jsonb) to authenticated, service_role;

alter table product_images add column if not exists options jsonb not null default '{}'::jsonb;
alter table product_images drop constraint if exists product_images_options_check;
alter table product_images add constraint product_images_options_check check (banto_image_options_ok(options));

-- ---------- WooCommerce の取り込み: URL の目印 → options ----------
create table if not exists product_image_hints (
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid not null,
  tag text not null check (tag ~ '^/wc-[0-9a-z]{1,13}\.$'),
  options jsonb not null check (banto_image_options_ok(options)),
  created_at timestamptz not null default now(),
  primary key (product_id, tag),
  foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade
);
alter table product_image_hints enable row level security;
create policy image_hints_catalog on product_image_hints for select using (banto_shop_perm(shop_id, 'catalog'));

-- 画像の行ができたら、目印の合う対応表の options を写す（options を明示した行はそのまま）
create or replace function banto_product_image_hint()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.options = '{}'::jsonb then
    select h.options into new.options from product_image_hints h
     where h.product_id = new.product_id and position(h.tag in new.storage_key) > 0 limit 1;
    new.options := coalesce(new.options, '{}'::jsonb);
  end if;
  return new;
end;
$$;
revoke execute on function banto_product_image_hint() from public, anon, authenticated;
drop trigger if exists product_images_hint on product_images;
create trigger product_images_hint before insert on product_images for each row execute function banto_product_image_hint();

-- 対応表を置く（取り込みの画面。catalog の項目）。p_items = [{ slug, tag, options }]（1 回 500 件まで）。
-- すでにある画像にも写す（取り込み直したとき）。空の options は対応表から外す
create or replace function product_image_hints_set(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_item jsonb; v_pid uuid; v_n integer := 0; v_applied integer := 0; v_hit integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items'; end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' or (v_item->>'tag') !~ '^/wc-[0-9a-z]{1,13}\.$' or not banto_image_options_ok(coalesce(v_item->'options', 'null'::jsonb)) then
      raise exception 'invalid_items';
    end if;
    select id into v_pid from products where shop_id = p_shop_id and slug = v_item->>'slug';
    if v_pid is null then continue; end if;
    if v_item->'options' = '{}'::jsonb then
      delete from product_image_hints where product_id = v_pid and tag = v_item->>'tag';
      continue;
    end if;
    insert into product_image_hints (shop_id, product_id, tag, options) values (p_shop_id, v_pid, v_item->>'tag', v_item->'options')
    on conflict (product_id, tag) do update set options = excluded.options;
    v_n := v_n + 1;
    update product_images set options = v_item->'options'
     where product_id = v_pid and shop_id = p_shop_id and position((v_item->>'tag') in storage_key) > 0 and options = '{}'::jsonb;
    get diagnostics v_hit = row_count;
    v_applied := v_applied + v_hit;
  end loop;
  return jsonb_build_object('hints', v_n, 'applied', v_applied);
end;
$$;
revoke execute on function product_image_hints_set(uuid, jsonb) from public, anon;
grant execute on function product_image_hints_set(uuid, jsonb) to authenticated, service_role;

-- ---------- AI 用 API ----------
-- 商品の JSON の画像に options を足す（0042 を差し替え。ほかは同じ）
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

-- 画像を SKU の options に結ぶ（products:write）。{} で商品全体に戻す。返すのは商品
create or replace function api_image_set_options(p_token_hash text, p_image_id uuid, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pid uuid;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not banto_image_options_ok(coalesce(p_options, 'null'::jsonb)) then raise exception 'invalid_options'; end if;
  update product_images set options = p_options where id = p_image_id and shop_id = v_tok.shop_id returning product_id into v_pid;
  if v_pid is null then raise exception 'not_found'; end if;
  return api_product_get(p_token_hash, v_pid);
end;
$$;
revoke execute on function api_image_set_options(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_image_set_options(text, uuid, jsonb) to service_role;

-- ---------- 復元: restore_shop_data（0012）は options を知らないので、あとから写す ----------
-- p_items = [{ storage_key, options }]。そのショップの、同じキーの画像に写す（1 回 5,000 件まで）
create or replace function restore_product_image_options(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_item jsonb; v_n integer := 0; v_hit integer;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000 then raise exception 'invalid_items'; end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item->'storage_key') <> 'string'
       or not banto_image_options_ok(coalesce(v_item->'options', 'null'::jsonb)) or v_item->'options' = '{}'::jsonb then
      continue;
    end if;
    update product_images set options = v_item->'options' where shop_id = p_shop_id and storage_key = v_item->>'storage_key';
    get diagnostics v_hit = row_count;
    v_n := v_n + v_hit;
  end loop;
  return jsonb_build_object('product_image_options', v_n);
end;
$$;
revoke execute on function restore_product_image_options(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_product_image_options(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0063_sku_images');
