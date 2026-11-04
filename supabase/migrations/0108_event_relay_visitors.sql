-- Banto 0108_event_relay_visitors: お店の行動の中継（0107）の段階 4b。ゲストの訪問者 ID と、ログインで会員に結ぶ visitor.identified
-- （メンテナの決定 2026-11-04、docs/event-relay.md）。前方専用。
--   - 訪問者 ID はブラウザが作る（Banto は溜めない・DB に書かない）。ゲストの行動を渡すのは、運営者が「ゲストも」と許した連携だけ
--     （マニフェストの visitors が all で、許しも all。重なりは 0107 の banto_relay_effective）
--   - お店の画面は、そういう連携があるショップのゲストのページにだけスクリプトを載せる。その判定のために、公開のショップ行に
--     relay_guests を足す（ショップ行と一緒にキャッシュされるので、ページのたびに DB に問い合わせない）

-- 0100 の banto_shop_public_json に relay_guests を足しただけ
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'option_names', s.option_names,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null),
    'pages_nav', case when s.settings->'modules'->'pages' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'title', p.title, 'nav', p.nav) order by p.sort_order, p.created_at), '[]'::jsonb)
         from pages p where p.shop_id = s.id and p.published and p.deleted_at is null
          and (p.published_at is null or p.published_at <= now()) and p.nav <> 'none' and p.audience_id is null)
      else '[]'::jsonb end,
    'blogs_nav', case when s.settings->'modules'->'blog' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', b.handle, 'title', b.title, 'nav', b.nav) order by b.sort_order, b.created_at), '[]'::jsonb)
         from blogs b where b.shop_id = s.id and b.nav <> 'none')
      else '[]'::jsonb end,
    -- 0108: ゲストの行動を渡す連携があるか（モジュール event_relay が ON のときだけ）。お店の画面がゲストのページにスクリプトを載せるかを決める
    'relay_guests', coalesce(s.settings->'modules'->'event_relay' = 'true'::jsonb, false) and exists (
      select 1 from hook_endpoints e
       where e.shop_id = s.id and e.enabled and e.url not like 'https://banto.invalid/%'
         and banto_relay_effective(e.manifest->'storefront_events', e.storefront_events)->>'visitors' = 'all'));
$$;

insert into banto_migrations (version) values ('0108_event_relay_visitors');
