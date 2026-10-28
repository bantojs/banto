-- Banto 0066_headless_order_lookup: 注文照会・領収書をヘッドレスで（人間の決定 2026-10-28）。前方専用。
--   - Banto はデータ（JSON）だけを渡し、レイアウト・印刷の体裁は連携サイトが決める
--   - 注文照会のページ（連携サイト）は shops.settings.headless.order_page_url（許可リストのオリジンの https。確かめるのは Worker の保存）。
--     注文メールのリンク（?banto_order=<番号>&banto_member=1）と、Banto の注文照会の画面の転送先に使う
--   - 会員の注文は会員トークンで（member_order、0023）、ゲストの注文は番号とメールアドレスで（lookup_order、今までどおり）

-- 注文の中身（lookup_order と会員の注文で同じ形。住所・アドレスは入れない）
create or replace function banto_order_view(p_o orders)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('number', p_o.number, 'status', p_o.status, 'created_at', p_o.created_at, 'shipped_at', p_o.shipped_at,
                            'total_jpy', p_o.total_jpy, 'shipping_jpy', p_o.shipping_jpy, 'discount_jpy', p_o.discount_jpy,
                            'shipping_tax_rate', p_o.shipping_tax_rate, 'tax_rounding', p_o.tax_rounding, 'payment_provider', p_o.payment_provider,
                            'tracking', case when p_o.tracking_number is not null then jsonb_build_object('carrier', p_o.tracking_carrier, 'number', p_o.tracking_number) end,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(p_o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'sku', coalesce(oi.item_variant, k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = p_o.id));
$$;
revoke execute on function banto_order_view(orders) from public, anon, authenticated;

-- ゲストの注文照会（0023 を差し替え。中身は banto_order_view にまとめただけで、形は同じ）
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select banto_order_view(o)
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;
revoke execute on function lookup_order(uuid, integer, text) from public;
grant execute on function lookup_order(uuid, integer, text) to anon, authenticated, service_role;

-- 会員の注文（0023 を差し替え。その会員の注文だけ・世代を確かめる。中身は banto_order_view にまとめただけで、形は同じ）
create or replace function member_order(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_number integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_o orders%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_order: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  select * into v_o from orders where shop_id = p_shop_id and customer_id = p_customer_id and number = p_number;
  if not found then return null; end if;
  return banto_order_view(v_o);
end;
$$;
revoke execute on function member_order(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function member_order(uuid, uuid, integer, integer) to service_role;

-- 注文メールの材料（0022 を差し替え: 会員の注文か・注文照会のページ・許可リストを足す）
create or replace function order_contact(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'created_at', v_o.created_at,
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'shipping_tax_rate', v_o.shipping_tax_rate, 'tax_rounding', v_o.tax_rounding,
    'tracking', case when v_o.tracking_number is not null then jsonb_build_object('carrier', v_o.tracking_carrier, 'number', v_o.tracking_number) end,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    -- 0066: 会員の注文か（メールのリンクの目印）と、注文照会のページ（連携サイト）。どちらも鍵ではない
    'member', v_o.customer_id is not null,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                               'order_page_url', v_s.settings->'headless'->>'order_page_url',
                               'return_origins', coalesce(v_s.settings->'headless'->'return_origins', '[]'::jsonb),
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy,
                               'tax', jsonb_build_object('tax_rate', v_s.settings->'tax_rate', 'tax_rate_reduced', v_s.settings->'tax_rate_reduced', 'tax_rounding', v_s.settings->'tax_rounding')),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                           'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

-- 公開の settings に注文照会のページを出す（0055 を差し替え。お客様の画面の転送に使う。鍵ではない）
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent')), '{}'::jsonb)
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb))
                                                || case when jsonb_typeof(p->'headless'->'order_page_url') = 'string'
                                                        then jsonb_build_object('order_page_url', p->'headless'->'order_page_url') else '{}'::jsonb end)
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

insert into banto_migrations (version) values ('0066_headless_order_lookup');
