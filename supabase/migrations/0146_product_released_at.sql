-- 0146_product_released_at: 商品の発売日（任意）。新着順とテーマの「新しい商品」はこの日、無ければ作成日（docs/storefront.md「URL」の sort=new、docs/themes.md）
--   - ほかのカートから移すと作成日がすべて移した日になり、新着順と「NEW」の札が元の発売の順と変わるため（作成日は書き換えない。監査と同期の手がかり）
--   - 新着順（sort=new）の鍵を coalesce(released_at, created_at) に変える（banto_product_list。0121 を定義し直す、行に released_at を足す）
--   - 選んだ商品の行（banto_product_pick、0112 / 0121）・AI 用 API の商品（api_product_json・create・update、0144）にも足す
--   - 予約公開ではない（未来の日付でも公開中なら見える。並びだけ）
--   - バックアップの復元（restore_shop_data / restore_catalog は列を知らない）は restore_product_released_at で戻す

alter table products add column if not exists released_at timestamptz;
grant select (released_at) on products to anon;
create index if not exists products_list_released on products (shop_id, (coalesce(released_at, created_at)) desc, id desc) where published;

-- AI 用 API の値: 日時の文字列（時差つき推奨。日付だけなら UTC の 0 時）か null。1990 年から今の 10 年後まで
create or replace function banto_api_released_at(p jsonb)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare v timestamptz;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  -- ISO 8601 の形だけ（PostgreSQL は yesterday・epoch・infinity のような語も日時として読むため）
  if jsonb_typeof(p) <> 'string' or (p #>> '{}') !~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$' then
    raise exception 'invalid_released_at' using errcode = '22023';
  end if;
  begin
    -- 時差の無い値は UTC として読む（DB のセッションの時間帯に左右されないように。日付だけなら UTC の 0 時）
    v := case when (p #>> '{}') ~ '[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' then (p #>> '{}')::timestamptz
              else ((p #>> '{}')::timestamp at time zone 'UTC') end;
  exception when others then
    raise exception 'invalid_released_at' using errcode = '22023';
  end;
  if v < '1990-01-01T00:00:00Z'::timestamptz or v > now() + interval '10 years' then raise exception 'invalid_released_at' using errcode = '22023'; end if;
  return v;
end;
$$;
revoke execute on function banto_api_released_at(jsonb) from public, anon, authenticated;

-- 範囲は書き込みの経路（管理画面・AI 用 API・復元）を問わず DB で 1 つに（1990 年から、書いた時の 10 年後まで）。
-- 管理画面で入れた値が API の往復や復元で通らなくなることを防ぐ
create or replace function banto_products_released_at_guard()
returns trigger language plpgsql as $$
begin
  if new.released_at is not null and (tg_op = 'INSERT' or new.released_at is distinct from old.released_at)
     and (new.released_at < '1990-01-01T00:00:00Z'::timestamptz or new.released_at > now() + interval '10 years') then
    raise exception 'invalid_released_at' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function banto_products_released_at_guard() from public, anon, authenticated;
drop trigger if exists products_released_at_guard on products;
create trigger products_released_at_guard before insert or update of released_at on products for each row execute function banto_products_released_at_guard();

-- ---------- 一覧（0121 と同じ。sort=new の鍵と、行の released_at だけが違う） ----------
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
    || '''extra_category_ids'', p.extra_category_ids, ''tags'', p.tags, ''created_at'', p.created_at, ''updated_at'', p.updated_at, ''released_at'', p.released_at,'
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

-- ---------- 選んだ商品（0121 と同じ。行に released_at） ----------
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
        'extra_category_ids', p.extra_category_ids, 'tags', p.tags, 'created_at', p.created_at, 'updated_at', p.updated_at, 'released_at', p.released_at,
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

-- ---------- AI 用 API の商品（0144 と同じ。released_at を足す） ----------
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
    'option_axes', banto_option_axes_named(p_product.shop_id, p_product.option_axes),
    'option_names', (select s.option_names from shops s where s.id = p_product.shop_id),
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at, 'released_at', p_product.released_at,
    'audience', (select jsonb_build_object('id', a.id, 'name', a.name) from audiences a where a.id = p_product.audience_id),
    'audience_mode', p_product.audience_mode, 'audience_hide', p_product.audience_hide,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                             'width', i.width, 'height', i.height, 'sort_order', i.sort_order,
                                                             'options', i.options, 'variants', i.variants, 'thumb_width', i.thumb_width) order by i.sort_order), '[]'::jsonb)
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
declare v_tok api_tokens; v_p products%rowtype; v_aud record; v_released timestamptz;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_aud from banto_api_product_audience(v_tok.shop_id, p_values, null::products);
  v_released := banto_api_released_at(p_values->'released_at');
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids,
                        audience_id, audience_mode, audience_hide, released_at)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'),
          v_aud.audience_id, v_aud.audience_mode, v_aud.audience_hide, v_released)
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
declare v_tok api_tokens; v_p products%rowtype; v_cur products%rowtype; v_aud record;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_cur from products where id = p_product_id and shop_id = v_tok.shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_aud from banto_api_product_audience(v_tok.shop_id, p_values, v_cur);
  update products set
    slug = coalesce(p_values->>'slug', slug),
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    description = case when p_values ? 'description' then nullif(btrim(p_values->>'description'), '') else description end,
    published = coalesce((p_values->>'published')::boolean, published),
    tags = case when p_values ? 'tags' then banto_normalize_tags(p_values->'tags') else tags end,
    brand = case when p_values ? 'brand' then nullif(btrim(coalesce(p_values->>'brand', '')), '') else brand end,
    attributes = case when p_values ? 'attributes' then banto_clean_object(p_values->'attributes', 50) else attributes end,
    category_id = case when p_values ? 'category' then api_category_ref(v_tok.shop_id, p_values->>'category') else category_id end,
    extra_category_ids = case when p_values ? 'extra_categories' then api_category_refs(v_tok.shop_id, p_values->'extra_categories') else extra_category_ids end,
    audience_id = v_aud.audience_id,
    audience_mode = v_aud.audience_mode,
    audience_hide = v_aud.audience_hide,
    released_at = case when p_values ? 'released_at' then banto_api_released_at(p_values->'released_at') else released_at end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- ---------- バックアップの復元: 発売日を URL の名前で戻す（restore_catalog の後に呼ぶ）。p_items は [{ slug, released_at }] ----------
create or replace function restore_product_released_at(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer := 0; v_at timestamptz;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'invalid_export'; end if;
  for v_row in select * from jsonb_array_elements(p_items) loop
    begin
      v_at := banto_api_released_at(v_row->'released_at');
    exception when others then
      continue;
    end;
    if v_at is null then continue; end if;
    update products set released_at = v_at where shop_id = p_shop_id and slug = v_row->>'slug';
    if found then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('products_released_at', v_n);
end;
$$;
revoke execute on function restore_product_released_at(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_product_released_at(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0146_product_released_at');
