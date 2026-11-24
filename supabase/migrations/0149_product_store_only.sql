-- 0149_product_store_only: 店頭のみ（ネットでは買えない）商品の印（メンテナの決定 2026-11-17、docs/storefront.md「店頭のみの商品」）
--   - 1 点ごとに色が違う・店頭の在庫だけ、のような「お店で試着して、買うかはお店で決める」商品。お店の画面に見せ、
--     同梱モジュール「お店で試着」が ON ならカートに入れて試着を申し込める。購入手続き（決済）には進めない
--   - 買えない理由は src/products/sale.ts の PurchaseBlock（store_only を足す）。カートの値付けは店頭のみの行を残すが小計に入れず、
--     購入手続き（createQuote）は外して知らせる。DB でも reserve_stock が断る（0148 の定義に 1 行足しただけ）。tryon_request は受ける
--   - product_member_skus（会員のカートの SKU）・api_product_*（AI 用 API）に store_only を足す（0148 と同じ。1 か所ずつ足しただけ）

alter table products add column if not exists store_only boolean not null default false;
grant select (store_only) on products to anon;

-- AI 用 API の値: 真偽か null（null は既定に戻す = false）
create or replace function banto_api_store_only(p jsonb, p_current boolean)
returns boolean
language plpgsql
immutable
as $$
begin
  if p is null then return p_current; end if;
  if jsonb_typeof(p) = 'null' then return false; end if;
  if jsonb_typeof(p) <> 'boolean' then raise exception 'invalid_store_only' using errcode = '22023'; end if;
  return (p #>> '{}')::boolean;
end;
$$;
revoke execute on function banto_api_store_only(jsonb, boolean) from public, anon, authenticated;

-- ---------- 在庫の予約（0148 と同じ。店頭のみの商品を断る 1 行だけ） ----------
create or replace function reserve_stock(p_shop_id uuid, p_items jsonb, p_ttl_seconds integer default 900,
                                         p_quote_id text default null, p_subject_hash text default null, p_ip_hash text default null,
                                         p_customer_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku_id uuid;
  v_qty integer;
  v_price integer;
  v_updated integer;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id uuid;
  v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reserve_stock: service_role only' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_items';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_ttl';
  end if;

  -- 同じ quote で生きた予約があれば拒む（決済ページを開かずに在庫だけ押さえ続けるのを止める）
  if p_quote_id is not null and exists (select 1 from reservations where shop_id = p_shop_id and quote_id = p_quote_id and status in ('pending', 'confirmed')) then
    raise exception 'quote_already_used';
  end if;
  -- 同じ人・同じ IP の未確定の予約の数（数えてから入れるまでを直列にする）。
  -- 0 円の注文はその場で confirmed になり pending が残らないので、直近 1 時間の 0 円注文（orders.payment_provider = 'free'）も数える（0056）
  if p_subject_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation|' || p_shop_id::text || '|' || p_subject_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.subject_hash = p_subject_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_customer', 3) then
      raise exception 'too_many_reservations' using detail = 'customer';
    end if;
  end if;
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation-ip|' || p_shop_id::text || '|' || p_ip_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.ip_hash = p_ip_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_ip', 20) then
      raise exception 'too_many_reservations' using detail = 'ip';
    end if;
  end if;

  -- 会員限定の商品（audience_id）は、条件に合う会員だけが買える（product_member_skus の purchasable と同じ判定を DB でも）
  if p_customer_id is not null then v_aud := banto_member_audience_ids(p_shop_id, p_customer_id); end if;

  -- sku_id 順に処理し、複数予約が同じ SKU 群を逆順でロックしてデッドロックするのを防ぐ
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku_id := (v_item->>'sku_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_sku_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'invalid_item' using detail = coalesce(v_item::text, 'null');
    end if;

    select k.price_jpy into v_price
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = k.shop_id
     where k.id = v_sku_id and k.shop_id = p_shop_id and p.published and s.published
       and (p.audience_id is null or (p_customer_id is not null and p.audience_id = any(v_aud)))
       -- 発売日の前（Coming Soon、0148）は買えない
       and (p.released_at is null or p.released_at <= now())
       -- 店頭のみの商品（0149）はネットでは買えない（お店で試着の申し込みはできる）
       and not p.store_only;
    if not found then
      raise exception 'sku_not_available' using detail = v_sku_id::text;
    end if;

    update inventory
       set available = available - v_qty, updated_at = now()
     where sku_id = v_sku_id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'insufficient_stock' using detail = v_sku_id::text;
    end if;

    v_items := v_items || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'unit_price_jpy', v_price);
  end loop;

  insert into reservations (shop_id, items, expires_at, quote_id, subject_hash, ip_hash)
  values (p_shop_id, v_items, now() + make_interval(secs => p_ttl_seconds), p_quote_id, p_subject_hash, p_ip_hash)
  returning id into v_reservation_id;

  return v_reservation_id;
end;
$$;

revoke execute on function reserve_stock(uuid, jsonb, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function reserve_stock(uuid, jsonb, integer, text, text, text, uuid) to service_role;

-- ---------- 会員のカートの SKU（0148 と同じ。商品に store_only） ----------
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
             'sku', to_jsonb(k) || jsonb_build_object('available', least(greatest(coalesce(inv.available, 0), 0), 99),
                                                      'price_jpy', banto_sku_member_price(k.id, p_customer_id, v_aud), 'regular_price_jpy', k.price_jpy),
             'product', jsonb_build_object('id', p.id, 'shop_id', p.shop_id, 'slug', p.slug, 'name', p.name, 'description', p.description, 'published', p.published,
                                           'created_at', p.created_at, 'updated_at', p.updated_at, 'tags', p.tags, 'category_id', p.category_id, 'brand', p.brand,
                                           'tax_class', p.tax_class, 'extra_category_ids', p.extra_category_ids, 'audience_id', p.audience_id, 'audience_mode', p.audience_mode, 'released_at', p.released_at, 'store_only', p.store_only),
             'purchasable', p.audience_id is null or p.audience_id = any(v_aud)))
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
      left join inventory inv on inv.sku_id = k.id
     where k.shop_id = p_shop_id and k.id = any(p_sku_ids) and p.published and s.published
       and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))), '[]'::jsonb);
end;
$$;

-- ---------- AI 用 API の商品（0148 と同じ。store_only を足す） ----------
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
                        audience_id, audience_mode, audience_hide, released_at, publish_at, store_only)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'),
          v_aud.audience_id, v_aud.audience_mode, v_aud.audience_hide, v_released, v_publish, v_store_only)
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
    store_only = case when p_values ? 'store_only' then banto_api_store_only(p_values->'store_only', store_only) else store_only end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

insert into banto_migrations (version) values ('0149_product_store_only');
