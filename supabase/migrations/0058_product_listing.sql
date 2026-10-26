-- Banto 0058_product_listing: 商品の一覧を DB で絞り込み・並べ替え・ページ送りする（10 万〜100 万件。人間の決定 2026-10-26）。前方専用。
-- それまでのお店の画面と公開 API は、公開中の商品を全件読んで Worker のメモリで絞り込んでいた（PostgREST の 1,000 行で黙って欠け、
-- 件数が増えると CPU 10ms とメモリに収まらない）。docs/knowledge/02-decisions.md「商品の一覧を DB に寄せる」。
--   1. products.list_price_jpy / list_compare_at_jpy: いちばん安い SKU の価格と、その SKU の通常価格（並べ替えのため。在庫は写さない）。
--      SKU の文単位のトリガーで保つ。値が変わると商品の updated_at も進む（updated_since での同期に価格の変更が載る）。
--   2. product_facets: 公開中の商品のタグごと・カテゴリーごと（子孫を含み、1 商品は 1 回）の件数。文単位のトリガーで差分を足す。
--      カテゴリーの木が変わったら（親の付け替え・削除）そのショップのカテゴリーの件数を作り直す。
--   3. 検索: pg_trgm の GIN（式インデックス。名前・ブランド・タグ・説明の先頭 300 文字）。2 文字以下の語はインデックスが効かない。
--   4. 並べ替えごとの部分インデックス（公開中だけ）と、キーセットのページ送り（offset は 10,000 まで）。
--   5. product_public_list / product_public_facets（anon）。公開中のショップの公開中の商品だけ。attributes は返さない。

-- ---------- pg_trgm ----------
-- Supabase は拡張を extensions スキーマに置く。素の PostgreSQL ではスキーマを作ってそこに入れる。
-- 既に別のスキーマに入っていればそれを使う（演算子クラスの場所は下で引く）
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------- 1. いちばん安い SKU の価格 ----------
alter table products
  add column list_price_jpy integer,
  add column list_compare_at_jpy integer;

