-- 0098_audience_products: 会員限定の商品（同梱モジュール audiences の段 C。メンテナの決定 2026-11-02、docs/audiences.md「会員限定の商品」）
--   - 商品に会員の条件（audience_id）と扱い（audience_mode）: hide = 合わない人には見せない（一覧・検索・サイトマップ・フィード・匿名の読み取りから消える）、
--     buy = だれにでも見せるが、買えるのは合う会員だけ。audience_hide: hide のとき、ゲストにも「会員の方だけ」と出さず 404 にする
--   - **判定は DB**。匿名（anon）の RLS と公開の関数は「条件の無い商品と buy の商品」だけ。ログイン中の会員は、会員のセッションを確かめる
--     service_role の関数（product_member_*）で、DB の最新の独自項目で合う条件の商品を足して受け取る
--   - URL のパラメータを含む条件（banto_audience_display_only）は商品に付けさせない（URL はだれでも付けられるため）
--   - 買えるか（buy と hide の両方）は、カートの値付けが受け取る purchasable（会員は DB が判定、ゲストは条件のある商品は買えない）で決め、
--     チェックアウトの一本道（src/commerce/checkout.ts の priceCart）で外す

alter table products add column if not exists audience_id uuid;
alter table products add column if not exists audience_mode text not null default 'hide';
alter table products add column if not exists audience_hide boolean not null default false;
alter table products drop constraint if exists products_audience_mode_check;
alter table products add constraint products_audience_mode_check check (audience_mode in ('hide', 'buy'));
-- 同じショップの条件だけ。使われている条件は消せない（管理画面は「使われているので消せません」）
alter table products drop constraint if exists products_audience_fkey;
alter table products add constraint products_audience_fkey foreign key (audience_id, shop_id) references audiences (id, shop_id) on delete restrict;
create index if not exists products_audience_idx on products (shop_id, audience_id) where audience_id is not null;
-- 匿名の読み取りでは扱いの印だけ（ゲストの画面が「会員の方だけ購入できます」を出すため。条件の中身は読ませない）
grant select (audience_id, audience_mode) on products to anon;

-- 表示用の条件（URL のパラメータを含む）は商品に付けさせない。付いている条件を表示用に変えるのも断る
create or replace function banto_products_audience_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.audience_id is not null and (tg_op = 'INSERT' or new.audience_id is distinct from old.audience_id)
     and exists (select 1 from audiences a where a.id = new.audience_id and banto_audience_display_only(a.condition)) then
    raise exception 'audience_display_only' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function banto_products_audience_guard() from public, anon, authenticated;
drop trigger if exists products_audience_guard on products;
create trigger products_audience_guard before insert or update of audience_id on products for each row execute function banto_products_audience_guard();

create or replace function banto_audiences_display_only_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if banto_audience_display_only(new.condition) and exists (select 1 from products p where p.audience_id = new.id) then
    raise exception 'audience_display_only_in_use' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function banto_audiences_display_only_guard() from public, anon, authenticated;
drop trigger if exists audiences_guard_display_only on audiences;
-- 名前の順で、形を組み直す audiences_guard（0097）の後に走る
create trigger audiences_guard_display_only before update on audiences for each row execute function banto_audiences_display_only_guard();

-- ---------- 匿名の RLS: 見せない商品とその SKU・画像を外す ----------
drop policy if exists products_public on products;
create policy products_public on products for select
  using (published = true and (audience_id is null or audience_mode = 'buy') and exists (select 1 from shops s where s.id = products.shop_id and s.published = true));
drop policy if exists skus_public on skus;
create policy skus_public on skus for select
  using (exists (select 1 from products p join shops s on s.id = p.shop_id
                 where p.id = skus.product_id and p.published and s.published and (p.audience_id is null or p.audience_mode = 'buy')));
drop policy if exists images_public on product_images;
create policy images_public on product_images for select
  using (exists (select 1 from products p join shops s on s.id = p.shop_id
                 where p.id = product_images.product_id and p.published and s.published and (p.audience_id is null or p.audience_mode = 'buy')));

-- ---------- 公開の関数（0055〜0095 の最新の形に、見せない商品を外す条件だけを足す） ----------
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
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published and (p.audience_id is null or p.audience_mode = 'buy')
   limit 1;
$$;

