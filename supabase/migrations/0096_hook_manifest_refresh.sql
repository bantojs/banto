-- 0096_hook_manifest_refresh: 外部プラグインのマニフェストを Cron で取り直す（メンテナの決定 2026-11-02、docs/hooks.md）
--   - 今までは連携の画面で保存したときだけ取り直していた。プラグインを上げても Banto が前のマニフェスト（capabilities・ブロックの提案・設定の項目）を
--     覚えたままになり、運営者には理由の分からない警告や「出てこない機能」になっていた
--   - Cron が 1 日 1 回、有効な外部の連携のマニフェストを取り直す（hook_manifests_due で期限の来たものを数件ずつ）。取れなければ前のまま、時刻だけ進める
--   - 取り直しても権限（スコープ）は変わらない（AI 用トークンのスコープはつないだときのまま。広げるにはつなぎ直す）
--   - URL が途中で変わった連携には書かない（hook_manifest_record が URL を突き合わせる）

alter table hook_endpoints add column if not exists manifest_checked_at timestamptz;

-- 期限の来た外部の連携（同梱プラグインは除く）。取り直したことの無いものから
create or replace function hook_manifests_due(p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'url', e.url) order by e.manifest_checked_at nulls first, e.created_at), '[]'::jsonb)
    from (select id, url, manifest_checked_at, created_at from hook_endpoints
           where enabled and url not like 'https://banto.invalid/plugins/%'
             and (manifest_checked_at is null or manifest_checked_at < now() - interval '1 day')
           order by manifest_checked_at nulls first, created_at
           limit greatest(1, least(coalesce(p_limit, 2), 10))) e;
$$;
revoke execute on function hook_manifests_due(integer) from public, anon, authenticated;
grant execute on function hook_manifests_due(integer) to service_role;

-- 取り直した結果を書く。p_manifest が null（取れなかった）なら前のまま時刻だけ進める。URL が変わっていたら何もしない
create or replace function hook_manifest_record(p_endpoint_id uuid, p_url text, p_manifest jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if p_manifest is not null and jsonb_typeof(p_manifest) <> 'object' then raise exception 'invalid_manifest'; end if;
  if p_manifest is not null and octet_length(p_manifest::text) > 65536 then raise exception 'invalid_manifest'; end if;
  update hook_endpoints set manifest = coalesce(p_manifest, manifest), manifest_checked_at = now()
   where id = p_endpoint_id and url = p_url;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke execute on function hook_manifest_record(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function hook_manifest_record(uuid, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0096_hook_manifest_refresh');
