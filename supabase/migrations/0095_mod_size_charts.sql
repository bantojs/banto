-- 0095_mod_size_charts: 採寸表（同梱モジュール size_charts、既定 OFF。メンテナの決定 2026-11-02、docs/size-charts.md）
--   - 採寸表はショップ全体・カテゴリー・商品の 3 つの段で置ける（size_charts の 1 行 = 1 つの段）。表示するときに近い段から決める:
--       列（項目名・単位）・測り方の図・結ぶ軸 → 商品 → 主カテゴリー（子から親へ）→ ショップで、列を持つ最初の段
--       行（サイズごとの値）・注記 → 商品からその段までのあいだで、行（注記）を持つ最初の段（列の段より上の行は使わない。列と合わないため）
--     例: カテゴリー「トップス」で列（着丈・身幅・肩幅・袖丈、cm）と測り方の図を決め、商品ごとに行（S・M・L の値）だけを入れる
--   - 商品の段で hidden = true なら、その商品には出さない（カテゴリーに表があってもアクセサリーには出さない、など）
--   - 結ぶ軸は SKU を分ける軸の key（0094 の shops.option_names にある key だけ）。行の value がその軸の値と同じなら、選んだ SKU の行を目立たせる
--   - 列ごとに単位（cm・mm・inch・号 など自由な短い文字）。セルの値は文字（「38〜40」「F」もあるため数にしない）
--   - 測り方の図は管理画面のブラウザで縮小した WebP を size-charts/<ショップ>/ に置き、キーと大きさだけを持つ
--   - 書き込みは RPC だけ（size_chart_set / api_size_chart_set）。形は banto_size_chart_normalize が知っている鍵だけに組み直す
--   - お客様の画面は product_public_get の size_chart（モジュールが ON のときだけ。往復を増やさない）

create table if not exists size_charts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  category_id uuid,
  product_id uuid,
  hidden boolean not null default false,
  axis text check (axis is null or axis ~ '^[a-z][a-z0-9_]{0,31}$'),
  columns jsonb check (columns is null or jsonb_typeof(columns) = 'array'),
  rows jsonb check (rows is null or jsonb_typeof(rows) = 'array'),
  note text check (note is null or char_length(note) between 1 and 2000),
  image_key text check (image_key is null or image_key ~ '^size-charts/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  image_width integer check (image_width is null or image_width between 1 and 4096),
  image_height integer check (image_height is null or image_height between 1 and 4096),
  updated_at timestamptz not null default now(),
  check (category_id is null or product_id is null),
  check (image_key is null or image_key like 'size-charts/' || shop_id::text || '/%'),
  foreign key (category_id, shop_id) references categories (id, shop_id) on delete cascade,
  foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade
);
create unique index if not exists size_charts_shop_level on size_charts (shop_id) where category_id is null and product_id is null;
create unique index if not exists size_charts_category_level on size_charts (category_id) where category_id is not null;
create unique index if not exists size_charts_product_level on size_charts (product_id) where product_id is not null;

alter table size_charts enable row level security;
drop policy if exists size_charts_catalog on size_charts;
create policy size_charts_catalog on size_charts for select using (banto_shop_perm(shop_id, 'catalog'));
revoke all on size_charts from anon, authenticated;
grant select on size_charts to authenticated;