create or replace function product_public_count(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (select 1 from shops where id = p_shop_id and published)
              then (select count(*)::integer from products where shop_id = p_shop_id and published and (audience_id is null or audience_mode = 'buy')) else 0 end;
$$;

-- サイトマップ: 見せない商品は出さない（buy の商品はページがだれにでも見えるので出す）
create or replace function product_public_slugs(p_shop_id uuid, p_offset integer, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select jsonb_agg(jsonb_build_array(slug, updated_at) order by id)
                     from (select id, slug, updated_at from products
                            where shop_id = p_shop_id and published and (audience_id is null or audience_mode = 'buy')
                              and exists (select 1 from shops where id = p_shop_id and published)
                            order by id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 0), 0), 10000)) x), '[]'::jsonb);
$$;

-- 商品フィード: 会員の条件のある商品は出さない（フィードはだれでも買える商品の一覧）
create or replace function product_feed_page(p_shop_id uuid, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select id, shop_id, slug, name, description, tags, category_id, extra_category_ids, brand, tax_class, published, created_at, updated_at
      from products
     where shop_id = p_shop_id and published and audience_id is null and (p_after is null or id > p_after)
       and exists (select 1 from shops where id = p_shop_id and published
                     and coalesce(settings->'modules'->>'product_feed', 'false') = 'true')
     order by id
     limit least(greatest(coalesce(p_limit, 0), 0), 1000)
  ),
  k as (select s.* from skus s where s.product_id in (select id from p))
  select jsonb_build_object(
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from p), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(to_jsonb(k) order by k.product_id, k.created_at) from k), '[]'::jsonb),
    -- 在庫は「あり / なし」だけ（フィードの availability に要るのはそれだけ。正確な数は返さない）
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('sku_id', i.sku_id, 'in_stock', i.available > 0)) from inventory i where i.sku_id in (select id from k)), '[]'::jsonb),
    'images', coalesce((select jsonb_agg(to_jsonb(im) order by im.product_id, im.sort_order) from product_images im where im.product_id in (select id from p)), '[]'::jsonb)
  );
$$;

create or replace function product_public_stock(p_shop_id uuid, p_sku_ids uuid[])
returns table (sku_id uuid, available integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_sku_ids is null then return; end if;
  if cardinality(p_sku_ids) > 200 then raise exception 'too_many_skus'; end if;
  return query
    select i.sku_id, least(greatest(i.available, 0), 99)::integer
      from inventory i
      join skus k on k.id = i.sku_id
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
     where s.id = p_shop_id and s.published and p.published and (p.audience_id is null or p.audience_mode = 'buy') and k.shop_id = p_shop_id
       and i.sku_id = any(p_sku_ids);
end;
$$;

-- タグ・カテゴリーの件数も、見せない商品を数えない
create or replace function banto_product_facet_rows_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply('[]'::jsonb,
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from new_rows where published and (audience_id is null or audience_mode = 'buy')));
  return null;
end;
$$;
create or replace function banto_product_facet_rows_upd()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply(
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from old_rows where published and (audience_id is null or audience_mode = 'buy')),
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from new_rows where published and (audience_id is null or audience_mode = 'buy')));
  return null;
end;
$$;
create or replace function banto_product_facet_rows_del()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_product_facets_apply(
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'shop_id', shop_id, 'tags', tags, 'category_id', category_id, 'extra_category_ids', extra_category_ids)), '[]')
       from old_rows where published and (audience_id is null or audience_mode = 'buy')),
    '[]'::jsonb);
  return null;
end;
$$;
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
end;
$$;

