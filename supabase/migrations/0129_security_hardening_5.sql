-- 0129_security_hardening_5: 守りの締め直し 5（docs/upgrade.md「変更ごとの注意」）。
--
-- 1. shops.settings の鍵ごとに要る項目を決める（モジュールの ON/OFF はそのモジュールの項目、ひな形は content、独自項目の定義は catalog /
--    customers、回数の上限・公開・お店の画面の使い方・会員の設定は owner / admin）。settings の項目だけでは変えられない。
--    回数の上限（banto_shop_limit）は 1 未満を受けない（0 で止められない）。AI 用 API の api_shop_update も同じ（公開と上限は発行者が owner / admin のときだけ）
-- 2. 二段階認証の解除（org_member_mfa_reset_authorize）: 相手がどこかの組織で owner なら、自分がその組織の owner でない限り外せない。
--    外すときは相手が属する全組織に監査ログ
-- 3. 大きさの上限: products.description 50,000 字、shops.settings 64 KiB、hook_endpoints.manifest / settings 64 KiB（既存の行は検査しない: not valid）
-- 4. メディアライブラリ（page_media）は 1 ショップあたりの数に上限（商品画像は商品ごとの上限が Worker にあり、大きなカタログの取り込みを止めないので数えない）
-- 5. 監査ログ: hooks の送信先（URL・有効・出来事・マニフェスト）の変更と削除、ブログの削除、ひな形の割り当て、実店舗の独自項目の定義、
--    法務のリンクの生死の記録（運営者の操作だけ）
-- 6. hooks の送信先の URL の検査（banto_hook_url_private）: 末尾のドットを落としてから名前を判定、先頭に 0 のある IPv4（8 進に読まれる）と
--    100.64/10・198.18/15・192.0.0/24 も私設として受けない
-- 7. つないだ連携（app_connections）の送信先は、ホストが変わる URL の更新を受けない（つなぎ直すか外す）
-- 8. page_media の url は storage_key を指すものだけ
-- 9. reserve_stock / tryon_request は会員限定（audience_id）の商品を、条件に合う会員にだけ売る（Worker の判定を DB でも）
-- 10. api_orders_list の検索語の % と _ をエスケープ
-- 11. パスキーの登録・追加の券の「ログインしてから 15 分」は authenticated_at で数える（0090 と同じ）
-- 12. 退会・全端末ログアウト・連携の解除・パスキーの削除はセッションの id が必須（無ければ reauth_required）
-- 13. enqueue_hook を運営者の JWT から呼ぶとき、ペイロードの order_id / product_id / customer_id はそのショップの行だけ
-- 14. shop_public_get / shop_public_list の PUBLIC の EXECUTE を剥奪（anon / authenticated / service_role は今までどおり）

-- ---------- 1. settings の鍵ごとの項目 ----------
-- 鍵（と modules の中の id）に要る項目。'admin' は owner / admin（banto_owns_shop）、null は settings の項目だけでよい
create or replace function banto_shop_settings_perm(p_key text, p_module text)
returns text
language sql
immutable
as $$
  select case
    when p_key = 'modules' then case p_module
      when 'coupons' then 'marketing' when 'dialogs' then 'marketing' when 'audiences' then 'marketing' when 'product_feed' then 'marketing'
      when 'inquiries' then 'support'
      when 'pages' then 'content' when 'blog' then 'content'
      when 'care_labels' then 'catalog' when 'size_charts' then 'catalog' when 'embed' then 'catalog' when 'woo_import' then 'catalog'
      when 'event_relay' then 'integrations' when 'line_login' then 'integrations' when 'google_login' then 'integrations' when 'passkey' then 'integrations'
      when 'shipping_labels' then 'orders'
      when 'store_tryon' then 'stores'
      when 'favorites' then 'customers'
      else null end
    when p_key in ('headless', 'oauth') then 'integrations'
    when p_key = 'page_layouts' then 'content'
    when p_key = 'product_fields' then 'catalog'
    when p_key = 'customer_fields' then 'customers'
    when p_key in ('members_login_limits', 'checkout', 'inquiries', 'order_lookup', 'line_marketing_limit', 'storefront',
                   'members_password', 'members_enabled', 'marketing_consent', 'images', 'store_tryon', 'legal_links') then 'admin'
    else null end;
$$;
revoke execute on function banto_shop_settings_perm(text, text) from public, anon, authenticated;

create or replace function banto_shops_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_key text; v_mod text; v_perm text;
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
    -- 公開の切り替えは owner / admin
    if new.published is distinct from old.published and not banto_owns_shop(old.id) then
      raise exception 'admin_required' using errcode = '42501';
    end if;
    -- settings の鍵ごとに要る項目（banto_shop_settings_perm）。変わった鍵だけ見る
    for v_key in
      select distinct k from (select jsonb_object_keys(coalesce(new.settings, '{}'::jsonb)) k
                              union select jsonb_object_keys(coalesce(old.settings, '{}'::jsonb))) x
    loop
      continue when new.settings->v_key is not distinct from old.settings->v_key;
      if v_key = 'modules' then
        for v_mod in
          select distinct k from (select jsonb_object_keys(case when jsonb_typeof(new.settings->'modules') = 'object' then new.settings->'modules' else '{}'::jsonb end) k
                                  union select jsonb_object_keys(case when jsonb_typeof(old.settings->'modules') = 'object' then old.settings->'modules' else '{}'::jsonb end)) y
        loop
          continue when new.settings->'modules'->v_mod is not distinct from old.settings->'modules'->v_mod;
          v_perm := banto_shop_settings_perm('modules', v_mod);
          if v_perm is not null and not banto_shop_perm(old.id, v_perm) then
            raise exception '%', v_perm || '_required' using errcode = '42501';
          end if;
        end loop;
        continue;
      end if;
      v_perm := banto_shop_settings_perm(v_key, null);
      if v_perm = 'admin' then
        if not banto_owns_shop(old.id) then raise exception 'admin_required' using errcode = '42501'; end if;
      elsif v_perm is not null and not banto_shop_perm(old.id, v_perm) then
        raise exception '%', v_perm || '_required' using errcode = '42501';
      end if;
    end loop;
    -- スラッグ・独自ドメイン・連番（注文・試着・お問い合わせ）・SKU の軸のひな形は、settings の項目では変えられない（0031 / 0089）
    if (new.slug is distinct from old.slug or new.domain is distinct from old.domain
        or new.order_seq is distinct from old.order_seq or new.tryon_seq is distinct from old.tryon_seq
        or new.inquiry_seq is distinct from old.inquiry_seq or new.option_axes is distinct from old.option_axes)
       and not banto_owns_shop(old.id) then
      raise exception 'admin_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- 回数の上限は 1〜9999 だけ（0 や負の値は既定に戻す。0 で止められない）
