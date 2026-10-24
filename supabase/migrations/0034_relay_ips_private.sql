-- Banto 0034_relay_ips_private: 中継元の IP（settings.headless.relay_ips）を公開の settings から外す（外部レビューの指摘 2026-10-18 その 2）
-- 前方専用。
--
-- 0033 では relay_ips を公開の settings（shop_public_get / shop_public_list、anon が呼べる）に含めていた。
-- これは連携側（WordPress 等）のサーバーの素の IP で、CDN / WAF の後ろに置いていても直接攻撃できてしまう。
-- 判定に使うのは Worker だけなので、公開しない。Worker は service_role で shops.settings を読み（X-Banto-Client-IP が付いた通信のときだけ）、
-- ショップ行と同じ時間だけキャッシュする（src/routes/common.ts の clientIpFor）。

create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt', 'product_fields',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding')), '{}'::jsonb)
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

insert into banto_migrations (version) values ('0034_relay_ips_private');
