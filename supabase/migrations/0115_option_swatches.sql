-- Banto 0115_option_swatches: 選択肢の値ごとの見本（色・画像）。メンテナの決定 2026-11-05（段階 2 の B10、docs/storefront.md「選択肢の見本」）。前方専用。
--   - shops.option_swatches = { <軸の key>: { <値>: { "color": "#rrggbb" } | { "image": { "key", "width", "height" } } } }
--     ショップ全体で 1 つの表（「ネイビー」はどの商品でも同じ色）。軸の key は 0094 の名前の表にあるものだけ
--   - 画像は管理画面のブラウザで小さく縮めて置き場の swatches/<ショップ>/ に置く（サーバーでは画像を処理しない）。key はこのショップの場所だけ
--   - 1 ショップ 500 個まで・値は 60 文字まで。形は制約で確かめる。書くのは option_swatches_set（項目 catalog）
--   - お客様の画面へは公開のショップ行（banto_shop_public_json）と一緒に渡す（ショップ行と一緒にキャッシュ。往復を増やさない）

create or replace function banto_option_swatches_ok(p jsonb, p_shop uuid)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and (select count(*) from jsonb_each(p) a, jsonb_each(case when jsonb_typeof(a.value) = 'object' then a.value else '{}'::jsonb end) v) <= 500
    and not exists (
      select 1 from jsonb_each(p) a
       where a.key !~ '^[a-z][a-z0-9_]{0,31}$' or jsonb_typeof(a.value) <> 'object'
          or exists (
            select 1 from jsonb_each(a.value) v
             where char_length(v.key) not between 1 and 60
                or jsonb_typeof(v.value) <> 'object'
                -- 欠けた鍵は NULL になり、NOT と OR を素通りするので coalesce で偽に
                or not coalesce(
                  (v.value ? 'color' and not v.value ? 'image' and (v.value->>'color') ~ '^#[0-9a-f]{6}$'
                    and (select count(*) from jsonb_object_keys(v.value)) = 1)
                  or (v.value ? 'image' and not v.value ? 'color' and jsonb_typeof(v.value->'image') = 'object'
                    and (select count(*) from jsonb_object_keys(v.value)) = 1
                    and coalesce((v.value->'image'->>'key') ~ ('^swatches/' || p_shop::text || '/[a-f0-9]{8,64}\.(webp|png|jpg)$'), false)
                    and jsonb_typeof(v.value->'image'->'width') = 'number' and jsonb_typeof(v.value->'image'->'height') = 'number'
                    and (v.value->'image'->>'width')::numeric between 1 and 512 and (v.value->'image'->>'height')::numeric between 1 and 512),
                  false)
          )
    ),
    false);
$$;
revoke execute on function banto_option_swatches_ok(jsonb, uuid) from public, anon;
grant execute on function banto_option_swatches_ok(jsonb, uuid) to authenticated, service_role;

alter table shops add column if not exists option_swatches jsonb not null default '{}'::jsonb;
alter table shops drop constraint if exists shops_option_swatches_check;
alter table shops add constraint shops_option_swatches_check check (banto_option_swatches_ok(option_swatches, id));

-- 1 つの軸の見本を差し替える（p_values = { <値>: 見本 }。空の物なら軸ごと外す）。軸は名前の表にある key だけ。
-- 返すのは差し替えで使われなくなった画像の鍵（Worker が置き場から消す）
create or replace function option_swatches_set(p_shop_id uuid, p_axis text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_all jsonb; v_old jsonb; v_next jsonb; v_removed jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_option_swatches'; end if;
  select option_swatches, option_names into v_all, v_next from shops where id = p_shop_id for update;
  if not found or not coalesce(v_next ? p_axis, false) then raise exception 'invalid_option_swatches'; end if;
  v_old := coalesce(v_all->p_axis, '{}'::jsonb);
  v_next := case when p_values = '{}'::jsonb then v_all - p_axis else v_all || jsonb_build_object(p_axis, p_values) end;
  if not banto_option_swatches_ok(v_next, p_shop_id) then raise exception 'invalid_option_swatches'; end if;
  update shops set option_swatches = v_next where id = p_shop_id;
  select coalesce(jsonb_agg(distinct o.value->'image'->>'key'), '[]'::jsonb) into v_removed
    from jsonb_each(v_old) o
   where o.value ? 'image'
     and not exists (select 1 from jsonb_each(coalesce(v_next->p_axis, '{}'::jsonb)) n where n.value->'image'->>'key' = o.value->'image'->>'key');
  return jsonb_build_object('swatches', coalesce(v_next->p_axis, '{}'::jsonb), 'removed_image_keys', v_removed);
end;
$$;
revoke execute on function option_swatches_set(uuid, text, jsonb) from public, anon;
grant execute on function option_swatches_set(uuid, text, jsonb) to authenticated, service_role;

-- 公開のショップ行に見本の表を足す（0110 の banto_shop_public_json に 1 行足しただけ）
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'option_names', s.option_names,
    'option_swatches', s.option_swatches,
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
         and banto_relay_effective(e.manifest->'storefront_events', e.storefront_events)->>'visitors' = 'all'),
    -- 0110: お店の画面のダイアログ（モジュール dialogs が ON のときだけ。有効で期間内のもの、優先の高い順に 20 まで）
    'dialogs', case when s.settings->'modules'->'dialogs' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'layout', d.layout, 'title', d.title, 'body', d.body, 'image_url', d.image_url,
                                                    'buttons', d.buttons, 'coupon_code', d.coupon_code, 'audience', d.audience, 'audience_id', d.audience_id,
                                                    'pages', d.pages, 'trigger', d.trigger, 'snooze_days', d.snooze_days)
                                 order by d.priority desc, d.created_at), '[]'::jsonb)
         from (select * from dialogs x where x.shop_id = s.id and x.enabled
                  and (x.starts_at is null or x.starts_at <= now()) and (x.ends_at is null or x.ends_at > now())
                order by x.priority desc, x.created_at limit 20) d)
      else '[]'::jsonb end);
$$;

insert into banto_migrations (version) values ('0115_option_swatches');
