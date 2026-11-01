-- 0089_security_hardening_3: 守りの締め直し 3（docs/upgrade.md「変更ごとの注意」）。
--
-- 1. 在庫の数は anon に読ませない（inventory の公開ポリシーを外す）。お店の画面とヘッドレスは product_public_stock（0〜99 の段階値）で引く
-- 2. お問い合わせ: 「同じアドレスの開いているチケット」は確認済みだけを数える。未確認は 24 時間に 3 件までで、超えたら行を作らず同じ形の応答
-- 3. hooks の送信先の URL を DB でも確かめる（私設のアドレス・localhost・社内の名前は受けない。外部の行を同梱の内部 URL に変えられない）
-- 4. shops の採番・判定だけが書く列（order_seq / tryon_seq / inquiry_seq / legal_links_state / theme_version_id）は運営者の JWT から UPDATE できない
-- 5. custom.v1 の文字列の検査は、スキームの途中のタブ・改行を捨ててから当てる
-- 6. ゲストの注文照会（lookup_order）は会員の注文を返さない（会員の注文は会員のログインで）
-- 7. 注文照会の外れをメールアドレスの HMAC ごと・ショップ全体でも数える（IP が取れない構成でも上限が効く）
-- 8. 無効にした連携は「つなぐ」もプラグインのデータの書き込みもできない
-- 9. アイキャッチ（pages / articles の image_url）は Banto の置き場の形だけ
-- 10. ページ・ブログ・記事の公開の RLS はモジュール ON のショップだけ
-- 11. ページ・ブログ・記事の物理削除は運営者の JWT からできない（ブログは blog_delete、ページ・記事は Cron の purge だけ）
-- 12. 監査ログ: inquiry_delete・mask_customer・テーマの版の settings / complete・AI 用トークンの削除
-- 13. 担当者の一覧・1 件の assignee にメールアドレスを出さない（user_id と label）
-- 14. api_pages_list / api_articles_list の検索語の % と _ をエスケープ

-- ---------- 1. 在庫 ----------
drop policy if exists inventory_public on inventory;
revoke all on inventory from anon;

