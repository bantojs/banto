-- 0163_product_search_keywords: 商品の検索用のキーワード（お客様には見せない、検索だけに使う言葉）。前方専用。メンテナの決定 2026-11-21（docs/products.md）。
--   - products.search_keywords（200 文字まで、空白はそろえる。トリガー banto_products_search_keywords_norm）。anon には読ませない（公開の関数も返さない）
--   - 検索の文字列 banto_product_search_text に 5 つ目の引数（キーワード）を足した形を作り、pg_trgm のインデックス products_search_trgm を作り直す
--     （説明の先頭 300 文字に入らない言葉・別の呼び方・型番を、説明を長くせずに探せるように）
--   - banto_product_list（0161 と同じ。検索の文字列を 5 つの引数の形に）と AI 用 API の api_product_*（0149 と同じ。search_keywords を足す）
--   - 商品の詳細の product_public_get（0098）・product_member_get（0099）は行をまるごと返すので、search_keywords を外す

alter table products add column if not exists search_keywords text;
alter table products drop constraint if exists products_search_keywords_len;
alter table products add constraint products_search_keywords_len check (search_keywords is null or char_length(search_keywords) between 1 and 200);

-- 前後の空白を除き、続く空白（全角を含む）を 1 つの半角の空白にする。空なら null。200 文字を超えたら断る
create or replace function banto_search_keywords_norm(p text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare v text;
begin
  v := nullif(btrim(regexp_replace(coalesce(p, ''), '[' || chr(32) || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(12288) || ']+', ' ', 'g')), '');
  if v is not null and char_length(v) > 200 then raise exception 'search_keywords_too_long' using errcode = '22023'; end if;
  return v;
end;
$$;
revoke execute on function banto_search_keywords_norm(text) from public, anon, authenticated;

create or replace function banto_products_search_keywords_norm()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.search_keywords := banto_search_keywords_norm(new.search_keywords);
  return new;
end;
$$;
revoke execute on function banto_products_search_keywords_norm() from public, anon, authenticated;
drop trigger if exists products_search_keywords_norm on products;
create trigger products_search_keywords_norm before insert or update of search_keywords on products
  for each row execute function banto_products_search_keywords_norm();

-- AI 用 API の値: 文字か null（null・空で外す）
create or replace function banto_api_search_keywords(p jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' then raise exception 'invalid_search_keywords' using errcode = '22023'; end if;
  return banto_search_keywords_norm(p #>> '{}');
end;
$$;
revoke execute on function banto_api_search_keywords(jsonb) from public, anon, authenticated;

-- ---------- 検索の文字列（0058 の 4 つの引数の形にキーワードを足す。4 つの引数の形は古いコードのために残す） ----------
create or replace function banto_product_search_text(p_name text, p_brand text, p_tags text[], p_description text, p_keywords text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(coalesce(p_name, '') || ' ' || coalesce(p_brand, '') || ' ' || coalesce(array_to_string(p_tags, ' '), '') || ' ' || left(coalesce(p_description, ''), 300) || ' ' || coalesce(p_keywords, ''));
$$;
-- 0129 と同じく、PUBLIC ではなく anon / authenticated / service_role に明示して付ける（インデックスの式に使う）
revoke execute on function banto_product_search_text(text, text, text[], text, text) from public;
grant execute on function banto_product_search_text(text, text, text[], text, text) to anon, authenticated, service_role;

drop index if exists products_search_trgm;
do $$
declare v_schema text;
begin
  select n.nspname into v_schema from pg_opclass o join pg_namespace n on n.oid = o.opcnamespace
   where o.opcname = 'gin_trgm_ops' limit 1;
  execute format('create index products_search_trgm on products using gin (banto_product_search_text(name, brand, tags, description, search_keywords) %I.gin_trgm_ops) where published', v_schema);
end;
$$;

-- ---------- 一覧（0161 と同じ。検索の文字列にキーワードを含める） ----------
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
  v_words text[];  -- 検索の語（空白で分けた語。重なりを除いて 5 つまで）
  v_likes text[];  -- 語ごとの like の型（%語%）
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
  -- 検索の語（0161）: 空白（半角・全角・タブ・改行）で語に分け、小文字にして重なりを除き 5 つまで（6 つ目からは捨てる）。語ごとに AND で探す。
  -- 分け方は src/storefront/search-words.ts と同じ（test/fixtures/search-words-cases.ts の答え合わせの表で縛る）
  select coalesce(array_agg(w order by ord), '{}') into v_words
    from (select w, min(ord) as ord
            from regexp_split_to_table(lower(left(btrim(coalesce(p_q, '')), 100)), '[' || chr(32) || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(12288) || ']+') with ordinality t(w, ord)
           where w <> '' group by w order by min(ord) limit 5) x;
  -- 2 文字以下の語だけでは pg_trgm のインデックスが効かず全件を見るので、3 文字以上の語が 1 つも無いときは、タグ・カテゴリー・ブランドで
  -- 絞っているときだけ探す（ログイン無しで何度も送られて DB を重くされないように。人間の決定 2026-10-26、0161 で語ごとに。メンテナの決定 2026-11-21）。
  -- 3 文字以上の語が 1 つあれば、その語でインデックスが効き、短い語はその結果の中で比べるだけ
  if cardinality(v_words) > 0 and not exists (select 1 from unnest(v_words) w where char_length(w) >= 3)
     and cardinality(v_tags) = 0 and p_category_ids is null and p_brand is null then
    raise exception 'q_too_short' using errcode = '22023';
  end if;
  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' order by ord), '{}') into v_likes
    from unnest(v_words) with ordinality t(w, ord);

  -- 見せない商品（0098）は、見る人が合う会員の条件（p_audiences）のものだけ
  v_where := 'p.shop_id = $1 and p.published and (p.audience_id is null or p.audience_mode = ''buy'' or p.audience_id = any($8))'
    || case when cardinality(v_tags) > 0 then ' and p.tags @> $10' else '' end
    || case when p_category_ids is not null then ' and (p.category_id = any($3) or p.extra_category_ids && $3)' else '' end
    || case when p_brand is not null then ' and p.brand = $4' else '' end
    || case when p_updated_since is not null then ' and p.updated_at > $6' else '' end
    || case when p_price_min is not null then ' and p.list_price_jpy >= $11' else '' end
    || case when p_price_max is not null then ' and p.list_price_jpy <= $12' else '' end
    || case when v_options is not null then ' and p.id in (select o.product_id from product_option_stock o join jsonb_each($13) f on o.key = f.key and o.value in (select jsonb_array_elements_text(f.value)) where o.shop_id = $1 group by o.product_id having count(distinct o.key) = (select count(*) from jsonb_object_keys($13)))' else '' end;
  -- 語ごとに 1 つずつ。3 文字以上の語は like（0058 の pg_trgm の式インデックスが効く）、2 文字以下の語は strpos（3 文字の組が
  -- 作れずインデックスを全部なめる形になるので、インデックスに当てずにほかの条件で絞った行の中で比べる）
  for i in 1..cardinality(v_likes) loop
    if char_length(v_words[i]) >= 3 then
      v_where := v_where || format(' and banto_product_search_text(p.name, p.brand, p.tags, p.description, p.search_keywords) like ($5)[%s]', i);
    else
      v_where := v_where || format(' and strpos(banto_product_search_text(p.name, p.brand, p.tags, p.description, p.search_keywords), ($14)[%s]) > 0', i);
    end if;
  end loop;

  if p_count then
    execute format('select count(*) from (select 1 from products p where %s limit 10001) x', v_where)
      into v_total using p_shop_id, p_tag, p_category_ids, p_brand, v_likes, p_updated_since, p_after, coalesce(p_audiences, '{}'), null::jsonb, v_tags, p_price_min, p_price_max, v_options, v_words;
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
    into v_rows using p_shop_id, p_tag, p_category_ids, p_brand, v_likes, p_updated_since, p_after, coalesce(p_audiences, '{}'), v_settings, v_tags, p_price_min, p_price_max, v_options, v_words;

  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
    v_next := jsonb_build_object('k', v_last->'k', 'id', v_last->'id');
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e - 'k'), '[]') from jsonb_array_elements(v_rows) e), 'next', v_next)
      || case when p_count then jsonb_build_object('total', least(v_total, 10000), 'total_capped', v_total > 10000) else '{}'::jsonb end;