-- ---------- 一覧: 中身を banto_product_list に移し、匿名は条件なし・会員は合う条件を渡す ----------
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
  p_audiences uuid[] default '{}'
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
begin
  if not exists (select 1 from shops where id = p_shop_id and published) then
    return jsonb_build_object('items', '[]'::jsonb, 'next', null);
  end if;
  -- 検索の語があるときは 1,000 まで（深い位置まで読ませて DB を重くさせない。先は p_after で）
  v_offset_max := 10000;
  if nullif(btrim(coalesce(p_q, '')), '') is not null then v_offset_max := 1000; end if;
  if v_offset > v_offset_max then raise exception 'offset_too_large' using errcode = '22023'; end if;
  case coalesce(p_sort, 'new')
    when 'new' then v_key := 'p.created_at'; v_order := 'p.created_at desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'updated' then v_key := 'p.updated_at'; v_order := 'p.updated_at desc, p.id desc'; v_cmp := '<'; v_cast := 'timestamptz';
    when 'price_asc' then v_key := 'coalesce(p.list_price_jpy, 2147483647)'; v_order := 'coalesce(p.list_price_jpy, 2147483647), p.id'; v_cmp := '>'; v_cast := 'integer';
    when 'price_desc' then v_key := 'coalesce(p.list_price_jpy, -1)'; v_order := 'coalesce(p.list_price_jpy, -1) desc, p.id desc'; v_cmp := '<'; v_cast := 'integer';
    when 'name' then v_key := 'p.name'; v_order := 'p.name, p.id'; v_cmp := '>'; v_cast := 'text';
    else raise exception 'invalid_sort' using errcode = '22023';
  end case;
  -- 2 文字以下の語は pg_trgm のインデックスが効かず全件を見るので、タグ・カテゴリー・ブランドで絞っているときだけ
  -- （ログイン無しで何度も送られて DB を重くされないように。人間の決定 2026-10-26）
  if p_q is not null and btrim(p_q) <> '' and char_length(btrim(p_q)) < 3
     and p_tag is null and p_category_ids is null and p_brand is null then
    raise exception 'q_too_short' using errcode = '22023';
  end if;
  if p_q is not null and btrim(p_q) <> '' then
    v_like := '%' || replace(replace(replace(lower(left(btrim(p_q), 100)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- 見せない商品（0098）は、見る人が合う会員の条件（p_audiences）のものだけ
  v_where := 'p.shop_id = $1 and p.published and (p.audience_id is null or p.audience_mode = ''buy'' or p.audience_id = any($8))'
    || case when p_tag is not null then ' and p.tags @> array[$2::text]' else '' end
    || case when p_category_ids is not null then ' and (p.category_id = any($3) or p.extra_category_ids && $3)' else '' end
    || case when p_brand is not null then ' and p.brand = $4' else '' end
    || case when v_like is not null then ' and banto_product_search_text(p.name, p.brand, p.tags, p.description) like $5' else '' end
    || case when p_updated_since is not null then ' and p.updated_at > $6' else '' end;

  if p_count then
    execute format('select count(*) from (select 1 from products p where %s limit 10001) x', v_where)
      into v_total using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}');
  end if;

  execute format(
    'select coalesce(jsonb_agg(r order by ord), ''[]'') from ('
    || 'select row_number() over (order by %s) as ord, jsonb_build_object('
    || '''id'', p.id, ''slug'', p.slug, ''name'', p.name, ''brand'', p.brand, ''category_id'', p.category_id,'
    || '''extra_category_ids'', p.extra_category_ids, ''tags'', p.tags, ''created_at'', p.created_at, ''updated_at'', p.updated_at,'
    || '''min_price_jpy'', p.list_price_jpy, ''compare_at_price_jpy'', p.list_compare_at_jpy, ''k'', %s,'
    || '''image'', (select jsonb_build_object(''storage_key'', i.storage_key, ''thumb_key'', i.thumb_key, ''width'', i.width, ''height'', i.height, ''variants'', i.variants, ''thumb_width'', i.thumb_width)'
    || '            from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1)'
    || ') as r from products p where %s %s order by %s limit %s offset %s) t',
    v_order, v_key, v_where,
    case when p_after is not null then format(' and (%s, p.id) %s (($7->>''k'')::%s, ($7->>''id'')::uuid)', v_key, v_cmp, v_cast) else '' end,
    v_order, v_limit + 1, case when p_after is not null then 0 else v_offset end)
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}');

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    v_next := jsonb_build_object('k', v_last->'k', 'id', v_last->'id');
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e - 'k'), '[]') from jsonb_array_elements(v_rows) e), 'next', v_next)
      || case when p_count then jsonb_build_object('total', least(v_total, 10000), 'total_capped', v_total > 10000) else '{}'::jsonb end;
end;
$$;
revoke execute on function banto_product_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, uuid[]) from public, anon, authenticated;

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
language sql
stable
security definer
set search_path = public
as $$
  select banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, '{}'::uuid[]);
$$;
revoke execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) from public;
grant execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) to anon, authenticated, service_role;