create or replace function product_public_stock(p_shop_id uuid, p_sku_ids uuid[])
returns table (sku_id uuid, available integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_sku_ids is null then return; end if;
  if cardinality(p_sku_ids) > 200 then raise exception 'too_many_skus'; end if;
  return query
    select i.sku_id, least(greatest(i.available, 0), 99)::integer
      from inventory i
      join skus k on k.id = i.sku_id
      join products p on p.id = k.product_id
      join shops s on s.id = p.shop_id
     where s.id = p_shop_id and s.published and p.published and k.shop_id = p_shop_id
       and i.sku_id = any(p_sku_ids);
end;
$$;
revoke execute on function product_public_stock(uuid, uuid[]) from public;
grant execute on function product_public_stock(uuid, uuid[]) to anon, authenticated, service_role;

-- ---------- 2. お問い合わせ ----------
create or replace function inquiry_create(p_shop_id uuid, p_input jsonb, p_link_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_basis text := coalesce(p_input->>'basis', '');
  v_category text := coalesce(p_input->>'category', '');
  v_body text := left(btrim(coalesce(p_input->>'body', '')), 5000);
  v_name text := left(nullif(btrim(coalesce(p_input->>'name', '')), ''), 100);
  v_ip text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
  v_from text; v_email text; v_cid uuid; v_order uuid; v_claimed integer; v_verified boolean := false; v_origin text;
  v_c customers%rowtype; v_o orders%rowtype; v_id uuid; v_number integer; v_kind text; v_send boolean; v_notify jsonb := null;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_create: service_role only' using errcode = '42501';
  end if;
  if not banto_inquiries_on(p_shop_id) then raise exception 'inquiries_disabled'; end if;
  v_from := banto_inquiry_mail_from(p_shop_id);
  if v_from is null then raise exception 'mail_not_configured'; end if;
  if v_category not in ('product', 'order', 'account', 'other') then raise exception 'invalid_category'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  if coalesce(p_input->>'order_number', '') ~ '^[0-9]{1,9}$' then v_claimed := nullif((p_input->>'order_number')::integer, 0); end if;

  -- 同じ IP から 1 時間・ショップ全体で 1 時間の上限
  if v_ip is not null and (select count(*) from inquiries where shop_id = p_shop_id and ip_hash = v_ip and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'per_ip_per_hour', 10) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;
  if (select count(*) from inquiries where shop_id = p_shop_id and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'per_hour', 100) then
    raise exception 'too_many_requests' using detail = 'shop';
  end if;

  if v_basis = 'member' then
    if coalesce(p_input->>'epoch', '') !~ '^-?[0-9]{1,9}$' then raise exception 'invalid_member'; end if;
    select * into v_c from customers where shop_id = p_shop_id and id = nullif(p_input->>'customer_id', '')::uuid
       and session_epoch = (p_input->>'epoch')::integer;
    if not found or v_c.email is null then raise exception 'invalid_member'; end if;
    v_email := lower(v_c.email); v_cid := v_c.id; v_verified := true; v_origin := 'member';
    if v_claimed is not null then
      select id into v_order from orders where shop_id = p_shop_id and number = v_claimed and customer_id = v_cid;
    end if;
  elsif v_basis in ('order', 'checkout') then
    if v_basis = 'order' then
      select * into v_o from orders where shop_id = p_shop_id and id = nullif(p_input->>'order_id', '')::uuid;
    else
      select o.* into v_o from reservations r join orders o on o.reservation_id = r.id
       where r.shop_id = p_shop_id and r.quote_id = coalesce(p_input->>'quote_id', '') order by r.created_at desc limit 1;
    end if;
    if not found then raise exception 'order_not_found'; end if;
    if v_o.customer_email is null then raise exception 'order_unavailable'; end if;
    v_email := lower(v_o.customer_email); v_cid := v_o.customer_id; v_order := v_o.id; v_verified := true; v_origin := v_basis;
    v_claimed := null;
  elsif v_basis = 'form' then
    v_email := lower(btrim(coalesce(p_input->>'email', '')));
    if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
    v_origin := 'form';
    -- 注文番号とメールアドレスが合えば注文に結ぶ（注文照会と同じ判定）。会員には、アドレスが確かめられるまで結ばない
    if v_claimed is not null then
      select id into v_order from orders where shop_id = p_shop_id and number = v_claimed and customer_email is not null and lower(customer_email) = v_email;
    end if;
  else
    raise exception 'invalid_basis';
  end if;
  if v_order is not null then v_claimed := null; end if;

  perform pg_advisory_xact_lock(hashtextextended('inquiry|' || p_shop_id::text || '|' || v_email, 0));
  -- 未確認（アドレスの持ち主が開いていない）のチケットは別の短い枠。超えたら行を作らず・メールも送らず、同じ形で返す
  -- （他人のアドレスで本人の枠を埋められない。アドレスが登録済みかも探られない）
  if not v_verified
     and (select count(*) from inquiries where shop_id = p_shop_id and lower(contact_email) = v_email
           and email_verified_at is null and created_at > now() - interval '24 hours')
         >= banto_shop_limit(p_shop_id, 'inquiries', 'max_unverified_per_email_per_day', 3) then
    return jsonb_build_object('id', gen_random_uuid(), 'number', null, 'verified', false, 'to', v_email, 'mail_from', v_from,
                              'send', false, 'kind', 'verify', 'notify', null);
  end if;
  -- 同じアドレスの開いているチケットの上限（確認済みだけを数える）
  if (select count(*) from inquiries where shop_id = p_shop_id and lower(contact_email) = v_email and status <> 'closed' and email_verified_at is not null)
       >= banto_shop_limit(p_shop_id, 'inquiries', 'max_open_per_email', 5) then
    raise exception 'too_many_requests' using detail = 'email';
  end if;

  update shops set inquiry_seq = inquiry_seq + 1 where id = p_shop_id returning inquiry_seq into v_number;
  insert into inquiries (shop_id, number, category, origin, contact_email, contact_name, email_verified_at, customer_id, order_id, claimed_order_number, ip_hash, return_to)
  values (p_shop_id, v_number, v_category, v_origin, v_email, coalesce(v_name, v_c.name), case when v_verified then now() end, v_cid, v_order, v_claimed, v_ip,
          left(nullif(btrim(coalesce(p_input->>'return_to', '')), ''), 500))
  returning id into v_id;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (p_shop_id, v_id, 'customer', v_body);
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (p_shop_id, v_id, p_link_hash, now() + interval '30 days');

  v_kind := case when v_verified then 'created' else 'verify' end;
  v_send := banto_inquiry_issue_mail(p_shop_id, v_id, v_kind, v_email);
  if v_verified then v_notify := banto_inquiry_verified(v_id); end if;
  return jsonb_build_object('id', v_id, 'number', v_number, 'verified', v_verified, 'to', v_email, 'mail_from', v_from, 'send', v_send, 'kind', v_kind, 'notify', v_notify);
end;
$$;
revoke execute on function inquiry_create(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function inquiry_create(uuid, jsonb, text, text) to service_role;

-- 未確認のまま 7 日（30 日から短く）
create or replace function mask_inquiries(p_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer; v_d integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_inquiries: service_role only' using errcode = '42501';
  end if;
  update inquiry_messages m set body = '[masked]'
    from inquiries i
   where m.inquiry_id = i.id and i.status = 'closed' and i.masked_at is null and i.closed_at < now() - make_interval(days => greatest(p_days, 1));
  delete from inquiry_attachments a using inquiries i
   where a.inquiry_id = i.id and i.status = 'closed' and i.masked_at is null and i.closed_at < now() - make_interval(days => greatest(p_days, 1));
  update inquiries set contact_email = null, contact_name = '[masked]', ip_hash = null, masked_at = now(), updated_at = now()
   where status = 'closed' and masked_at is null and closed_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v_n = row_count;
  delete from inquiries where email_verified_at is null and created_at < now() - interval '7 days';
  get diagnostics v_d = row_count;
  delete from inquiry_links where expires_at < now();
  delete from inquiry_checks where created_at < now() - interval '1 day';
  delete from inquiry_mails where created_at < now() - interval '2 days';
  return v_n + v_d;
end;
$$;
revoke execute on function mask_inquiries(integer) from public, anon, authenticated;
grant execute on function mask_inquiries(integer) to service_role;

-- ---------- 3. hooks の送信先の URL ----------
-- 行き先が私設のアドレス・ループバック・リンクローカル・社内の名前なら受けない（Worker の externalHookUrl と同じ判定を DB にも。直接の INSERT / UPDATE と復元を止める）。
-- 同梱の内部 URL（https://banto.invalid/plugins/<id>）は、新しい行（管理画面のプラグインの有効化・復元）か同梱だった行の更新か service_role だけ
create or replace function banto_hook_url_private(p_url text)
returns boolean
language plpgsql
immutable
as $$
declare v_host text; v_ip inet; v_mapped text;
begin
  v_host := lower(substring(p_url from '^https?://(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#\[]+)'));
  if v_host is null or v_host = '' then return true; end if;
  if v_host = 'localhost' or v_host ~ '\.(localhost|internal|local|home\.arpa|lan)\.?$' then return true; end if;
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
  -- 末尾のドットは URL パーサーが捨てる（10.0.0.5. は 10.0.0.5）
  v_host := regexp_replace(v_host, '\.$', '');
  -- 数だけの名前（2130706433・127.1・0x7f.1）は URL パーサーが IPv4 に直す。4 つ組のドット区切りの形だけを inet で判定し、ほかの形は受けない
  if v_host ~ '^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$' then
    if v_host !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' then return true; end if;
    begin
      v_ip := v_host::inet;
    exception when others then
      return true;
    end;
    return v_ip <<= '10.0.0.0/8'::inet or v_ip <<= '172.16.0.0/12'::inet or v_ip <<= '192.168.0.0/16'::inet
        or v_ip <<= '127.0.0.0/8'::inet or v_ip <<= '169.254.0.0/16'::inet or v_ip <<= '0.0.0.0/8'::inet;
  end if;
  return false;
end;
$$;
revoke execute on function banto_hook_url_private(text) from public, anon, authenticated;

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
  return new;
end;
$$;
revoke execute on function banto_hook_endpoints_guard() from public, anon, authenticated;
drop trigger if exists hook_endpoints_guard on hook_endpoints;
create trigger hook_endpoints_guard before insert or update of url on hook_endpoints for each row execute function banto_hook_endpoints_guard();

-- ---------- 4. shops の列 ----------
-- 0061 の inquiry_seq と 0065 の option_axes も、settings の項目では変えられない（0062 の最終形に 2 列を足す）
create or replace function banto_shops_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
revoke execute on function banto_shops_guard() from public, anon, authenticated;

-- 採番・判定だけが書く列は、運営者の JWT からは UPDATE できない（関数が security definer で書く。トリガーの守りに列の権限を重ねる）
revoke update on shops from authenticated;
grant update (owner_id, slug, name, published, legal_notice, privacy_policy, return_policy, stripe_account_id, settings, updated_at, domain, org_id, option_axes)
  on shops to authenticated;

-- ---------- 5. custom.v1 の文字列 ----------
-- ブラウザは URL の中の ASCII のタブ・改行を捨てるので、捨ててから当てる（'jav\tascript:' を通さない）
create or replace function banto_app_data_custom_check(v jsonb, p_depth integer, p_name text)
returns void
language plpgsql
immutable
as $$
declare k text; e jsonb; s text;
begin
  if p_depth > 5 then raise exception 'invalid_app_data_too_deep'; end if;
  case jsonb_typeof(v)
    when 'object' then
      if (select count(*) from jsonb_object_keys(v)) > 50 then raise exception 'invalid_app_data_too_many_keys'; end if;
      for k, e in select * from jsonb_each(v) loop
        if k !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'invalid_app_data_key_name'; end if;
        perform banto_app_data_custom_check(e, p_depth + 1, k);
      end loop;
    when 'array' then
      if jsonb_array_length(v) > 100 then raise exception 'invalid_app_data_too_many_items'; end if;
      for e in select x from jsonb_array_elements(v) x loop
        perform banto_app_data_custom_check(e, p_depth + 1, p_name);
      end loop;
    when 'string' then
      s := v #>> '{}';
      if char_length(s) > 5000 then raise exception 'invalid_app_data_string_too_long'; end if;
      if regexp_replace(s, '[\t\n\r]', '', 'g') ~* '^[[:space:][:cntrl:]]*(javascript|vbscript|data|file):' then raise exception 'invalid_app_data_url'; end if;
      if (p_name = 'url' or p_name like '%\_url') and s !~ '^https://[^[:space:]<>"''`]+$' then raise exception 'invalid_app_data_url'; end if;
    else
      null; -- number / boolean / null
  end case;
end;
$$;
revoke execute on function banto_app_data_custom_check(jsonb, integer, text) from public, anon, authenticated;

-- ---------- 6. ゲストの注文照会は会員の注文を返さない ----------
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select banto_order_view(o)
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_id is null
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;
revoke execute on function lookup_order(uuid, integer, text) from public, anon, authenticated;
grant execute on function lookup_order(uuid, integer, text) to service_role;

-- ---------- 7. 注文照会の外れをメールアドレスごと・ショップ全体でも数える ----------
alter table order_lookup_failures add column if not exists email_hash text check (email_hash ~ '^[0-9a-f]{64}$');
create index if not exists order_lookup_failures_email on order_lookup_failures (shop_id, email_hash, created_at) where email_hash is not null;

drop function if exists order_lookup(uuid, integer, text, text);
create or replace function order_lookup(p_shop_id uuid, p_number integer, p_email text, p_ip_hash text, p_email_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
  v_email text := case when p_email_hash ~ '^[0-9a-f]{64}$' then p_email_hash end;
  v_r jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_lookup: service_role only' using errcode = '42501';
  end if;
  if v_ip is not null and (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.ip_hash = v_ip and f.created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'order_lookup', 'per_ip_per_hour', 20) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;
  -- IP が取れない構成（中継のヘッダー無し）でも、同じアドレスでの番号の総当たりとショップ全体の外れに上限が効く
  if v_email is not null and (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.email_hash = v_email and f.created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'order_lookup', 'per_email_per_hour', 20) then
    raise exception 'too_many_requests' using detail = 'email';
  end if;
  if (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'order_lookup', 'per_hour', 200) then
    raise exception 'too_many_requests' using detail = 'shop';
  end if;
  if (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.number = p_number and f.created_at > now() - interval '1 hour') >= 50 then
    raise exception 'too_many_requests' using detail = 'order';
  end if;
  v_r := lookup_order(p_shop_id, p_number, p_email);
  if v_r is null then
    delete from order_lookup_failures where created_at < now() - interval '1 day';
    insert into order_lookup_failures (shop_id, number, ip_hash, email_hash) values (p_shop_id, p_number, v_ip, v_email);
  end if;
  return v_r;
end;
$$;
revoke execute on function order_lookup(uuid, integer, text, text, text) from public, anon, authenticated;
grant execute on function order_lookup(uuid, integer, text, text, text) to service_role;

-- ---------- 8. 無効にした連携 ----------
create or replace function app_connect_begin(p_shop_id uuid, p_endpoint_id uuid, p_scopes text[], p_ticket_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare v_ep hook_endpoints; v_exp timestamptz := now() + interval '2 minutes';
begin
  if auth.uid() is null or not banto_shop_perm(p_shop_id, 'integrations') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_ep from hook_endpoints where id = p_endpoint_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  if v_ep.url like 'https://banto.invalid/%' then raise exception 'not_found'; end if;
  if not v_ep.enabled then raise exception 'not_found'; end if;
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_ticket'; end if;
  -- スコープは語彙のもので、許す人が持つ項目まで（AI 用トークンの決まりと同じ）
  if exists (select 1 from unnest(coalesce(p_scopes, '{}'::text[])) s where banto_scope_perm(s) is null) then raise exception 'invalid_scopes'; end if;
  if not banto_token_scopes_ok(auth.uid(), p_shop_id, coalesce(p_scopes, '{}'::text[])) then
    raise exception 'scope_not_permitted' using errcode = '42501';
  end if;
  if 'app_data:write' = any(coalesce(p_scopes, '{}'::text[])) and v_ep.app_handle is null then raise exception 'app_handle_required'; end if;
  insert into app_connections (endpoint_id, shop_id, scopes, created_by, ticket_hash, ticket_expires_at)
  values (p_endpoint_id, p_shop_id, coalesce(p_scopes, '{}'::text[]), auth.uid(), p_ticket_hash, v_exp)
  on conflict (endpoint_id) do update
    set scopes = excluded.scopes, created_by = excluded.created_by, ticket_hash = excluded.ticket_hash,
        ticket_expires_at = excluded.ticket_expires_at, updated_at = now();
  return v_exp;
end;
$$;
revoke execute on function app_connect_begin(uuid, uuid, text[], text) from public, anon;
grant execute on function app_connect_begin(uuid, uuid, text[], text) to authenticated;

create or replace function api_app_require(p_token_hash text)
returns hook_endpoints
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_ep hook_endpoints;
begin
  v_tok := api_require(p_token_hash, 'app_data:write');
  select * into v_ep from hook_endpoints where id = v_tok.endpoint_id and shop_id = v_tok.shop_id;
  if not found or not v_ep.enabled then raise exception 'unauthorized' using errcode = '42501'; end if;
  if v_ep.app_handle is null then raise exception 'app_handle_required'; end if;
  return v_ep;
end;
$$;
revoke execute on function api_app_require(text) from public, anon, authenticated;
grant execute on function api_app_require(text) to service_role;

-- ---------- 9. アイキャッチは Banto の置き場の形だけ ----------
-- /media/pages/<ショップ id>/<名前> か、MEDIA_BASE_URL（任意のホスト・パスの前置き）+ /pages/<ショップ id>/<名前>（page_media.storage_key と同じ鍵の形）。
-- ホストはショップの設定に依らないので DB では形だけ。外の画像の URL（閲覧者の IP が外へ出る）は置けない
create or replace function banto_content_image_url_ok(p text)
returns boolean
language sql
immutable
as $$
  select p is null or (char_length(p) <= 2000
    and p ~ '^(/media/|https?://[^/\s<>"''`?#]+/([^\s<>"''`?#]*/)?)pages/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$');
$$;
revoke execute on function banto_content_image_url_ok(text) from public, anon;
grant execute on function banto_content_image_url_ok(text) to authenticated, service_role;

update pages set image_url = null where image_url is not null and not banto_content_image_url_ok(image_url);
update articles set image_url = null where image_url is not null and not banto_content_image_url_ok(image_url);
alter table pages drop constraint if exists pages_image_url_check;
alter table pages add constraint pages_image_url_check check (banto_content_image_url_ok(image_url));
alter table articles drop constraint if exists articles_image_url_check;
alter table articles add constraint articles_image_url_check check (banto_content_image_url_ok(image_url));

-- api_page_save / api_article_save の検査（api_content_check）も同じに
create or replace function api_content_check(p jsonb, p_kind text)
returns void
language plpgsql
stable
as $$
declare v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_values'; end if;
  if p ? 'handle' then
    if jsonb_typeof(p->'handle') <> 'string' then raise exception 'invalid_handle'; end if;
    v := p->>'handle';
    if p_kind = 'page' and not banto_page_handle_ok(v) then raise exception 'invalid_handle'; end if;
    if p_kind = 'article' and (v !~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' or v = 'feed') then raise exception 'invalid_handle'; end if;
  end if;
  if p ? 'title' and (jsonb_typeof(p->'title') <> 'string' or char_length(btrim(p->>'title')) not between 1 and 200) then raise exception 'invalid_title'; end if;
  if p ? 'body' and (jsonb_typeof(p->'body') <> 'string' or char_length(p->>'body') > 50000) then raise exception 'invalid_content_body'; end if;
  if p ? 'seo_title' and not (jsonb_typeof(p->'seo_title') = 'null' or (jsonb_typeof(p->'seo_title') = 'string' and char_length(p->>'seo_title') <= 200)) then raise exception 'invalid_seo_title'; end if;
  if p ? 'seo_description' and not (jsonb_typeof(p->'seo_description') = 'null' or (jsonb_typeof(p->'seo_description') = 'string' and char_length(p->>'seo_description') <= 500)) then raise exception 'invalid_seo_description'; end if;
  if p ? 'template_suffix' and not (jsonb_typeof(p->'template_suffix') = 'null' or (jsonb_typeof(p->'template_suffix') = 'string' and p->>'template_suffix' ~ '^[a-z0-9_-]{1,40}$')) then raise exception 'invalid_template_suffix'; end if;
  if p ? 'image_url' and not (jsonb_typeof(p->'image_url') = 'null' or (jsonb_typeof(p->'image_url') = 'string' and banto_content_image_url_ok(p->>'image_url'))) then raise exception 'invalid_image_url'; end if;
  if p ? 'published' and jsonb_typeof(p->'published') <> 'boolean' then raise exception 'invalid_published'; end if;
  if p ? 'published_at' and jsonb_typeof(p->'published_at') <> 'null' then
    if jsonb_typeof(p->'published_at') <> 'string' then raise exception 'invalid_published_at'; end if;
    begin
      perform (p->>'published_at')::timestamptz;
    exception when others then
      raise exception 'invalid_published_at';
    end;
  end if;
  if p_kind = 'page' then
    if p ? 'nav' and (jsonb_typeof(p->'nav') <> 'string' or p->>'nav' not in ('none', 'header', 'footer')) then raise exception 'invalid_nav'; end if;
    if p ? 'sort_order' and (jsonb_typeof(p->'sort_order') <> 'number' or (p->>'sort_order')::numeric <> trunc((p->>'sort_order')::numeric) or abs((p->>'sort_order')::numeric) > 1000000) then raise exception 'invalid_sort_order'; end if;
  else
    if p ? 'excerpt' and not (jsonb_typeof(p->'excerpt') = 'null' or (jsonb_typeof(p->'excerpt') = 'string' and char_length(p->>'excerpt') <= 1000)) then raise exception 'invalid_excerpt'; end if;
    if p ? 'author' and not (jsonb_typeof(p->'author') = 'null' or (jsonb_typeof(p->'author') = 'string' and char_length(p->>'author') <= 100)) then raise exception 'invalid_author'; end if;
    if p ? 'tags' and (jsonb_typeof(p->'tags') <> 'array' or jsonb_array_length(p->'tags') > 20
                       or exists (select 1 from jsonb_array_elements(p->'tags') t where jsonb_typeof(t) <> 'string' or char_length(btrim(t #>> '{}')) > 50)) then
      raise exception 'invalid_tags';
    end if;
  end if;
end;
$$;
revoke execute on function api_content_check(jsonb, text) from public, anon, authenticated;

-- ---------- 10. 公開の RLS はモジュール ON のショップだけ（shop_public_get の pages_nav / blogs_nav と同じ判定） ----------
-- anon は shops.settings を読めない（0028）ので、判定は security definer の関数で（ON / OFF しか返さない）
create or replace function banto_shop_module_public(p_shop_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from shops s where s.id = p_shop_id and s.published and s.settings->'modules'->p_module = 'true'::jsonb);
$$;
revoke execute on function banto_shop_module_public(uuid, text) from public;
grant execute on function banto_shop_module_public(uuid, text) to anon, authenticated, service_role;

drop policy if exists pages_public on pages;
create policy pages_public on pages for select
  using (published and deleted_at is null and (published_at is null or published_at <= now()) and banto_shop_module_public(shop_id, 'pages'));
drop policy if exists blogs_public on blogs;
create policy blogs_public on blogs for select
  using (banto_shop_module_public(shop_id, 'blog'));
drop policy if exists articles_public on articles;
create policy articles_public on articles for select
  using (published and deleted_at is null and published_at <= now() and banto_shop_module_public(shop_id, 'blog'));

-- ---------- 11. 物理削除は運営者の JWT からできない ----------
-- ページ・記事はゴミ箱（deleted_at）へ移し、Cron の purge が 30 日で消す。ブログは blog_delete（記事ごと）
revoke delete on pages, blogs, articles from authenticated;

create or replace function blog_delete(p_shop_id uuid, p_blog_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shop_id is null or not banto_shop_perm(p_shop_id, 'content')
     or not exists (select 1 from blogs where id = p_blog_id and shop_id = p_shop_id) then
    raise exception 'blog_not_found' using errcode = '42501';
  end if;
  delete from articles where blog_id = p_blog_id and shop_id = p_shop_id;
  delete from blogs where id = p_blog_id and shop_id = p_shop_id;
end;
$$;
revoke execute on function blog_delete(uuid, uuid) from public, anon;
grant execute on function blog_delete(uuid, uuid) to authenticated, service_role;

-- ---------- 12. 監査ログ ----------
create or replace function inquiry_delete(p_inquiry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_number integer;
begin
  select shop_id, number into v_shop, v_number from inquiries where id = p_inquiry_id;
  if v_shop is null or not banto_shop_perm(v_shop, 'support') then raise exception 'inquiry_not_found' using errcode = '42501'; end if;
  delete from inquiries where id = p_inquiry_id;
  perform banto_audit(banto_shop_org(v_shop), v_shop, 'inquiry.deleted', 'inquiry', p_inquiry_id::text, jsonb_build_object('number', v_number));
end;
$$;
revoke execute on function inquiry_delete(uuid) from public, anon;
grant execute on function inquiry_delete(uuid) to authenticated;

create or replace function mask_customer(p_shop_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_tryon integer; v_inq integer;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where shop_id = p_shop_id and lower(customer_email) = lower(btrim(p_email));
  get diagnostics v_count = row_count;
  update tryon_requests
     set customer_email = null, customer_name = '[masked]', customer_phone = null, note = null
   where shop_id = p_shop_id and lower(customer_email) = lower(btrim(p_email));
  get diagnostics v_tryon = row_count;
  update inquiry_messages m set body = '[masked]'
    from inquiries i
   where m.inquiry_id = i.id and i.shop_id = p_shop_id and lower(i.contact_email) = lower(btrim(p_email));
  delete from inquiry_attachments a using inquiries i
   where a.inquiry_id = i.id and i.shop_id = p_shop_id and lower(i.contact_email) = lower(btrim(p_email));
  update inquiries
     set contact_email = null, contact_name = '[masked]', ip_hash = null, masked_at = now(), updated_at = now(),
         status = 'closed', closed_at = coalesce(closed_at, now())
   where shop_id = p_shop_id and lower(contact_email) = lower(btrim(p_email));
  get diagnostics v_inq = row_count;
  -- 誰が・いつ・何件を。アドレスはハッシュの先頭だけ（0051 と同じ）
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'customer.masked', 'customer', banto_audit_email_hash(p_email),
                      jsonb_build_object('email_hash', banto_audit_email_hash(p_email), 'orders', v_count, 'tryon_requests', v_tryon, 'inquiries', v_inq));
  return v_count + v_tryon + v_inq;
end;
$$;
revoke execute on function mask_customer(uuid, text) from public, anon;
grant execute on function mask_customer(uuid, text) to authenticated;

-- テーマの版の settings / complete の変更（公開中の版の見た目が変わる）
create or replace function banto_audit_theme_versions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'shop.theme_version_updated', 'theme_version', new.id::text,
                      jsonb_build_object('name', new.name, 'settings_changed', old.settings is distinct from new.settings,
                                         'complete', new.complete, 'complete_changed', old.complete is distinct from new.complete,
                                         'live', exists (select 1 from shops s where s.id = new.shop_id and s.theme_version_id = new.id)));
  return new;
end;
$$;
revoke execute on function banto_audit_theme_versions() from public, anon, authenticated;
drop trigger if exists theme_versions_audit on theme_versions;
create trigger theme_versions_audit after update of settings, complete on theme_versions
  for each row when (old.settings is distinct from new.settings or old.complete is distinct from new.complete)
  execute function banto_audit_theme_versions();

-- AI 用トークンの削除（連携を消したときの連鎖削除を含む。api_token.revoked は revoked_at だけを見る）
create or replace function banto_audit_api_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'api_token.issued', 'api_token', new.id::text,
                        jsonb_build_object('name', new.name, 'prefix', new.prefix, 'scopes', to_jsonb(new.scopes), 'expires_at', new.expires_at));
    return new;
  end if;
  if tg_op = 'DELETE' then
    perform banto_audit(banto_shop_org(old.shop_id), old.shop_id, 'api_token.deleted', 'api_token', old.id::text,
                        jsonb_build_object('name', old.name, 'prefix', old.prefix, 'endpoint_id', old.endpoint_id, 'revoked', old.revoked_at is not null));
    return old;
  end if;
  perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'api_token.revoked', 'api_token', new.id::text,
                      jsonb_build_object('name', new.name, 'prefix', new.prefix));
  return new;
end;
$$;
revoke execute on function banto_audit_api_tokens() from public, anon, authenticated;
drop trigger if exists api_tokens_audit_delete on api_tokens;
create trigger api_tokens_audit_delete after delete on api_tokens for each row execute function banto_audit_api_tokens();

-- ---------- 13. 担当者にメールアドレスを出さない ----------
-- 運営側の人のアドレスも個人情報。一覧と 1 件には user_id と表示用の label（メールの @ より前）だけ
create or replace function banto_inquiry_assignees(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'label', split_part(coalesce(u.email, ''), '@', 1)) order by lower(split_part(coalesce(u.email, ''), '@', 1)), u.id), '[]'::jsonb)
    from auth.users u
   where u.id in (
           select s.owner_id from shops s where s.id = p_shop_id and s.org_id is null
           union
           select m.user_id from shops s join org_members m on m.org_id = s.org_id where s.id = p_shop_id and m.role in ('owner', 'admin')
           union
           select ms.user_id from shops s join org_member_shops ms on ms.org_id = s.org_id and ms.shop_id = s.id where s.id = p_shop_id and 'support' = any(ms.perms))
     and banto_user_shop_perm(u.id, p_shop_id, 'support');
$$;
revoke execute on function banto_inquiry_assignees(uuid) from public, anon, authenticated;

create or replace function api_inquiry_json(p_i inquiries, p_pii boolean, p_messages boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'number', p_i.number, 'status', p_i.status, 'category', p_i.category, 'origin', p_i.origin, 'verified', p_i.email_verified_at is not null,
    'customer_id', p_i.customer_id, 'claimed_order_number', p_i.claimed_order_number, 'masked', p_i.masked_at is not null,
    'order', (select jsonb_build_object('number', o.number, 'status', o.status, 'total_jpy', o.total_jpy, 'created_at', o.created_at) from orders o where o.id = p_i.order_id),
    'assignee', (select jsonb_build_object('user_id', u.id, 'label', split_part(coalesce(u.email, ''), '@', 1)) from auth.users u where u.id = p_i.assignee_id),
    'created_at', p_i.created_at, 'last_message_at', p_i.last_message_at, 'closed_at', p_i.closed_at)
  || case when p_messages then jsonb_build_object('messages', coalesce((
          select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at,
                                              'attachments', banto_inquiry_message_attachments(m.id, p_pii)) order by m.created_at, m.id)
            from inquiry_messages m where m.inquiry_id = p_i.id), '[]'::jsonb)) else '{}'::jsonb end
  || case when p_pii then jsonb_build_object('contact', jsonb_build_object('email', p_i.contact_email, 'name', p_i.contact_name)) else '{}'::jsonb end;
$$;
revoke execute on function api_inquiry_json(inquiries, boolean, boolean) from public, anon, authenticated;

-- ---------- 14. 検索語の % と _ ----------
create or replace function api_pages_list(p_token_hash text, p_status text, p_query text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'pages');
  if coalesce(p_status, 'all') not in ('all', 'published', 'scheduled', 'draft', 'trash') then raise exception 'invalid_status'; end if;
  return (
    with m as (
      select * from pages p
       where p.shop_id = v_tok.shop_id
         and banto_content_status_ok(p_status, p.published, p.published_at, p.deleted_at)
         and (nullif(btrim(p_query), '') is null
              or p.title ilike '%' || banto_like_escape(btrim(p_query)) || '%'
              or p.handle ilike '%' || banto_like_escape(btrim(p_query)) || '%')
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(api_page_json(x, false) order by x.sort_order, x.created_at, x.id)
                           from (select * from m order by sort_order, created_at, id limit v_limit offset v_offset) x), '[]'::jsonb),
      'total', (select count(*) from m), 'limit', v_limit, 'offset', v_offset)
  );
end;
$$;
revoke execute on function api_pages_list(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_pages_list(text, text, text, integer, integer) to service_role;

create or replace function api_articles_list(p_token_hash text, p_blog text, p_status text, p_query text, p_tag text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_b blogs%rowtype; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
begin
  v_tok := api_content_require(p_token_hash, 'content:read', 'blog');
  v_b := api_blog_of(v_tok.shop_id, p_blog);
  if coalesce(p_status, 'all') not in ('all', 'published', 'scheduled', 'draft', 'trash') then raise exception 'invalid_status'; end if;
  return (
    with m as (
      select * from articles a
       where a.blog_id = v_b.id and a.shop_id = v_tok.shop_id
         and banto_content_status_ok(p_status, a.published, a.published_at, a.deleted_at)
         and (nullif(btrim(p_query), '') is null
              or a.title ilike '%' || banto_like_escape(btrim(p_query)) || '%'
              or a.handle ilike '%' || banto_like_escape(btrim(p_query)) || '%')
         and (nullif(btrim(p_tag), '') is null or btrim(p_tag) = any(a.tags))
    )
    select jsonb_build_object(
      'blog', api_blog_json(v_b),
      'items', coalesce((select jsonb_agg(api_article_json(x, v_b.handle, false) order by coalesce(x.published_at, x.created_at) desc, x.id desc)
                           from (select * from m order by coalesce(published_at, created_at) desc, id desc limit v_limit offset v_offset) x), '[]'::jsonb),
      'total', (select count(*) from m), 'limit', v_limit, 'offset', v_offset)
  );
end;
$$;
revoke execute on function api_articles_list(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_articles_list(text, text, text, text, text, integer, integer) to service_role;

insert into banto_migrations (version) values ('0089_security_hardening_3');