-- p_ids の商品の list_* を SKU から引き直す（変わった行だけ書く）
create or replace function banto_product_list_price_refresh(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update products p
     set list_price_jpy = m.price, list_compare_at_jpy = m.compare_at
    from (select x.id,
                 (select k.price_jpy from skus k where k.product_id = x.id order by k.price_jpy, k.created_at, k.id limit 1) as price,
                 (select k.compare_at_price_jpy from skus k where k.product_id = x.id order by k.price_jpy, k.created_at, k.id limit 1) as compare_at
            from unnest(p_ids) x(id)) m
   where p.id = m.id
     and (p.list_price_jpy is distinct from m.price or p.list_compare_at_jpy is distinct from m.compare_at);
$$;

create or replace function banto_skus_list_price_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_list_price_refresh(array(select distinct product_id from new_rows));
  return null;
end;
$$;
create or replace function banto_skus_list_price_upd()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_list_price_refresh(array(
    select distinct x from (select n.product_id as a, o.product_id as b from new_rows n join old_rows o on o.id = n.id
                             where n.price_jpy is distinct from o.price_jpy or n.compare_at_price_jpy is distinct from o.compare_at_price_jpy
                                or n.product_id is distinct from o.product_id) c,
                       lateral unnest(array[c.a, c.b]) x));
  return null;
end;
$$;
create or replace function banto_skus_list_price_del()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_list_price_refresh(array(select distinct product_id from old_rows));
  return null;
end;
$$;
create trigger skus_list_price_ins after insert on skus referencing new table as new_rows
  for each statement execute function banto_skus_list_price_ins();
create trigger skus_list_price_upd after update on skus referencing old table as old_rows new table as new_rows
  for each statement execute function banto_skus_list_price_upd();
create trigger skus_list_price_del after delete on skus referencing old table as old_rows
  for each statement execute function banto_skus_list_price_del();

-- ---------- 2. タグ・カテゴリーごとの件数 ----------
create table product_facets (
  shop_id uuid not null references shops(id) on delete cascade,
  kind text not null check (kind in ('tag', 'category')),
  key text not null,
  count integer not null,
  primary key (shop_id, kind, key)
);
alter table product_facets enable row level security;
-- 運営者は読めるだけ（書くのはトリガーだけ）。お客様の画面は product_public_facets で読む
create policy product_facets_catalog on product_facets for select using (banto_owns_shop(shop_id) or banto_shop_perm(shop_id, 'catalog'));
revoke insert, update, delete on product_facets from anon, authenticated;

-- 商品の行（id, shop_id, tags, category_id, extra_category_ids を持つ jsonb の配列）が数える先。
-- タグは重複を除き、カテゴリーは主・追加のそれぞれの祖先まで広げて重複を除く（1 商品はカテゴリーごとに 1 回）
create or replace function banto_product_facet_keys(p_rows jsonb)
returns table (shop_id uuid, kind text, key text)
language sql
stable
security definer
set search_path = public
as $$
  with recursive r as (
    select (e->>'id')::uuid as id, (e->>'shop_id')::uuid as shop_id,
           case when jsonb_typeof(e->'tags') = 'array' then e->'tags' else '[]'::jsonb end as tags,
           array_remove(array[(e->>'category_id')::uuid]
                        || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(e->'extra_category_ids') = 'array' then e->'extra_category_ids' else '[]'::jsonb end)::uuid), '{}'), null) as cats
      from jsonb_array_elements(p_rows) e
  ),
  anc(id, anc) as (
    select c.id, c.id from categories c where c.shop_id in (select distinct r.shop_id from r)
    union all
    select a.id, c.parent_id from anc a join categories c on c.id = a.anc where c.parent_id is not null
  )
  select r.shop_id, 'tag', t.value from r, lateral (select distinct value from jsonb_array_elements_text(r.tags) where value is not null) t
  union all
  select r.shop_id, 'category', x.anc::text
    from r, lateral (select distinct a.anc from unnest(r.cats) d(cid) join anc a on a.id = d.cid) x;
$$;

-- 差分を足す。増える分は upsert、減る分は update か（0 以下になるなら）delete だけ
-- （減る分で行を作らない: ショップの削除の連鎖の途中で、消えていくショップの行を作らないため）
create or replace function banto_product_facets_apply(p_old jsonb, p_new jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  with d as (
    select k.shop_id, k.kind, k.key, sum(k.d)::integer as d
      from (select f.*, -1 as d from banto_product_facet_keys(p_old) f
            union all
            select f.*, 1 from banto_product_facet_keys(p_new) f) k
     group by 1, 2, 3
    having sum(k.d) <> 0
  ),
  ins as (
    insert into product_facets (shop_id, kind, key, count)
    select d.shop_id, d.kind, d.key, d.d from d where d.d > 0
    on conflict (shop_id, kind, key) do update set count = product_facets.count + excluded.count
    returning 1
  ),
  upd as (
    update product_facets f set count = f.count + d.d
      from d
     where d.d < 0 and f.shop_id = d.shop_id and f.kind = d.kind and f.key = d.key and f.count + d.d > 0
    returning 1
  )
  delete from product_facets f using d
   where d.d < 0 and f.shop_id = d.shop_id and f.kind = d.kind and f.key = d.key and f.count + d.d <= 0;
$$;

-- 公開中の行だけを数える形に
create or replace function banto_product_facet_rows_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply('[]'::jsonb,
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from new_rows where published));
  return null;