-- ---------- 形を確かめて組み直す（知っている鍵だけ） ----------
-- p: { hidden?, axis?, columns?, rows?, note?, image? }。columns・rows は [] も null（上の段を使う）にそろえる
--   columns: [{ key?, label, unit? }]（12 まで。key が無ければ c1・c2…を振る）
--   rows: [{ value, cells: { <列の key>: 文字 } }]（60 まで、value は重ならない）
--   axis: key か表示名（ショップの名前の表にあるものだけ）
--   image: { key, width, height } か null
create or replace function banto_size_chart_normalize(p_shop_id uuid, p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_names jsonb;
  v_axis text;
  v_cols jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_col jsonb;
  v_row jsonb;
  v_key text;
  v_label text;
  v_unit text;
  v_value text;
  v_cells jsonb;
  v_cell record;
  v_seen text[] := '{}';
  v_values text[] := '{}';
  v_n integer := 0;
  v_note text;
  v_image jsonb := null;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_size_chart'; end if;
  if octet_length(p::text) > 65536 then raise exception 'invalid_size_chart_too_large'; end if;
  if p ? 'hidden' and jsonb_typeof(p->'hidden') not in ('boolean', 'null') then raise exception 'invalid_size_chart_hidden'; end if;

  -- 軸: key か表示名。表に無いものは受けない（新しい軸はここでは作らない）
  if jsonb_typeof(p->'axis') = 'string' and btrim(p->>'axis') <> '' then
    select coalesce(option_names, '{}'::jsonb) into v_names from shops where id = p_shop_id;
    v_axis := banto_option_key_find(v_names, btrim(p->>'axis'));
    if v_axis is null then raise exception 'invalid_size_chart_axis'; end if;
  elsif p ? 'axis' and jsonb_typeof(p->'axis') not in ('null', 'string') then
    raise exception 'invalid_size_chart_axis';
  end if;

  -- 列
  if jsonb_typeof(p->'columns') = 'array' and jsonb_array_length(p->'columns') > 0 then
    if jsonb_array_length(p->'columns') > 12 then raise exception 'invalid_size_chart_columns'; end if;
    for v_col in select e from jsonb_array_elements(p->'columns') e loop
      v_n := v_n + 1;
      if jsonb_typeof(v_col) <> 'object' then raise exception 'invalid_size_chart_columns'; end if;
      v_label := btrim(coalesce(v_col->>'label', ''));
      if char_length(v_label) not between 1 and 40 then raise exception 'invalid_size_chart_column_label'; end if;
      v_unit := nullif(btrim(coalesce(v_col->>'unit', '')), '');
      if v_unit is not null and char_length(v_unit) > 10 then raise exception 'invalid_size_chart_column_unit'; end if;
      v_key := nullif(btrim(coalesce(v_col->>'key', '')), '');
      if v_key is not null and v_key !~ '^[a-z][a-z0-9_]{0,31}$' then raise exception 'invalid_size_chart_column_key'; end if;
      if v_key is null then
        v_key := 'c' || v_n;
        while v_key = any(v_seen) loop v_n := v_n + 1; v_key := 'c' || v_n; end loop;
      end if;
      if v_key = any(v_seen) then raise exception 'invalid_size_chart_column_key'; end if;
      v_seen := v_seen || v_key;
      v_cols := v_cols || jsonb_build_array(jsonb_build_object('key', v_key, 'label', v_label, 'unit', v_unit));
    end loop;
  elsif p ? 'columns' and jsonb_typeof(p->'columns') not in ('null', 'array') then
    raise exception 'invalid_size_chart_columns';
  end if;

  -- 行（列の key は鍵の形だけ確かめる。どの列に当たるかは表示するときの列で決まる）
  if jsonb_typeof(p->'rows') = 'array' and jsonb_array_length(p->'rows') > 0 then
    if jsonb_array_length(p->'rows') > 60 then raise exception 'invalid_size_chart_rows'; end if;
    for v_row in select e from jsonb_array_elements(p->'rows') e loop
      if jsonb_typeof(v_row) <> 'object' then raise exception 'invalid_size_chart_rows'; end if;
      v_value := btrim(coalesce(v_row->>'value', ''));
      if char_length(v_value) not between 1 and 40 then raise exception 'invalid_size_chart_row_value'; end if;
      if lower(v_value) = any(v_values) then raise exception 'invalid_size_chart_row_value'; end if;
      v_values := v_values || lower(v_value);
      if v_row ? 'cells' and jsonb_typeof(v_row->'cells') not in ('object', 'null') then raise exception 'invalid_size_chart_cells'; end if;
      v_cells := '{}'::jsonb;
      for v_cell in select key, value from jsonb_each(coalesce(nullif(v_row->'cells', 'null'::jsonb), '{}'::jsonb)) loop
        if v_cell.key !~ '^[a-z][a-z0-9_]{0,31}$' then raise exception 'invalid_size_chart_cells'; end if;
        if jsonb_typeof(v_cell.value) = 'null' then continue; end if;
        if jsonb_typeof(v_cell.value) not in ('string', 'number') then raise exception 'invalid_size_chart_cells'; end if;
        v_label := btrim(v_cell.value #>> '{}');
        if char_length(v_label) > 40 then raise exception 'invalid_size_chart_cells'; end if;
        if v_label <> '' then v_cells := v_cells || jsonb_build_object(v_cell.key, v_label); end if;
      end loop;
      if (select count(*) from jsonb_object_keys(v_cells)) > 12 then raise exception 'invalid_size_chart_cells'; end if;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('value', v_value, 'cells', v_cells));
    end loop;
  elsif p ? 'rows' and jsonb_typeof(p->'rows') not in ('null', 'array') then
    raise exception 'invalid_size_chart_rows';
  end if;

  if p ? 'note' and jsonb_typeof(p->'note') not in ('string', 'null') then raise exception 'invalid_size_chart_note'; end if;
  v_note := nullif(btrim(coalesce(p->>'note', '')), '');
  if v_note is not null and char_length(v_note) > 2000 then raise exception 'invalid_size_chart_note'; end if;

  if jsonb_typeof(p->'image') = 'object' then
    if coalesce(p->'image'->>'key', '') !~ ('^size-charts/' || p_shop_id::text || '/[A-Za-z0-9._-]{1,100}$')
       or jsonb_typeof(p->'image'->'width') <> 'number' or jsonb_typeof(p->'image'->'height') <> 'number'
       or (p->'image'->>'width')::numeric not between 1 and 4096 or (p->'image'->>'height')::numeric not between 1 and 4096 then
      raise exception 'invalid_size_chart_image';
    end if;
    v_image := jsonb_build_object('key', p->'image'->>'key', 'width', (p->'image'->>'width')::numeric::int, 'height', (p->'image'->>'height')::numeric::int);
  elsif p ? 'image' and jsonb_typeof(p->'image') <> 'null' then
    raise exception 'invalid_size_chart_image';
  end if;

  return jsonb_build_object(
    'hidden', coalesce((p->>'hidden')::boolean, false),
    'axis', v_axis,
    'columns', case when jsonb_array_length(v_cols) > 0 then v_cols end,
    'rows', case when jsonb_array_length(v_rows) > 0 then v_rows end,
    'note', v_note,
    'image', v_image);
end;
$$;
revoke execute on function banto_size_chart_normalize(uuid, jsonb) from public, anon, authenticated;

-- 1 つの段の行 → JSON（管理画面・AI 用 API）
create or replace function banto_size_chart_json(r size_charts)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'level', case when r.product_id is not null then 'product' when r.category_id is not null then 'category' else 'shop' end,
    'category_id', r.category_id, 'product_id', r.product_id, 'hidden', r.hidden, 'axis', r.axis,
    'columns', r.columns, 'rows', r.rows, 'note', r.note,
    'image', case when r.image_key is not null then jsonb_build_object('key', r.image_key, 'width', r.image_width, 'height', r.image_height) end,
    'updated_at', r.updated_at);
