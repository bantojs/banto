-- Banto 0107_mod_event_relay: お店の行動を、つないだ外部プラグインへ渡す（同梱モジュール event_relay、既定 OFF。
-- メンテナの決定 2026-11-04、docs/event-relay.md）。前方専用。
--   - Banto は出来事を溜めない（中継するだけ）。溜めて判定するのは外部プラグイン。
--   - プラグインはマニフェストの storefront_events で欲しい出来事を求め、運営者が連携の画面で許す（hook_endpoints.storefront_events）。
--     許せるのはマニフェストが求めた範囲まで（狭められるが広げられない）。マニフェストを取り直して狭まれば、渡すときに狭い方を使う。
--   - 送る道は Banto を経由する道（お店の画面のスクリプト・ヘッドレスの入口 → Banto → プラグイン、署名は hooks と同じ）。
--     Banto の Worker は送り先を event_relay_targets（service_role）で引き、しばらく覚える（リクエストのたびに DB に問い合わせない）。
--   - 段階 4a では会員の出来事だけを渡す（visitors = all は許せるが、ゲストの訪問者 ID は段階 4b から）。

alter table hook_endpoints add column if not exists storefront_events jsonb;
alter table hook_endpoints drop constraint if exists hook_endpoints_storefront_events_shape;
alter table hook_endpoints add constraint hook_endpoints_storefront_events_shape check (
  storefront_events is null or (jsonb_typeof(storefront_events) = 'object' and jsonb_typeof(storefront_events->'types') = 'array'
                                and storefront_events->>'visitors' in ('members', 'all'))
);

-- 許しを書くのは hook_storefront_events_set だけ（運営者の JWT からの列の直接の書き込みは止める。監査ログを飛ばさせない）
create or replace function banto_hook_storefront_events_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and coalesce(current_setting('banto.relay_grant', true), '') <> '1'
     and (tg_op = 'INSERT' and new.storefront_events is not null
          or tg_op = 'UPDATE' and new.storefront_events is distinct from old.storefront_events) then
    raise exception 'use_hook_storefront_events_set' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_hook_storefront_events_guard() from public, anon, authenticated;
drop trigger if exists hook_endpoints_storefront_events_guard on hook_endpoints;
create trigger hook_endpoints_storefront_events_guard before insert or update of storefront_events on hook_endpoints
  for each row execute function banto_hook_storefront_events_guard();

-- Banto が渡せる出来事の種類（src/storefront/events.ts の ShopEvent と同じ）
create or replace function banto_relay_event_types()
returns text[] language sql immutable as $$
  select array['product_view', 'article_view', 'page_view', 'cart_add', 'cart_view', 'checkout_start', 'purchase']::text[];
$$;
revoke execute on function banto_relay_event_types() from public, anon, authenticated;

-- 求め（マニフェスト）と許し（運営者）の重なり。どちらかが無ければ null
create or replace function banto_relay_effective(p_manifest jsonb, p_grant jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case
    when p_manifest is null or jsonb_typeof(p_manifest) <> 'object' or p_grant is null then null
    else (
      with t as (
        select array_agg(x order by x) as types
          from (select distinct x from jsonb_array_elements_text(coalesce(p_grant->'types', '[]'::jsonb)) x
                 where x = any(banto_relay_event_types())
                   and coalesce(p_manifest->'types', '[]'::jsonb) ? x) s
      )
      select case when t.types is null then null
                  else jsonb_build_object('types', to_jsonb(t.types),
                                          'visitors', case when p_grant->>'visitors' = 'all' and p_manifest->>'visitors' = 'all' then 'all' else 'members' end)
             end
        from t
    )
  end;
$$;
revoke execute on function banto_relay_effective(jsonb, jsonb) from public, anon, authenticated;

-- 運営者が許す（項目 integrations）。p_grant は { types: [...], visitors: "members"|"all" }、null で取り消す
create or replace function hook_storefront_events_set(p_shop_id uuid, p_endpoint_id uuid, p_grant jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_ep hook_endpoints; v_eff jsonb;
begin
  if auth.uid() is null or not banto_shop_perm(p_shop_id, 'integrations') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_ep from hook_endpoints where id = p_endpoint_id and shop_id = p_shop_id for update;
  if not found or v_ep.url like 'https://banto.invalid/%' then raise exception 'not_found'; end if;
  v_eff := case when p_grant is null or jsonb_typeof(p_grant) <> 'object' then null
                else banto_relay_effective(v_ep.manifest->'storefront_events', p_grant) end;
  if p_grant is not null and jsonb_typeof(p_grant) = 'object' and v_ep.manifest->'storefront_events' is null then
    raise exception 'not_requested';
  end if;
  perform set_config('banto.relay_grant', '1', true);
  update hook_endpoints set storefront_events = v_eff, updated_at = now() where id = v_ep.id;
  perform set_config('banto.relay_grant', '', true);
  -- 会員の行動を外へ渡す許しは、誰が・いつ・どこまでを残す（個人情報は入らない）
  if v_eff is distinct from v_ep.storefront_events then
    perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'app.storefront_events', 'hook_endpoint', v_ep.id::text,
                        jsonb_build_object('grant', v_eff));
  end if;
  return v_eff;
end;
$$;
revoke execute on function hook_storefront_events_set(uuid, uuid, jsonb) from public, anon;
grant execute on function hook_storefront_events_set(uuid, uuid, jsonb) to authenticated, service_role;

-- 送り先（Worker、service_role）。有効な連携のうち、許しとマニフェストの重なりがあるものだけ。署名のための接続ごとの暗号文も
create or replace function event_relay_targets(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'event_relay_targets: service_role only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('endpoint_id', e.id, 'url', e.url, 'secret_box', c.secret_box,
                                        'grant', banto_relay_effective(e.manifest->'storefront_events', e.storefront_events)) order by e.created_at)
      from hook_endpoints e
      left join app_connections c on c.endpoint_id = e.id
     where e.shop_id = p_shop_id and e.enabled and e.url not like 'https://banto.invalid/%'
       and banto_relay_effective(e.manifest->'storefront_events', e.storefront_events) is not null
  ), '[]'::jsonb);
end;
$$;
revoke execute on function event_relay_targets(uuid) from public, anon, authenticated;
grant execute on function event_relay_targets(uuid) to service_role;

insert into banto_migrations (version) values ('0107_mod_event_relay');
