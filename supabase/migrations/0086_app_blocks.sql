-- Banto 0086_app_blocks: 外部プラグインが提案するブロック（`::: app`、メンテナの決定 2026-11-01、docs/app-data.md §6）。前方専用。
--   - プラグインはマニフェストの blocks でブロックを提案する（名前・データの種類・設定の欄）。見た目（HTML・スクリプト）は受けない。
--     描くのは Banto の既定の見た目（reviews.v1 だけ）かテーマの snippet（snippets/app-<プラグイン>-<ブロック>.liquid → app-<ブロック>）
--   - ページ・記事を書く人（項目 content）は連携の表（項目 integrations）を読めない。編集の画面に出すブロックの一覧だけを返す関数を足す。
--     返すのは有効・名前のある連携の名前・表示名・マニフェストの blocks だけ（URL・設定・署名の情報は返さない）

create or replace function shop_app_blocks(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not banto_shop_perm(p_shop_id, 'content') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('app', e.app_handle, 'name', e.name, 'blocks', e.manifest->'blocks') order by e.app_handle)
      from hook_endpoints e
     where e.shop_id = p_shop_id and e.enabled and e.app_handle is not null
       and jsonb_typeof(e.manifest->'blocks') = 'array' and jsonb_array_length(e.manifest->'blocks') > 0
  ), '[]'::jsonb);
end;
$$;
revoke execute on function shop_app_blocks(uuid) from public, anon;
grant execute on function shop_app_blocks(uuid) to authenticated;

insert into banto_migrations (version) values ('0086_app_blocks');