create or replace function banto_shop_limit(p_shop_id uuid, p_section text, p_key text, p_default integer)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when (s.settings->p_section->>p_key) ~ '^[1-9][0-9]{0,3}$' then (s.settings->p_section->>p_key)::integer end from shops s where s.id = p_shop_id),
    p_default);
$$;

-- 利用者がそのショップの owner / admin（組織の owner / admin か、組織の外のショップの持ち主）か
create or replace function banto_user_owns_shop(p_user uuid, p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shops s
     where s.id = p_shop_id
       and ((s.org_id is null and s.owner_id = p_user)
            or (s.org_id is not null and exists (select 1 from org_members m where m.org_id = s.org_id and m.user_id = p_user and m.role in ('owner', 'admin')))));
$$;
revoke execute on function banto_user_owns_shop(uuid, uuid) from public, anon, authenticated;

create or replace function api_shop_update(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens;
  v_threshold integer;
  v_per_ip integer;
  v_login_ip integer;
  v_patch jsonb := '{}'::jsonb;
  v_in jsonb;
  v_terms jsonb;
  v_key text;
  v_val text;
  v_settings jsonb;
begin
  v_tok := api_require(p_token_hash, 'shop:write');
  -- 公開の切り替えと回数の上限は、発行者が owner / admin のときだけ（管理画面の settings の項目と同じ線）
  if (p_values ? 'published' or p_values ? 'max_pending_per_ip' or p_values ? 'login_per_ip_per_hour')
     and not banto_user_owns_shop(v_tok.owner_id, v_tok.shop_id) then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  select settings into v_settings from shops where id = v_tok.shop_id for update;
  if p_values ? 'low_stock_threshold' then
    v_threshold := (p_values->>'low_stock_threshold')::integer;
    if v_threshold is null or v_threshold < 0 or v_threshold > 100000 then raise exception 'invalid_low_stock_threshold'; end if;
    v_patch := v_patch || jsonb_build_object('low_stock_threshold', v_threshold);
  end if;
  -- 購入前の確認画面の文言（0032）: 渡した鍵だけ変え、null か空文字で消す。1 項目 2000 文字まで
  if p_values ? 'checkout_terms' then
    v_in := p_values->'checkout_terms';
    if jsonb_typeof(v_in) is distinct from 'object' then raise exception 'invalid_checkout_terms'; end if;
    v_terms := case when jsonb_typeof(v_settings->'checkout_terms') = 'object' then v_settings->'checkout_terms' else '{}'::jsonb end;
    foreach v_key in array array['delivery', 'cancellation', 'payment_note'] loop
      continue when not v_in ? v_key;
      case jsonb_typeof(v_in->v_key)
        when 'null' then v_val := '';
        when 'string' then v_val := btrim(replace(v_in->>v_key, E'\r\n', E'\n'));
        else raise exception 'invalid_checkout_terms';
      end case;
      if length(v_val) > 2000 then raise exception 'invalid_checkout_terms'; end if;
      v_terms := v_terms || jsonb_build_object(v_key, v_val);
    end loop;
    v_patch := v_patch || jsonb_build_object('checkout_terms', v_terms);
  end if;
  -- IP ごとの上限（0033。banto_shop_limit が読むのは 1〜4 桁）。同じ節のほかの値は残す
  if p_values ? 'max_pending_per_ip' then
    v_per_ip := (p_values->>'max_pending_per_ip')::integer;
    if v_per_ip is null or v_per_ip < 1 or v_per_ip > 9999 then raise exception 'invalid_max_pending_per_ip'; end if;
    v_patch := v_patch || jsonb_build_object('checkout',
      coalesce(case when jsonb_typeof(v_settings->'checkout') = 'object' then v_settings->'checkout' end, '{}'::jsonb) || jsonb_build_object('max_pending_per_ip', v_per_ip));
  end if;
  if p_values ? 'login_per_ip_per_hour' then
    v_login_ip := (p_values->>'login_per_ip_per_hour')::integer;
    if v_login_ip is null or v_login_ip < 1 or v_login_ip > 9999 then raise exception 'invalid_login_per_ip_per_hour'; end if;
    v_patch := v_patch || jsonb_build_object('members_login_limits',
      coalesce(case when jsonb_typeof(v_settings->'members_login_limits') = 'object' then v_settings->'members_login_limits' end, '{}'::jsonb) || jsonb_build_object('per_ip_per_hour', v_login_ip));
  end if;
  update shops set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    legal_notice = case when p_values ? 'legal_notice' then nullif(btrim(p_values->>'legal_notice'), '') else legal_notice end,
    privacy_policy = case when p_values ? 'privacy_policy' then nullif(btrim(p_values->>'privacy_policy'), '') else privacy_policy end,
    return_policy = case when p_values ? 'return_policy' then nullif(btrim(p_values->>'return_policy'), '') else return_policy end,
    published = coalesce((p_values->>'published')::boolean, published),
    settings = settings || v_patch
  where id = v_tok.shop_id;
  return api_shop_get(p_token_hash);
end;
$$;

-- ---------- 2. 二段階認証の解除 ----------
create or replace function org_member_mfa_reset_authorize(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_org record; v_ok boolean := false;
begin
  if auth.uid() is null or p_user_id is null or p_user_id = auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 登録は人単位（GoTrue）で組織単位ではない。相手がどこかの組織で owner なら、自分がその組織の owner でない限り外せない
  if exists (select 1 from org_members t
              where t.user_id = p_user_id and t.role = 'owner'
                and not exists (select 1 from org_members me where me.org_id = t.org_id and me.user_id = auth.uid() and me.role = 'owner')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for v_org in
    select me.org_id, me.role as my_role, them.role as their_role
      from org_members me join org_members them on them.org_id = me.org_id
     where me.user_id = auth.uid() and them.user_id = p_user_id and me.role in ('owner', 'admin')
  loop
    if v_org.their_role = 'owner' and v_org.my_role <> 'owner' then continue; end if;
    v_ok := true;
  end loop;
  if not v_ok then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 相手が属する全組織に残す（外した側の組織にしか残らないと、ほかの組織の owner / admin が気づけない）
  for v_org in select distinct org_id from org_members where user_id = p_user_id loop
    perform banto_audit(v_org.org_id, null, 'org_member.mfa_reset', 'user', p_user_id::text, jsonb_build_object('by_org', (select org_id from org_members where user_id = auth.uid() and org_id = v_org.org_id)));
  end loop;
  return true;
end;
$$;

-- ---------- 3. 大きさの上限 ----------
-- 既存の行は検査しない（not valid）。超えている行は次に変えるときに短くする必要がある
alter table products drop constraint if exists products_description_len;
alter table products add constraint products_description_len check (description is null or char_length(description) <= 50000) not valid;
alter table shops drop constraint if exists shops_settings_size;
alter table shops add constraint shops_settings_size check (pg_column_size(settings) <= 65536) not valid;
alter table hook_endpoints drop constraint if exists hook_endpoints_manifest_size;
alter table hook_endpoints add constraint hook_endpoints_manifest_size check (manifest is null or pg_column_size(manifest) <= 65536) not valid;
alter table hook_endpoints drop constraint if exists hook_endpoints_settings_size;
alter table hook_endpoints add constraint hook_endpoints_settings_size check (settings is null or pg_column_size(settings) <= 65536) not valid;

-- ---------- 4. メディアライブラリの数 ----------
create or replace function banto_page_media_max() returns integer language sql immutable as $$ select 2000 $$;
revoke execute on function banto_page_media_max() from public, anon, authenticated;

create or replace function banto_page_media_shop_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from shops where id = new.shop_id for update;
  if (select count(*) from page_media where shop_id = new.shop_id) >= banto_page_media_max() then
    raise exception 'page_media_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function banto_page_media_shop_limit() from public, anon, authenticated;
drop trigger if exists page_media_shop_limit on page_media;
create trigger page_media_shop_limit before insert on page_media for each row execute function banto_page_media_shop_limit();

-- ---------- 5. 監査ログ ----------
create or replace function banto_hook_host(p_url text)
returns text language sql immutable as $$
  select left(lower(substring(p_url from '^https?://(?:[^@/?#]*@)?([^/?#]+)')), 200);
$$;
revoke execute on function banto_hook_host(text) from public, anon, authenticated;

create or replace function banto_audit_hook_endpoints()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_detail jsonb := '{}'::jsonb; v_changed boolean := false;
begin
  if tg_op = 'DELETE' then
    perform banto_audit(banto_shop_org(old.shop_id), old.shop_id, 'hook_endpoint.deleted', 'hook_endpoint', old.id::text,
                        jsonb_build_object('name', left(old.name, 100), 'host', banto_hook_host(old.url)));
    return old;
  end if;
  if new.url is distinct from old.url then
    v_detail := v_detail || jsonb_build_object('host_from', banto_hook_host(old.url), 'host_to', banto_hook_host(new.url));
    v_changed := true;
  end if;
  if new.enabled is distinct from old.enabled then
    v_detail := v_detail || jsonb_build_object('enabled', new.enabled);
    v_changed := true;
  end if;
  if new.events is distinct from old.events then
    v_detail := v_detail || jsonb_build_object('events', to_jsonb(new.events));
    v_changed := true;
  end if;
  -- マニフェストの取り直し（Cron、service_role）はログにしない。運営者が差し替えたときだけ
  if new.manifest is distinct from old.manifest and auth.role() is distinct from 'service_role' then
    v_detail := v_detail || jsonb_build_object('manifest', true);
    v_changed := true;
  end if;
  if v_changed then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'hook_endpoint.changed', 'hook_endpoint', new.id::text,
                        jsonb_build_object('name', left(new.name, 100)) || v_detail);
  end if;
  return new;
end;
$$;
revoke execute on function banto_audit_hook_endpoints() from public, anon, authenticated;
drop trigger if exists hook_endpoints_audit on hook_endpoints;
create trigger hook_endpoints_audit after update of url, enabled, events, manifest or delete on hook_endpoints
  for each row execute function banto_audit_hook_endpoints();

create or replace function blog_delete(p_shop_id uuid, p_blog_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_handle text; v_n integer;
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'content') then
    raise exception 'blog_not_found' using errcode = '42501';
  end if;
  select handle into v_handle from blogs where id = p_blog_id and shop_id = p_shop_id;
  if not found then raise exception 'blog_not_found' using errcode = '42501'; end if;
  delete from articles where blog_id = p_blog_id and shop_id = p_shop_id;
  get diagnostics v_n = row_count;
  delete from blogs where id = p_blog_id and shop_id = p_shop_id;
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'blog.deleted', 'blog', p_blog_id::text, jsonb_build_object('handle', v_handle, 'articles', v_n));
end;
$$;

create or replace function page_layouts_set(p_shop_id uuid, p_layouts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'content') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_out := banto_page_layouts_apply(p_shop_id, p_layouts);
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'shop.page_layouts_changed', 'shop', p_shop_id::text,
                      jsonb_build_object('keys', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v_out) k), '[]'::jsonb)));
  return v_out;
