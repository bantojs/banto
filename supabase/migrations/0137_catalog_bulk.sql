-- Banto 0137_catalog_bulk: 商品のまとめて編集（表計算のように、選んだ商品と SKU のマスを直して 1 回で保存）のための関数
-- （メンテナの決定 2026-11-08「一括編集の保存はまとめて 1 回・誤りが 1 つでもあれば何も変えない RPC」、docs/knowledge/02-decisions.md）。前方専用。
--
-- catalog_bulk_update(p_shop_id, p_changes): 変えたマスだけを受け取る。1 つのマス = { kind: product | sku, id, col, from, to }。
--   - from は画面を開いたときの値（文字。空は null）。今の値と違うマスがあれば、そのマスは changed（そのあいだにだれかが直した）
--   - 形・範囲・指す先（カテゴリーはこのショップのもの）を先に全部確かめ、誤りのあるマスを並べて返す（どれも変えない）
--   - 誤りが無ければ、行ごとに 1 回の更新で全部を書く（価格と通常価格を同時に変えても、途中で制約に掛からない）
--   - 在庫は扱わない（在庫の画面の stock_adjust / stock_count。数を置き換えると、開いてから売れた分を上書きするため）
-- security definer（在庫の画面の 0136 と同じ）: 項目 catalog を確かめ、読み書きはどれも shop_id で絞る。形は表の制約・トリガーも守る。
--
-- 列: 商品 name（1〜200 字）・published（true / false）・category_id（このショップのカテゴリー、空で外す）・tags（カンマ区切り、banto_normalize_tags）・
--     brand（1〜100 字、空で外す）・tax_class（standard / reduced / exempt）
--     SKU  price_jpy（0〜1 億の整数）・compare_at_price_jpy（空か、価格より大きい整数）・gtin（空か 8・12・13・14 桁）

-- 列の今の値を、画面と同じ文字の形で（比べるため）
create or replace function banto_bulk_text(p_kind text, p_col text, p_product products, p_sku skus)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_kind = 'product' then case p_col
      when 'name' then p_product.name
      when 'published' then p_product.published::text
      when 'category_id' then p_product.category_id::text
      when 'tags' then nullif(array_to_string(p_product.tags, ', '), '')
      when 'brand' then p_product.brand
      when 'tax_class' then p_product.tax_class
    end
    else case p_col
      when 'price_jpy' then p_sku.price_jpy::text
      when 'compare_at_price_jpy' then p_sku.compare_at_price_jpy::text
      when 'gtin' then p_sku.gtin
    end
  end;
$$;
revoke execute on function banto_bulk_text(text, text, products, skus) from public, anon, authenticated;

