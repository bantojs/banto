-- 0148_product_sale_dates: 発売日を「販売開始日」に（Coming Soon）と、商品の予約公開（メンテナの決定 2026-11-17、docs/storefront.md「発売日と公開日」）
--   - 発売日（products.released_at、0146）が未来の商品は、お店に見えるが買えない（Coming Soon）。カートに入れる・値付け・最終確認・在庫の予約・
--     お店で試着の申し込みのどれでも断る。判定は TS の一本道（src/products/sale.ts → priceCart）と、DB の reserve_stock・tryon_request（ここ）。
--     発売日になれば DB の時計で自動で買える（Cron は要らない）。過去の発売日（移行で入れる元の発売日）は今までどおり並びだけ
--   - 公開日（products.publish_at、任意）: 非公開の商品をその日時に公開する予約。公開は Cron（publish_scheduled_products）が published を true にする
--     （一覧の件数の集計（product_facets）・キャッシュ・RLS は今の「published」のまま動く。粒度は Cron の間隔）。
--     公開した商品・手で公開した商品には publish_at を残さない（トリガー）
--   - 作成日（created_at）は書き換えない
--   - reserve_stock・tryon_request は 0129 の定義に条件を 1 行足しただけ。api_product_* は 0146 に publish_at を足しただけ

alter table products add column if not exists publish_at timestamptz;
create index if not exists products_publish_due on products (publish_at) where publish_at is not null and not published;

-- 公開している商品には publish_at を残さない（予約は「非公開の商品を公開する」ためだけ）
create or replace function banto_products_publish_at_clear()
returns trigger language plpgsql as $$
begin
  if new.published then new.publish_at := null; end if;
  return new;
end;
$$;
revoke execute on function banto_products_publish_at_clear() from public, anon, authenticated;
drop trigger if exists products_publish_at_clear on products;
create trigger products_publish_at_clear before insert or update of published, publish_at on products for each row execute function banto_products_publish_at_clear();