end;
$$;

create or replace function api_page_layouts_set(p_token_hash text, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_cur jsonb; v_map jsonb; e record; k text; v_page text; v_key text;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'pages');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_page_layouts'; end if;
  if exists (select 1 from jsonb_object_keys(p_changes) x where x not in ('home', 'articles', 'product', 'product_categories', 'collection', 'collection_categories', 'legal', 'legal_pages', 'blogs')) then
    raise exception 'invalid_page_layouts:unknown_key';
  end if;
  v_cur := coalesce((select settings->'page_layouts' from shops where id = v_tok.shop_id), '{}'::jsonb);
  foreach k in array array['home', 'product', 'collection', 'legal'] loop
    if p_changes ? k then
      if jsonb_typeof(p_changes->k) = 'null' or coalesce(p_changes->>k, '') = '' then v_cur := v_cur - k;
      else
        select id::text into v_page from pages where shop_id = v_tok.shop_id and deleted_at is null and (handle = p_changes->>k or id::text = p_changes->>k);
        if v_page is null then raise exception 'invalid_page_layouts:%', k; end if;
        v_cur := v_cur || jsonb_build_object(k, v_page);
      end if;
    end if;
  end loop;
  foreach k in array array['articles', 'blogs', 'product_categories', 'collection_categories', 'legal_pages'] loop
    if p_changes ? k then
      if jsonb_typeof(p_changes->k) <> 'object' then raise exception 'invalid_page_layouts:%', k; end if;
      v_map := case when jsonb_typeof(v_cur->k) = 'object' then v_cur->k else '{}'::jsonb end;
      for e in select * from jsonb_each(p_changes->k) loop
        v_key := case when k in ('articles', 'blogs') then (select b.id::text from blogs b where b.shop_id = v_tok.shop_id and (b.handle = e.key or b.id::text = e.key))
                      when k in ('product_categories', 'collection_categories') then (select c.id::text from categories c where c.shop_id = v_tok.shop_id and (c.slug = e.key or c.id::text = e.key))
                      when e.key in ('legal', 'privacy', 'returns') then e.key end;
        if v_key is null then raise exception 'invalid_page_layouts:%', k; end if;
        if jsonb_typeof(e.value) = 'null' or coalesce(e.value #>> '{}', '') = '' then v_map := v_map - v_key;
        else
          v_page := null;
          if jsonb_typeof(e.value) = 'string' then
            select id::text into v_page from pages where shop_id = v_tok.shop_id and deleted_at is null and (handle = e.value #>> '{}' or id::text = e.value #>> '{}');
          end if;
          if v_page is null then raise exception 'invalid_page_layouts:%', k; end if;
          v_map := v_map || jsonb_build_object(v_key, v_page);
        end if;
      end loop;
      v_cur := v_cur || jsonb_build_object(k, v_map);
    end if;
  end loop;
  v_cur := banto_page_layouts_apply(v_tok.shop_id, v_cur);
  perform banto_audit(banto_shop_org(v_tok.shop_id), v_tok.shop_id, 'shop.page_layouts_changed', 'shop', v_tok.shop_id::text,
                      jsonb_build_object('keys', coalesce((select jsonb_agg(kk order by kk) from jsonb_object_keys(v_cur) kk), '[]'::jsonb)));
  return banto_page_layouts_readable(v_tok.shop_id, v_cur);
end;
$$;

create or replace function store_fields_set(p_org_id uuid, p_defs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not banto_org_admin(p_org_id) then raise exception 'org_not_found' using errcode = '42501'; end if;
  update organizations set store_fields = coalesce(p_defs, '[]'::jsonb) where id = p_org_id;
  perform banto_audit(p_org_id, null, 'org.store_fields_changed', 'organization', p_org_id::text,
                      jsonb_build_object('keys', coalesce((select jsonb_agg(d->>'key' order by d->>'key') from jsonb_array_elements(coalesce((select store_fields from organizations where id = p_org_id), '[]'::jsonb)) d), '[]'::jsonb)));
  return (select store_fields from organizations where id = p_org_id);
end;
$$;

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
  -- 運営者が「今すぐ確かめる」で書いたときだけ残す（Cron の定期の確認は残さない）
  if auth.role() is distinct from 'service_role' then
    perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'shop.legal_links_checked', 'shop', p_shop_id::text,
                        (select coalesce(jsonb_object_agg(k, v->'ok'), '{}'::jsonb) from jsonb_each(v_state) e(k, v)));
  end if;
  return v_state;
end;
$$;

-- ---------- 6. hooks の送信先の URL ----------
create or replace function banto_hook_url_private(p_url text)
returns boolean
language plpgsql
immutable
as $$
declare v_host text; v_ip inet; v_mapped text;
begin
  v_host := lower(substring(p_url from '^https?://(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#\[]+)'));
  if v_host is null or v_host = '' then return true; end if;
  if v_host ~ '^\[.*\]$' then
    begin
      v_ip := substring(v_host from 2 for length(v_host) - 2)::inet;
    exception when others then
      return true;
    end;
    if v_ip <<= '::1/128'::inet or v_ip <<= '::/128'::inet or v_ip <<= 'fc00::/7'::inet or v_ip <<= 'fe80::/10'::inet then return true; end if;
    if v_ip <<= '::ffff:0:0/96'::inet then
      -- IPv4 を埋め込む IPv6 は中の IPv4 で判定（host() は ::ffff:a.b.c.d の形で返す）
      v_mapped := substring(host(v_ip) from '([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$');
      if v_mapped is null then return true; end if;
      return banto_hook_url_private('http://' || v_mapped || '/');
    end if;
    return false;
  end if;
  -- 末尾のドットは URL パーサーが捨てる（10.0.0.5. は 10.0.0.5、localhost. は localhost）。名前の判定の前に落とす
  v_host := regexp_replace(v_host, '\.+$', '');
  if v_host = 'localhost' or v_host ~ '\.(localhost|internal|local|home\.arpa|lan)$' then return true; end if;
  -- 数だけの名前（2130706433・127.1・0x7f.1）は URL パーサーが IPv4 に直す。4 つ組のドット区切りの形だけを inet で判定し、ほかの形は受けない。
  -- 先頭に 0 のあるオクテット（0177.0.0.1）はブラウザと Node が 8 進に読む（PostgreSQL は 10 進）ので受けない
  if v_host ~ '^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$' then
    if v_host !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' then return true; end if;
    if v_host ~ '(^|\.)0[0-9]' then return true; end if;
    begin
      v_ip := v_host::inet;
    exception when others then
      return true;
    end;
    return v_ip <<= '10.0.0.0/8'::inet or v_ip <<= '172.16.0.0/12'::inet or v_ip <<= '192.168.0.0/16'::inet
        or v_ip <<= '127.0.0.0/8'::inet or v_ip <<= '169.254.0.0/16'::inet or v_ip <<= '0.0.0.0/8'::inet
        or v_ip <<= '100.64.0.0/10'::inet or v_ip <<= '198.18.0.0/15'::inet or v_ip <<= '192.0.0.0/24'::inet;
  end if;
  return false;
end;
$$;

-- ---------- 7. つないだ連携の送信先 ----------
create or replace function banto_hook_endpoints_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.url is null or new.url !~ '^https?://' then raise exception 'invalid_url'; end if;
  if new.url like 'https://banto.invalid/%' then
    -- 外部の送信先として登録した行を同梱の内部 URL に書き換えることは運営者にはさせない（0031 の守りの抜け）
    if tg_op = 'UPDATE' and old.url not like 'https://banto.invalid/%' and auth.role() is distinct from 'service_role' then
      raise exception 'invalid_url';
    end if;
    return new;
  end if;
  if banto_hook_url_private(new.url) then raise exception 'invalid_url'; end if;
  -- つないだ連携（0088）の送信先のホストは変えられない（前の相手に渡したトークンとシークレットが残るため。つなぎ直すか外す）
  if tg_op = 'UPDATE' and auth.role() is distinct from 'service_role'
     and banto_hook_host(new.url) is distinct from banto_hook_host(old.url)
     and exists (select 1 from app_connections where endpoint_id = old.id) then
    raise exception 'app_connected_url_locked' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------- 8. page_media の url ----------
create or replace function api_page_media_add(p_token_hash text, p_storage_key text, p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_id uuid;
begin
  v_tok := api_require(p_token_hash, 'content:write');
  if not exists (select 1 from shops where id = v_tok.shop_id and (settings->'modules'->'pages' = 'true'::jsonb or settings->'modules'->'blog' = 'true'::jsonb)) then
    raise exception 'module_disabled';
  end if;
  if p_storage_key is null or p_storage_key !~ ('^pages/' || v_tok.shop_id::text || '/[A-Za-z0-9._-]{1,100}$') then raise exception 'invalid_storage_key'; end if;
  -- url は置き場の鍵を指すものだけ（<置き場>/<鍵>）
  if p_url is null or char_length(p_url) > 2000 or p_url !~ '^(https?://[^/?#\s<>"''`]+)?/' or right(p_url, char_length(p_storage_key) + 1) <> '/' || p_storage_key then
    raise exception 'invalid_url';
  end if;
  insert into page_media (shop_id, storage_key, url) values (v_tok.shop_id, p_storage_key, p_url) returning id into v_id;
  return jsonb_build_object('id', v_id, 'url', p_url);
end;
$$;

-- ---------- 9. 会員限定の商品の予約 ----------
drop function if exists reserve_stock(uuid, jsonb, integer, text, text, text);
create or replace function reserve_stock(p_shop_id uuid, p_items jsonb, p_ttl_seconds integer default 900,
                                         p_quote_id text default null, p_subject_hash text default null, p_ip_hash text default null,
                                         p_customer_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku_id uuid;
  v_qty integer;
  v_price integer;
  v_updated integer;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id uuid;
  v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reserve_stock: service_role only' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_items';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_ttl';
  end if;

  -- 同じ quote で生きた予約があれば拒む（決済ページを開かずに在庫だけ押さえ続けるのを止める）
  if p_quote_id is not null and exists (select 1 from reservations where shop_id = p_shop_id and quote_id = p_quote_id and status in ('pending', 'confirmed')) then
    raise exception 'quote_already_used';
  end if;
  -- 同じ人・同じ IP の未確定の予約の数（数えてから入れるまでを直列にする）。
  -- 0 円の注文はその場で confirmed になり pending が残らないので、直近 1 時間の 0 円注文（orders.payment_provider = 'free'）も数える（0056）
  if p_subject_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation|' || p_shop_id::text || '|' || p_subject_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.subject_hash = p_subject_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_customer', 3) then
      raise exception 'too_many_reservations' using detail = 'customer';
    end if;
  end if;
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation-ip|' || p_shop_id::text || '|' || p_ip_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.ip_hash = p_ip_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_ip', 20) then
      raise exception 'too_many_reservations' using detail = 'ip';
    end if;
  end if;

  -- 会員限定の商品（audience_id）は、条件に合う会員だけが買える（product_member_skus の purchasable と同じ判定を DB でも）
  if p_customer_id is not null then v_aud := banto_member_audience_ids(p_shop_id, p_customer_id); end if;

  -- sku_id 順に処理し、複数予約が同じ SKU 群を逆順でロックしてデッドロックするのを防ぐ
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku_id := (v_item->>'sku_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_sku_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'invalid_item' using detail = coalesce(v_item::text, 'null');
    end if;

    select k.price_jpy into v_price
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = k.shop_id
     where k.id = v_sku_id and k.shop_id = p_shop_id and p.published and s.published
       and (p.audience_id is null or (p_customer_id is not null and p.audience_id = any(v_aud)));
    if not found then
      raise exception 'sku_not_available' using detail = v_sku_id::text;
    end if;

    update inventory
       set available = available - v_qty, updated_at = now()
     where sku_id = v_sku_id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'insufficient_stock' using detail = v_sku_id::text;
    end if;

    v_items := v_items || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'unit_price_jpy', v_price);
  end loop;

  insert into reservations (shop_id, items, expires_at, quote_id, subject_hash, ip_hash)
  values (p_shop_id, v_items, now() + make_interval(secs => p_ttl_seconds), p_quote_id, p_subject_hash, p_ip_hash)
  returning id into v_reservation_id;

  return v_reservation_id;
end;
$$;

revoke execute on function reserve_stock(uuid, jsonb, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function reserve_stock(uuid, jsonb, integer, text, text, text, uuid) to service_role;

create or replace function tryon_request(p_shop_id uuid, p_store_id uuid, p_items jsonb, p_customer jsonb, p_visit_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_it jsonb; v_sku skus%rowtype; v_qty integer; v_n integer; v_id uuid; v_number integer; v_cid uuid; v_total integer := 0;
  v_email text; v_ip text; v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_request: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and published) then raise exception 'shop_not_found'; end if;
  if not exists (select 1 from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = p_shop_id and ss.store_id = p_store_id and ss.tryon and st.active) then
    raise exception 'store_not_available';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then raise exception 'invalid_items'; end if;
  if position('@' in coalesce(p_customer->>'customer_email', '')) < 2 then raise exception 'invalid_customer'; end if;
  v_email := lower(btrim(p_customer->>'customer_email'));
  v_ip := case when (p_customer->>'ip_hash') ~ '^[0-9a-f]{64}$' then p_customer->>'ip_hash' end;
  v_cid := nullif(p_customer->>'customer_id', '')::uuid;
  if v_cid is not null and not exists (select 1 from customers where shop_id = p_shop_id and id = v_cid) then v_cid := null; end if;
  if v_cid is not null then v_aud := banto_member_audience_ids(p_shop_id, v_cid); end if;

  perform pg_advisory_xact_lock(hashtextextended('tryon|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from tryon_requests where shop_id = p_shop_id and customer_email = v_email and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_customer', 3) then
    raise exception 'too_many_requests' using detail = 'customer';
  end if;
  if v_ip is not null and (select count(*) from tryon_requests where shop_id = p_shop_id and ip_hash = v_ip and status in ('requested', 'sent', 'ready'))
     >= banto_shop_limit(p_shop_id, 'store_tryon', 'max_open_per_ip', 10) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;

  update shops set tryon_seq = tryon_seq + 1 where id = p_shop_id returning tryon_seq into v_number;
  insert into tryon_requests (shop_id, store_id, number, visit_date, customer_id, customer_email, customer_name, customer_phone, note, ip_hash)
  values (p_shop_id, p_store_id, v_number, p_visit_date, v_cid, v_email,
          left(nullif(btrim(coalesce(p_customer->>'customer_name', '')), ''), 100), left(nullif(btrim(coalesce(p_customer->>'customer_phone', '')), ''), 20),
          left(nullif(btrim(coalesce(p_customer->>'note', '')), ''), 500), v_ip)
  returning id into v_id;

  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_qty := case when coalesce(v_it->>'qty', '') ~ '^[0-9]{1,2}$' then (v_it->>'qty')::integer else 0 end;
    if v_qty <= 0 then raise exception 'invalid_items'; end if;
    select k.* into v_sku from skus k join products p on p.id = k.product_id
     where k.id = nullif(v_it->>'sku_id', '')::uuid and k.shop_id = p_shop_id and p.published
       -- 会員限定の商品は、条件に合う会員だけ（product_member_skus の purchasable と同じ）
       and (p.audience_id is null or (v_cid is not null and p.audience_id = any(v_aud)));
    if not found then raise exception 'sku_not_available'; end if;
    update inventory set available = available - v_qty where sku_id = v_sku.id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'insufficient_stock' using detail = v_sku.id::text; end if;
    insert into tryon_items (shop_id, request_id, sku_id, qty, unit_price_jpy) values (p_shop_id, v_id, v_sku.id, v_qty, v_sku.price_jpy);
    v_total := v_total + v_qty;
  end loop;
  if v_total > 20 then raise exception 'invalid_items'; end if;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.requested',
    jsonb_build_object('request_id', v_id, 'number', v_number, 'shop_id', p_shop_id, 'store_id', p_store_id, 'status', 'requested',
                       'visit_date', p_visit_date, 'customer_id', v_cid));
  return jsonb_build_object('id', v_id, 'number', v_number);
end;
$$;

-- ---------- 10. api_orders_list の検索語 ----------
create or replace function api_orders_list(p_token_hash text, p_status text default null, p_from timestamptz default null,
                                           p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0,
                                           p_query text default null, p_customer_id uuid default null,
                                           p_updated_since timestamptz default null, p_after uuid default null, p_tag text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens; v_pii boolean; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_number integer;
  v_seq boolean; v_cursor jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_number := case when p_query ~ '^\d+$' then p_query::integer else null end;
  v_seq := p_updated_since is not null;
  if p_after is not null and not v_seq then raise exception 'invalid_cursor'; end if;

  select count(*) into v_total from orders o
   where o.shop_id = v_tok.shop_id
     and (p_status is null or o.status::text = p_status)
     and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
     and (p_customer_id is null or o.customer_id = p_customer_id)
     and (p_tag is null or o.tags @> array[btrim(p_tag)])
     and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
     and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || banto_like_escape(p_query) || '%' or o.customer_name ilike '%' || banto_like_escape(p_query) || '%')));
  with page as (
    select o.id, o.updated_at,
           row_number() over (order by case when v_seq then o.updated_at end asc, case when v_seq then o.id end asc, o.created_at desc, o.id desc) as ord
      from orders o
     where o.shop_id = v_tok.shop_id
       and (p_status is null or o.status::text = p_status)
       and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
       and (p_customer_id is null or o.customer_id = p_customer_id)
       and (p_tag is null or o.tags @> array[btrim(p_tag)])
       and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
       and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || banto_like_escape(p_query) || '%' or o.customer_name ilike '%' || banto_like_escape(p_query) || '%')))
     order by ord
     limit v_limit offset case when v_seq then 0 else v_offset end
  )
  select coalesce(jsonb_agg(api_order_json(o, v_pii) order by p.ord), '[]'::jsonb),
         (select jsonb_build_object('updated_since', l.updated_at, 'after', l.id) from page l order by l.ord desc limit 1)
    into v_items, v_cursor
    from page p join orders o on o.id = p.id;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', case when v_seq then 0 else v_offset end, 'pii', v_pii)
         || case when v_seq then jsonb_build_object('cursor', v_cursor, 'has_more', v_total > jsonb_array_length(v_items)) else '{}'::jsonb end;