end;
$$;

-- ---------- AI 用 API の商品（0149 と同じ。search_keywords を足す） ----------
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
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at, 'released_at', p_product.released_at, 'publish_at', p_product.publish_at, 'store_only', p_product.store_only,
    'search_keywords', p_product.search_keywords,
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
declare v_tok api_tokens; v_p products%rowtype; v_aud record; v_released timestamptz; v_publish timestamptz; v_store_only boolean;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_aud from banto_api_product_audience(v_tok.shop_id, p_values, null::products);
  v_released := banto_api_released_at(p_values->'released_at');
  v_publish := banto_api_publish_at(p_values->'publish_at');
  v_store_only := banto_api_store_only(p_values->'store_only', false);
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids,
                        audience_id, audience_mode, audience_hide, released_at, publish_at, store_only, search_keywords)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'),
          v_aud.audience_id, v_aud.audience_mode, v_aud.audience_hide, v_released, v_publish, v_store_only, banto_api_search_keywords(p_values->'search_keywords'))
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
    released_at = case when p_values ? 'released_at' then banto_api_released_at(p_values->'released_at') else released_at end,
    publish_at = case when p_values ? 'publish_at' then banto_api_publish_at(p_values->'publish_at') else publish_at end,
    store_only = case when p_values ? 'store_only' then banto_api_store_only(p_values->'store_only', store_only) else store_only end,
    search_keywords = case when p_values ? 'search_keywords' then banto_api_search_keywords(p_values->'search_keywords') else search_keywords end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- ---------- 商品の詳細（お客様の画面）: 行をまるごと返すので、検索用のキーワードを外す（0098・0099 と同じ。- 'search_keywords' を足しただけ） ----------
