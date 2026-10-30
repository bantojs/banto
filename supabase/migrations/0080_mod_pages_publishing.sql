-- Banto 0080_mod_pages_publishing: ショップのページの「安心」（同梱モジュール pages、メンテナの決定 2026-10-30、docs/pages.md）。前方専用。
--   - 予約公開: published_at（公開する日時。null は「すぐ」）。お客様に見えるのは published かつ published_at が過ぎたものだけ。
--     判定は表示のとき（RLS と pages_nav）なので、決まった時刻に動かす処理は要らない（キャッシュの分だけ遅れて出る）
--   - ゴミ箱: deleted_at。お客様には見えず、同じ URL の名前で新しいページを作れる（一意はゴミ箱の外だけ）。
--     30 日を過ぎたものは Cron が pages_purge_trash で消す
--   - リビジョン: タイトルか本文が変わった保存のたびに、変わる前の版を page_revisions に残す（トリガー。1 ページに 20 まで、古いものから消す）
--   - アイキャッチ画像: image_url（ショップの画像の置き場の URL。画面で確かめる。OG の画像とテーマの page.image）
--   - メディアライブラリ: page_media（本文の画像を置いたときに記録し、編集の画面で選び直せる）
-- 扱えるのは 0079 と同じく項目 content を持つ人。

-- ---------- 列 ----------
alter table pages add column if not exists published_at timestamptz;
alter table pages add column if not exists deleted_at timestamptz;
alter table pages add column if not exists image_url text;
alter table pages drop constraint if exists pages_image_url_check;
alter table pages add constraint pages_image_url_check
  check (image_url is null or (char_length(image_url) <= 2000 and image_url ~ '^(https?://|/)[^\s<>"''`]*$'));

-- URL の名前の一意はゴミ箱の外だけ（ゴミ箱に入れたページと同じ名前で作り直せる。戻すときに重なれば 23505）
alter table pages drop constraint if exists pages_shop_id_handle_key;
create unique index if not exists pages_shop_handle_live on pages (shop_id, handle) where deleted_at is null;
create index if not exists pages_trash on pages (deleted_at) where deleted_at is not null;

-- ---------- お客様の画面（anon）: 公開中・公開の日時を過ぎた・ゴミ箱に無いもの ----------
drop policy if exists pages_public on pages;
create policy pages_public on pages for select
  using (published and deleted_at is null and (published_at is null or published_at <= now())
         and exists (select 1 from shops s where s.id = pages.shop_id and s.published = true));

-- 0079 の banto_shop_public_json の pages_nav に、公開の日時とゴミ箱の判定を足しただけ
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null),
    'pages_nav', case when s.settings->'modules'->'pages' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'title', p.title, 'nav', p.nav) order by p.sort_order, p.created_at), '[]'::jsonb)
         from pages p where p.shop_id = s.id and p.published and p.deleted_at is null
          and (p.published_at is null or p.published_at <= now()) and p.nav <> 'none')
      else '[]'::jsonb end);
$$;

-- ---------- リビジョン ----------
create table if not exists page_revisions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  title text not null,
  body text not null,
  -- 変える前の版を作った人（変えた人。auth.uid()、AI 用トークンや service_role なら null）
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists page_revisions_page on page_revisions (page_id, created_at desc);
alter table page_revisions enable row level security;
drop policy if exists page_revisions_content on page_revisions;
create policy page_revisions_content on page_revisions for select using (banto_shop_perm(shop_id, 'content'));
revoke all on page_revisions from anon;
revoke insert, update, delete on page_revisions from authenticated;
grant select on page_revisions to authenticated;

create or replace function banto_page_revisions_max() returns integer language sql immutable as $$ select 20 $$;
revoke execute on function banto_page_revisions_max() from public, anon, authenticated;

create or replace function banto_page_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.title is distinct from new.title or old.body is distinct from new.body then
    insert into page_revisions (shop_id, page_id, title, body, created_by) values (old.shop_id, old.id, old.title, old.body, auth.uid());
    delete from page_revisions r
     where r.page_id = old.id
       and r.id not in (select id from page_revisions where page_id = old.id order by created_at desc, id desc limit banto_page_revisions_max());
  end if;
  return new;
end;
$$;
revoke execute on function banto_page_revision() from public, anon, authenticated;
drop trigger if exists pages_revision on pages;
create trigger pages_revision after update on pages for each row execute function banto_page_revision();

-- ---------- メディアライブラリ ----------
create table if not exists page_media (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  -- 置き場の鍵（pages/<ショップ>/…）と、お客様の画面で使う URL
  storage_key text not null check (storage_key ~ '^pages/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  url text not null check (char_length(url) <= 2000 and url ~ '^(https?://|/)[^\s<>"''`]*$'),
  created_at timestamptz not null default now()
);
create index if not exists page_media_shop on page_media (shop_id, created_at desc);
alter table page_media enable row level security;
drop policy if exists page_media_content on page_media;
create policy page_media_content on page_media for all
  using (banto_shop_perm(shop_id, 'content')) with check (banto_shop_perm(shop_id, 'content') and storage_key like 'pages/' || shop_id::text || '/%');
revoke all on page_media from anon;
grant select, insert, delete on page_media to authenticated;

-- ---------- ゴミ箱を空にする（Cron。service_role だけ） ----------
create or replace function pages_purge_trash(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v integer;
begin
  delete from pages where deleted_at is not null and deleted_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v = row_count;
  return v;
end;
$$;
revoke execute on function pages_purge_trash(integer) from public, anon, authenticated;
grant execute on function pages_purge_trash(integer) to service_role;

insert into banto_migrations (version) values ('0080_mod_pages_publishing');