end;
$$;

-- ---------- 11. パスキーの 15 分 ----------
create or replace function member_passkey_begin(p_shop_id uuid, p_purpose text, p_challenge_hash text, p_ip_hash text, p_customer_id uuid default null, p_epoch integer default null, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_domain text; v_c customers; v_id uuid; v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_begin: service_role only' using errcode = '42501';
  end if;
  if p_purpose not in ('login', 'register') then raise exception 'invalid_purpose'; end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;

  if p_purpose = 'login' then
    if p_ip_hash is not null then
      select count(*) into v_n from member_passkey_challenges
       where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
      if v_n >= 30 then return jsonb_build_object('ok', false, 'reason', 'limited'); end if;
    end if;
    select count(*) into v_n from member_passkey_challenges where shop_id = p_shop_id and created_at > now() - interval '10 minutes';
    if v_n >= 3000 then return jsonb_build_object('ok', false, 'reason', 'limited'); end if;
    insert into member_passkey_challenges (shop_id, purpose, challenge_hash, ip_hash, expires_at)
    values (p_shop_id, 'login', p_challenge_hash, p_ip_hash, now() + interval '5 minutes')
    returning id into v_id;
    return jsonb_build_object('ok', true, 'challenge_id', v_id, 'rp_id', v_domain);
  end if;

  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found or p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not exists (select 1 from member_sessions where id = p_session_id and kind = 'web') or not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  if (select count(*) from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id) >= banto_passkey_limit() then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  insert into member_passkey_challenges (shop_id, purpose, challenge_hash, customer_id, session_id, ip_hash, expires_at)
  values (p_shop_id, 'register', p_challenge_hash, p_customer_id, p_session_id, p_ip_hash, now() + interval '5 minutes')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'challenge_id', v_id, 'rp_id', v_domain,
    'user', jsonb_build_object('email', v_c.email, 'name', v_c.name),
    'exclude', coalesce((select jsonb_agg(credential_id order by created_at) from member_passkeys
                          where shop_id = p_shop_id and customer_id = p_customer_id and rp_id = v_domain), '[]'::jsonb));
