-- 0161_search_words: 商品の検索の語を空白で語に分け、すべてを含む商品を探す（AND）。前方専用。メンテナの決定 2026-11-21（docs/storefront.md「URL」）。
--   - banto_product_list（0153 を差し替え）: p_q を空白（半角・全角・タブ・改行・垂直タブ・改ページだけ。[[:space:]] はロケールで広がるので列挙する）で語に分け、重なりを除いて 5 語まで、語ごとに AND で like
--   - 短い語の決まり（2026-10-26）は語ごとに: 3 文字以上の語が 1 つも無く、タグ・カテゴリー・ブランドでも絞っていないときだけ q_too_short
--   - 1 語だけのときは今までと同じ結果。お店の画面・ヘッドレスの公開 API・会員の一覧はどれもこの関数を通る（AI 用 API の商品の一覧 api_products_list は名前とスラッグの ilike のまま）
--   - Worker は src/storefront/search-words.ts で分けた語を半角の空白でつないで渡す（分け方・大文字小文字・長さの数え方の違いで判定がずれないように）

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
      v_where := v_where || format(' and banto_product_search_text(p.name, p.brand, p.tags, p.description) like ($5)[%s]', i);
    else
      v_where := v_where || format(' and strpos(banto_product_search_text(p.name, p.brand, p.tags, p.description), ($14)[%s]) > 0', i);
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

insert into banto_migrations (version) values ('0161_search_words');
