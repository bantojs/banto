-- 0153_product_option_stock: 商品の一覧の絞り込み（段 2）。SKU の選択肢（カラー・サイズなど）で、在庫のあるものに絞る（docs/storefront.md「URL」、メンテナの決定 2026-11-17）
--   - URL は Shopify と同じ形: ?filter.v.option.<key>=<値>（くり返すと同じ鍵はどれか。鍵どうしはすべて）。key は 0094 の英字の鍵
--   - 表 product_option_stock（商品 × 鍵 × 値。在庫のある SKU の選択肢だけ）。在庫が 0 をまたいだとき・SKU の選択肢が変わったときだけトリガーで
--     その商品の行を作り直す（在庫は頻繁に変わるので、それ以外では書かない）
--   - 鍵ごとに見る（「赤の S は品切れ・赤の M はある・青の S はある」商品は 赤 と S の両方に当てはまる。Shopify のテーマの絞り込みと同じ考え）
--   - 件数（product_public_facets の options）は絞る前の範囲（ショップ全体の公開の一覧で在庫のある商品の数）。今のタグ・カテゴリーの件数と同じ考え
--   - banto_product_list・product_public_list・product_member_list に p_options を足す（0150 の形を消して作り直す。名前で渡す今までの呼び方はそのまま）

create table if not exists product_option_stock (
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  key text not null,
  value text not null,
  primary key (product_id, key, value)
);
create index if not exists product_option_stock_shop on product_option_stock (shop_id, key, value);
alter table product_option_stock enable row level security;
drop policy if exists product_option_stock_catalog on product_option_stock;
create policy product_option_stock_catalog on product_option_stock for select using (banto_owns_shop(shop_id) or banto_shop_perm(shop_id, 'catalog'));
revoke all on product_option_stock from anon;
revoke insert, update, delete on product_option_stock from authenticated;

-- その商品の行を作り直す（在庫のある SKU の選択肢の値。文字と数だけ、100 文字まで）
create or replace function banto_product_option_stock_refresh(p_product_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_product_id is null then return; end if;
  delete from product_option_stock where product_id = p_product_id;
  insert into product_option_stock (shop_id, product_id, key, value)
  select distinct k.shop_id, k.product_id, e.key, left(btrim(e.value #>> '{}'), 100)
    from skus k
    join inventory i on i.sku_id = k.id and i.available > 0
    cross join lateral jsonb_each(case when jsonb_typeof(k.options) = 'object' then k.options else '{}'::jsonb end) e
   where k.product_id = p_product_id
     and jsonb_typeof(e.value) in ('string', 'number')
     and btrim(e.value #>> '{}') <> ''
  on conflict do nothing;
end;
$$;
revoke execute on function banto_product_option_stock_refresh(uuid) from public, anon, authenticated;

create or replace function banto_skus_option_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform banto_product_option_stock_refresh(old.product_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.product_id is distinct from old.product_id) then
    perform banto_product_option_stock_refresh(new.product_id);
  end if;
  return null;
end;
$$;
revoke execute on function banto_skus_option_stock() from public, anon, authenticated;
drop trigger if exists skus_option_stock on skus;
create trigger skus_option_stock after insert or update of options, product_id or delete on skus for each row execute function banto_skus_option_stock();

-- 在庫は 0 をまたいだときだけ
create or replace function banto_inventory_option_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (coalesce(old.available, 0) > 0) = (coalesce(new.available, 0) > 0) then return null; end if;
  perform banto_product_option_stock_refresh((select product_id from skus where id = new.sku_id));
  return null;
end;
$$;
revoke execute on function banto_inventory_option_stock() from public, anon, authenticated;
drop trigger if exists inventory_option_stock on inventory;
create trigger inventory_option_stock after update of available on inventory for each row execute function banto_inventory_option_stock();

-- 一覧の選択肢の条件を整える（{ "<key>": ["値", …] }、鍵は 3 つまで・値は 1 つの鍵に 10 まで、100 文字まで。空なら null）
create or replace function banto_list_options(p jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare v jsonb := '{}'::jsonb; e record; vals jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'invalid_options' using errcode = '22023'; end if;
  for e in select * from jsonb_each(p) loop
    if e.key !~ '^[a-z][a-z0-9_]{0,31}$' or jsonb_typeof(e.value) <> 'array' then raise exception 'invalid_options' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into vals
      from (select left(btrim(t), 100) as x from jsonb_array_elements_text(e.value) t) y where x <> '';
    if jsonb_array_length(vals) > 10 then raise exception 'invalid_options' using errcode = '22023'; end if;
    if jsonb_array_length(vals) > 0 then v := v || jsonb_build_object(e.key, vals); end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v)) > 3 then raise exception 'invalid_options' using errcode = '22023'; end if;
  return case when v = '{}'::jsonb then null else v end;
end;
$$;
revoke execute on function banto_list_options(jsonb) from public, anon, authenticated;

drop function if exists product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer);
drop function if exists product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer);
drop function if exists banto_product_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, uuid[], text[], integer, integer);