end;
$$;
create or replace function banto_product_facet_rows_upd()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_new jsonb;
begin
  -- 数える材料（公開・タグ・カテゴリー）が変わった行だけ
  with c as (
    select o.id, o.shop_id, o.published as op, o.tags as ot, o.category_id as oc, o.extra_category_ids as oe,
           n.published as np, n.tags as nt, n.category_id as nc, n.extra_category_ids as ne, n.shop_id as ns
      from old_rows o join new_rows n on n.id = o.id
     where o.published is distinct from n.published or o.tags is distinct from n.tags
        or o.category_id is distinct from n.category_id or o.extra_category_ids is distinct from n.extra_category_ids
        or o.shop_id is distinct from n.shop_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', ot, 'category_id', oc, 'extra_category_ids', oe)) filter (where op), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', ns, 'tags', nt, 'category_id', nc, 'extra_category_ids', ne)) filter (where np), '[]')
    into v_old, v_new
    from c;
  if v_old <> '[]'::jsonb or v_new <> '[]'::jsonb then perform banto_product_facets_apply(v_old, v_new); end if;
  return null;
end;
$$;
create or replace function banto_product_facet_rows_del()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply(
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from old_rows where published),
    '[]'::jsonb);
  return null;
end;
$$;
create trigger products_facets_ins after insert on products referencing new table as new_rows
  for each statement execute function banto_product_facet_rows_ins();
create trigger products_facets_upd after update on products referencing old table as old_rows new table as new_rows
  for each statement execute function banto_product_facet_rows_upd();
create trigger products_facets_del after delete on products referencing old table as old_rows
  for each statement execute function banto_product_facet_rows_del();

