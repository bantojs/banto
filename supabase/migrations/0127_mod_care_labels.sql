-- Banto 0127_mod_care_labels: 同梱モジュール「洗濯表示」（care_labels、既定 OFF）。メンテナの決定 2026-11-08（docs/care-labels.md）。前方専用。
--   - 記号は JIS L 0001:2024 の記号番号（43 個）で持つ。区分（家庭洗濯・漂白・タンブル乾燥・自然乾燥・アイロン・ドライ・ウエット）ごとに 1 つまで
--     products.care / categories.care = { "symbols": ["140", "210", ...], "notes": ["ネット使用", ...] }（null = 決めていない）
--   - 商品に無ければ主カテゴリーから親へたどって近いカテゴリーのもの（写さずに表示のときに決める。部品は src/care-labels/care.ts）
--   - 記号の絵は Banto に同梱しない（記号は国によって登録商標。公式のデータは運営者が入手して持ち込む）。
--     shops.care_symbols = { "<記号番号>": { "key": "care/<ショップ>/<乱数>.(webp|png)", "width", "height" } }、書くのは care_symbols_set（項目 catalog）
--   - お客様の画面へは、商品・カテゴリーは今までの読み取り（列が増えるだけ）、絵の表は公開のショップ行（banto_shop_public_json、モジュールが ON のときだけ）

create or replace function banto_care_codes()
returns text[] language sql immutable set search_path = public as $$
  select array['190','170','160','161','150','151','140','141','142','130','131','132','110','111','100',
               '220','210','200',
               '320','310','300',
               '440','445','430','435','420','425','410','415',
               '530','520','510','511','500',
               '620','621','610','611','600',
               '710','711','712','700']::text[];
$$;
revoke execute on function banto_care_codes() from public, anon;
grant execute on function banto_care_codes() to authenticated, service_role;

-- 形: 鍵は symbols と notes だけ。記号は知っている番号・区分（番号の 1 桁目）ごとに 1 つ・7 つまで。付記は 8 つまで・1〜40 文字
create or replace function banto_care_ok(p jsonb)
returns boolean language sql immutable set search_path = public as $$
  select p is null or coalesce(
    jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('symbols', 'notes'))
    and (not p ? 'symbols' or (
      jsonb_typeof(p->'symbols') = 'array'
      and jsonb_array_length(p->'symbols') <= 7
      and not exists (select 1 from jsonb_array_elements(p->'symbols') e where jsonb_typeof(e) <> 'string' or not (e #>> '{}') = any(banto_care_codes()))
      and (select count(distinct left(e #>> '{}', 1)) from jsonb_array_elements(p->'symbols') e) = jsonb_array_length(p->'symbols')))
    and (not p ? 'notes' or (
      jsonb_typeof(p->'notes') = 'array'
      and jsonb_array_length(p->'notes') <= 8
      and not exists (select 1 from jsonb_array_elements(p->'notes') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 40))),
    false);
$$;
revoke execute on function banto_care_ok(jsonb) from public, anon;
grant execute on function banto_care_ok(jsonb) to authenticated, service_role;

alter table products add column if not exists care jsonb;
alter table products drop constraint if exists products_care_check;
alter table products add constraint products_care_check check (banto_care_ok(care));
alter table categories add column if not exists care jsonb;
alter table categories drop constraint if exists categories_care_check;
alter table categories add constraint categories_care_check check (banto_care_ok(care));

-- 記号の絵の表: 知っている番号だけ・このショップの care/ の画像だけ（ブラウザで 256px まで縮めて PNG / WebP にして置く）
create or replace function banto_care_symbols_ok(p jsonb, p_shop uuid)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_each(p) a
       where not a.key = any(banto_care_codes())
          or jsonb_typeof(a.value) <> 'object'
          or (select count(*) from jsonb_object_keys(a.value)) <> 3
          or not coalesce((a.value->>'key') ~ ('^care/' || p_shop::text || '/[a-f0-9]{8,64}\.(webp|png)$'), false)
          or jsonb_typeof(a.value->'width') <> 'number' or jsonb_typeof(a.value->'height') <> 'number'
          or (a.value->>'width')::numeric not between 1 and 256 or (a.value->>'height')::numeric not between 1 and 256),
    false);
$$;
revoke execute on function banto_care_symbols_ok(jsonb, uuid) from public, anon;
grant execute on function banto_care_symbols_ok(jsonb, uuid) to authenticated, service_role;

alter table shops add column if not exists care_symbols jsonb not null default '{}'::jsonb;
alter table shops drop constraint if exists shops_care_symbols_check;
alter table shops add constraint shops_care_symbols_check check (banto_care_symbols_ok(care_symbols, id));

-- 表をまるごと差し替える。返すのは使われなくなった画像の鍵（Worker が置き場から消す）
create or replace function care_symbols_set(p_shop_id uuid, p_symbols jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_removed jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_symbols is null or not banto_care_symbols_ok(p_symbols, p_shop_id) then raise exception 'invalid_care_symbols'; end if;
  select care_symbols into v_old from shops where id = p_shop_id for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  update shops set care_symbols = p_symbols where id = p_shop_id;
  select coalesce(jsonb_agg(distinct o.value->>'key'), '[]'::jsonb) into v_removed
    from jsonb_each(v_old) o
   where not exists (select 1 from jsonb_each(p_symbols) n where n.value->>'key' = o.value->>'key');
  return jsonb_build_object('symbols', p_symbols, 'removed_image_keys', v_removed);
end;
$$;
revoke execute on function care_symbols_set(uuid, jsonb) from public, anon;
grant execute on function care_symbols_set(uuid, jsonb) to authenticated, service_role;

-- AI 用 API（products:write）: 商品かカテゴリーの洗濯表示を置き換える（null で外す）。ref は id か URL の名前
create or replace function api_care_set(p_token_hash text, p_target text, p_ref text, p_care jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_tok api_tokens; v_id uuid; v_care jsonb := case when p_care = 'null'::jsonb then null else p_care end;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if p_target not in ('product', 'category') then raise exception 'invalid_care_target'; end if;
  if not banto_care_ok(v_care) then raise exception 'invalid_care'; end if;
  if p_target = 'product' then
    update products set care = v_care
     where shop_id = v_tok.shop_id and (id::text = p_ref or slug = p_ref) returning id into v_id;
  else
    update categories set care = v_care
     where shop_id = v_tok.shop_id and (id::text = p_ref or slug = p_ref) returning id into v_id;
  end if;
  if v_id is null then raise exception 'not_found'; end if;
  return jsonb_build_object('target', p_target, 'id', v_id, 'care', v_care);
end;
$$;
revoke execute on function api_care_set(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function api_care_set(text, text, text, jsonb) to service_role;

-- 公開のショップ行に記号の絵の表を足す（0115 の banto_shop_public_json に 1 行足しただけ。モジュールが OFF なら空）
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'option_names', s.option_names,
    'option_swatches', s.option_swatches,
    'care_symbols', case when s.settings->'modules'->'care_labels' = 'true'::jsonb then s.care_symbols else '{}'::jsonb end,
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
    'relay_guests', coalesce(s.settings->'modules'->'event_relay' = 'true'::jsonb, false) and exists (
      select 1 from hook_endpoints e
       where e.shop_id = s.id and e.enabled and e.url not like 'https://banto.invalid/%'
         and banto_relay_effective(e.manifest->'storefront_events', e.storefront_events)->>'visitors' = 'all'),
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

insert into banto_migrations (version) values ('0127_mod_care_labels');