-- ---------- 会員: 合う条件（DB の最新の独自項目で判定。表示用の条件は数えない） ----------
create or replace function banto_member_audience_ids(p_shop_id uuid, p_customer_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(a.id), '{}')
    from audiences a, customers c
   where a.shop_id = p_shop_id and c.shop_id = p_shop_id and c.id = p_customer_id
     and not banto_audience_display_only(a.condition)
     and banto_audience_ok(a.condition, true, coalesce(c.attributes, '{}'::jsonb));
$$;
revoke execute on function banto_member_audience_ids(uuid, uuid) from public, anon, authenticated;

-- 会員の一覧（セッションが生きていなければゲストと同じ）
create or replace function product_member_list(
  p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid,
  p_sort text default 'new', p_limit integer default 24, p_after jsonb default null, p_offset integer default 0,
  p_tag text default null, p_category_ids uuid[] default null, p_brand text default null, p_q text default null,
  p_updated_since timestamptz default null, p_count boolean default false
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
  return banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, v_aud);
end;
$$;
revoke execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean) to service_role;

-- 会員の商品詳細: 商品（product_public_get と同じ形）・画像・SKU（在庫は 0〜99）と、この会員が買えるか。見えなければ null
create or replace function product_member_get(p_shop_id uuid, p_slug text, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_aud uuid[] := '{}';
  v_p products%rowtype;
  v_settings jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_get: service_role only' using errcode = '42501';
  end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  select p.* into v_p from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
     and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))
   limit 1;
  if not found then return null; end if;
  select settings into v_settings from shops where id = p_shop_id;
  return jsonb_build_object(
    'product', to_jsonb(v_p) - 'attributes'
               || jsonb_build_object('attributes', banto_public_product_attributes(v_settings, v_p.attributes), 'app_data', banto_public_app_data(v_p.id),
                                     'size_chart', case when v_settings->'modules'->'size_charts' = 'true'::jsonb then banto_size_chart_resolve(v_p.shop_id, v_p.category_id, v_p.id) end),
    'images', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from product_images i where i.product_id = v_p.id), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99)) order by k.created_at)
                        from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = v_p.id), '[]'::jsonb),
    'purchasable', v_p.audience_id is null or v_p.audience_id = any(v_aud)
  );
end;
$$;
revoke execute on function product_member_get(uuid, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function product_member_get(uuid, text, uuid, integer, uuid) to service_role;

-- 会員のカート: SKU・商品（公開の列と扱いの印）・在庫と、この会員が買えるか
create or replace function product_member_skus(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sku_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_skus: service_role only' using errcode = '42501';
  end if;
  if p_sku_ids is null then return '[]'::jsonb; end if;
  if cardinality(p_sku_ids) > 100 then raise exception 'too_many_skus'; end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'sku', to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99)),
             'product', jsonb_build_object('id', p.id, 'shop_id', p.shop_id, 'slug', p.slug, 'name', p.name, 'description', p.description, 'published', p.published,
                                           'created_at', p.created_at, 'updated_at', p.updated_at, 'tags', p.tags, 'category_id', p.category_id, 'brand', p.brand,
                                           'tax_class', p.tax_class, 'extra_category_ids', p.extra_category_ids, 'audience_id', p.audience_id, 'audience_mode', p.audience_mode),
             'purchasable', p.audience_id is null or p.audience_id = any(v_aud)))
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
      left join inventory inv on inv.sku_id = k.id
     where k.shop_id = p_shop_id and k.id = any(p_sku_ids) and p.published and s.published
       and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))), '[]'::jsonb);
end;
$$;
revoke execute on function product_member_skus(uuid, uuid, integer, uuid, uuid[]) from public, anon, authenticated;
grant execute on function product_member_skus(uuid, uuid, integer, uuid, uuid[]) to service_role;

-- ゲストが見せない商品の URL で来たとき: 「会員の方だけ」と出してよいか（audience_hide なら null = 404。中身は返さない）
create or replace function product_public_gate(p_shop_id uuid, p_slug text)
returns text language sql stable security definer set search_path = public as $$
  select 'members' from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
     and p.audience_id is not null and p.audience_mode = 'hide' and not p.audience_hide
   limit 1;
$$;
revoke execute on function product_public_gate(uuid, text) from public;
grant execute on function product_public_gate(uuid, text) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0098_audience_products');
