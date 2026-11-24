-- 0150_product_list_filters: 商品の一覧の絞り込み（段 1）。複数のタグ（すべてを持つ商品）と価格の上下限（docs/storefront.md「URL」、メンテナの決定 2026-11-17）
--   - URL は Shopify と同じ名前: ?tag=a&tag=b（今までの ?tag= と互換）・?filter.v.price.gte= / ?filter.v.price.lte=（円）
--   - 価格は一覧の価格（products.list_price_jpy = いちばん安い SKU の価格、0058）で比べる。会員価格は使わない（ゲストの一覧と同じ並びにするため）
--   - banto_product_list・product_public_list・product_member_list に p_tags / p_price_min / p_price_max を足す（引数の形が変わるので前の形を消して作り直す。
--     名前で渡す今までの呼び方はそのまま通る）
--   - product_public_facets に price_max（公開の一覧に出る商品のいちばん高い一覧の価格。テーマの価格の欄の上限）

drop function if exists product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean);
drop function if exists product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean);
drop function if exists banto_product_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, uuid[]);

-- ---------- 一覧（0146 と同じ。タグを配列で、価格の上下限を足す） ----------
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
  p_price_max integer default null
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
     and cardinality(v_tags) = 0 and p_category_ids is null and p_brand is null then
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
    || case when p_price_max is not null then ' and p.list_price_jpy <= $12' else '' end;

  if p_count then
    execute format('select count(*) from (select 1 from products p where %s limit 10001) x', v_where)
      into v_total using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}'), null::jsonb, v_tags, p_price_min, p_price_max;
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
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}'), v_settings, v_tags, p_price_min, p_price_max;

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    v_next := jsonb_build_object('k', v_last->'k', 'id', v_last->'id');
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e - 'k'), '[]') from jsonb_array_elements(v_rows) e), 'next', v_next)
      || case when p_count then jsonb_build_object('total', least(v_total, 10000), 'total_capped', v_total > 10000) else '{}'::jsonb end;
end;
$$;
revoke execute on function banto_product_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, uuid[], text[], integer, integer) from public, anon, authenticated;

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
  p_price_max integer default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, '{}'::uuid[], p_tags, p_price_min, p_price_max);
$$;
revoke execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer) from public;
grant execute on function product_public_list(uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer) to anon, authenticated, service_role;

-- 会員の一覧（0098 と同じ。セッションが生きていなければゲストと同じ）
create or replace function product_member_list(
  p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid,
  p_sort text default 'new', p_limit integer default 24, p_after jsonb default null, p_offset integer default 0,
  p_tag text default null, p_category_ids uuid[] default null, p_brand text default null, p_q text default null,
  p_updated_since timestamptz default null, p_count boolean default false,
  p_tags text[] default null, p_price_min integer default null, p_price_max integer default null
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
  return banto_product_list(p_shop_id, p_sort, p_limit, p_after, p_offset, p_tag, p_category_ids, p_brand, p_q, p_updated_since, p_count, v_aud, p_tags, p_price_min, p_price_max);
end;
$$;
revoke execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer) from public, anon, authenticated;
grant execute on function product_member_list(uuid, uuid, integer, uuid, text, integer, jsonb, integer, text, uuid[], text, text, timestamptz, boolean, text[], integer, integer) to service_role;

-- ---------- 件数（0058 と同じ。price_max を足す） ----------
-- いちばん高い一覧の価格は、価格の高い順の索引（products_list_price_desc）の先頭だけを見る
create or replace function product_public_facets(p_shop_id uuid, p_tag_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not exists (select 1 from shops where id = p_shop_id and published)
              then jsonb_build_object('tags', '[]'::jsonb, 'categories', '{}'::jsonb, 'price_max', null)
         else jsonb_build_object(
           'tags', coalesce((select jsonb_agg(jsonb_build_object('tag', key, 'count', count) order by count desc, key collate "C")
                               from (select key, count from product_facets where shop_id = p_shop_id and kind = 'tag'
                                      order by count desc, key collate "C" limit least(greatest(coalesce(p_tag_limit, 200), 1), 1000)) t), '[]'::jsonb),
           'categories', coalesce((select jsonb_object_agg(key, count) from product_facets where shop_id = p_shop_id and kind = 'category'), '{}'::jsonb),
           'price_max', (select nullif(coalesce(p.list_price_jpy, -1), -1) from products p
                          where p.shop_id = p_shop_id and p.published and (p.audience_id is null or p.audience_mode = 'buy')
                          order by coalesce(p.list_price_jpy, -1) desc, p.id desc limit 1))
         end;
$$;
revoke execute on function product_public_facets(uuid, integer) from public;
grant execute on function product_public_facets(uuid, integer) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0150_product_list_filters');
