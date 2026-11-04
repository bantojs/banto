-- Banto 0109_event_relay_custom: お店の行動の中継（0107）の段階 4c。作り手の独自の出来事（x. で始まる名前）を、
-- プラグインがマニフェストの storefront_events.custom で求め、運営者が許したものだけ渡す（メンテナの決定 2026-11-04、docs/event-relay.md）。前方専用。
--   - 許しの形は { types, custom?, visitors }。custom は名前の並びで、"x.*" はすべて（マニフェストが "x.*" を求めたときだけ許せる）
--   - 決まった種類か独自の出来事のどちらかが残れば許しがある（0107 は決まった種類が無ければ null だった）
--   - 中身（meta）は Banto が解釈しない。形と大きさは Worker が確かめる（src/modules/event-relay/relay.ts）

-- 0107 の banto_relay_effective に custom を足した。配列でない値（文字など）は空として扱う
create or replace function banto_relay_effective(p_manifest jsonb, p_grant jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case
    when p_manifest is null or jsonb_typeof(p_manifest) <> 'object' or p_grant is null or jsonb_typeof(p_grant) <> 'object' then null
    else (
      with src as (
        select case when jsonb_typeof(p_grant->'types') = 'array' then p_grant->'types' else '[]'::jsonb end as g_types,
               case when jsonb_typeof(p_manifest->'types') = 'array' then p_manifest->'types' else '[]'::jsonb end as m_types,
               case when jsonb_typeof(p_grant->'custom') = 'array' then p_grant->'custom' else '[]'::jsonb end as g_custom,
               case when jsonb_typeof(p_manifest->'custom') = 'array' then p_manifest->'custom' else '[]'::jsonb end as m_custom
      ), t as (
        select coalesce(array_agg(x order by x), '{}'::text[]) as types
          from (select distinct x from src, jsonb_array_elements_text(src.g_types) x
                 where x = any(banto_relay_event_types()) and src.m_types ? x) s
      ), c as (
        select coalesce(array_agg(x order by x), '{}'::text[]) as custom
          from (select distinct x from src, jsonb_array_elements_text(src.g_custom) x
                 where (x = 'x.*' or x ~ '^x\.[a-z0-9_.]{1,58}$')
                   and (src.m_custom ? x or (x <> 'x.*' and src.m_custom ? 'x.*'))) s
      )
      select case when cardinality(t.types) = 0 and cardinality(c.custom) = 0 then null
                  else jsonb_build_object('types', to_jsonb(t.types),
                                          'visitors', case when p_grant->>'visitors' = 'all' and p_manifest->>'visitors' = 'all' then 'all' else 'members' end)
                       || case when cardinality(c.custom) > 0 then jsonb_build_object('custom', to_jsonb(c.custom)) else '{}'::jsonb end
             end
        from t, c
    )
  end;
$$;
revoke execute on function banto_relay_effective(jsonb, jsonb) from public, anon, authenticated;

insert into banto_migrations (version) values ('0109_event_relay_custom');
