-- Banto 0074_theme_preview: テーマのプレビューと描く条件の手直し（テーマの段階 2・3 の見直し、docs/themes.md）。前方専用。
--   - theme_preview_settings: プレビューの版に、管理画面で保存した設定の値（theme_versions.settings）を効かせる。
--     お客様の画面はプレビューの券を確かめてから、service_role でこの関数だけを呼ぶ（版の表は anon には読ませない）
--   - banto_site_liquid: お店の画面が Liquid のテーマを描いてよいか。Workers のプラン（banto_site_plan）に加えて、
--     plan_limits.theme_versions が 0（使わせない）なら公開中の版も描かない（0073 は取り込みを止めるだけだった）

create or replace function theme_preview_settings(p_shop_id uuid, p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select settings from theme_versions where id = p_version_id and shop_id = p_shop_id;
$$;
revoke execute on function theme_preview_settings(uuid, uuid) from public, anon, authenticated;
grant execute on function theme_preview_settings(uuid, uuid) to service_role;

create or replace function banto_site_liquid()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'plan', banto_site_plan(),
    'themes', coalesce((banto_plan_limits()->>'theme_versions')::bigint, 1) > 0);
$$;
revoke execute on function banto_site_liquid() from public;
grant execute on function banto_site_liquid() to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0074_theme_preview');
