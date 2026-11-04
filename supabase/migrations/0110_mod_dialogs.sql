-- Banto 0110_mod_dialogs: お店の画面のダイアログ（同梱モジュール dialogs、既定 OFF。メンテナの決定 2026-11-04、docs/dialogs.md）。前方専用。
--   - 判定するのは「今の訪問・今のページで分かること」だけ（ページの種類・商品・カテゴリー・タグ、秒数・スクロール・離脱しそう・
--     今回の訪問のページ数・カートの金額、会員かゲストか・会員の条件）。履歴・待ち・集計は持たない（MA は外部プラグイン）
--   - 中身は決まった形だけ（見出し・本文・https の画像・ボタン 2 つ・公開のクーポンコード）。Banto が描いてエスケープする
--   - 書くのは運営者（項目 marketing）。段階 2 で AI 用 API とつないだプラグイン
--   - お店の画面には公開のショップ行（banto_shop_public_json の dialogs）で渡す。ショップ行と一緒にキャッシュされ、ページのたびに DB に問い合わせない
--   - 出した・閉じた・押したは中立の出来事（dialog_view・dialog_close・dialog_click）。GA4 と、許した連携（event_relay）へ。Banto は溜めない

create table if not exists dialogs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  enabled boolean not null default true,
  priority integer not null default 0 check (priority between 0 and 100),
  layout text not null default 'bar' check (layout in ('modal', 'bar', 'corner')),
  title text not null check (char_length(title) between 1 and 100),
  body text not null default '' check (char_length(body) <= 500),
  image_url text check (image_url is null or (char_length(image_url) <= 500 and image_url ~ '^https://[^\s"<>]+$')),
  buttons jsonb not null default '[]'::jsonb check (jsonb_typeof(buttons) = 'array' and jsonb_array_length(buttons) <= 2),
  coupon_code text check (coupon_code is null or coupon_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  audience text not null default 'all' check (audience in ('all', 'guests', 'members', 'audience')),
  audience_id uuid references audiences (id) on delete set null,
  pages jsonb not null default '{"kinds":["all"]}'::jsonb check (jsonb_typeof(pages) = 'object'),
  trigger jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger) = 'object'),
  snooze_days integer not null default 7 check (snooze_days between 0 and 365),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
create index if not exists dialogs_shop_idx on dialogs (shop_id, enabled);
alter table dialogs enable row level security;

