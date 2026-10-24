-- 0027_tryon_shop_names: 実店舗のスタッフの申し込みの一覧にショップ名を出す（docs/store-tryon.md）
--
-- 実店舗のスタッフ（org_member_stores の tryon）はショップの表を読めない（0024 の RLS）。同じ店舗を複数のショップで使うと、
-- どのショップの申し込みか分からないので、その店舗の申し込みがあるショップ・その店舗を使うショップの名前だけを返す。
-- 名前と id 以外（設定・法務・入金先）は返さない。tryon の項目が無ければ空。
create or replace function tryon_store_shops(p_store_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when banto_store_perm(p_store_id, 'tryon') then (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.created_at), '[]'::jsonb)
      from shops s
     where s.org_id = (select org_id from stores where id = p_store_id)
       and (exists (select 1 from shop_stores ss where ss.shop_id = s.id and ss.store_id = p_store_id)
            or exists (select 1 from tryon_requests r where r.shop_id = s.id and r.store_id = p_store_id)))
  else '[]'::jsonb end;
$$;

revoke execute on function tryon_store_shops(uuid) from public, anon;
grant execute on function tryon_store_shops(uuid) to authenticated;

insert into banto_migrations (version) values ('0027_tryon_shop_names');