-- ---------- 一覧（0150 と同じ。選択肢の条件を足す） ----------
create or replace function banto_product_list(
  p_shop_id uuid,
  p_sort text default 'new',
  p_limit integer default 24,
  p_after jsonb default null,
  p_offset integer default 0,
  p_tag text default null,
  p_category_ids uuid[] default null,
  p_brand text default null,
  p_q text default null,
  p_updated_since timestamptz default null,
  p_count boolean default false,
  p_audiences uuid[] default '{}',
  p_tags text[] default null,
  p_price_min integer default null,
  p_price_max integer default null,
  p_options jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_offset_max integer;
  v_key text;    -- 並べ替えの値の式
  v_order text;  -- order by
  v_cmp text;    -- キーセットの比較（> か <）
  v_cast text;   -- p_after の k の型
  v_where text;
  v_like text;
  v_rows jsonb;
  v_total integer;
  v_last jsonb;
  v_next jsonb;
  v_settings jsonb;
  v_tags text[];
  v_options jsonb;
begin
  select settings into v_settings from shops where id = p_shop_id and published;
  if not found then
    return jsonb_build_object('items', '[]'::jsonb, 'next', null);
  end if;
  -- タグ（すべてを持つ商品。p_tag は 1 つだけの今までの呼び方）。空・重なりを除いて 5 つまで
  select coalesce(array_agg(distinct x), '{}') into v_tags
    from (select left(btrim(t), 50) as x from unnest(coalesce(p_tags, '{}') || case when p_tag is null then '{}'::text[] else array[p_tag] end) t) y
   where x <> '';
  if cardinality(v_tags) > 5 then raise exception 'too_many_tags' using errcode = '22023'; end if;
  -- 選択肢（{ "<key>": ["値", …] }。同じ鍵はどれか、鍵どうしはすべて。在庫のある SKU の選択肢だけ、product_option_stock）
  v_options := banto_list_options(p_options);
  -- 価格（一覧の価格 = いちばん安い SKU の価格、税込の円）。価格の無い商品は、上下限のどちらかがあれば出さない
  if p_price_min < 0 or p_price_max < 0 then raise exception 'invalid_price_filter' using errcode = '22023'; end if;
  -- 検索の語があるときは 1,000 まで（深い位置まで読ませて DB を重くさせない。先は p_after で）
  v_offset_max := 10000;
  if nullif(btrim(coalesce(p_q, '')), '') is not null then v_offset_max := 1000; end if;
  if v_offset > v_offset_max then raise exception 'offset_too_large' using errcode = '22023'; end if;
  case coalesce(p_sort, 'new')
    when 'new' then v_key := 'coalesce(p.released_at, p.created_at)'; v_order := 'coalesce(p.released_at, p.created_at) desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'updated' then v_key := 'p.updated_at'; v_order := 'p.updated_at desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'price_asc' then v_key := 'coalesce(p.list_price_jpy, 2147483647)'; v_order := 'coalesce(p.list_price_jpy, 2147483647), p.id'; v_cmp := '>'; v_cast := 'integer';
    when 'price_desc' then v_key := 'coalesce(p.list_price_jpy, -1)'; v_order := 'coalesce(p.list_price_jpy, -1) desc, p.id desc'; v_cmp := '<'; v_cast := 'integer';
    when 'name' then v_key := 'p.name'; v_order := 'p.name, p.id'; v_cmp := '>'; v_cast := 'text';
    else raise exception 'invalid_sort' using errcode = '22023';
  end case;
  -- 2 文字以下の語は pg_trgm のインデックスが効かず全件を見るので、タグ・カテゴリー・ブランドで絞っているときだけ
  -- （ログイン無しで何度も送られて DB を重くされないように。人間の決定 2026-10-26）
  if p_q is not null and btrim(p_q) <> '' and char_length(btrim(p_q)) < 3
     and cardinality(v_tags) = 0 and v_options is null and p_category_ids is null and p_brand is null then
    raise exception 'q_too_short' using errcode = '22023';
  end if;
  if p_q is not null and btrim(p_q) <> '' then
    v_like := '%' || replace(replace(replace(lower(left(btrim(p_q), 100)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- 見せない商品（0098）は、見る人が合う会員の条件（p_audiences）のものだけ
  v_where := 'p.shop_id = $1 and p.published and (p.audience_id is null or p.audience_mode = ''buy'' or p.audience_id = any($8))'
    || case when cardinality(v_tags) > 0 then ' and p.tags @> $10' else '' end
    || case when p_category_ids is not null then ' and (p.category_id = any($3) or p.extra_category_ids && $3)' else '' end
    || case when p_brand is not null then ' and p.brand = $4' else '' end
    || case when v_like is not null then ' and banto_product_search_text(p.name, p.brand, p.tags, p.description) like $5' else '' end
    || case when p_updated_since is not null then ' and p.updated_at > $6' else '' end
    || case when p_price_min is not null then ' and p.list_price_jpy >= $11' else '' end
    || case when p_price_max is not null then ' and p.list_price_jpy <= $12' else '' end
    || case when v_options is not null then ' and not exists (select 1 from jsonb_each($13) f where not exists (select 1 from product_option_stock o where o.product_id = p.id and o.key = f.key and o.value in (select jsonb_array_elements_text(f.value))))' else '' end;

  if p_count then
    execute format('select count(*) from (select 1 from products p where %s limit 10001) x', v_where)
      into v_total using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}'), null::jsonb, v_tags, p_price_min, p_price_max, v_options;
  end if;

  execute format(
    'select coalesce(jsonb_agg(r order by ord), ''[]'') from ('
    || 'select row_number() over (order by %s) as ord, jsonb_build_object('
    || '''id'', p.id, ''slug'', p.slug, ''name'', p.name, ''brand'', p.brand, ''category_id'', p.category_id,'
    || '''extra_category_ids'', p.extra_category_ids, ''tags'', p.tags, ''created_at'', p.created_at, ''updated_at'', p.updated_at, ''released_at'', p.released_at,'
    || '''min_price_jpy'', p.list_price_jpy, ''compare_at_price_jpy'', p.list_compare_at_jpy, ''k'', %s,'
    || '''attributes'', banto_card_product_attributes($9, p.attributes),'
    || '''image'', (select jsonb_build_object(''storage_key'', i.storage_key, ''thumb_key'', i.thumb_key, ''width'', i.width, ''height'', i.height, ''variants'', i.variants, ''thumb_width'', i.thumb_width)'
    || '            from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1)'
    || ') as r from products p where %s %s order by %s limit %s offset %s) t',
    v_order, v_key, v_where,
    case when p_after is not null then format(' and (%s, p.id) %s (($7->>''k'')::%s, ($7->>''id'')::uuid)', v_key, v_cmp, v_cast) else '' end,
    v_order, v_limit + 1, case when p_after is not null then 0 else v_offset end)
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}'), v_settings, v_tags, p_price_min, p_price_max, v_options;

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    v_next := jsonb_build_object('k', v_last->'k', 'id', v_last->'id');
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e - 'k'), '[]') from jsonb_array_elements(v_rows) e), 'next', v_next)
      || case when p_count then jsonb_build_object('total', least(v_total, 10000), 'total_capped', v_total > 10000) else '{}'::jsonb end;
end;
$$;
revoke execute on function banto_product_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, uuid[], text[], integer, integer, jsonb) from public, anon, authenticated;

create or replace function product_public_list(
  p_shop_id uuid,
  p_sort text default 'new',
  p_limit integer default 24,
  p_after jsonb default null,
  p_offset integer default 0,
  p_tag text default null,
  p_category_ids uuid[] default null,
  p_brand text default null,
  p_q text default null,
  p_updated_since timestamptz default null,
  p_count boolean default false,
  p_tags text[] default null,
  p_price_min integer default null,
  p_price_max integer default null,
  p_options jsonb default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, '{}'::uuid[], p_tags, p_price_min, p_price_max, p_options);
$$;
revoke execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer, jsonb) from public;
grant execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer, jsonb) to anon, authenticated, service_role;

create or replace function product_member_list(
  p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid,
  p_sort text default 'new', p_limit integer default 24, p_after jsonb default null, p_offset integer default 0,
  p_tag text default null, p_category_ids uuid[] default null, p_brand text default null, p_q text default null,
  p_updated_since timestamptz default null, p_count boolean default false,
  p_tags text[] default null, p_price_min integer default null, p_price_max integer default null, p_options jsonb default null
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_list: service_role only' using errcode = '42501';
  end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  return banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, v_aud, p_tags, p_price_min, p_price_max, p_options);
end;
$$;
revoke execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer, jsonb) from public, anon, authenticated;
grant execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer, jsonb) to service_role;

-- ---------- 件数（0150 と同じ。options を足す: 鍵 × 値ごとの在庫のある公開の商品の数、多い順に 200 まで） ----------
create or replace function product_public_facets(p_shop_id uuid, p_tag_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not exists (select 1 from shops where id = p_shop_id and published)
              then jsonb_build_object('tags', '[]'::jsonb, 'categories', '{}'::jsonb, 'price_max', null, 'options', '[]'::jsonb)
         else jsonb_build_object(
           'tags', coalesce((select jsonb_agg(jsonb_build_object('tag', key, 'count', count) order by count desc, key collate "C")
                               from (select key, count from product_facets where shop_id = p_shop_id and kind = 'tag'
                                      order by count desc, key collate "C" limit least(greatest(coalesce(p_tag_limit, 200), 1), 1000)) t), '[]'::jsonb),
           'categories', coalesce((select jsonb_object_agg(key, count) from product_facets where shop_id = p_shop_id and kind = 'category'), '{}'::jsonb),
           'price_max', (select nullif(coalesce(p.list_price_jpy, -1), -1) from products p
                          where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
                          order by coalesce(p.list_price_jpy, -1) desc, p.id desc limit 1),
           'options', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'value', value, 'count', n) order by key, n desc, value collate "C")
                                  from (select o.key, o.value, count(*)::integer as n
                                          from product_option_stock o join products p on p.id = o.product_id
                                         where o.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
                                         group by o.key, o.value
                                         order by n desc, o.key, o.value collate "C" limit 200) x), '[]'::jsonb))
         end;
$$;
revoke execute on function product_public_facets(uuid, integer) from public;
grant execute on function product_public_facets(uuid, integer) to anon, authenticated, service_role;

-- 今の商品の表を作る
select banto_product_option_stock_refresh(id) from products;

insert into banto_migrations (version) values ('0153_product_option_stock');
