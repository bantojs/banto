-- Banto 0072_theme_api: テーマを AI 用トークンで取り込む・公開する（テーマの段階 2、人間の決定 2026-10-28、docs/themes.md・docs/ai-access.md）。前方専用。
--   - スコープ theme:write: 版の一覧・取り込み（版を足す・資産を置く・置き終える）・プレビューのリンク・公開していない版の削除
--   - スコープ theme:publish: 公開・取り下げ（theme:write とは別。トークンが漏れても、theme:write だけなら公開中の画面は変わらない）
--   - どちらも権限の項目 design（0071）。発行者が design を持つ間だけ効く（banto_token_scope_ok）
--   - 中身の検査（テンプレートの解析・資産の種類）と置き場への読み書きは Worker（管理画面と同じ src/themes/liquid/versions.ts）。
--     ここはショップの所有・版の数・状態（complete）・独自ドメインを確かめ、監査ログの「だれが」はトークン（api_require の banto.actor）

-- ---------- スコープ ----------
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish']::text[]
);

create or replace function banto_scope_perm(p_scope text)
returns text language sql immutable as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- ---------- 読む ----------
create or replace function api_theme_json(p_t theme_versions, p_published uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p_t.id, 'name', p_t.name, 'complete', p_t.complete, 'published', coalesce(p_t.id = p_published, false),
                            'size_bytes', p_t.size_bytes, 'file_count', p_t.file_count, 'manifest', p_t.manifest, 'created_at', p_t.created_at);
$$;
revoke execute on function api_theme_json(theme_versions, uuid) from public, anon, authenticated;

-- 版の一覧と、取り込める条件（Workers のプラン・独自ドメイン・版の数の上限）
create or replace function api_themes_list(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_s shops%rowtype;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  select * into v_s from shops where id = v_tok.shop_id;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(api_theme_json(t, v_s.theme_version_id) order by t.created_at desc) from theme_versions t where t.shop_id = v_s.id), '[]'::jsonb),
    'published_id', v_s.theme_version_id,
    'shop_id', v_s.id,
    'domain', v_s.domain,
    'shop_published', v_s.published,
    'site_plan', banto_site_plan(),
    'max_versions', banto_theme_versions_max());
end;
$$;

