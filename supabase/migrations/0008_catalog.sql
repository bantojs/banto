-- Banto 0008_catalog: 商品マスタの拡張（コアの「汎用の器」。docs/knowledge/08-woo-migration.md）
--   カテゴリー（階層、3 段まで）/ ブランド / カスタム項目の値 / SKU の選択肢（サイズ・色など）/ JAN・GTIN / 通常価格（セール表示用）
-- 前方専用。

-- ---------- カテゴリー ----------
create table categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  parent_id uuid,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (length(name) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (shop_id, slug),
  unique (id, shop_id),
  -- 親は同じショップのカテゴリーだけ。親を消すと子は最上位になる
  foreign key (parent_id, shop_id) references categories (id, shop_id) on delete set null (parent_id)
);
create index on categories(shop_id);

-- 階層は 3 段まで、循環させない
create or replace function banto_check_category_parent()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_depth integer := 1; v_cur uuid := new.parent_id;
begin
  while v_cur is not null loop
    if v_cur = new.id then raise exception 'category_cycle'; end if;
    v_depth := v_depth + 1;
    if v_depth > 3 then raise exception 'category_too_deep'; end if;
    select parent_id into v_cur from categories where id = v_cur;
  end loop;
  -- 子孫を含めて 3 段に収まるか（自分の下に子がいる状態で親を付け替えた場合）
  if exists (
    with recursive d(id, lvl) as (
      select id, 1 from categories where parent_id = new.id
      union all
      select c.id, d.lvl + 1 from categories c join d on c.parent_id = d.id where d.lvl < 4
    ) select 1 from d where v_depth + d.lvl > 3
  ) then raise exception 'category_too_deep'; end if;
  return new;
end;
$$;
create trigger categories_parent_check before insert or update of parent_id on categories
  for each row execute function banto_check_category_parent();

alter table categories enable row level security;
create policy categories_owner on categories for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id));
create policy categories_public on categories for select
  using (exists (select 1 from shops s where s.id = categories.shop_id and s.published = true));

-- ---------- 商品 ----------
alter table products
  add column category_id uuid,
  add column brand text check (brand is null or length(brand) between 1 and 100),
  -- カスタム項目の値（項目の定義は shops.settings.product_fields）。値は文字列か数値のみ
  add column attributes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(attributes) = 'object' and octet_length(attributes::text) <= 16000),
  add constraint products_category_fk foreign key (category_id, shop_id) references categories (id, shop_id) on delete set null (category_id);
create index on products(category_id);

