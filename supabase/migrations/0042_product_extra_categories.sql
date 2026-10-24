-- Banto 0042_product_extra_categories: 商品の追加カテゴリー（複数）と、クーポンのタグの条件。
-- 前方専用。人間の決定 2026-10-19（docs/knowledge/02-decisions.md）。
--   主カテゴリー（products.category_id、1 つ）はそのまま。パンくず・canonical・商品フィードの分類に使う。
--   追加カテゴリー（products.extra_category_ids）は「売り場の棚」。お店の画面と公開 API のカテゴリーの絞り込みと、
--   クーポンのカテゴリーの条件で、主カテゴリーと同じに扱う（どれか 1 つが合えば。src/products/categories.ts の productCategoryIds）。
--   表ではなく配列の列にしたのは、お店の画面がキャッシュした商品の行をメモリで絞り込むため（DB 往復を増やさない）。
--   同じショップのカテゴリーだけ・カテゴリーを消したら外す、はトリガーで保証する。
-- クーポンの条件に tags / exclude_tags（商品のタグ）を足す。判定は src/commerce/discounts.ts だけ。

-- ---------- 列 ----------
alter table products
  add column extra_category_ids uuid[] not null default '{}' check (cardinality(extra_category_ids) <= 20);
create index products_extra_category_ids_idx on products using gin (extra_category_ids);

-- 重複・null・主カテゴリーと同じものを外し、新しく足したものが同じショップのカテゴリーかを確かめる。
-- 外すだけの変更（カテゴリーの削除で消えた id）は確かめない（ショップの削除の連鎖の途中でも止めない）
create or replace function banto_product_extra_categories()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_before uuid[] := '{}'; v_added uuid[];
begin
  if tg_op = 'UPDATE' then v_before := old.extra_category_ids; end if;
  select coalesce(array_agg(id order by ord), '{}') into new.extra_category_ids
    from (select id, min(ord) as ord from unnest(new.extra_category_ids) with ordinality u(id, ord)
           where id is not null and id is distinct from new.category_id group by id) x;
  select coalesce(array_agg(id), '{}') into v_added
    from unnest(new.extra_category_ids) id
   where not (id = any(v_before));
  if cardinality(v_added) > 0
     and (select count(*) from categories where shop_id = new.shop_id and id = any(v_added)) <> cardinality(v_added) then
    raise exception 'category_not_found';
  end if;
  return new;
end;
$$;
create trigger products_extra_categories before insert or update of extra_category_ids, category_id on products
  for each row execute function banto_product_extra_categories();

-- カテゴリーを消したら、追加カテゴリーからも外す（主カテゴリーは外部キーの on delete set null で外れる）
create or replace function banto_category_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update products set extra_category_ids = array_remove(extra_category_ids, old.id)
   where shop_id = old.shop_id and extra_category_ids @> array[old.id];
  return old;
end;
$$;
create trigger categories_deleted after delete on categories
  for each row execute function banto_category_deleted();

revoke all on function banto_product_extra_categories() from public, anon, authenticated;
revoke all on function banto_category_deleted() from public, anon, authenticated;

-- ---------- AI 用 API（0008 / 0037 の同名関数を置き換える。権限は既存のまま） ----------
-- 追加カテゴリーの指定（slug の配列）→ id の配列。null・空なら空。見つからなければ例外
create or replace function api_category_refs(p_shop_id uuid, p_slugs jsonb)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_slug text; v_out uuid[] := '{}';
begin
  if p_slugs is null or jsonb_typeof(p_slugs) = 'null' then return v_out; end if;
  if jsonb_typeof(p_slugs) <> 'array' or jsonb_array_length(p_slugs) > 20
     or exists (select 1 from jsonb_array_elements(p_slugs) e where jsonb_typeof(e) <> 'string') then
    raise exception 'invalid_extra_categories';
  end if;
  for v_slug in select value from jsonb_array_elements_text(p_slugs) loop
    v_out := v_out || api_category_ref(p_shop_id, v_slug);
  end loop;
  return array_remove(v_out, null);
end;
$$;
revoke execute on function api_category_refs(uuid, jsonb) from public, anon, authenticated;
grant execute on function api_category_refs(uuid, jsonb) to service_role;

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
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'compare_at_price_jpy', k.compare_at_price_jpy, 'options', k.options, 'gtin', k.gtin,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
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
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'))
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
    category_id = case when p_values ? 'category' then api_category_ref(v_tok.shop_id, p_values->>'category') else category_id end,
    extra_category_ids = case when p_values ? 'extra_categories' then api_category_refs(v_tok.shop_id, p_values->'extra_categories') else extra_category_ids end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- ---------- 一括取り込み（0024 を置き換える。extra_category_slugs を受け付ける。権限は既存のまま） ----------
