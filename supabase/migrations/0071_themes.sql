-- Banto 0071_themes: Liquid のテーマ（人間の決定 2026-10-28、docs/themes.md）。前方専用。
--   - テーマは版ごとに 1 行（theme_versions）。中身（テンプレート・設定の宣言・翻訳）は Worker が 1 つのファイルに束ねて
--     StorageAdapter（MEDIA）の themes/<shop_id>/<版の id>/ に置き、ここには置き場の鍵と数だけを持つ
--   - 公開中の版は shops.theme_version_id。お客様の画面は shop_public_get の theme で受け取る（DB の往復を増やさない）
--   - 扱えるのは新しい権限の項目 design（組織の owner / admin を含む）。書き込みは下の関数だけ
--   - 公開できるのは独自ドメインのあるショップだけ。テーマの JS が管理画面と同じオリジンで動かないように
--     （管理画面は独自ドメインでは出さない。src/routes/storefront/domain.ts）。Workers のプランの判定は Worker が行う
--   - 資産（CSS・JS・画像）は版を足した後に 1 つずつ置く。置き終えたら complete にし、complete の版だけを公開できる。
--     complete の版の資産は差し替えさせない（公開中の JS を監査ログに残さず差し替えさせない。Worker が確かめる）
--   - 公開・取り下げは監査ログに残す（DB のトリガーだけが書く、0051）。プレビューを出したことも残す（theme_preview_audit）

-- ---------- 権限の項目に design を足す（0024・0061） ----------
create or replace function banto_shop_perms_all()
returns text[]
language sql
immutable
as $$ select array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design'] $$;

alter table org_member_shops drop constraint if exists org_member_shops_perms_check;
alter table org_member_shops add constraint org_member_shops_perms_check
  check (perms <@ array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design']);

-- ---------- 表 ----------
create table if not exists theme_versions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  -- 束ねたファイルの置き場（themes/<shop_id>/<id>/bundle.json）。資産は同じ場所の assets/
  storage_key text not null,
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  file_count integer not null check (file_count between 1 and 1000),
  -- テーマの情報（settings_schema.json の theme_info など、画面に出すだけ）
  manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest) = 'object'),
  -- 運営者が画面で選んだ設定の値（settings_data.json に当たる）
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 65536),
  -- 資産を置き終えたか（theme_version_complete）。complete の版だけを公開できる
  complete boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (shop_id, id)
);
create index if not exists theme_versions_shop on theme_versions (shop_id, created_at desc);
alter table theme_versions enable row level security;
drop policy if exists theme_versions_select on theme_versions;
create policy theme_versions_select on theme_versions for select using (banto_shop_perm(shop_id, 'design'));
revoke insert, update, delete on theme_versions from anon, authenticated;

alter table shops add column if not exists theme_version_id uuid;
alter table shops drop constraint if exists shops_theme_version_fk;
alter table shops add constraint shops_theme_version_fk foreign key (id, theme_version_id) references theme_versions(shop_id, id) on delete set null (theme_version_id);

-- 公開中の版は theme_publish だけが変える（settings の項目で shops を直接書き換えて、design の項目と独自ドメインの検査をすり抜けさせない。
-- 取り下げ（null）も同じ。0062 の legal_links_state と同じ形）。外れてよいのは、版の行が消えたとき（外部キーの set null）だけ。
-- 新しいショップは版なしで始まる
create or replace function banto_shops_theme_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.theme_version_id := null;
  elsif new.theme_version_id is distinct from old.theme_version_id
        and current_setting('banto.theme_publish', true) is distinct from 'on'
        and not (new.theme_version_id is null and not exists (select 1 from theme_versions where id = old.theme_version_id)) then
    raise exception 'theme_version_readonly' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_shops_theme_guard() from public, anon, authenticated;
drop trigger if exists shops_theme_guard on shops;
create trigger shops_theme_guard before insert or update of theme_version_id on shops for each row execute function banto_shops_theme_guard();

-- 1 つのショップに置ける版の数
create or replace function banto_theme_versions_max() returns integer language sql immutable as $$ select 20 $$;
revoke execute on function banto_theme_versions_max() from public, anon, authenticated;

-- ---------- 運営側（authenticated。design の項目） ----------
-- 版を足す。Worker が束ねたファイルを置いてから呼ぶ。戻り値は版の id
create or replace function theme_version_create(p_shop_id uuid, p_id uuid, p_name text, p_size_bytes integer, p_file_count integer, p_manifest jsonb default '{}'::jsonb, p_settings jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'design') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  -- 同じショップの版の数（行ロックで同時に足されても上限を越えない）
  perform 1 from shops where id = p_shop_id for update;
  if (select count(*) from theme_versions where shop_id = p_shop_id) >= banto_theme_versions_max() then
    raise exception 'theme_versions_full' using errcode = 'P0001';
  end if;
  insert into theme_versions (id, shop_id, name, storage_key, size_bytes, file_count, manifest, settings)
  values (p_id, p_shop_id, btrim(p_name), 'themes/' || p_shop_id || '/' || p_id || '/bundle.json', p_size_bytes, p_file_count,
          coalesce(p_manifest, '{}'::jsonb), coalesce(p_settings, '{}'::jsonb));
  return p_id;