drop policy if exists dialogs_read on dialogs;
create policy dialogs_read on dialogs for select using (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists dialogs_insert on dialogs;
create policy dialogs_insert on dialogs for insert with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists dialogs_update on dialogs;
create policy dialogs_update on dialogs for update using (banto_shop_perm(shop_id, 'marketing')) with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists dialogs_delete on dialogs;
create policy dialogs_delete on dialogs for delete using (banto_shop_perm(shop_id, 'marketing'));
revoke all on dialogs from anon;
grant select, insert, update, delete on dialogs to authenticated;

-- 書くときに形を確かめて組み直す（知らない鍵は落とす）。数の上限は 1 ショップ 50
create or replace function banto_dialogs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_btn jsonb; v_buttons jsonb := '[]'::jsonb; v_kinds jsonb; v_pages jsonb; v_trig jsonb := '{}'::jsonb; v_n int; v_list jsonb;
begin
  if tg_op = 'INSERT' and (select count(*) from dialogs where shop_id = new.shop_id) >= 50 then
    raise exception 'dialogs_limit' using errcode = 'P0001';
  end if;
  -- ボタン: 文字（1〜40）とリンク（https:// か、ショップの中のパス /…。// で始まるものは外へ出るので受けない）
  for v_btn in select * from jsonb_array_elements(new.buttons) loop
    if jsonb_typeof(v_btn) <> 'object' or jsonb_typeof(v_btn->'label') <> 'string' or jsonb_typeof(v_btn->'url') <> 'string'
       or char_length(v_btn->>'label') not between 1 and 40 or char_length(v_btn->>'url') > 500
       or not ((v_btn->>'url') ~ '^https://[^\s"<>]+$' or (v_btn->>'url') ~ '^/[^/\s"<>][^\s"<>]*$' or (v_btn->>'url') = '/') then
      raise exception 'invalid_dialog:buttons' using errcode = '22023';
    end if;
    v_buttons := v_buttons || jsonb_build_array(jsonb_build_object('label', v_btn->>'label', 'url', v_btn->>'url'));
  end loop;
  new.buttons := v_buttons;
  -- ページ: 種類（all / home / product / list / article / page / cart）と、商品・カテゴリーの id・タグ（どれか 1 つが合えば）
  v_kinds := coalesce((select jsonb_agg(distinct k) from jsonb_array_elements_text(case when jsonb_typeof(new.pages->'kinds') = 'array' then new.pages->'kinds' else '[]'::jsonb end) k
                        where k in ('all', 'home', 'product', 'list', 'article', 'page', 'cart')), '[]'::jsonb);
  if jsonb_array_length(v_kinds) = 0 then raise exception 'invalid_dialog:pages' using errcode = '22023'; end if;
  v_pages := jsonb_build_object('kinds', v_kinds);
  foreach v_n in array array[1, 2, 3] loop
    v_list := case v_n when 1 then new.pages->'products' when 2 then new.pages->'categories' else new.pages->'tags' end;
    if v_list is not null and jsonb_typeof(v_list) = 'array' and jsonb_array_length(v_list) > 0 then
      if jsonb_array_length(v_list) > 50 or exists (select 1 from jsonb_array_elements(v_list) x where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') not between 1 and 64) then
        raise exception 'invalid_dialog:pages' using errcode = '22023';
      end if;
      v_pages := v_pages || jsonb_build_object(case v_n when 1 then 'products' when 2 then 'categories' else 'tags' end, v_list);
    end if;
  end loop;
  new.pages := v_pages;
  -- きっかけ: 秒数・スクロール・離脱しそう・今回の訪問のページ数・カートの金額（決まった鍵と範囲だけ）
  if new.trigger ? 'delay_s' then
    if jsonb_typeof(new.trigger->'delay_s') <> 'number' or (new.trigger->>'delay_s')::numeric not between 0 and 600 then raise exception 'invalid_dialog:trigger' using errcode = '22023'; end if;
    v_trig := v_trig || jsonb_build_object('delay_s', floor((new.trigger->>'delay_s')::numeric)::int);
  end if;
  if new.trigger ? 'scroll_pct' then
    if jsonb_typeof(new.trigger->'scroll_pct') <> 'number' or (new.trigger->>'scroll_pct')::numeric not between 1 and 100 then raise exception 'invalid_dialog:trigger' using errcode = '22023'; end if;
    v_trig := v_trig || jsonb_build_object('scroll_pct', floor((new.trigger->>'scroll_pct')::numeric)::int);
  end if;
  if new.trigger->'exit_intent' = 'true'::jsonb then v_trig := v_trig || '{"exit_intent": true}'::jsonb; end if;
  if new.trigger ? 'visit_pages' then
    if jsonb_typeof(new.trigger->'visit_pages') <> 'number' or (new.trigger->>'visit_pages')::numeric not between 1 and 50 then raise exception 'invalid_dialog:trigger' using errcode = '22023'; end if;
    v_trig := v_trig || jsonb_build_object('visit_pages', floor((new.trigger->>'visit_pages')::numeric)::int);
  end if;
  if new.trigger ? 'cart_min_jpy' then
    if jsonb_typeof(new.trigger->'cart_min_jpy') <> 'number' or (new.trigger->>'cart_min_jpy')::numeric not between 1 and 100000000 then raise exception 'invalid_dialog:trigger' using errcode = '22023'; end if;
    v_trig := v_trig || jsonb_build_object('cart_min_jpy', floor((new.trigger->>'cart_min_jpy')::numeric)::bigint);
  end if;
  new.trigger := v_trig;
  -- 会員の条件は同じショップのものだけ。条件を選ばないなら id は持たない
  if new.audience = 'audience' then
    if new.audience_id is null or not exists (select 1 from audiences a where a.id = new.audience_id and a.shop_id = new.shop_id) then
      raise exception 'invalid_dialog:audience' using errcode = '22023';
    end if;
  else
    new.audience_id := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function banto_dialogs_guard() from public, anon, authenticated;
drop trigger if exists dialogs_guard on dialogs;
create trigger dialogs_guard before insert or update on dialogs for each row execute function banto_dialogs_guard();

-- 出した・閉じた・押したを、行動の中継（0107）で渡せる種類に足す
create or replace function banto_relay_event_types()
returns text[] language sql immutable as $$
  select array['product_view', 'article_view', 'page_view', 'cart_add', 'cart_view', 'checkout_start', 'purchase', 'dialog_view', 'dialog_close', 'dialog_click']::text[];
$$;
revoke execute on function banto_relay_event_types() from public, anon, authenticated;

-- 0108 の banto_shop_public_json に dialogs を足しただけ
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

insert into banto_migrations (version) values ('0110_mod_dialogs');