create or replace function product_public_get(p_shop_id uuid, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(p) - 'attributes' - 'search_keywords'
         || jsonb_build_object('attributes', banto_public_product_attributes(s.settings, p.attributes), 'app_data', banto_public_app_data(p.id),
                               'size_chart', case when s.settings->'modules'->'size_charts' = 'true'::jsonb
                                                  then banto_size_chart_resolve(p.shop_id, p.category_id, p.id) end)
    from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published and (p.audience_id is null or p.audience_mode = 'buy')
   limit 1;
$$;

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
    'product', to_jsonb(v_p) - 'attributes' - 'search_keywords'
               || jsonb_build_object('attributes', banto_public_product_attributes(v_settings, v_p.attributes), 'app_data', banto_public_app_data(v_p.id),
                                     'size_chart', case when v_settings->'modules'->'size_charts' = 'true'::jsonb then banto_size_chart_resolve(v_p.shop_id, v_p.category_id, v_p.id) end),
    'images', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from product_images i where i.product_id = v_p.id), '[]'::jsonb),
    -- 0099: price_jpy はこの会員の単価（会員価格が安ければそれ）、regular_price_jpy は通常の価格
    'skus', coalesce((select jsonb_agg(to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99),
                                                         'price_jpy', banto_sku_member_price(k.id, p_customer_id, v_aud), 'regular_price_jpy', k.price_jpy)
                             order by k.created_at)
                        from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = v_p.id), '[]'::jsonb),
    'purchasable', v_p.audience_id is null or v_p.audience_id = any(v_aud)
  );
end;
$$;

insert into banto_migrations (version) values ('0163_product_search_keywords');