-- AI 用 API の公開日: ISO 8601 の日時の文字列か null。今から 10 年後まで（過去の日時は次の Cron で公開）
create or replace function banto_api_publish_at(p jsonb)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare v timestamptz;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or (p #>> '{}') !~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$' then
    raise exception 'invalid_publish_at' using errcode = '22023';
  end if;
  begin
    -- 時差の無い値は UTC として読む（0146 の発売日と同じ）
    v := case when (p #>> '{}') ~ '[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' then (p #>> '{}')::timestamptz
              else ((p #>> '{}')::timestamp at time zone 'UTC') end;
  exception when others then
    raise exception 'invalid_publish_at' using errcode = '22023';
  end;
  if v > now() + interval '10 years' then raise exception 'invalid_publish_at' using errcode = '22023'; end if;
  return v;
end;
$$;
revoke execute on function banto_api_publish_at(jsonb) from public, anon, authenticated;

-- Cron: 公開日を過ぎた非公開の商品を公開する（1 回に 500 まで）。公開したら product.updated の hooks を積む
create or replace function publish_scheduled_products()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_row record; v_n integer := 0;
begin
  for v_row in
    update products p set published = true
     where p.id in (select id from products where publish_at is not null and not published and publish_at <= now()
                     order by publish_at limit 500 for update skip locked)
    returning p.id, p.shop_id, p.slug, p.name
  loop
    perform enqueue_hook(v_row.shop_id, 'product.updated', jsonb_build_object('product_id', v_row.id, 'shop_id', v_row.shop_id, 'slug', v_row.slug, 'name', v_row.name, 'published', true));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function publish_scheduled_products() from public, anon, authenticated;
grant execute on function publish_scheduled_products() to service_role;

-- バックアップの復元: 公開日（予約公開）を URL の名前で戻す（非公開の商品だけ。restore_catalog の後に呼ぶ）。p_items は [{ slug, publish_at }]
create or replace function restore_product_publish_at(p_shop_id uuid, p_items jsonb)
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
      v_at := banto_api_publish_at(v_row->'publish_at');
    exception when others then
      continue;
    end;
    if v_at is null then continue; end if;
    update products set publish_at = v_at where shop_id = p_shop_id and slug = v_row->>'slug' and not published;
    if found then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('products_publish_at', v_n);
end;
$$;
revoke execute on function restore_product_publish_at(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_product_publish_at(uuid, jsonb) to service_role;

-- ---------- 在庫の予約（0129 と同じ。発売日の前の商品を断る 1 行だけ） ----------
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
       and (p.released_at is null or p.released_at <= now());
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

-- ---------- お店で試着の申し込み（0129 と同じ。発売日の前の商品を断る 1 行だけ） ----------
create or replace function tryon_request(p_shop_id uuid, p_store_id uuid, p_items jsonb, p_customer jsonb, p_visit_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it jsonb; v_sku skus%rowtype; v_qty integer; v_n integer; v_id uuid; v_number integer; v_cid uuid; v_total integer := 0;
  v_email text; v_ip text; v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_request: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and published) then raise exception 'shop_not_found'; end if;
  if not exists (select 1 from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = p_shop_id and ss.store_id = p_store_id and ss.tryon and st.active) then
    raise exception 'store_not_available';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then raise exception 'invalid_items'; end if;
  if position('@' in coalesce(p_customer->>'customer_email', '')) < 2 then raise exception 'invalid_customer'; end if;
  v_email := lower(btrim(p_customer->>'customer_email'));
  v_ip := case when (p_customer->>'ip_hash') ~ '^[0-9a-f]{64}$' then p_customer->>'ip_hash' end;
  v_cid := nullif(p_customer->>'customer_id', '')::uuid;
  if v_cid is not null and not exists (select 1 from customers where shop_id = p_shop_id and id = v_cid) then v_cid := null; end if;
  if v_cid is not null then v_aud := banto_member_audience_ids(p_shop_id, v_cid); end if;

  perform pg_advisory_xact_lock(hashtextextended('tryon|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from tryon_requests where shop_id = p_shop_id and customer_email = v_email and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_customer', 3) then
    raise exception 'too_many_requests' using detail = 'customer';
  end if;
  if v_ip is not null and (select count(*) from tryon_requests where shop_id = p_shop_id and ip_hash = v_ip and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_ip', 10) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;

  update shops set tryon_seq = tryon_seq + 1 where id = p_shop_id returning tryon_seq into v_number;
  insert into tryon_requests (shop_id, store_id, number, visit_date, customer_id, customer_email, customer_name, customer_phone, note, ip_hash)
  values (p_shop_id, p_store_id, v_number, p_visit_date, v_cid, v_email,
          left(nullif(btrim(coalesce(p_customer->>'customer_name', '')), ''), 100), left(nullif(btrim(coalesce(p_customer->>'customer_phone', '')), ''), 20),
          left(nullif(btrim(coalesce(p_customer->>'note', '')), ''), 500), v_ip)
  returning id into v_id;

  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_qty := case when coalesce(v_it->>'qty', '') ~ '^[0-9]{1,2}$' then (v_it->>'qty')::integer else 0 end;
    if v_qty <= 0 then raise exception 'invalid_items'; end if;
    select k.* into v_sku from skus k join products p on p.id = k.product_id
     where k.id = nullif(v_it->>'sku_id', '')::uuid and k.shop_id = p_shop_id and p.published
       -- 会員限定の商品は、条件に合う会員だけ（product_member_skus の purchasable と同じ）
       and (p.audience_id is null or (v_cid is not null and p.audience_id = any(v_aud)))
       -- 発売日の前（Coming Soon、0148）は申し込めない
       and (p.released_at is null or p.released_at <= now());
    if not found then raise exception 'sku_not_available'; end if;
    update inventory set available = available - v_qty where sku_id = v_sku.id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'insufficient_stock' using detail = v_sku.id::text; end if;
    insert into tryon_items (shop_id, request_id, sku_id, qty, unit_price_jpy) values (p_shop_id, v_id, v_sku.id, v_qty, v_sku.price_jpy);
    v_total := v_total + v_qty;
  end loop;
  if v_total > 20 then raise exception 'invalid_items'; end if;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.requested',
    jsonb_build_object('request_id', v_id, 'number', v_number, 'shop_id', p_shop_id, 'store_id', p_store_id, 'status', 'requested',
                       'visit_date', p_visit_date, 'customer_id', v_cid));
  return jsonb_build_object('id', v_id, 'number', v_number);
end;
$$;

-- ---------- 会員のカートの SKU（0099 と同じ。商品に released_at を足す。Coming Soon の判定は Worker の src/products/sale.ts） ----------
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
                                           'tax_class', p.tax_class, 'extra_category_ids', p.extra_category_ids, 'audience_id', p.audience_id, 'audience_mode', p.audience_mode, 'released_at', p.released_at),
             'purchasable', p.audience_id is null or p.audience_id = any(v_aud)))
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
      left join inventory inv on inv.sku_id = k.id
     where k.shop_id = p_shop_id and k.id = any(p_sku_ids) and p.published and s.published
       and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))), '[]'::jsonb);
end;
$$;

-- ---------- AI 用 API の商品（0146 と同じ。publish_at を足す） ----------
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
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at, 'released_at', p_product.released_at, 'publish_at', p_product.publish_at,
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
declare v_tok api_tokens; v_p products%rowtype; v_aud record; v_released timestamptz; v_publish timestamptz;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  select * into v_aud from banto_api_product_audience(v_tok.shop_id, p_values, null::products);
  v_released := banto_api_released_at(p_values->'released_at');
  v_publish := banto_api_publish_at(p_values->'publish_at');
  insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id, extra_category_ids,
                        audience_id, audience_mode, audience_hide, released_at, publish_at)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'),
          nullif(btrim(coalesce(p_values->>'brand', '')), ''), banto_clean_object(p_values->'attributes', 50),
          api_category_ref(v_tok.shop_id, p_values->>'category'), api_category_refs(v_tok.shop_id, p_values->'extra_categories'),
          v_aud.audience_id, v_aud.audience_mode, v_aud.audience_hide, v_released, v_publish)
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
    publish_at = case when p_values ? 'publish_at' then banto_api_publish_at(p_values->'publish_at') else publish_at end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

insert into banto_migrations (version) values ('0148_product_sale_dates');