-- ショップの件数を作り直す（p_kind が null なら両方）。カテゴリーの木が変わったときと、このマイグレーションの初期化に使う
create or replace function banto_product_facets_rebuild(p_shop_id uuid, p_kind text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from product_facets where shop_id = p_shop_id and (p_kind is null or kind = p_kind);
  if p_kind is null or p_kind = 'tag' then
    insert into product_facets (shop_id, kind, key, count)
    select p_shop_id, 'tag', t.value, count(distinct p.id)
      from products p, unnest(p.tags) t(value)
     where p.shop_id = p_shop_id and p.published and t.value is not null
     group by t.value;
  end if;
  if p_kind is null or p_kind = 'category' then
    insert into product_facets (shop_id, kind, key, count)
    with recursive anc(id, anc) as (
      select c.id, c.id from categories c where c.shop_id = p_shop_id
      union all
      select a.id, c.parent_id from anc a join categories c on c.id = a.anc where c.parent_id is not null
    )
    select p_shop_id, 'category', a.anc::text, count(distinct p.id)
      from products p
      cross join lateral unnest(array_remove(array[p.category_id] || p.extra_category_ids, null)) d(cid)
      join anc a on a.id = d.cid
     where p.shop_id = p_shop_id and p.published
     group by a.anc;
  end if;
end;
$$;

-- カテゴリーの親の付け替え・削除（追加カテゴリーから外す 0042 のトリガーの後に動く文単位のトリガー）
create or replace function banto_categories_facets_upd()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  for v_shop in select distinct n.shop_id from new_rows n join old_rows o on o.id = n.id where n.parent_id is distinct from o.parent_id loop
    perform banto_product_facets_rebuild(v_shop, 'category');
  end loop;
  return null;
end;
$$;
create or replace function banto_categories_facets_del()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  for v_shop in select distinct o.shop_id from old_rows o where exists (select 1 from shops s where s.id = o.shop_id) loop
    perform banto_product_facets_rebuild(v_shop, 'category');
  end loop;
  return null;
end;
$$;
create trigger categories_facets_upd after update on categories referencing old table as old_rows new table as new_rows
  for each statement execute function banto_categories_facets_upd();
create trigger categories_facets_del after delete on categories referencing old table as old_rows
  for each statement execute function banto_categories_facets_del();

-- ---------- 3. 検索 ----------
-- 小文字にした「名前 ブランド タグ 説明の先頭 300 文字」。式インデックスと product_public_list で同じ式を使う
create or replace function banto_product_search_text(p_name text, p_brand text, p_tags text[], p_description text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(coalesce(p_name, '') || ' ' || coalesce(p_brand, '') || ' ' || coalesce(array_to_string(p_tags, ' '), '') || ' ' || left(coalesce(p_description, ''), 300));
$$;

do $$
declare v_schema text;
begin
  select n.nspname into v_schema from pg_opclass o join pg_namespace n on n.oid = o.opcnamespace
   where o.opcname = 'gin_trgm_ops' limit 1;
  execute format('create index products_search_trgm on products using gin (banto_product_search_text(name, brand, tags, description) %I.gin_trgm_ops) where published', v_schema);
end;
$$;

-- ---------- 4. 並べ替えのインデックス（公開中だけ） ----------
create index products_list_new on products (shop_id, created_at desc, id desc) where published;
create index products_list_updated on products (shop_id, updated_at desc, id desc) where published;
create index products_list_price_asc on products (shop_id, (coalesce(list_price_jpy, 2147483647)), id) where published;
create index products_list_price_desc on products (shop_id, (coalesce(list_price_jpy, -1)) desc, id desc) where published;
create index products_list_name on products (shop_id, name, id) where published;
create index products_list_brand on products (shop_id, brand) where published and brand is not null;

-- ---------- 5. お客様の画面・公開 API ----------
-- p_sort: new | updated | price_asc | price_desc | name。p_after: 前のページの next（{"k": 並べ替えの値, "id": 商品 id}）。
-- p_after が無いときだけ p_offset（0〜10,000）。p_category_ids は子孫まで広げた id（null = 絞らない、空 = 0 件）。
-- p_count: total（10,000 まで数える。超えたら total_capped = true）。
-- 返す形: { items: [...], next: {k, id} | null, total?: number, total_capped?: boolean }
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
  p_count boolean default false
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
begin
  if not exists (select 1 from shops where id = p_shop_id and published) then
    return jsonb_build_object('items', '[]'::jsonb, 'next', null);
  end if;
  if v_offset > 10000 then raise exception 'offset_too_large' using errcode = '22023'; end if;
  case coalesce(p_sort, 'new')
    when 'new' then v_key := 'p.created_at'; v_order := 'p.created_at desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'updated' then v_key := 'p.updated_at'; v_order := 'p.updated_at desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'price_asc' then v_key := 'coalesce(p.list_price_jpy, 2147483647)'; v_order := 'coalesce(p.list_price_jpy, 2147483647), p.id'; v_cmp := '>'; v_cast := 'integer';
    when 'price_desc' then v_key := 'coalesce(p.list_price_jpy, -1)'; v_order := 'coalesce(p.list_price_jpy, -1) desc, p.id desc'; v_cmp := '<'; v_cast := 'integer';
    when 'name' then v_key := 'p.name'; v_order := 'p.name, p.id'; v_cmp := '>'; v_cast := 'text';
    else raise exception 'invalid_sort' using errcode = '22023';
  end case;
  if p_q is not null and btrim(p_q) <> '' then
    v_like := '%' || replace(replace(replace(lower(left(btrim(p_q), 100)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  v_where := 'p.shop_id = $1 and p.published'
    || case when p_tag is not null then ' and p.tags @> array[$2::text]' else '' end
    || case when p_category_ids is not null then ' and (p.category_id = any($3) or p.extra_category_ids && $3)' else '' end
    || case when p_brand is not null then ' and p.brand = $4' else '' end
    || case when v_like is not null then ' and banto_product_search_text(p.name, p.brand, p.tags, p.description) like $5' else '' end
    || case when p_updated_since is not null then ' and p.updated_at > $6' else '' end;

  if p_count then
    execute format('select count(*) from (select 1 from products p where %s limit 10001) x', v_where)
      into v_total using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since;
  end if;

  execute format(
    'select coalesce(jsonb_agg(r order by ord), ''[]'') from ('
    || 'select row_number() over (order by %s) as ord, jsonb_build_object('
    || '''id'', p.id, ''slug'', p.slug, ''name'', p.name, ''brand'', p.brand, ''category_id'', p.category_id,'
    || '''extra_category_ids'', p.extra_category_ids, ''tags'', p.tags, ''created_at'', p.created_at, ''updated_at'', p.updated_at,'
    || '''min_price_jpy'', p.list_price_jpy, ''compare_at_price_jpy'', p.list_compare_at_jpy, ''k'', %s,'
    || '''image'', (select jsonb_build_object(''storage_key'', i.storage_key, ''thumb_key'', i.thumb_key, ''width'', i.width, ''height'', i.height)'
    || '            from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1)'
    || ') as r from products p where %s %s order by %s limit %s offset %s) t',
    v_order, v_key, v_where,
    case when p_after is not null then format(' and (%s, p.id) %s (($7->>''k'')::%s, ($7->>''id'')::uuid)', v_key, v_cmp, v_cast) else '' end,
    v_order, v_limit + 1, case when p_after is not null then 0 else v_offset end)
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after;

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    v_next := jsonb_build_object('k', v_last->'k', 'id', v_last->'id');
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e - 'k'), '[]') from jsonb_array_elements(v_rows) e), 'next', v_next)
      || case when p_count then jsonb_build_object('total', least(v_total, 10000), 'total_capped', v_total > 10000) else '{}'::jsonb end;
end;
$$;

-- タグ（多い順に p_tag_limit 件まで、同数なら文字コード順）とカテゴリーごとの件数（{ category_id: 件数 }）
create or replace function product_public_facets(p_shop_id uuid, p_tag_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not exists (select 1 from shops where id = p_shop_id and published)
              then jsonb_build_object('tags', '[]'::jsonb, 'categories', '{}'::jsonb)
         else jsonb_build_object(
           'tags', coalesce((select jsonb_agg(jsonb_build_object('tag', key, 'count', count) order by count desc, key collate "C")
                               from (select key, count from product_facets where shop_id = p_shop_id and kind = 'tag'
                                      order by count desc, key collate "C" limit least(greatest(coalesce(p_tag_limit, 200), 1), 1000)) t), '[]'::jsonb),
           'categories', coalesce((select jsonb_object_agg(key, count) from product_facets where shop_id = p_shop_id and kind = 'category'), '{}'::jsonb))
         end;
$$;

revoke execute on function banto_product_list_price_refresh(uuid[]) from public, anon, authenticated;
revoke execute on function banto_skus_list_price_ins() from public, anon, authenticated;
revoke execute on function banto_skus_list_price_upd() from public, anon, authenticated;
revoke execute on function banto_skus_list_price_del() from public, anon, authenticated;
revoke execute on function banto_product_facet_keys(jsonb) from public, anon, authenticated;
revoke execute on function banto_product_facets_apply(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function banto_product_facet_rows_ins() from public, anon, authenticated;
revoke execute on function banto_product_facet_rows_upd() from public, anon, authenticated;
revoke execute on function banto_product_facet_rows_del() from public, anon, authenticated;
revoke execute on function banto_product_facets_rebuild(uuid, text) from public, anon, authenticated;
revoke execute on function banto_categories_facets_upd() from public, anon, authenticated;
revoke execute on function banto_categories_facets_del() from public, anon, authenticated;
revoke execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) from public;
grant execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) to anon, authenticated, service_role;
revoke execute on function product_public_facets(uuid, integer) from public;
grant execute on function product_public_facets(uuid, integer) to anon, authenticated, service_role;

-- ---------- 既存のデータ ----------
-- 価格の初期化では updated_at を進めない（同期の差分に全商品が載らないように）
alter table products disable trigger products_updated_at;
select banto_product_list_price_refresh(array(select id from products));
alter table products enable trigger products_updated_at;
select banto_product_facets_rebuild(id) from shops;

insert into banto_migrations (version) values ('0058_product_listing');
