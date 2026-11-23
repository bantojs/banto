-- 0165_checkout_members_only: 注文は会員だけ（ショップの設定 checkout_members_only、既定 OFF）。前方専用。2026-11-23（docs/members.md）。
--   - 会員機能（members_enabled）が ON で checkout_members_only が true のショップでは、会員でない予約（reserve_stock の p_customer_id が無い）を
--     member_required で断る。お店の画面・ヘッドレス・どの支払い方法（Stripe・KOMOJU・Amazon Pay・代金引換・0 円）も reserve_stock を通るので、ここで閉じる
--   - 会員の登録はログインのときにその場で作るので、「会員登録が必須」= 「購入手続きにはログインが必須」
--   - 設定の鍵は owner / admin（banto_shop_settings_perm、0155 を差し替え）。お客様の画面にも渡す（カートの案内、banto_shop_public_settings、0157 を差し替え）
--   - reserve_stock は 0149 と同じ（上の 1 つの判定を足しただけ）

create or replace function banto_checkout_members_only(p_settings jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(p_settings->'members_enabled' = 'true'::jsonb and p_settings->'checkout_members_only' = 'true'::jsonb, false);
$$;
revoke execute on function banto_checkout_members_only(jsonb) from public, anon, authenticated;

create or replace function banto_shop_settings_perm(p_key text, p_module text)
returns text
language sql
immutable
as $$
  select case
    when p_key = 'modules' then case p_module
      when 'coupons' then 'marketing' when 'dialogs' then 'marketing' when 'audiences' then 'marketing' when 'product_feed' then 'marketing'
      when 'inquiries' then 'support'
      when 'pages' then 'content' when 'blog' then 'content'
      when 'care_labels' then 'catalog' when 'size_charts' then 'catalog' when 'embed' then 'catalog' when 'woo_import' then 'catalog'
      when 'event_relay' then 'integrations' when 'line_login' then 'integrations' when 'google_login' then 'integrations' when 'passkey' then 'integrations'
      when 'shipping_labels' then 'orders'
      when 'store_tryon' then 'stores'
      when 'favorites' then 'customers'
      when 'member_news' then 'marketing'
      else null end
    when p_key in ('headless', 'oauth') then 'integrations'
    when p_key = 'page_layouts' then 'content'
    when p_key = 'product_fields' then 'catalog'
    when p_key = 'customer_fields' then 'customers'
    when p_key = 'views_orders' then 'orders'
    when p_key = 'views_customers' then 'customers'
    when p_key = 'views_products' then 'catalog'
    when p_key = 'views_inquiries' then 'support'
    when p_key in ('members_login_limits', 'checkout', 'inquiries', 'order_lookup', 'line_marketing_limit', 'storefront',
                   'members_password', 'members_enabled', 'marketing_consent', 'images', 'store_tryon', 'legal_links',
                   'checkout_members_only') then 'admin'
    else null end;
$$;
revoke execute on function banto_shop_settings_perm(text, text) from public, anon, authenticated;

create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent', 'page_layouts', 'cod',
                                'checkout_members_only')), '{}'::jsonb)
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb))
                                                || case when jsonb_typeof(p->'headless'->'order_page_url') = 'string'
                                                        then jsonb_build_object('order_page_url', p->'headless'->'order_page_url') else '{}'::jsonb end
                                                || case when jsonb_typeof(p->'headless'->'account_page_url') = 'string'
                                                        then jsonb_build_object('account_page_url', p->'headless'->'account_page_url') else '{}'::jsonb end)
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

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
  -- 注文は会員だけのショップ（0165）: 会員でない予約は断る（お店の画面・ヘッドレス・どの支払い方法でも）
  -- （会員はこのショップの会員だけ。ログインの世代は予約に結ぶとき attach_reservation_customer が確かめる）
  if exists (select 1 from shops s where s.id = p_shop_id and banto_checkout_members_only(s.settings))
     and (p_customer_id is null or not exists (select 1 from customers c where c.id = p_customer_id and c.shop_id = p_shop_id)) then
    raise exception 'member_required' using errcode = '42501';
  end if;
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

insert into banto_migrations (version) values ('0165_checkout_members_only');