create or replace function import_catalog(p_shop_id uuid, p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_sku jsonb; v_cat_id uuid; v_extra uuid[]; v_parent uuid; v_pid uuid; v_kid uuid; v_existing uuid; v_avail integer;
  v_price integer; v_compare integer; v_gtin text; v_created boolean;
  v_n_cat integer := 0; v_p_new integer := 0; v_p_upd integer := 0; v_k_new integer := 0; v_k_upd integer := 0;
  l_p_new integer; l_k_new integer; l_k_upd integer;
  v_errors jsonb := '[]'::jsonb;
  v_overwrite boolean := coalesce((p_batch->>'overwrite_stock')::boolean, true);
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;

  -- カテゴリー（親が先）
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'categories', '[]'::jsonb)) loop
    v_parent := null;
    if coalesce(v_row->>'parent_slug', '') <> '' then
      select id into v_parent from categories where shop_id = p_shop_id and slug = v_row->>'parent_slug';
    end if;
    insert into categories (shop_id, slug, name, parent_id, sort_order)
    values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 100), v_parent, coalesce((v_row->>'sort_order')::integer, 0))
    on conflict (shop_id, slug) do update set name = excluded.name, parent_id = excluded.parent_id;
    v_n_cat := v_n_cat + 1;
  end loop;

  -- 商品と SKU
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'products', '[]'::jsonb)) loop
    begin
      l_p_new := 0; l_k_new := 0; l_k_upd := 0;
      v_cat_id := null;
      if coalesce(v_row->>'category_slug', '') <> '' then
        select id into v_cat_id from categories where shop_id = p_shop_id and slug = v_row->>'category_slug';
      end if;
      -- 追加カテゴリー（slug の配列）。鍵が無ければ既存の値を変えない（古い取り込み画面から送られても消さない）。見つからない slug は飛ばす
      v_extra := null;
      if jsonb_typeof(v_row->'extra_category_slugs') = 'array' then
        select coalesce(array_agg(c.id order by e.ord), '{}') into v_extra
          from jsonb_array_elements_text(v_row->'extra_category_slugs') with ordinality e(slug, ord)
          join categories c on c.shop_id = p_shop_id and c.slug = e.slug;
        v_extra := v_extra[1:20];
      end if;
      select id into v_pid from products where shop_id = p_shop_id and slug = v_row->>'slug';
      if v_pid is null then
        insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids)
        values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 200), nullif(btrim(coalesce(v_row->>'description', '')), ''),
                coalesce((v_row->>'published')::boolean, false), banto_normalize_tags(v_row->'tags'),
                nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''), banto_clean_object(v_row->'attributes', 200), v_cat_id, coalesce(v_extra, '{}'))
        returning id into v_pid;
        l_p_new := 1;
      else
        -- カスタム項目は既存の値に上書きでマージする（取り込み元に無い項目を消さない）
        update products set
          name = left(btrim(v_row->>'name'), 200),
          description = nullif(btrim(coalesce(v_row->>'description', '')), ''),
          published = coalesce((v_row->>'published')::boolean, published),
          tags = banto_normalize_tags(v_row->'tags'),
          brand = nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''),
          attributes = attributes || banto_clean_object(v_row->'attributes', 200),
          category_id = v_cat_id,
          extra_category_ids = coalesce(v_extra, extra_category_ids)
        where id = v_pid;
      end if;

      for v_sku in select * from jsonb_array_elements(coalesce(v_row->'skus', '[]'::jsonb)) loop
        v_price := (v_sku->>'price_jpy')::integer;
        v_compare := (v_sku->>'compare_at_price_jpy')::integer;
        if v_compare is not null and v_compare <= v_price then v_compare := null; end if;
        v_gtin := nullif(btrim(coalesce(v_sku->>'gtin', '')), '');
        if v_gtin is not null and v_gtin !~ '^([0-9]{8}|[0-9]{12,14})$' then v_gtin := null; end if;
        select id, product_id into v_kid, v_existing from skus where shop_id = p_shop_id and code = v_sku->>'code';
        v_created := v_kid is null;
        if v_created then
          insert into skus (shop_id, product_id, code, name, price_jpy, compare_at_price_jpy, gtin, options)
          values (p_shop_id, v_pid, v_sku->>'code', nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), v_price, v_compare, v_gtin,
                  banto_clean_object(v_sku->'options', 5))
          returning id into v_kid;
          l_k_new := l_k_new + 1;
        else
          if v_existing <> v_pid then raise exception 'sku_belongs_to_other_product: %', v_sku->>'code'; end if;
          update skus set name = nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), price_jpy = v_price, compare_at_price_jpy = v_compare,
                          gtin = v_gtin, options = banto_clean_object(v_sku->'options', 5)
           where id = v_kid;
          l_k_upd := l_k_upd + 1;
        end if;
        -- 在庫（inventory 行は skus の insert でトリガーが作る）
        if v_sku ? 'available' and (v_created or v_overwrite) then
          v_avail := greatest(0, coalesce((v_sku->>'available')::integer, 0));
          update inventory set available = v_avail, updated_at = now() where sku_id = v_kid;
        end if;
      end loop;

      perform enqueue_hook(p_shop_id, 'product.updated', jsonb_build_object('product_id', v_pid, 'shop_id', p_shop_id, 'slug', v_row->>'slug'));
      -- 件数はこの商品が最後まで通ったときだけ数える（例外なら全部取り消されるため）
      v_p_new := v_p_new + l_p_new; v_p_upd := v_p_upd + (1 - l_p_new); v_k_new := v_k_new + l_k_new; v_k_upd := v_k_upd + l_k_upd;
    exception when others then
      -- この商品だけ取り消して続ける（plpgsql の例外ブロックはセーブポイントとして働く）
      v_errors := v_errors || jsonb_build_object('slug', v_row->>'slug', 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('categories', v_n_cat, 'products_created', v_p_new, 'products_updated', v_p_upd,
                            'skus_created', v_k_new, 'skus_updated', v_k_upd, 'errors', v_errors);
end;
$$;

-- ---------- バックアップからの復元（0008 を置き換える。追加カテゴリーの id を振り直す） ----------
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
      category_id = case when v_cat_map ? (v_row->>'category_id') then (v_cat_map->>(v_row->>'category_id'))::uuid else null end,
      -- 追加カテゴリー（0042）。戻らなかったカテゴリーは外す
      extra_category_ids = coalesce((select array_agg((v_cat_map->>x.id)::uuid order by x.ord)
                                       from jsonb_array_elements_text(case when jsonb_typeof(v_row->'extra_category_ids') = 'array' then v_row->'extra_category_ids' else '[]'::jsonb end)
                                            with ordinality x(id, ord)
                                      where v_cat_map ? x.id), '{}')
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

-- ---------- クーポンの条件の検査（0036 を置き換える。tags / exclude_tags を受け付ける） ----------
create or replace function banto_api_coupon_apply(p_shop_id uuid, p_c coupon_campaigns, p_values jsonb)
returns coupon_campaigns
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text; v_val jsonb; v_cond jsonb; v_ck text; v_cv jsonb; v_ids uuid[]; v_n integer; v_s text; v_tags text[];
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key, v_val in select * from jsonb_each(p_values) loop
    case v_key
      when 'name' then
        v_s := btrim(coalesce(v_val #>> '{}', ''));
        if jsonb_typeof(v_val) <> 'string' or length(v_s) not between 1 and 100 then raise exception 'invalid_name'; end if;
        p_c.name := v_s;
      when 'code' then
        if jsonb_typeof(v_val) = 'null' or btrim(v_val #>> '{}') = '' then p_c.code := null;
        else
          v_s := upper(btrim(v_val #>> '{}'));
          if jsonb_typeof(v_val) <> 'string' or v_s !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then raise exception 'invalid_code'; end if;
          p_c.code := v_s;
        end if;
      when 'kind' then
        if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' not in ('percent', 'fixed', 'free_shipping') then raise exception 'invalid_kind'; end if;
        p_c.kind := v_val #>> '{}';
      when 'value' then
        if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}') !~ '^\d+$' then raise exception 'invalid_value'; end if;
        p_c.value := (v_val #>> '{}')::integer;
      when 'starts_at', 'ends_at' then
        if jsonb_typeof(v_val) not in ('string', 'null') then raise exception 'invalid_%', v_key; end if;
        begin
          if v_key = 'starts_at' then p_c.starts_at := (v_val #>> '{}')::timestamptz; else p_c.ends_at := (v_val #>> '{}')::timestamptz; end if;
        exception when others then raise exception 'invalid_%', v_key;
        end;
      when 'usage_limit', 'per_customer_limit', 'grant_valid_days' then
        if jsonb_typeof(v_val) = 'null' then v_n := null;
        elsif jsonb_typeof(v_val) = 'number' and (v_val #>> '{}') ~ '^\d{1,7}$' then v_n := (v_val #>> '{}')::integer;
        else raise exception 'invalid_%', v_key;
        end if;
        if v_key = 'usage_limit' then
          if v_n is not null and v_n not between 1 and 100000 then raise exception 'invalid_usage_limit'; end if;
          p_c.usage_limit := v_n;
        elsif v_key = 'per_customer_limit' then
          if v_n is not null and v_n not between 1 and 1000 then raise exception 'invalid_per_customer_limit'; end if;
          p_c.per_customer_limit := v_n;
        else
          if v_n is not null and v_n not between 1 and 3650 then raise exception 'invalid_grant_valid_days'; end if;
          p_c.grant_valid_days := v_n;
        end if;
      when 'combinable', 'active', 'claimable' then
        if jsonb_typeof(v_val) <> 'boolean' then raise exception 'invalid_%', v_key; end if;
        if v_key = 'combinable' then p_c.combinable := v_val::boolean;
        elsif v_key = 'active' then p_c.active := v_val::boolean;
        else p_c.claimable := v_val::boolean;
        end if;
      when 'audience' then
        if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' not in ('public', 'members') then raise exception 'invalid_audience'; end if;
        p_c.audience := v_val #>> '{}';
      when 'auto_grant' then
        if jsonb_typeof(v_val) = 'null' then p_c.auto_grant := null;
        elsif jsonb_typeof(v_val) = 'string' and v_val #>> '{}' in ('first_login', 'after_purchase') then p_c.auto_grant := v_val #>> '{}';
        else raise exception 'invalid_auto_grant';
        end if;
      when 'external_ref' then
        if jsonb_typeof(v_val) = 'null' or btrim(v_val #>> '{}') = '' then p_c.external_ref := null;
        elsif jsonb_typeof(v_val) = 'string' and length(btrim(v_val #>> '{}')) <= 100 then p_c.external_ref := btrim(v_val #>> '{}');
        else raise exception 'invalid_external_ref';
        end if;
      when 'conditions' then
        if jsonb_typeof(v_val) = 'null' then v_val := '{}'::jsonb; end if;
        if jsonb_typeof(v_val) <> 'object' then raise exception 'invalid_conditions'; end if;
        v_cond := '{}'::jsonb;
        for v_ck, v_cv in select * from jsonb_each(v_val) loop
          if jsonb_typeof(v_cv) = 'null' then continue; end if;
          case v_ck
            when 'product_ids', 'exclude_product_ids', 'category_ids', 'exclude_category_ids' then
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 200
                 or exists (select 1 from jsonb_array_elements(v_cv) e
                             where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              select coalesce(array_agg(distinct (e #>> '{}')::uuid), '{}') into v_ids from jsonb_array_elements(v_cv) e;
              if v_ck in ('product_ids', 'exclude_product_ids') then
                if (select count(*) from products where shop_id = p_shop_id and id = any(v_ids)) <> coalesce(array_length(v_ids, 1), 0) then raise exception 'invalid_conditions_unknown_products'; end if;
              else
                if (select count(*) from categories where shop_id = p_shop_id and id = any(v_ids)) <> coalesce(array_length(v_ids, 1), 0) then raise exception 'invalid_conditions_unknown_categories'; end if;
              end if;
              if coalesce(array_length(v_ids, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object(v_ck, to_jsonb(v_ids)); end if;
            when 'tags', 'exclude_tags' then
              -- タグ（0042）。商品のタグと同じ正規化（src/products/tags.ts）。20 個まで
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 20
                 or exists (select 1 from jsonb_array_elements(v_cv) e where jsonb_typeof(e) <> 'string') then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              v_tags := banto_normalize_tags(v_cv);
              if coalesce(array_length(v_tags, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object(v_ck, to_jsonb(v_tags)); end if;
            when 'exclude_sale' then
              if jsonb_typeof(v_cv) <> 'boolean' then raise exception 'invalid_conditions_exclude_sale'; end if;
              if v_cv::boolean then v_cond := v_cond || jsonb_build_object('exclude_sale', true); end if;
            when 'min_subtotal_jpy', 'max_subtotal_jpy', 'min_qty' then
              -- 上限: 点数は 999、金額は 1 億円（管理画面と同じ）
              v_n := 100000000;
              if v_ck = 'min_qty' then v_n := 999; end if;
              if jsonb_typeof(v_cv) <> 'number' or (v_cv #>> '{}') !~ '^\d{1,9}$' or (v_cv #>> '{}')::integer > v_n then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              v_cond := v_cond || jsonb_build_object(v_ck, (v_cv #>> '{}')::integer);
            else raise exception 'invalid_conditions_unknown_key';
          end case;
        end loop;
        p_c.conditions := v_cond;
      else raise exception 'invalid_field_%', left(v_key, 40);
    end case;
  end loop;
  -- 種類と値の組み合わせ（テーブルの CHECK と同じ。わかりやすい理由で返す）
  if p_c.kind = 'free_shipping' then p_c.value := 0;
  elsif p_c.kind = 'percent' and p_c.value not between 1 and 100 then raise exception 'invalid_value';
  elsif p_c.kind = 'fixed' and p_c.value not between 1 and 10000000 then raise exception 'invalid_value';
  end if;
  if p_c.starts_at is not null and p_c.ends_at is not null and p_c.starts_at >= p_c.ends_at then raise exception 'invalid_ends_at'; end if;
  return p_c;
end;
$$;

insert into banto_migrations (version) values ('0042_product_extra_categories');