create or replace function catalog_bulk_update(p_shop_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c jsonb;
  v_kind text;
  v_col text;
  v_id uuid;
  v_to text;
  v_from text;
  v_p products;
  v_s skus;
  v_errors jsonb := '[]'::jsonb;
  v_rows jsonb := '{}'::jsonb;   -- "<kind>:<id>" → { col: to }
  v_key text;
  v_vals jsonb;
  v_price integer;
  v_compare integer;
  v_np integer := 0;
  v_ns integer := 0;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) > 3000 then raise exception 'invalid_changes' using errcode = '22023'; end if;

  -- 対象の行を id の順に押さえる（比べている間にほかの保存が割り込まない）
  perform 1 from products p where p.shop_id = p_shop_id
     and p.id in (select (e->>'id')::uuid from jsonb_array_elements(p_changes) e where e->>'kind' = 'product' and e->>'id' ~ '^[0-9a-f-]{36}$')
   order by p.id for update;
  perform 1 from skus k where k.shop_id = p_shop_id
     and k.id in (select (e->>'id')::uuid from jsonb_array_elements(p_changes) e where e->>'kind' = 'sku' and e->>'id' ~ '^[0-9a-f-]{36}$')
   order by k.id for update;

  for v_c in select e from jsonb_array_elements(p_changes) e loop
    v_kind := v_c->>'kind';
    v_col := coalesce(v_c->>'col', '');
    if coalesce(v_kind, '') not in ('product', 'sku') or coalesce(v_c->>'id', '') !~ '^[0-9a-f-]{36}$'
       or (v_kind = 'product' and v_col not in ('name', 'published', 'category_id', 'tags', 'brand', 'tax_class'))
       or (v_kind = 'sku' and v_col not in ('price_jpy', 'compare_at_price_jpy', 'gtin'))
       or coalesce(jsonb_typeof(v_c->'to'), '') not in ('string', 'null') or coalesce(jsonb_typeof(v_c->'from'), '') not in ('string', 'null') then
      raise exception 'invalid_changes' using errcode = '22023';
    end if;
    v_id := (v_c->>'id')::uuid;
    v_to := nullif(btrim(v_c->>'to'), '');
    v_from := nullif(btrim(v_c->>'from'), '');
    v_key := v_kind || ':' || v_id;
    v_p := null;
    v_s := null;
    if v_kind = 'product' then
      select * into v_p from products where id = v_id and shop_id = p_shop_id;
      if v_p.id is null then v_errors := v_errors || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'col', v_col, 'error', 'not_found')); continue; end if;
    else
      select * into v_s from skus where id = v_id and shop_id = p_shop_id;
      if v_s.id is null then v_errors := v_errors || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'col', v_col, 'error', 'not_found')); continue; end if;
    end if;
    -- 今の値も同じ形（前後の空白を落とし、空は null）にそろえて比べる（API で前後に空白のある名前で作った商品も、いつまでも changed にしない）
    if nullif(btrim(banto_bulk_text(v_kind, v_col, v_p, v_s)), '') is distinct from v_from then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'col', v_col, 'error', 'changed', 'current', banto_bulk_text(v_kind, v_col, v_p, v_s)));
      continue;
    end if;
    -- 形と範囲
    if not coalesce(case v_col
        when 'name' then v_to is not null and char_length(v_to) <= 200
        when 'published' then v_to in ('true', 'false')
        when 'category_id' then v_to is null or (v_to ~ '^[0-9a-f-]{36}$' and exists (select 1 from categories c where c.id = v_to::uuid and c.shop_id = p_shop_id))
        when 'tags' then true
        when 'brand' then v_to is null or char_length(v_to) <= 100
        when 'tax_class' then v_to in ('standard', 'reduced', 'exempt')
        when 'price_jpy' then v_to ~ '^[0-9]{1,9}$' and v_to::integer <= 100000000
        when 'compare_at_price_jpy' then v_to is null or (v_to ~ '^[0-9]{1,9}$' and v_to::integer <= 100000000)
        when 'gtin' then v_to is null or v_to ~ '^([0-9]{8}|[0-9]{12,14})$'
      end, false) then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'col', v_col, 'error', 'invalid'));
      continue;
    end if;
    v_rows := jsonb_set(v_rows, array[v_key], coalesce(v_rows->v_key, '{}'::jsonb) || jsonb_build_object(v_col, v_to));
  end loop;

  -- 通常価格は、保存したあとの価格より大きいこと（片方だけ変えても、両方変えても）
  for v_key, v_vals in select * from jsonb_each(v_rows) where key like 'sku:%' loop
    select * into v_s from skus where id = substr(v_key, 5)::uuid;
    v_price := case when v_vals ? 'price_jpy' then (v_vals->>'price_jpy')::integer else v_s.price_jpy end;
    v_compare := case when v_vals ? 'compare_at_price_jpy' then (v_vals->>'compare_at_price_jpy')::integer else v_s.compare_at_price_jpy end;
    if v_compare is not null and v_compare <= v_price then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('kind', 'sku', 'id', v_s.id, 'col', case when v_vals ? 'compare_at_price_jpy' then 'compare_at_price_jpy' else 'price_jpy' end, 'error', 'compare_at_low'));
    end if;
  end loop;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors);
  end if;

  for v_key, v_vals in select * from jsonb_each(v_rows) order by key loop
    if v_key like 'product:%' then
      update products set
        name = case when v_vals ? 'name' then v_vals->>'name' else name end,
        published = case when v_vals ? 'published' then (v_vals->>'published')::boolean else published end,
        category_id = case when v_vals ? 'category_id' then (v_vals->>'category_id')::uuid else category_id end,
        tags = case when v_vals ? 'tags' then banto_normalize_tags(coalesce(to_jsonb(regexp_split_to_array(v_vals->>'tags', '\s*,\s*')), '[]'::jsonb)) else tags end,
        brand = case when v_vals ? 'brand' then v_vals->>'brand' else brand end,
        tax_class = case when v_vals ? 'tax_class' then v_vals->>'tax_class' else tax_class end,
        updated_at = now()
       where id = substr(v_key, 9)::uuid and shop_id = p_shop_id;
      v_np := v_np + 1;
    else
      update skus set
        price_jpy = case when v_vals ? 'price_jpy' then (v_vals->>'price_jpy')::integer else price_jpy end,
        compare_at_price_jpy = case when v_vals ? 'compare_at_price_jpy' then (v_vals->>'compare_at_price_jpy')::integer else compare_at_price_jpy end,
        gtin = case when v_vals ? 'gtin' then v_vals->>'gtin' else gtin end
       where id = substr(v_key, 5)::uuid and shop_id = p_shop_id;
      v_ns := v_ns + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'products', v_np, 'skus', v_ns);
end;
$$;
revoke execute on function catalog_bulk_update(uuid, jsonb) from public, anon;
grant execute on function catalog_bulk_update(uuid, jsonb) to authenticated;

insert into banto_migrations (version) values ('0137_catalog_bulk');
