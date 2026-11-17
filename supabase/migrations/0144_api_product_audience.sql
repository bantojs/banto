-- 0144_api_product_audience: 商品の会員限定（0098）を AI 用 API で読み書きする（docs/ai-access.md §18、docs/audiences.md「会員限定の商品」）
--   - api_product_create / api_product_update が audience（条件の id か名前、null で外す）・audience_mode（hide / buy）・audience_hide を受け付ける。
--     送らなかった欄は今のまま（管理画面の audience_present と同じ）。スコープは products:write のまま（管理画面でも項目 catalog の人が付ける）
--   - 判定は今の DB のまま: 同じショップの条件だけは外部キー products_audience_fkey、表示用の条件はトリガー banto_products_audience_guard
--   - 条件を付けるのはモジュール audiences が ON のショップだけ（module_disabled）。外す（null）のは OFF でも通す
--   - hide と buy の食い違いは黙って直さずに断る（audience_hide_requires_hide）。buy だけを送ったときは audience_hide を false にする
--   - api_product_json に audience（{ id, name } か null）・audience_mode・audience_hide を足す（一覧・詳細・作成・更新・画像の操作の応答）
--   - api_audiences_list: 条件の一覧（products:read、id・name・product_usable だけ。条件の中身は返さない）

-- 送られた値から会員の条件の 3 つの欄を決める。p_cur は今の行（作成なら null）
create or replace function banto_api_product_audience(p_shop_id uuid, p_values jsonb, p_cur products,
                                                       out audience_id uuid, out audience_mode text, out audience_hide boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_ref jsonb := p_values->'audience'; v_ref_text text; v_any boolean;
begin
  audience_id := p_cur.audience_id;
  audience_mode := coalesce(p_cur.audience_mode, 'hide');
  audience_hide := coalesce(p_cur.audience_hide, false);
  v_any := p_values ? 'audience' or p_values ? 'audience_mode' or p_values ? 'audience_hide';
  if not v_any then return; end if;

  if p_values ? 'audience' then
    if v_ref is null or jsonb_typeof(v_ref) = 'null' then
      audience_id := null;
    elsif jsonb_typeof(v_ref) <> 'string' or btrim(v_ref #>> '{}') = '' then
      raise exception 'invalid_audience' using errcode = '22023';
    else
      v_ref_text := btrim(v_ref #>> '{}');
      select a.id into audience_id from audiences a
       where a.shop_id = p_shop_id
         and (case when v_ref_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then a.id = v_ref_text::uuid else false end
              or a.name = v_ref_text)
       order by (a.id::text = lower(v_ref_text)) desc
       limit 1;
      if audience_id is null then raise exception 'audience_not_found' using errcode = '22023'; end if;
    end if;
  end if;

  if p_values ? 'audience_mode' then
    if jsonb_typeof(p_values->'audience_mode') <> 'string' or p_values->>'audience_mode' not in ('hide', 'buy') then
      raise exception 'invalid_audience_mode' using errcode = '22023';
    end if;
    audience_mode := p_values->>'audience_mode';
  end if;

  if p_values ? 'audience_hide' then
    if jsonb_typeof(p_values->'audience_hide') <> 'boolean' then raise exception 'invalid_audience_hide' using errcode = '22023'; end if;
    audience_hide := (p_values->'audience_hide')::boolean;
  elsif p_values ? 'audience_mode' and audience_mode = 'buy' then
    -- 「存在も隠す」は hide のときだけの印なので、buy に変えたら外す
    audience_hide := false;
  end if;

  if audience_hide and audience_mode = 'buy' then raise exception 'audience_hide_requires_hide' using errcode = '22023'; end if;

  -- 条件を付けたまま（付け直す・扱いを変える）はモジュールが ON のときだけ。外すのはいつでも
  if audience_id is not null
     and not exists (select 1 from shops s where s.id = p_shop_id and s.settings->'modules'->'audiences' = 'true'::jsonb) then
    raise exception 'module_disabled:audiences';
  end if;
end;
$$;
revoke execute on function banto_api_product_audience(uuid, jsonb, products) from public, anon, authenticated;

-- AI 用 API の商品: 会員の条件を足す。ほかは 0094 と同じ
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
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
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

-- 作成: 会員の条件を足す。ほかは 0042 と同じ
create or replace function api_product_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype; v_aud record;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_aud from banto_api_product_audience(v_tok.shop_id, p_values, null::products);
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids,
                        audience_id, audience_mode, audience_hide)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'),
          v_aud.audience_id, v_aud.audience_mode, v_aud.audience_hide)
  returning * into v_p;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- 更新: 会員の条件を足す（送らなかった欄は今のまま）。ほかは 0042 と同じ
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
    audience_hide = v_aud.audience_hide
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- 会員の条件の一覧（products:read）。商品に付けられるか（表示用の条件でないか）だけを添え、条件の中身は返さない
create or replace function api_audiences_list(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  if not exists (select 1 from shops s where s.id = v_tok.shop_id and s.settings->'modules'->'audiences' = 'true'::jsonb) then
    raise exception 'module_disabled:audiences';
  end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
                                                                                   'product_usable', not banto_audience_display_only(a.condition))
                                                                order by a.name), '[]'::jsonb)
                                         from audiences a where a.shop_id = v_tok.shop_id));
end;
$$;
revoke execute on function api_audiences_list(text) from public, anon, authenticated;
grant execute on function api_audiences_list(text) to service_role;

insert into banto_migrations (version) values ('0144_api_product_audience');
