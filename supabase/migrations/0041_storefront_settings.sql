-- Banto 0041_storefront_settings: お店の画面の使い方（storefront）と GA4（analytics）を、お客様の画面に渡す settings に足す。docs/storefront.md
-- 前方専用。値の形は管理画面と src/storefront/mode.ts・src/modules/ga4/ga4.ts が確かめる。ここは公開してよい鍵の allowlist だけ。
--
--   storefront.mode        'full'（既定）/ 'checkout'（商品の一覧と詳細は外のサイト、カートと購入は Banto）/ 'off'（Banto の画面を使わない）
--   storefront.site_url    使わない画面を開かれたときの転送先（https）
--   storefront.product_url 商品ページの転送先（{slug} を商品のスラッグに置き換える。任意）
--   analytics.ga4_id       GA4 の測定 ID（G-XXXXXXXX）。同梱モジュール ga4 が ON のショップのお店の画面だけに入れる（docs/ga4.md）
--
-- どれもお客様の画面の HTML や転送先に出る値なので、公開して困るものではない。

create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt', 'product_fields',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics')), '{}'::jsonb)
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb)))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

insert into banto_migrations (version) values ('0041_storefront_settings');