-- 1 つの版（置き場の鍵と状態。Worker が資産を置く前に、そのショップの版か・置き終えていないかを確かめる）
create or replace function api_theme_get(p_token_hash text, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_t theme_versions%rowtype; v_pub uuid;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  select * into v_t from theme_versions where id = p_version_id and shop_id = v_tok.shop_id;
  if not found then raise exception 'not_found'; end if;
  select theme_version_id into v_pub from shops where id = v_tok.shop_id;
  return api_theme_json(v_t, v_pub) || jsonb_build_object('shop_id', v_t.shop_id, 'storage_key', v_t.storage_key);
end;
$$;

-- ---------- 書く（theme:write） ----------
-- 版を足す。Worker が検査して束ねたファイルを置いてから呼ぶ（0071 の theme_version_create と同じ規則）
create or replace function api_theme_create(p_token_hash text, p_id uuid, p_name text, p_size_bytes integer, p_file_count integer, p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_t theme_versions%rowtype;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  perform 1 from shops where id = v_tok.shop_id for update;
  if (select count(*) from theme_versions where shop_id = v_tok.shop_id) >= banto_theme_versions_max() then
    raise exception 'theme_versions_full';
  end if;
  insert into theme_versions (id, shop_id, name, storage_key, size_bytes, file_count, manifest, created_by)
  values (p_id, v_tok.shop_id, btrim(p_name), 'themes/' || v_tok.shop_id || '/' || p_id || '/bundle.json', p_size_bytes, p_file_count,
          coalesce(p_manifest, '{}'::jsonb), v_tok.owner_id)
  returning * into v_t;
  return api_theme_json(v_t, null) || jsonb_build_object('shop_id', v_t.shop_id, 'storage_key', v_t.storage_key);
end;
$$;

-- 資産を置き終えた（Worker がすべての資産があるのを確かめてから呼ぶ）。これより後は資産を差し替えさせない
create or replace function api_theme_complete(p_token_hash text, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_t theme_versions%rowtype; v_pub uuid;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  update theme_versions set complete = true where id = p_version_id and shop_id = v_tok.shop_id returning * into v_t;
  if not found then raise exception 'not_found'; end if;
  select theme_version_id into v_pub from shops where id = v_tok.shop_id;
  return api_theme_json(v_t, v_pub);
end;
$$;

-- プレビューのリンクを作る前に呼ぶ（監査ログに残す）。独自ドメインと公開中のショップが要る。戻り値はショップの id とドメイン
create or replace function api_theme_preview(p_token_hash text, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_s shops%rowtype;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  if not exists (select 1 from theme_versions where id = p_version_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  select * into v_s from shops where id = v_tok.shop_id;
  if v_s.domain is null then raise exception 'theme_requires_domain'; end if;
  if not v_s.published then raise exception 'shop_unpublished'; end if;
  perform banto_audit(v_s.org_id, v_s.id, 'shop.theme_previewed', 'shop', v_s.id::text, jsonb_build_object('version', p_version_id));
  return jsonb_build_object('shop_id', v_s.id, 'slug', v_s.slug, 'domain', v_s.domain);
end;
$$;

-- 公開していない版を消す。戻り値は置き場の接頭辞（Worker がファイルを消す）
create or replace function api_theme_delete(p_token_hash text, p_version_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'theme:write');
  if not exists (select 1 from theme_versions where id = p_version_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  if exists (select 1 from shops where id = v_tok.shop_id and theme_version_id = p_version_id) then raise exception 'theme_published'; end if;
  delete from theme_versions where id = p_version_id and shop_id = v_tok.shop_id;
  return 'themes/' || v_tok.shop_id || '/' || p_version_id || '/';
end;
$$;

-- ---------- 公開（theme:publish） ----------
-- p_version_id が null なら取り下げて TSX の既定のテーマに戻す。公開は置き終えた版・独自ドメインのあるショップだけ（0071 の theme_publish と同じ）
create or replace function api_theme_publish(p_token_hash text, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'theme:publish');
  if p_version_id is not null then
    if not exists (select 1 from theme_versions where id = p_version_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
    if not exists (select 1 from theme_versions where id = p_version_id and complete) then raise exception 'theme_incomplete'; end if;
    if not exists (select 1 from shops where id = v_tok.shop_id and domain is not null) then raise exception 'theme_requires_domain'; end if;
  end if;
  perform set_config('banto.theme_publish', 'on', true);
  update shops set theme_version_id = p_version_id where id = v_tok.shop_id;
  perform set_config('banto.theme_publish', 'off', true);
  return jsonb_build_object('published_id', p_version_id);
end;
$$;

revoke execute on function api_themes_list(text) from public, anon, authenticated;
grant execute on function api_themes_list(text) to service_role;
revoke execute on function api_theme_get(text, uuid) from public, anon, authenticated;
grant execute on function api_theme_get(text, uuid) to service_role;
revoke execute on function api_theme_create(text, uuid, text, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function api_theme_create(text, uuid, text, integer, integer, jsonb) to service_role;
revoke execute on function api_theme_complete(text, uuid) from public, anon, authenticated;
grant execute on function api_theme_complete(text, uuid) to service_role;
revoke execute on function api_theme_preview(text, uuid) from public, anon, authenticated;
grant execute on function api_theme_preview(text, uuid) to service_role;
revoke execute on function api_theme_delete(text, uuid) from public, anon, authenticated;
grant execute on function api_theme_delete(text, uuid) to service_role;
revoke execute on function api_theme_publish(text, uuid) from public, anon, authenticated;
grant execute on function api_theme_publish(text, uuid) to service_role;

insert into banto_migrations (version) values ('0072_theme_api');