end;
$$;
revoke execute on function theme_version_create(uuid, uuid, text, integer, integer, jsonb, jsonb) from public, anon;
grant execute on function theme_version_create(uuid, uuid, text, integer, integer, jsonb, jsonb) to authenticated;

-- 設定の値を変える（公開中の版でもよい）。版はそのショップのものだけ
create or replace function theme_version_set_settings(p_shop_id uuid, p_version_id uuid, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'design') or not exists (select 1 from theme_versions where id = p_version_id and shop_id = p_shop_id) then
    raise exception 'theme_not_found' using errcode = '42501';
  end if;
  update theme_versions set settings = coalesce(p_settings, '{}'::jsonb) where id = p_version_id and shop_id = p_shop_id;
end;
$$;
revoke execute on function theme_version_set_settings(uuid, uuid, jsonb) from public, anon;
grant execute on function theme_version_set_settings(uuid, uuid, jsonb) to authenticated;

-- 資産を置き終えた（Worker が置いた後に呼ぶ）。これより後は資産を差し替えさせず、公開できるようになる
create or replace function theme_version_complete(p_shop_id uuid, p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'design') or not exists (select 1 from theme_versions where id = p_version_id and shop_id = p_shop_id) then
    raise exception 'theme_not_found' using errcode = '42501';
  end if;
  update theme_versions set complete = true where id = p_version_id and shop_id = p_shop_id;
end;
$$;
revoke execute on function theme_version_complete(uuid, uuid) from public, anon;
grant execute on function theme_version_complete(uuid, uuid) to authenticated;

-- プレビューを出したことを監査ログに残す（プレビューのリンクは公開していない版をショップのドメインで開けるため。Worker が券を作る前に呼ぶ）
create or replace function theme_preview_audit(p_shop_id uuid, p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'design') or not exists (select 1 from theme_versions where id = p_version_id and shop_id = p_shop_id) then
    raise exception 'theme_not_found' using errcode = '42501';
  end if;
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'shop.theme_previewed', 'shop', p_shop_id::text, jsonb_build_object('version', p_version_id));
end;
$$;
revoke execute on function theme_preview_audit(uuid, uuid) from public, anon;
grant execute on function theme_preview_audit(uuid, uuid) to authenticated;

-- 版を消す。公開中の版は消せない。版はそのショップのものだけ。戻り値は置き場の接頭辞（Worker がファイルを消す）
create or replace function theme_version_delete(p_shop_id uuid, p_version_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_t theme_versions%rowtype;
begin
  select * into v_t from theme_versions where id = p_version_id and shop_id = p_shop_id;
  if not found or not banto_shop_perm(v_t.shop_id, 'design') then
    raise exception 'theme_not_found' using errcode = '42501';
  end if;
  if exists (select 1 from shops where id = v_t.shop_id and theme_version_id = v_t.id) then
    raise exception 'theme_published' using errcode = 'P0001';
  end if;
  delete from theme_versions where id = v_t.id;
  return 'themes/' || v_t.shop_id || '/' || v_t.id || '/';
end;
$$;
revoke execute on function theme_version_delete(uuid, uuid) from public, anon;
grant execute on function theme_version_delete(uuid, uuid) to authenticated;

-- 公開する（p_version_id が null なら取り下げて TSX の既定のテーマに戻す）。公開は独自ドメインのあるショップだけ
create or replace function theme_publish(p_shop_id uuid, p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'design') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if p_version_id is not null then
    if not exists (select 1 from theme_versions where id = p_version_id and shop_id = p_shop_id) then
      raise exception 'theme_not_found' using errcode = '42501';
    end if;
    if not exists (select 1 from theme_versions where id = p_version_id and complete) then
      raise exception 'theme_incomplete' using errcode = 'P0001';
    end if;
    if not exists (select 1 from shops where id = p_shop_id and domain is not null) then
      raise exception 'theme_requires_domain' using errcode = 'P0001';
    end if;
  end if;
  perform set_config('banto.theme_publish', 'on', true);
  update shops set theme_version_id = p_version_id where id = p_shop_id;
  perform set_config('banto.theme_publish', 'off', true);
end;
$$;
revoke execute on function theme_publish(uuid, uuid) from public, anon;
grant execute on function theme_publish(uuid, uuid) to authenticated;

-- ---------- お客様の画面（anon）: 公開中のテーマを shop_public_get に足す ----------
-- 0062 の banto_shop_public_json に theme を足しただけ（独自ドメインが無くなったショップには出さない）
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null));
$$;

-- ---------- 監査ログ（0051）: 公開・取り下げ ----------
create or replace function banto_audit_shop_theme()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.theme_version_id is distinct from new.theme_version_id then
    perform banto_audit(new.org_id, new.id, 'shop.theme_published', 'shop', new.id::text, jsonb_build_object('from', old.theme_version_id, 'to', new.theme_version_id));
  end if;
  return new;
end;
$$;
revoke execute on function banto_audit_shop_theme() from public, anon, authenticated;
drop trigger if exists shops_audit_theme on shops;
create trigger shops_audit_theme after update of theme_version_id on shops for each row execute function banto_audit_shop_theme();

insert into banto_migrations (version) values ('0071_themes');