end;
$$;

create or replace function member_passkey_register(
  p_shop_id uuid, p_challenge_id uuid, p_challenge_hash text, p_customer_id uuid, p_epoch integer, p_session_id uuid,
  p_credential_id text, p_public_key text, p_alg integer, p_sign_count bigint, p_rp_id text, p_backed_up boolean, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_ch member_passkey_challenges; v_domain text; v_id uuid; v_email text; v_from text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_register: service_role only' using errcode = '42501';
  end if;
  v_domain := banto_passkey_shop(p_shop_id);
  if v_domain is null or v_domain <> p_rp_id then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  v_ch := banto_passkey_consume(p_shop_id, p_challenge_id, p_challenge_hash, 'register');
  if v_ch.id is null or v_ch.customer_id is distinct from p_customer_id or v_ch.session_id is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not exists (select 1 from member_sessions where id = p_session_id and kind = 'web') or not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 20) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  perform 1 from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if (select count(*) from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id) >= banto_passkey_limit() then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if exists (select 1 from member_passkeys where shop_id = p_shop_id and credential_id = p_credential_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  insert into member_passkeys (shop_id, customer_id, credential_id, public_key, alg, rp_id, sign_count, backed_up, label)
  values (p_shop_id, p_customer_id, p_credential_id, p_public_key, p_alg, p_rp_id, coalesce(p_sign_count, 0), coalesce(p_backed_up, false),
          nullif(left(btrim(coalesce(p_label, '')), 60), ''))
  returning id into v_id;
  select email into v_email from customers where shop_id = p_shop_id and id = p_customer_id;
  -- 知らせのメールの送信元（メール通知プラグインの設定。無ければ null = 送らない）
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email, 'mail_from', v_from);
end;
$$;

