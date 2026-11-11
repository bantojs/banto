-- Banto 0136_inventory_ops: 在庫の画面（商品をまたいで全 SKU を 1 つの表に）のための関数（メンテナの決定 2026-11-08「在庫は差でも変えられる RPC を足す」、
-- docs/knowledge/02-decisions.md）。前方専用。在庫を変えるのは今までどおり RPC だけ（CLAUDE.md §1-7）。どれも項目 catalog。
--
-- stock_adjust（入荷・出荷）: 数を足す・引く（同じ SKU が 2 度あれば両方足す）。条件付きの更新 1 回（0 を下回らせない）で、画面を開いてから保存までに売れた分を上書きしない。
--   1 つでも足りなければ、どれも変えない（insufficient_stock:<品番>）。
-- stock_count（棚卸し）: 数を置き換える。画面を開いたときの数（expected）も受け取り、そのあいだに動いた SKU があれば、どれも変えずに
--   その SKU の今の数を返す（画面が知らせ、確かめてから送り直す）。
-- inventory_list: 在庫の表の 1 ページ（品番の順のキーセット）。キーワードは品番・JAN の完全一致か、商品名・品番の部分一致。stock = out で在庫切れだけ。

create or replace function stock_adjust(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku uuid;
  v_delta integer;
  v_after integer;
  v_out jsonb := '[]'::jsonb;
  v_code text;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items' using errcode = '22023'; end if;
  -- 形を先に全部確かめる（整数だけ・100 万まで）。行は SKU の id の順に押さえる（同時に動かしても互いを待ち合って止まらない）
  if exists (select 1 from jsonb_array_elements(p_items) e
              where coalesce(e->>'sku_id', '') !~ '^[0-9a-f-]{36}$' or jsonb_typeof(e->'delta') is distinct from 'number'
                 or (e->>'delta') !~ '^-?[0-9]{1,7}$' or abs((e->>'delta')::integer) > 1000000) then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku := (v_item->>'sku_id')::uuid;
    v_delta := (v_item->>'delta')::integer;
    if v_delta = 0 then continue; end if;
    update inventory set available = available + v_delta, updated_at = now()
     where sku_id = v_sku and shop_id = p_shop_id and available + v_delta >= 0
     returning available into v_after;
    if not found then
      select code into v_code from skus where id = v_sku and shop_id = p_shop_id;
      if v_code is null then raise exception 'sku_not_found' using errcode = 'P0002'; end if;
      raise exception 'insufficient_stock:%', v_code using errcode = 'P0001';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('sku_id', v_sku, 'available', v_after));
  end loop;
  return v_out;
end;
$$;
revoke execute on function stock_adjust(uuid, jsonb) from public, anon;
grant execute on function stock_adjust(uuid, jsonb) to authenticated;

create or replace function stock_count(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicts jsonb;
  v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where coalesce(e->>'sku_id', '') !~ '^[0-9a-f-]{36}$'
                 or jsonb_typeof(e->'expected') is distinct from 'number' or (e->>'expected') !~ '^-?[0-9]{1,9}$'
                 or jsonb_typeof(e->'available') is distinct from 'number' or (e->>'available') !~ '^[0-9]{1,9}$') then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  -- 同じ SKU を 2 度は受けない（どちらの数にするか決められない）
  if (select count(distinct e->>'sku_id') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  -- 対象の行を押さえてから、開いたときの数と比べる（比べている間に売れても、取り違えない）
  perform 1 from inventory i where i.shop_id = p_shop_id and i.sku_id in (select (e->>'sku_id')::uuid from jsonb_array_elements(p_items) e) order by i.sku_id for update;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where not exists (select 1 from inventory i where i.shop_id = p_shop_id and i.sku_id = (e->>'sku_id')::uuid)) then
    raise exception 'sku_not_found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku_id', i.sku_id, 'code', k.code, 'expected', (e->>'expected')::integer, 'current', i.available, 'available', (e->>'available')::integer) order by k.code), '[]'::jsonb)
    into v_conflicts
    from jsonb_array_elements(p_items) e
    join inventory i on i.shop_id = p_shop_id and i.sku_id = (e->>'sku_id')::uuid
    join skus k on k.id = i.sku_id
   where i.available <> (e->>'expected')::integer;
  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('ok', false, 'conflicts', v_conflicts);
  end if;
  update inventory i set available = (e->>'available')::integer, updated_at = now()
    from jsonb_array_elements(p_items) e
   where i.shop_id = p_shop_id and i.sku_id = (e->>'sku_id')::uuid and i.available <> (e->>'available')::integer;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'updated', v_n);
end;
$$;
revoke execute on function stock_count(uuid, jsonb) from public, anon;
grant execute on function stock_count(uuid, jsonb) to authenticated;

create or replace function inventory_list(p_shop_id uuid, p_q text, p_stock text, p_after_code text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := nullif(btrim(left(coalesce(p_q, ''), 100)), '');
  v_like text;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if v_q is not null then v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('sku_id', k.id, 'code', k.code, 'gtin', k.gtin, 'name', k.name, 'options', k.options,
                                        'product_id', p.id, 'product_name', p.name, 'available', i.available) order by k.code)
      from (select k.* from skus k
              join products p on p.id = k.product_id
              join inventory i on i.sku_id = k.id
             where k.shop_id = p_shop_id
               and (v_q is null or k.code = v_q or k.gtin = v_q or p.name ilike v_like or k.code ilike v_like)
               and (p_stock is distinct from 'out' or i.available = 0)
               and (p_after_code is null or k.code > p_after_code)
             order by k.code
             limit least(greatest(coalesce(p_limit, 100), 1), 500)) k
      join products p on p.id = k.product_id
      join inventory i on i.sku_id = k.id), '[]'::jsonb);
end;
$$;
revoke execute on function inventory_list(uuid, text, text, text, integer) from public, anon;
grant execute on function inventory_list(uuid, text, text, text, integer) to authenticated;

insert into banto_migrations (version) values ('0136_inventory_ops');