-- ---------- SKU ----------
alter table skus
  -- 選択肢（例: {"サイズ": "M", "色": "黒"}）
  add column options jsonb not null default '{}'::jsonb
    check (jsonb_typeof(options) = 'object' and octet_length(options::text) <= 2000),
  -- JAN / GTIN（8・12・13・14 桁）
  add column gtin text check (gtin is null or gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  -- 通常価格（セール表示用の比較価格）。販売価格より高いときだけ持つ
  add column compare_at_price_jpy integer check (compare_at_price_jpy is null or compare_at_price_jpy > price_jpy);

-- ---------- 入力の正規化（AI 用 API と復元で共通） ----------
-- オブジェクトのうち、キーが 1〜40 文字で値が文字列・数値のものだけ残す（文字列は 500 文字まで）。それ以外は捨てる
create or replace function banto_clean_object(p jsonb, p_max_keys integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' then to_jsonb(left(v #>> '{}', 500)) else v end), '{}'::jsonb)
    from (select key as k, value as v from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end)
           where length(btrim(key)) between 1 and 40 and jsonb_typeof(value) in ('string', 'number')
           order by key limit p_max_keys) x;
$$;

-- ---------- AI 用 API（0003 / 0007 の同名関数を置き換える。権限は既存のまま） ----------
create or replace function api_category_json(p_category categories)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when p_category.id is null then null else
    jsonb_build_object('id', p_category.id, 'slug', p_category.slug, 'name', p_category.name, 'parent_id', p_category.parent_id, 'sort_order', p_category.sort_order) end;
$$;

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
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

-- カテゴリーの指定（slug）→ id。空文字なら null（外す）。見つからなければ例外
create or replace function api_category_ref(p_shop_id uuid, p_slug text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_slug is null or btrim(p_slug) = '' then return null; end if;
  select id into v_id from categories where shop_id = p_shop_id and slug = btrim(p_slug);
  if not found then raise exception 'category_not_found'; end if;
  return v_id;
end;
$$;

create or replace function api_product_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'))
  returning * into v_p;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

create or replace function api_product_update(p_token_hash text, p_product_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  update products set
    slug = coalesce(p_values->>'slug', slug),
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    description = case when p_values ? 'description' then nullif(btrim(p_values->>'description'), '') else description end,
    published = coalesce((p_values->>'published')::boolean, published),
    tags = case when p_values ? 'tags' then banto_normalize_tags(p_values->'tags') else tags end,
    brand = case when p_values ? 'brand' then nullif(btrim(coalesce(p_values->>'brand', '')), '') else brand end,
    attributes = case when p_values ? 'attributes' then banto_clean_object(p_values->'attributes', 50) else attributes end,
    category_id = case when p_values ? 'category' then api_category_ref(v_tok.shop_id, p_values->>'category') else category_id end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

create or replace function api_sku_create(p_token_hash text, p_product_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_k skus%rowtype; v_available integer;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not exists (select 1 from products where id = p_product_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  insert into skus (shop_id, product_id, code, name, price_jpy, options, gtin, compare_at_price_jpy)
  values (v_tok.shop_id, p_product_id, p_values->>'code', nullif(btrim(coalesce(p_values->>'name', '')), ''), (p_values->>'price_jpy')::integer,
          banto_clean_object(p_values->'options', 5), nullif(btrim(coalesce(p_values->>'gtin', '')), ''), (p_values->>'compare_at_price_jpy')::integer)
  returning * into v_k;
  v_available := coalesce((p_values->>'available')::integer, 0);
  if v_available < 0 then raise exception 'invalid_available'; end if;
  update inventory set available = v_available, updated_at = now() where sku_id = v_k.id;
  return api_product_get(p_token_hash, p_product_id);
end;
$$;

create or replace function api_sku_update(p_token_hash text, p_sku_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_k skus%rowtype; v_available integer;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  update skus set
    code = coalesce(p_values->>'code', code),
    name = case when p_values ? 'name' then nullif(btrim(p_values->>'name'), '') else name end,
    price_jpy = coalesce((p_values->>'price_jpy')::integer, price_jpy),
    options = case when p_values ? 'options' then banto_clean_object(p_values->'options', 5) else options end,
    gtin = case when p_values ? 'gtin' then nullif(btrim(coalesce(p_values->>'gtin', '')), '') else gtin end,
    compare_at_price_jpy = case when p_values ? 'compare_at_price_jpy' then (p_values->>'compare_at_price_jpy')::integer else compare_at_price_jpy end
  where id = p_sku_id and shop_id = v_tok.shop_id
  returning * into v_k;
  if not found then raise exception 'not_found'; end if;
  if p_values ? 'available' then
    v_available := (p_values->>'available')::integer;
    if v_available is null or v_available < 0 then raise exception 'invalid_available'; end if;
    update inventory set available = v_available, updated_at = now() where sku_id = v_k.id;
  end if;
  return api_product_get(p_token_hash, v_k.product_id);
end;
$$;

-- カテゴリーの一覧と作成・更新（slug で突き合わせ。parent は親の slug、空なら最上位）
create or replace function api_categories_list(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  return (select coalesce(jsonb_agg(api_category_json(c) order by c.sort_order, c.name), '[]'::jsonb) from categories c where c.shop_id = v_tok.shop_id);
end;
$$;

create or replace function api_category_save(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c categories%rowtype; v_parent uuid;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  v_parent := api_category_ref(v_tok.shop_id, p_values->>'parent');
  insert into categories (shop_id, slug, name, parent_id, sort_order)
  values (v_tok.shop_id, btrim(p_values->>'slug'), btrim(p_values->>'name'), v_parent, coalesce((p_values->>'sort_order')::integer, 0))
  on conflict (shop_id, slug) do update set
    name = coalesce(nullif(btrim(excluded.name), ''), categories.name),
    parent_id = case when p_values ? 'parent' then excluded.parent_id else categories.parent_id end,
    sort_order = case when p_values ? 'sort_order' then excluded.sort_order else categories.sort_order end
  returning * into v_c;
  return api_category_json(v_c);
end;
$$;

-- ---------- バックアップからの復元 ----------
-- restore_shop_data（0006）の後に呼ぶ。0006 が知らない列（タグ・カテゴリー・ブランド・カスタム項目・SKU の拡張）を
-- slug / code で突き合わせて戻す（id は振り直されているため）。戻した件数を返す。
create or replace function restore_catalog(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_cat_map jsonb := '{}'::jsonb; v_new uuid; v_n_cat integer := 0; v_n_prod integer := 0; v_n_sku integer := 0;
  v_cats jsonb := coalesce(p_data->'categories', '[]'::jsonb);
  v_products jsonb := coalesce(p_data->'products', '[]'::jsonb);
  v_skus jsonb := coalesce(p_data->'skus', '[]'::jsonb);
begin
  if jsonb_typeof(v_cats) <> 'array' or jsonb_typeof(v_products) <> 'array' or jsonb_typeof(v_skus) <> 'array' then raise exception 'invalid_export'; end if;
  -- カテゴリー: まず親なしで作り、次に親を付ける（並び順に依存しない）
  for v_row in select * from jsonb_array_elements(v_cats) loop
    insert into categories (shop_id, slug, name, sort_order)
    values (p_shop_id, v_row->>'slug', v_row->>'name', coalesce((v_row->>'sort_order')::integer, 0))
    on conflict (shop_id, slug) do update set name = excluded.name
    returning id into v_new;
    v_cat_map := v_cat_map || jsonb_build_object(v_row->>'id', v_new::text);
    v_n_cat := v_n_cat + 1;
  end loop;
  for v_row in select * from jsonb_array_elements(v_cats) loop
    if v_cat_map ? (v_row->>'parent_id') then
      update categories set parent_id = (v_cat_map->>(v_row->>'parent_id'))::uuid
       where shop_id = p_shop_id and slug = v_row->>'slug';
    end if;
  end loop;
  -- 商品
  for v_row in select * from jsonb_array_elements(v_products) loop
    update products set
      tags = banto_normalize_tags(v_row->'tags'),
      brand = nullif(btrim(coalesce(v_row->>'brand', '')), ''),
      attributes = banto_clean_object(v_row->'attributes', 50),
      category_id = case when v_cat_map ? (v_row->>'category_id') then (v_cat_map->>(v_row->>'category_id'))::uuid else null end
     where shop_id = p_shop_id and slug = v_row->>'slug';
    if found then v_n_prod := v_n_prod + 1; end if;
  end loop;
  -- SKU
  for v_row in select * from jsonb_array_elements(v_skus) loop
    update skus set
      options = banto_clean_object(v_row->'options', 5),
      gtin = nullif(btrim(coalesce(v_row->>'gtin', '')), ''),
      compare_at_price_jpy = (v_row->>'compare_at_price_jpy')::integer
     where shop_id = p_shop_id and code = v_row->>'code';
    if found then v_n_sku := v_n_sku + 1; end if;
  end loop;
  return jsonb_build_object('categories', v_n_cat, 'products_extended', v_n_prod, 'skus_extended', v_n_sku);
end;
$$;

-- ---------- 実行権限 ----------
-- 新しい api_* と内部ヘルパーは service_role 専用（0003 と同じ）
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('api_category_json', 'api_category_ref', 'api_categories_list', 'api_category_save', 'banto_clean_object', 'restore_catalog')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
-- CHECK 制約から呼ぶものではないが、トリガー関数は所有者権限で動くので剥奪してよい
revoke all on function banto_check_category_parent() from public, anon, authenticated;

insert into banto_migrations (version) values ('0008_catalog');