create or replace function member_passkey_ticket_create(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_ticket_create: service_role only' using errcode = '42501';
  end if;
  if banto_passkey_shop(p_shop_id) is null then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_token'; end if;
  if p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id)
     or not exists (select 1 from member_sessions where id = p_session_id and kind = 'api') then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  if (select count(*) from member_passkey_tickets where shop_id = p_shop_id and customer_id = p_customer_id and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  delete from member_passkey_tickets where expires_at < now() - interval '1 day';
  insert into member_passkey_tickets (shop_id, customer_id, session_epoch, api_session_id, token_hash, expires_at)
  values (p_shop_id, p_customer_id, p_epoch, p_session_id, p_token_hash, now() + interval '2 minutes')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------- 12. セッションの id が必須 ----------
create or replace function member_withdraw(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_email text; v_found boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_withdraw: service_role only' using errcode = '42501';
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  delete from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch returning email into v_email;
  v_found := found;
  if not v_found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'email', v_email, 'mail_from', banto_member_mail_from(p_shop_id));
end;
$$;

create or replace function member_logout_all(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_logout_all: service_role only' using errcode = '42501';
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  update customers set session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;

create or replace function member_unlink_identity(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_provider text, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_unlink_identity: service_role only' using errcode = '42501';
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return false; end if;
  if v_c.email is null then raise exception 'last_login_method'; end if;
  delete from member_identities where shop_id = p_shop_id and customer_id = p_customer_id and provider = p_provider;
  return found;
end;
$$;

create or replace function member_passkey_delete(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_id uuid, p_session_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_delete: service_role only' using errcode = '42501';
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    raise exception 'reauth_required';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return false;
  end if;
  delete from member_passkeys where id = p_id and shop_id = p_shop_id and customer_id = p_customer_id;
  return found;
end;
$$;

-- ---------- 13. enqueue_hook のペイロード ----------
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_perm text; v_product uuid;
begin
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  if auth.role() is distinct from 'service_role' then
    v_perm := case p_event when 'product.updated' then 'catalog' when 'order.shipped' then 'orders' end;
    if v_perm is null then
      raise exception 'event_not_permitted' using errcode = '42501';
    end if;
    if not banto_shop_perm(p_shop_id, v_perm) then
      raise exception 'shop_not_found' using errcode = '42501';
    end if;
    -- ペイロードの id（uuid の形のもの）はそのショップの行だけ（別のショップの商品・無い注文で受け手を動かさない）
    if (p_payload->>'order_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from orders o where o.shop_id = p_shop_id and o.id::text = p_payload->>'order_id') then
      raise exception 'invalid_payload' using detail = 'order_id';
    end if;
    if (p_payload->>'product_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from products p where p.shop_id = p_shop_id and p.id::text = p_payload->>'product_id') then
      raise exception 'invalid_payload' using detail = 'product_id';
    end if;
    if (p_payload->>'customer_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from customers c where c.shop_id = p_shop_id and c.id::text = p_payload->>'customer_id') then
      raise exception 'invalid_payload' using detail = 'customer_id';
    end if;
  end if;
  -- inventory.low に商品の id を足す（SKU から引く。足せなければそのまま）
  if p_event = 'inventory.low' and coalesce(p_payload, '{}'::jsonb) ? 'sku_id' and not (p_payload ? 'product_id') then
    select k.product_id into v_product from skus k where k.shop_id = p_shop_id and k.id::text = p_payload->>'sku_id';
    if v_product is not null then p_payload := p_payload || jsonb_build_object('product_id', v_product); end if;
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events)
     and not (p_event = 'product.updated' and coalesce(p_payload, '{}'::jsonb) ? 'product_id' and exists (
       select 1 from hook_deliveries d
        where d.endpoint_id = e.id and d.status = 'pending' and d.attempts = 0 and d.event = 'product.updated'
          and d.payload->>'product_id' = p_payload->>'product_id'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- 14. PUBLIC の EXECUTE ----------
revoke execute on function shop_public_get(text, text) from public;
revoke execute on function shop_public_list() from public;
-- RLS のポリシーと公開の関数が使う判定の関数は、PUBLIC ではなく anon / authenticated / service_role に明示して付ける（呼べる範囲は今までと同じ）
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('banto_org_admin', 'banto_org_role', 'banto_owner_signup_allowed', 'banto_owns_shop', 'banto_product_search_text',
                         'banto_setup_state', 'banto_shop_perm', 'banto_store_perm', 'banto_store_visible', 'banto_valid_tags', 'shop_payment_options')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end;
$$;

insert into banto_migrations (version) values ('0129_security_hardening_5');
