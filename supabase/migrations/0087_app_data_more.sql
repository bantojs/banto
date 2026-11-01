-- Banto 0087_app_data_more: レビューの「もっと見る」（メンテナの決定 2026-11-01、docs/app-data.md §7）。前方専用。
--   - Banto に置くのは新しい 20 件まで。21 件目からは、押した人のブラウザが Banto の小さなスクリプトで
--     プラグインの公開 API（マニフェストの more）から JSON を取り、Banto の決まった形の HTML で描く（プラグインの JS は読まない）
--   - お客様の画面に渡すのは、連携のマニフェストの more の中の、その種類の URL（https:// だけ）。
--     マニフェストは連携の画面を通らずにも書けるので、ここでも形を確かめる

create or replace function banto_app_more_url(p_manifest jsonb, p_kind text)
returns text language sql immutable as $$
  select case when jsonb_typeof(p_manifest->'more') = 'object'
               and jsonb_typeof(p_manifest->'more'->p_kind) = 'string'
               and char_length(p_manifest->'more'->>p_kind) <= 500
               and p_manifest->'more'->>p_kind ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*)?(\?[A-Za-z0-9._~!$&''()*+,;=:@%/?-]*)?$'
              then p_manifest->'more'->>p_kind end;
$$;
revoke execute on function banto_app_more_url(jsonb, text) from public, anon, authenticated;

create or replace function banto_public_app_data(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
           jsonb_build_object('app', e.app_handle, 'kind', d.kind, 'key', d.key, 'data', d.data, 'updated_at', d.updated_at)
           || jsonb_strip_nulls(jsonb_build_object('more_url', banto_app_more_url(e.manifest, d.kind)))
           order by e.app_handle, d.kind, d.key), '[]'::jsonb)
    from app_data d join hook_endpoints e on e.id = d.endpoint_id and e.shop_id = d.shop_id
   where d.product_id = p_product_id and d.public and e.enabled and e.app_handle is not null;
$$;
revoke execute on function banto_public_app_data(uuid) from public, anon, authenticated;

insert into banto_migrations (version) values ('0087_app_data_more');
