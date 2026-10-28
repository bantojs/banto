-- Banto 0069_headless_account_page: 会員ページを連携サイトに向ける（人間の決定 2026-10-28）。前方専用。
--   - 会員ページ（連携サイト）は shops.settings.headless.account_page_url（許可リストのオリジンの https。確かめるのは Worker の保存）。
--     会員へのお知らせのメール（ログインがあった・パスワードを決めた）のリンクに使う。公開の settings にも出す
--   - 試着のお知らせのメールの「お店」のリンク: お店の画面を使わない（off / checkout）ショップは外のサイト（storefront.site_url）へ。
--     そのために tryon_contact（0025）の shop に storefront を足す
--   - AI 用 API の GET /shop（api_shop_get、0033）がヘッドレス連携とお店の画面の使い方の設定を返す（連携側のプラグインが入れ漏れを確かめる）

-- 公開の settings（0066 を差し替え: headless.account_page_url を足す）
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

-- 試着のお知らせの材料（0025 を差し替え: shop.storefront を足す）
create or replace function tryon_contact(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_st stores%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_st from stores where id = v_r.store_id;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'request_id', v_r.id, 'number', v_r.number, 'status', v_r.status, 'visit_date', v_r.visit_date, 'hold_until', v_r.hold_until,
    'customer_email', v_r.customer_email, 'customer_name', v_r.customer_name, 'customer_phone', v_r.customer_phone, 'note', v_r.note,
    'store', jsonb_build_object('name', v_st.name, 'postal_code', v_st.postal_code, 'address', v_st.address, 'phone', v_st.phone,
                                'email', v_st.email, 'notify_email', v_st.notify_email, 'hours', v_st.hours, 'special_days', v_st.special_days),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain, 'contact_email', v_s.settings->>'contact_email', 'settings', v_s.settings->'store_tryon',
                               'storefront', jsonb_build_object('mode', v_s.settings->'storefront'->>'mode', 'site_url', v_s.settings->'storefront'->>'site_url')),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = v_r.id));
end;
$$;
revoke execute on function tryon_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function tryon_contact(uuid, uuid) to service_role;

-- AI 用 API の GET /shop（0033 を差し替え: headless と storefront を足す）
create or replace function api_shop_get(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_shop shops%rowtype;
begin
  v_tok := api_require(p_token_hash, 'shop:read');
  select * into v_shop from shops where id = v_tok.shop_id;
  return jsonb_build_object(
    'id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'published', v_shop.published,
    'legal_notice', v_shop.legal_notice, 'privacy_policy', v_shop.privacy_policy, 'return_policy', v_shop.return_policy,
    'checkout_terms', jsonb_build_object(
      'delivery', nullif(btrim(v_shop.settings->'checkout_terms'->>'delivery'), ''),
      'cancellation', nullif(btrim(v_shop.settings->'checkout_terms'->>'cancellation'), ''),
      'payment_note', nullif(btrim(v_shop.settings->'checkout_terms'->>'payment_note'), '')),
    'low_stock_threshold', coalesce((v_shop.settings->>'low_stock_threshold')::integer, 3),
    'max_pending_per_ip', banto_shop_limit(v_shop.id, 'checkout', 'max_pending_per_ip', 20),
    'login_per_ip_per_hour', banto_shop_limit(v_shop.id, 'members_login_limits', 'per_ip_per_hour', 30),
    'stripe_connected', v_shop.stripe_account_id is not null,
    -- ヘッドレス連携の設定（0069。連携側のプラグインが入れ漏れを確かめるため。秘密は無い）
    'headless', jsonb_build_object(
      'return_origins', coalesce(v_shop.settings->'headless'->'return_origins', '[]'::jsonb),
      'relay_ips', coalesce(v_shop.settings->'headless'->'relay_ips', '[]'::jsonb),
      'order_page_url', v_shop.settings->'headless'->>'order_page_url',
      'account_page_url', v_shop.settings->'headless'->>'account_page_url',
      'legal_links', coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(v_shop.settings->'headless'->'legal_links') = 'object' then v_shop.settings->'headless'->'legal_links' else '{}'::jsonb end) e(k, v)
                               where k in ('legal', 'privacy', 'returns') and jsonb_typeof(v) = 'string'), '{}'::jsonb)),
    'storefront', jsonb_build_object('mode', coalesce(v_shop.settings->'storefront'->>'mode', 'full'), 'site_url', v_shop.settings->'storefront'->>'site_url', 'product_url', v_shop.settings->'storefront'->>'product_url'),
    'created_at', v_shop.created_at, 'updated_at', v_shop.updated_at);
end;
$$;

insert into banto_migrations (version) values ('0069_headless_account_page');
