-- 0162_vendor_facets: お店の一覧のブランドの絞り込み（?filter.p.vendor=）の件数。前方専用。メンテナの決定 2026-11-21（docs/storefront.md「URL」）。
--   - product_facets に kind = 'brand'（ブランドごとの公開の商品の数）。タグ・カテゴリーと同じく、文単位のトリガーが差分で数える（0058・0098）
--   - product_public_facets に brands（多い順に 100 まで）を足す
--   - 絞り込みそのものは今までの banto_product_list の p_brand（ちょうど同じ名前、0058）。関数の形は変えない

alter table product_facets drop constraint if exists product_facets_kind_check;
alter table product_facets add constraint product_facets_kind_check check (kind in ('tag', 'category', 'brand'));

-- 商品の行（id, shop_id, tags, category_id, extra_category_ids, brand を持つ jsonb の配列）が数える先。ブランドは 1 商品 1 つ
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
                        || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(e->'extra_category_ids') = 'array' then e->'extra_category_ids' else '[]'::jsonb end)::uuid), '{}'), null) as cats,
           nullif(e->>'brand', '') as brand
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
    from r, lateral (select distinct a.anc from unnest(r.cats) d(cid) join anc a on a.id = d.cid) x
  union all
  select r.shop_id, 'brand', r.brand from r where r.brand is not null;
$$;
revoke execute on function banto_product_facet_keys(jsonb) from public, anon, authenticated;

-- 数える材料の行にブランドを足す（見せない商品を数えないのは 0098 のまま）
create or replace function banto_product_facet_rows_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply('[]'::jsonb,
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids, 'brand', brand)), '[]')
       from new_rows where published and (audience_id is null or audience_mode = 'buy')));
  return null;
end;
$$;
create or replace function banto_product_facet_rows_upd()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply(
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids, 'brand', brand)), '[]')
       from old_rows where published and (audience_id is null or audience_mode = 'buy')),
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids, 'brand', brand)), '[]')
       from new_rows where published and (audience_id is null or audience_mode = 'buy')));
  return null;
end;
$$;
create or replace function banto_product_facet_rows_del()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply(
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids, 'brand', brand)), '[]')
       from old_rows where published and (audience_id is null or audience_mode = 'buy')),
    '[]'::jsonb);
  return null;
end;
$$;

-- 作り直し（p_kind が null ならすべて）
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
     where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy') and t.value is not null
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
     where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
     group by a.anc;
  end if;
  if p_kind is null or p_kind = 'brand' then
    insert into product_facets (shop_id, kind, key, count)
    select p_shop_id, 'brand', p.brand, count(*)
      from products p
     where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy') and p.brand is not null and p.brand <> ''
     group by p.brand;
  end if;
end;
$$;
revoke execute on function banto_product_facets_rebuild(uuid, text) from public, anon, authenticated;

-- ---------- 件数（0153 と同じ。brands を足す: ブランドごとの公開の商品の数、多い順に 100 まで） ----------
create or replace function product_public_facets(p_shop_id uuid, p_tag_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not exists (select 1 from shops where id = p_shop_id and published)
              then jsonb_build_object('tags', '[]'::jsonb, 'categories', '{}'::jsonb, 'price_max', null, 'options', '[]'::jsonb, 'brands', '[]'::jsonb)
         else jsonb_build_object(
           'tags', coalesce((select jsonb_agg(jsonb_build_object('tag', key, 'count', count) order by count desc, key collate "C")
                               from (select key, count from product_facets where shop_id = p_shop_id and kind = 'tag'
                                      order by count desc, key collate "C" limit least(greatest(coalesce(p_tag_limit, 200), 1), 1000)) t), '[]'::jsonb),
           'categories', coalesce((select jsonb_object_agg(key, count) from product_facets where shop_id = p_shop_id and kind = 'category'), '{}'::jsonb),
           'price_max', (select nullif(coalesce(p.list_price_jpy, -1), -1) from products p
                          where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
                          order by coalesce(p.list_price_jpy, -1) desc, p.id desc limit 1),
           'options', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'value', value, 'count', n) order by key, n desc, value collate "C")
                                  from (select key, value, n from (
                                          select o.key, o.value, count(*)::integer as n,
                                                 row_number() over (partition by o.key order by count(*) desc, o.value collate "C") as rn
                                            from product_option_stock o join products p on p.id = o.product_id
                                           where o.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
                                           group by o.key, o.value) y
                                         where rn <= 50) x), '[]'::jsonb),
           'brands', coalesce((select jsonb_agg(jsonb_build_object('brand', key, 'count', count) order by count desc, key collate "C")
                                 from (select key, count from product_facets where shop_id = p_shop_id and kind = 'brand'
                                        order by count desc, key collate "C" limit 100) b), '[]'::jsonb))
         end;
$$;
revoke execute on function product_public_facets(uuid, integer) from public;
grant execute on function product_public_facets(uuid, integer) to anon, authenticated, service_role;

-- 今の商品のブランドを数える
select banto_product_facets_rebuild(id, 'brand') from shops;

insert into banto_migrations (version) values ('0162_vendor_facets');
