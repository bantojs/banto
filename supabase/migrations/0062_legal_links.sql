-- Banto 0062_legal_links: 法務のページ（特商法・プライバシー・返品）を連携サイトのページへ向ける（人間の決定 2026-10-27）。前方専用。
--   - 設定は shops.settings.headless.legal_links = { legal?, privacy?, returns?, check_hours }（headless の下なので integrations の項目。0055 の banto_shops_guard）
--   - 外のページが生きているかは Cron（と管理画面の保存・「今すぐ確かめる」）が確かめ、結果を legal_links_state に置く。
--     リクエストのたびには取りに行かない。落ちていれば Banto の法務のページを出す（文面の正は Banto のまま）
--   - 公開の形（banto_shop_public_json）の legal_links には、最後の確認で生きていて、確認した URL が今の設定と同じものだけを出す

alter table shops add column if not exists legal_links_state jsonb not null default '{}'::jsonb;

-- 確かめる間隔（時間）。1・6・24（既定）・168 のどれか
create or replace function banto_legal_links_hours(p_settings jsonb)
returns integer language sql immutable as $$
  select case when (p_settings->'headless'->'legal_links'->>'check_hours') in ('1', '6', '24', '168')
              then (p_settings->'headless'->'legal_links'->>'check_hours')::integer else 24 end;
$$;
revoke execute on function banto_legal_links_hours(jsonb) from public, anon, authenticated;

-- 設定にある外の URL（種類 → URL。https の文字列だけ）
create or replace function banto_legal_links_urls(p_settings jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, p_settings->'headless'->'legal_links'->>k)
                     from unnest(array['legal', 'privacy', 'returns']) k
                    where jsonb_typeof(p_settings->'headless'->'legal_links'->k) = 'string'
                      and (p_settings->'headless'->'legal_links'->>k) like 'https://%'), '{}'::jsonb);
$$;
revoke execute on function banto_legal_links_urls(jsonb) from public, anon, authenticated;

-- お客様に見せてよい（生きている）外の URL だけ
create or replace function banto_legal_links_live(s shops)
returns jsonb language sql stable as $$
  select coalesce((select jsonb_object_agg(e.key, e.value)
                     from jsonb_each(banto_legal_links_urls(s.settings)) e
                    where (s.legal_links_state->e.key->>'ok')::boolean is true
                      and s.legal_links_state->e.key->'url' = e.value), '{}'::jsonb);
$$;
revoke execute on function banto_legal_links_live(shops) from public, anon, authenticated;

-- 公開の形に legal_links を足す（0028 を差し替え）
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s));
$$;
revoke execute on function banto_shop_public_json(shops) from public, anon, authenticated;

-- 確かめた結果を書く。p_results = { <kind>: { url, ok } }。設定に無い種類・設定と違う URL は捨てる。
-- 管理画面（authenticated）は integrations の項目、Cron は service_role
create or replace function legal_links_record(p_shop_id uuid, p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_shop shops; v_urls jsonb; v_state jsonb := '{}'::jsonb; v_kind text;
begin
  if auth.role() <> 'service_role' and not banto_shop_perm(p_shop_id, 'integrations') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'object' then raise exception 'invalid_body'; end if;
  select * into v_shop from shops where id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  v_urls := banto_legal_links_urls(v_shop.settings);
  for v_kind in select jsonb_object_keys(v_urls) loop
    if jsonb_typeof(p_results->v_kind) = 'object' and p_results->v_kind->'url' = v_urls->v_kind
       and jsonb_typeof(p_results->v_kind->'ok') = 'boolean' then
      v_state := v_state || jsonb_build_object(v_kind, jsonb_build_object('url', v_urls->v_kind, 'ok', p_results->v_kind->'ok', 'checked_at', now()));
    elsif v_shop.legal_links_state->v_kind->'url' = v_urls->v_kind then
      v_state := v_state || jsonb_build_object(v_kind, v_shop.legal_links_state->v_kind);
    end if;
  end loop;
  perform set_config('banto.legal_links_record', 'on', true);
  update shops set legal_links_state = v_state where id = p_shop_id;
  perform set_config('banto.legal_links_record', 'off', true);
  return v_state;
end;
$$;
revoke execute on function legal_links_record(uuid, jsonb) from public, anon;
grant execute on function legal_links_record(uuid, jsonb) to authenticated, service_role;

-- 確かめる時期の来たショップ（Cron。外の URL があり、どれかが未確認・設定と違う・間隔を過ぎた）。古い順に p_limit 件
create or replace function legal_links_due(p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('shop_id', d.id, 'urls', d.urls) order by d.oldest nulls first), '[]'::jsonb)
    from (
      select s.id, banto_legal_links_urls(s.settings) urls,
             (select min((s.legal_links_state->e.key->>'checked_at')::timestamptz) from jsonb_each(banto_legal_links_urls(s.settings)) e) oldest
        from shops s
       where banto_legal_links_urls(s.settings) <> '{}'::jsonb
         and exists (select 1 from jsonb_each(banto_legal_links_urls(s.settings)) e
                      where s.legal_links_state->e.key->'url' is distinct from e.value
                         or (s.legal_links_state->e.key->>'checked_at')::timestamptz < now() - make_interval(hours => banto_legal_links_hours(s.settings)))
       order by oldest nulls first
       limit greatest(1, least(coalesce(p_limit, 3), 50))
    ) d;
$$;
revoke execute on function legal_links_due(integer) from public, anon, authenticated;
grant execute on function legal_links_due(integer) to service_role;

-- legal_links_state は legal_links_record だけが書く（直接の更新は誰にも許さない。0055 の banto_shops_guard を差し替え）
create or replace function banto_shops_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.org_id is null and auth.uid() is not null then
      select m.org_id into new.org_id from org_members m join organizations o on o.id = m.org_id
       where m.user_id = auth.uid() and m.role in ('owner', 'admin') order by o.created_at limit 1;
      -- 0024 以降、運営者は必ず組織に属する。owner / admin の組織が無い人（降格された初代 owner）は組織の外にショップを作れない
      if new.org_id is null and auth.role() = 'authenticated' then raise exception 'org_required' using errcode = '42501'; end if;
    end if;
    if new.owner_id is not null and not exists (select 1 from owners where id = new.owner_id) then new.owner_id := null; end if;
    new.legal_links_state := '{}'::jsonb;
    return new;
  end if;
  if new.legal_links_state is distinct from old.legal_links_state and current_setting('banto.legal_links_record', true) is distinct from 'on' then
    raise exception 'legal_links_state_readonly' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if new.org_id is distinct from old.org_id and old.org_id is not null then raise exception 'org_immutable' using errcode = '42501'; end if;
    if new.owner_id is distinct from old.owner_id then raise exception 'owner_immutable' using errcode = '42501'; end if;
    if new.stripe_account_id is distinct from old.stripe_account_id and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
    -- 連携の設定（決済後の戻り先・中継元の IP・外部ログインの client_id・法務のページの外の URL）は integrations の項目（0055）
    if (new.settings->'headless' is distinct from old.settings->'headless' or new.settings->'oauth' is distinct from old.settings->'oauth')
       and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
    -- スラッグ・独自ドメイン・注文番号と試着の連番は、settings の項目では変えられない（0031）
    if (new.slug is distinct from old.slug or new.domain is distinct from old.domain
        or new.order_seq is distinct from old.order_seq or new.tryon_seq is distinct from old.tryon_seq)
       and not banto_owns_shop(old.id) then
      raise exception 'admin_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

insert into banto_migrations (version) values ('0062_legal_links');