$$;
revoke execute on function banto_size_chart_json(size_charts) from public, anon, authenticated;

-- ---------- 近い段から決める（表示するときだけ。どこにも写さない） ----------
-- 商品（p_product_id）→ 主カテゴリー（p_category_id から親へ）→ ショップ。商品を渡さなければカテゴリーから、どちらも無ければショップだけ。
-- 結果: { axis, axis_name, columns, rows, note, image, sources: { columns, rows } } か null（表が無い・商品の段で hidden）
create or replace function banto_size_chart_resolve(p_shop_id uuid, p_category_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_levels size_charts[] := '{}';
  v_kinds text[] := '{}';
  v_row size_charts;
  v_cur uuid := p_category_id;
  v_depth integer := 0;
  v_c integer;
  v_r integer;
  v_t integer;
  i integer;
begin
  if p_product_id is not null then
    select * into v_row from size_charts where product_id = p_product_id and shop_id = p_shop_id;
    if found then
      if v_row.hidden then return null; end if;
      v_levels := v_levels || v_row; v_kinds := v_kinds || 'product'::text;
    end if;
  end if;
  while v_cur is not null and v_depth < 4 loop
    v_depth := v_depth + 1;
    select * into v_row from size_charts where category_id = v_cur and shop_id = p_shop_id;
    if found then v_levels := v_levels || v_row; v_kinds := v_kinds || 'category'::text; end if;
    select parent_id into v_cur from categories where id = v_cur and shop_id = p_shop_id;
  end loop;
  select * into v_row from size_charts where shop_id = p_shop_id and category_id is null and product_id is null;
  if found then v_levels := v_levels || v_row; v_kinds := v_kinds || 'shop'::text; end if;

  for i in 1 .. coalesce(array_length(v_levels, 1), 0) loop
    if v_c is null and v_levels[i].columns is not null then v_c := i; end if;
  end loop;
  if v_c is null then return null; end if;
  for i in 1 .. v_c loop
    if v_r is null and v_levels[i].rows is not null then v_r := i; end if;
    if v_t is null and v_levels[i].note is not null then v_t := i; end if;
  end loop;

  return jsonb_build_object(
    'axis', v_levels[v_c].axis,
    'axis_name', (select coalesce(s.option_names->>v_levels[v_c].axis, v_levels[v_c].axis) from shops s where s.id = p_shop_id),
    'columns', v_levels[v_c].columns,
    'rows', coalesce(v_levels[v_r].rows, '[]'::jsonb),
    'note', v_levels[v_t].note,
    'image', case when v_levels[v_c].image_key is not null
                  then jsonb_build_object('key', v_levels[v_c].image_key, 'width', v_levels[v_c].image_width, 'height', v_levels[v_c].image_height) end,
    'sources', jsonb_build_object('columns', v_kinds[v_c], 'rows', v_kinds[v_r]));
end;
$$;
revoke execute on function banto_size_chart_resolve(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------- 書き込み（1 つの段を置き換える。中身が空なら行を消す） ----------
create or replace function banto_size_chart_write(p_shop_id uuid, p_category_id uuid, p_product_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb; v_row size_charts; v_old_image text;
begin
  if p_category_id is not null and p_product_id is not null then raise exception 'invalid_size_chart_level'; end if;
  if p_category_id is not null and not exists (select 1 from categories where id = p_category_id and shop_id = p_shop_id) then raise exception 'not_found'; end if;
  if p_product_id is not null and not exists (select 1 from products where id = p_product_id and shop_id = p_shop_id) then raise exception 'not_found'; end if;
  v := banto_size_chart_normalize(p_shop_id, p_data);
  if p_product_id is null and (v->'hidden')::boolean then raise exception 'invalid_size_chart_hidden'; end if;
  select image_key into v_old_image from size_charts
   where shop_id = p_shop_id and category_id is not distinct from p_category_id and product_id is not distinct from p_product_id;
  if not (v->'hidden')::boolean and v->'axis' = 'null'::jsonb and v->'columns' = 'null'::jsonb and v->'rows' = 'null'::jsonb
     and v->'note' = 'null'::jsonb and v->'image' = 'null'::jsonb then
    delete from size_charts where shop_id = p_shop_id and category_id is not distinct from p_category_id and product_id is not distinct from p_product_id;
    return jsonb_build_object('deleted', true, 'old_image_key', v_old_image);
  end if;
  update size_charts set hidden = (v->>'hidden')::boolean, axis = v->>'axis', columns = nullif(v->'columns', 'null'::jsonb),
         rows = nullif(v->'rows', 'null'::jsonb), note = v->>'note', image_key = v->'image'->>'key',
         image_width = (v->'image'->>'width')::int, image_height = (v->'image'->>'height')::int, updated_at = now()
   where shop_id = p_shop_id and category_id is not distinct from p_category_id and product_id is not distinct from p_product_id
  returning * into v_row;
  if not found then
    insert into size_charts (shop_id, category_id, product_id, hidden, axis, columns, rows, note, image_key, image_width, image_height)
    values (p_shop_id, p_category_id, p_product_id, (v->>'hidden')::boolean, v->>'axis', nullif(v->'columns', 'null'::jsonb),
            nullif(v->'rows', 'null'::jsonb), v->>'note', v->'image'->>'key', (v->'image'->>'width')::int, (v->'image'->>'height')::int)
    returning * into v_row;
  end if;
  return banto_size_chart_json(v_row) || jsonb_build_object('old_image_key', case when v_old_image is distinct from v_row.image_key then v_old_image end);
end;
$$;
revoke execute on function banto_size_chart_write(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- 管理画面（項目 catalog）。戻り値の old_image_key は置き換えで使わなくなった図（Worker が置き場から消す）
create or replace function size_chart_set(p_shop_id uuid, p_category_id uuid, p_product_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  return banto_size_chart_write(p_shop_id, p_category_id, p_product_id, p_data);
end;
$$;
revoke execute on function size_chart_set(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function size_chart_set(uuid, uuid, uuid, jsonb) to authenticated;

-- 管理画面: その段の行と、表示される結果（上の段を含めて決めたもの）
create or replace function size_chart_get(p_shop_id uuid, p_category_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_row size_charts; v_cat uuid := p_category_id;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_product_id is not null then select category_id into v_cat from products where id = p_product_id and shop_id = p_shop_id; end if;
  select * into v_row from size_charts
   where shop_id = p_shop_id and category_id is not distinct from (case when p_product_id is null then p_category_id end)
     and product_id is not distinct from p_product_id;
  return jsonb_build_object(
    'own', case when v_row.id is not null then banto_size_chart_json(v_row) end,
    'effective', banto_size_chart_resolve(p_shop_id, v_cat, p_product_id),
    'inherited', case when p_product_id is not null then banto_size_chart_resolve(p_shop_id, v_cat, null)
                      when p_category_id is not null then banto_size_chart_resolve(p_shop_id, (select parent_id from categories where id = p_category_id and shop_id = p_shop_id), null) end);
end;
$$;
revoke execute on function size_chart_get(uuid, uuid, uuid) from public, anon;
grant execute on function size_chart_get(uuid, uuid, uuid) to authenticated;

-- ---------- AI 用 API（products:read / products:write。モジュールが OFF でも置ける。表示はモジュールの ON/OFF） ----------
create or replace function api_size_chart_get(p_token_hash text, p_category_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_row size_charts; v_cat uuid := p_category_id;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  if p_category_id is not null and p_product_id is not null then raise exception 'invalid_size_chart_level'; end if;
  if p_product_id is not null then
    select category_id into v_cat from products where id = p_product_id and shop_id = v_tok.shop_id;
    if not found then raise exception 'not_found'; end if;
  elsif p_category_id is not null and not exists (select 1 from categories where id = p_category_id and shop_id = v_tok.shop_id) then
    raise exception 'not_found';
  end if;
  select * into v_row from size_charts
   where shop_id = v_tok.shop_id and category_id is not distinct from p_category_id and product_id is not distinct from p_product_id;
  return jsonb_build_object(
    'own', case when v_row.id is not null then banto_size_chart_json(v_row) end,
    'effective', banto_size_chart_resolve(v_tok.shop_id, v_cat, p_product_id));
end;
$$;
revoke execute on function api_size_chart_get(text, uuid, uuid) from public, anon, authenticated;
grant execute on function api_size_chart_get(text, uuid, uuid) to service_role;

-- 図（image）は API では変えない（入れても今の図のまま）。図は管理画面のブラウザで縮小して置く
create or replace function api_size_chart_set(p_token_hash text, p_category_id uuid, p_product_id uuid, p_data jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_row size_charts; v_data jsonb;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'invalid_size_chart'; end if;
  select * into v_row from size_charts
   where shop_id = v_tok.shop_id and category_id is not distinct from p_category_id and product_id is not distinct from p_product_id;
  v_data := (p_data - 'image') || jsonb_build_object('image',
    case when v_row.image_key is not null then jsonb_build_object('key', v_row.image_key, 'width', v_row.image_width, 'height', v_row.image_height) end);
  return banto_size_chart_write(v_tok.shop_id, p_category_id, p_product_id, v_data) - 'old_image_key';
end;
$$;
revoke execute on function api_size_chart_set(text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_size_chart_set(text, uuid, uuid, jsonb) to service_role;

-- ---------- お客様の画面: 商品と一緒に返す（モジュールが ON のときだけ）。ほかは 0084 と同じ ----------
create or replace function product_public_get(p_shop_id uuid, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(p) - 'attributes'
         || jsonb_build_object('attributes', banto_public_product_attributes(s.settings, p.attributes), 'app_data', banto_public_app_data(p.id),
                               'size_chart', case when s.settings->'modules'->'size_charts' = 'true'::jsonb
                                                  then banto_size_chart_resolve(p.shop_id, p.category_id, p.id) end)
    from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
   limit 1;
$$;
revoke execute on function product_public_get(uuid, text) from public;
grant execute on function product_public_get(uuid, text) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0095_mod_size_charts');
