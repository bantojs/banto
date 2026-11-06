-- Banto 0121_list_card_fields: 一覧のカードに商品の独自項目を出す。メンテナの決定 2026-11-06（テーマ作りからの相談、docs/storefront.md）。前方専用。
--   - 項目の定義（shops.settings.product_fields）に card: true を付けた公開の項目だけを、一覧の行（banto_product_list = product_public_list /
--     product_member_list）と選んだ商品の行（banto_product_pick、0112）の attributes に入れる。すべての公開の項目を載せると一覧が重くなるため
--   - 非公開（public: false）の項目は card を付けても入れない（0055 の banto_public_product_attributes と同じ考え）
--   - 0098・0112 の関数を定義し直す（形は attributes が増えるだけ）

create or replace function banto_card_product_attributes(p_settings jsonb, p_attributes jsonb)
returns jsonb language sql immutable as $$
  select coalesce((
    select jsonb_object_agg(a.k, a.v)
      from jsonb_each(case when jsonb_typeof(p_attributes) = 'object' then p_attributes else '{}'::jsonb end) a(k, v)
     where exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_settings->'product_fields') = 'array' then p_settings->'product_fields' else '[]'::jsonb end) f
                    where jsonb_typeof(f) = 'object' and f->>'key' = a.k and f->'public' is distinct from 'false'::jsonb and f->'card' = 'true'::jsonb)
  ), '{}'::jsonb);
$$;
revoke execute on function banto_card_product_attributes(jsonb, jsonb) from public, anon, authenticated;

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
  v_settings jsonb;
begin
  select settings into v_settings from shops where id = p_shop_id and published;
  if not found then
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
    || '''attributes'', banto_card_product_attributes($9, p.attributes),'
    || '''image'', (select jsonb_build_object(''storage_key'', i.storage_key, ''thumb_key'', i.thumb_key, ''width'', i.width, ''height'', i.height, ''variants'', i.variants, ''thumb_width'', i.thumb_width)'
    || '            from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1)'
    || ') as r from products p where %s %s order by %s limit %s offset %s) t',
    v_order, v_key, v_where,
    case when p_after is not null then format(' and (%s, p.id) %s (($7->>''k'')::%s, ($7->>''id'')::uuid)', v_key, v_cmp, v_cast) else '' end,
    v_order, v_limit + 1, case when p_after is not null then 0 else v_offset end)
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_like, p_updated_since, p_after, coalesce(p_audiences, '{}'), v_settings;

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

create or replace function banto_product_pick(p_shop_id uuid, p_slugs text[], p_audiences uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_slugs is null or not exists (select 1 from shops where id = p_shop_id and published) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  if cardinality(p_slugs) > 100 then raise exception 'too_many_slugs' using errcode = '22023'; end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', p.id, 'slug', p.slug, 'name', p.name, 'brand', p.brand, 'category_id', p.category_id,
        'extra_category_ids', p.extra_category_ids, 'tags', p.tags, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'min_price_jpy', p.list_price_jpy, 'compare_at_price_jpy', p.list_compare_at_jpy,
        'attributes', banto_card_product_attributes(s.settings, p.attributes),
        'image', (select jsonb_build_object('storage_key', i.storage_key, 'thumb_key', i.thumb_key, 'width', i.width, 'height', i.height, 'variants', i.variants, 'thumb_width', i.thumb_width)
                    from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1))
      order by w.ord)
      from unnest(p_slugs) with ordinality w(slug, ord)
      join products p on p.shop_id = p_shop_id and p.slug = w.slug
      join shops s on s.id = p_shop_id
     where p.published and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(coalesce(p_audiences, '{}')))
  ), '[]'::jsonb));
end;
$$;
revoke execute on function banto_product_pick(uuid, text[], uuid[]) from public, anon, authenticated;

insert into banto_migrations (version) values ('0121_list_card_fields');
