-- Banto 0050_marketing_consent: 「お得な情報やセールの案内を受け取る」の同意（人間の決定 2026-10-23、docs/knowledge/13-external-customer-master.md 段階 1c）。前方専用。
--
-- 同意は本人が Banto の画面で行う行為なので、Banto が規定の列として持つ（attributes には置かない。基準 (1) 法務 → 記録はコア）。
--   customers.marketing_consent         true / false / null（未回答）
--   customers.marketing_consent_at      いつ
--   customers.marketing_consent_source  どこで: checkout / account / import / api / admin
--   orders.marketing_consent            注文のときの選択（ゲストの注文はここにだけ残る）
-- 向き（この列だけ特別）:
--   true  … 本人の行為だけ（レジ・会員ページ。取り込みは import）。外部の API・運営者からは付けられない
--   false … どこで起きても正しい（MA の配信停止 → API、会員ページ、運営者の「同意を外す」）
-- 出す / 出さないはショップの設定 settings.marketing_consent（既定 OFF）。ON のショップのレジと会員ページにチェックが出る。
-- 文言の適法性は、最終確認画面と同じく専門家の確認が未実施（docs/members.md）。

-- ---------- 列 ----------
alter table customers add column if not exists marketing_consent boolean;
alter table customers add column if not exists marketing_consent_at timestamptz;
alter table customers add column if not exists marketing_consent_source text check (marketing_consent_source in ('checkout', 'account', 'import', 'api', 'admin'));
alter table orders add column if not exists marketing_consent boolean;
grant select (marketing_consent, marketing_consent_at, marketing_consent_source) on customers to authenticated;

-- API の値（false だけ受ける。true は consent_requires_person）
create or replace function banto_api_consent_false(p_values jsonb)
returns boolean
language plpgsql
immutable
as $$
begin
  if p_values is null or not (p_values ? 'marketing_consent') then return false; end if;
  if jsonb_typeof(p_values->'marketing_consent') = 'boolean' and not (p_values->'marketing_consent')::boolean then return true; end if;
  if jsonb_typeof(p_values->'marketing_consent') = 'boolean' then raise exception 'consent_requires_person'; end if;
  raise exception 'invalid_marketing_consent';
end;
$$;
revoke execute on function banto_api_consent_false(jsonb) from public, anon, authenticated;

-- ---------- 注文 → 会員（レジで選んだ同意を写す） ----------
-- 予約の購入者情報（attach_reservation_customer の JSON）に marketing_consent があれば、confirm_reservation が作る注文の行に写し（before insert）、
-- 会員の注文なら customers にも写す（after insert、source = checkout）。confirm_reservation 自体は触らない
create or replace function banto_orders_consent_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_consent text;
begin
  if new.marketing_consent is null and new.reservation_id is not null then
    select r.customer->>'marketing_consent' into v_consent from reservations r where r.id = new.reservation_id;
    if v_consent in ('true', 'false') then new.marketing_consent := v_consent::boolean; end if;
  end if;
  return new;
end;
$$;
create or replace function banto_orders_consent_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_id is not null and new.marketing_consent is not null then
    update customers
       set marketing_consent = new.marketing_consent, marketing_consent_at = now(), marketing_consent_source = 'checkout'
     where shop_id = new.shop_id and id = new.customer_id and marketing_consent is distinct from new.marketing_consent;
  end if;
  return null;
end;
$$;
revoke execute on function banto_orders_consent_before() from public, anon, authenticated;
revoke execute on function banto_orders_consent_after() from public, anon, authenticated;
drop trigger if exists orders_consent_before on orders;
drop trigger if exists orders_consent_after on orders;
create trigger orders_consent_before before insert on orders for each row execute function banto_orders_consent_before();
create trigger orders_consent_after after insert on orders for each row execute function banto_orders_consent_after();

-- ---------- 会員ページ（本人の行為。service_role、世代を確かめる） ----------
create or replace function member_set_marketing_consent(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_consent boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_set_marketing_consent: service_role only' using errcode = '42501';
  end if;
  if p_consent is null then raise exception 'invalid_marketing_consent'; end if;
  update customers
     set marketing_consent = p_consent, marketing_consent_at = now(), marketing_consent_source = 'account'
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;
revoke execute on function member_set_marketing_consent(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function member_set_marketing_consent(uuid, uuid, integer, boolean) to service_role;

-- ---------- 運営者: 同意を外す（付けることはできない） ----------
create or replace function customer_marketing_consent_withdraw(p_shop_id uuid, p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  update customers
     set marketing_consent = false, marketing_consent_at = now(), marketing_consent_source = 'admin'
   where shop_id = p_shop_id and id = p_customer_id and marketing_consent is distinct from false;
  return found;
end;
$$;
revoke execute on function customer_marketing_consent_withdraw(uuid, uuid) from public, anon;
grant execute on function customer_marketing_consent_withdraw(uuid, uuid) to authenticated, service_role;

-- ---------- 会員ページの読み取り（0014 を差し替え: marketing_consent を返す） ----------
create or replace function member_get(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_with_orders boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_get: service_role only' using errcode = '42501';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return null; end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'shop_id', v_c.shop_id, 'email', v_c.email, 'name', v_c.name, 'default_address', v_c.default_address,
                                   'marketing_consent', v_c.marketing_consent,
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null,
                                   'providers', coalesce((select jsonb_agg(provider order by provider) from member_identities
                                                           where shop_id = p_shop_id and customer_id = v_c.id), '[]'::jsonb)),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

-- ---------- お客様の画面に渡す settings（0041 を差し替え: marketing_consent の設定） ----------
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt', 'product_fields',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent')), '{}'::jsonb)
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb)))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

-- ---------- hooks（0047 を差し替え: ペイロードに marketing_consent、同意の変化でも customer.updated） ----------
create or replace function banto_customers_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_id uuid; v_event text; v_ref jsonb; v_consent boolean;
begin
  if tg_op = 'DELETE' then
    v_shop := old.shop_id; v_id := old.id; v_ref := old.external_ref; v_consent := old.marketing_consent; v_event := 'customer.deleted';
  elsif tg_op = 'INSERT' then
    v_shop := new.shop_id; v_id := new.id; v_ref := new.external_ref; v_consent := new.marketing_consent; v_event := 'customer.created';
  else
    if new.email is not distinct from old.email and new.name is not distinct from old.name
       and new.default_address is not distinct from old.default_address
       and new.attributes is not distinct from old.attributes
       and new.external_ref is not distinct from old.external_ref
       and new.marketing_consent is not distinct from old.marketing_consent then
      return null;
    end if;
    v_shop := new.shop_id; v_id := new.id; v_ref := new.external_ref; v_consent := new.marketing_consent; v_event := 'customer.updated';
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, v_event, jsonb_build_object('customer_id', v_id, 'shop_id', v_shop, 'external_ref', v_ref, 'marketing_consent', v_consent)
    from hook_endpoints e
   where e.shop_id = v_shop and e.enabled and v_event = any(e.events);
  return null;
end;
$$;
revoke execute on function banto_customers_hook() from public, anon, authenticated;

-- ---------- AI 用 API（0047 を差し替え） ----------
create or replace function api_customer_json(p_c customers)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'email', p_c.email, 'name', p_c.name, 'default_address', p_c.default_address,
    'external_ref', p_c.external_ref, 'attributes', coalesce(p_c.attributes, '{}'::jsonb),
    'marketing_consent', p_c.marketing_consent, 'marketing_consent_at', p_c.marketing_consent_at, 'marketing_consent_source', p_c.marketing_consent_source,
    'created_at', p_c.created_at, 'updated_at', p_c.updated_at, 'last_login_at', p_c.last_login_at,
    'orders', (select jsonb_build_object('count', count(*), 'total_jpy', coalesce(sum(o.total_jpy), 0), 'last_order_at', max(o.created_at))
                 from orders o where o.shop_id = p_c.shop_id and o.customer_id = p_c.id and o.status in ('paid', 'shipped'))
  );
$$;
revoke execute on function api_customer_json(customers) from public, anon, authenticated;

-- 一覧・検索（0047 を差し替え: marketing_consent で絞る。MA が同意した会員だけを引くため）
drop function if exists api_customers_list(text, text, text, integer, integer, text, text, timestamptz);
create or replace function api_customers_list(p_token_hash text, p_query text default null, p_email text default null,
                                              p_limit integer default 50, p_offset integer default 0,
                                              p_external_provider text default null, p_external_id text default null,
                                              p_updated_since timestamptz default null, p_marketing_consent boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_q text; v_email text; v_prov text; v_ext text;
begin
  v_tok := api_require(p_token_hash, 'customers:read');
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_q := case when nullif(btrim(p_query), '') is not null then '%' || banto_like_escape(btrim(p_query)) || '%' end;
  v_email := nullif(lower(btrim(p_email)), '');
  v_prov := nullif(btrim(p_external_provider), '');
  v_ext := nullif(btrim(p_external_id), '');
  if v_ext is not null and v_prov is null then raise exception 'invalid_external_ref'; end if;
  select count(*) into v_total from customers c
   where c.shop_id = v_tok.shop_id
     and (v_email is null or lower(c.email) = v_email)
     and (v_q is null or c.email ilike v_q or c.name ilike v_q)
     and (v_prov is null or c.external_ref->>'provider' = v_prov)
     and (v_ext is null or c.external_ref->>'id' = v_ext)
     and (p_updated_since is null or c.updated_at >= p_updated_since)
     and (p_marketing_consent is null or c.marketing_consent = p_marketing_consent);
  select coalesce(jsonb_agg(api_customer_json(c)), '[]'::jsonb) into v_items
    from (select * from customers c
           where c.shop_id = v_tok.shop_id
             and (v_email is null or lower(c.email) = v_email)
             and (v_q is null or c.email ilike v_q or c.name ilike v_q)
             and (v_prov is null or c.external_ref->>'provider' = v_prov)
             and (v_ext is null or c.external_ref->>'id' = v_ext)
             and (p_updated_since is null or c.updated_at >= p_updated_since)
             and (p_marketing_consent is null or c.marketing_consent = p_marketing_consent)
           order by case when p_updated_since is null then null else c.updated_at end asc,
                    case when p_updated_since is null then c.created_at end desc, c.id
           limit v_limit offset v_offset) c;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;


-- 作る（0047 を差し替え: marketing_consent は false だけ受ける。同意は本人の行為なので API では付けられない）
create or replace function api_customer_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_email text; v_name text; v_c customers%rowtype; v_key text;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key not in ('email', 'name', 'default_address', 'attributes', 'external_ref', 'marketing_consent') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  v_email := lower(btrim(coalesce(p_values->>'email', '')));
  if jsonb_typeof(p_values->'email') <> 'string' or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if p_values ? 'name' and jsonb_typeof(p_values->'name') not in ('string', 'null') then raise exception 'invalid_name'; end if;
  v_name := nullif(btrim(coalesce(p_values->>'name', '')), '');
  if length(v_name) > 200 then raise exception 'invalid_name'; end if;
  if exists (select 1 from customers where shop_id = v_tok.shop_id and lower(email) = v_email) then raise exception 'email_taken'; end if;
  begin
    insert into customers (shop_id, email, name, default_address, attributes, external_ref, marketing_consent, marketing_consent_at, marketing_consent_source)
    values (v_tok.shop_id, v_email, v_name, banto_api_address(p_values->'default_address'),
            banto_customer_attributes(v_tok.shop_id, p_values->'attributes'), banto_customer_external_ref(p_values->'external_ref'),
            case when banto_api_consent_false(p_values) then false end, case when banto_api_consent_false(p_values) then now() end, case when banto_api_consent_false(p_values) then 'api' end)
    returning * into v_c;
  exception when unique_violation then
    raise exception 'external_ref_taken';
  end;
  return api_customer_json(v_c);
end;
$$;


-- 氏名・住所・属性・外部の ID・同意の取り下げ（0047 を差し替え）。メールアドレスは変えない（email_change_not_allowed）。attributes は渡した鍵だけ重ねる（null で消す）
create or replace function api_customer_update(p_token_hash text, p_customer_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c customers%rowtype; v_key text; v_name text;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key = 'email' then raise exception 'email_change_not_allowed'; end if;
    if v_key not in ('name', 'default_address', 'attributes', 'external_ref', 'marketing_consent') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  select * into v_c from customers where shop_id = v_tok.shop_id and id = p_customer_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_values ? 'name' then
    if jsonb_typeof(p_values->'name') not in ('string', 'null') then raise exception 'invalid_name'; end if;
    v_name := nullif(btrim(coalesce(p_values->>'name', '')), '');
    if length(v_name) > 200 then raise exception 'invalid_name'; end if;
    v_c.name := v_name;
  end if;
  if p_values ? 'default_address' then v_c.default_address := banto_api_address(p_values->'default_address'); end if;
  if p_values ? 'attributes' then v_c.attributes := banto_customer_attributes_merge(v_tok.shop_id, v_c.attributes, p_values->'attributes'); end if;
  if p_values ? 'external_ref' then v_c.external_ref := banto_customer_external_ref(p_values->'external_ref'); end if;
  if banto_api_consent_false(p_values) and v_c.marketing_consent is distinct from false then
    v_c.marketing_consent := false; v_c.marketing_consent_at := now(); v_c.marketing_consent_source := 'api';
  end if;
  begin
    update customers set name = v_c.name, default_address = v_c.default_address, attributes = v_c.attributes, external_ref = v_c.external_ref,
                         marketing_consent = v_c.marketing_consent, marketing_consent_at = v_c.marketing_consent_at, marketing_consent_source = v_c.marketing_consent_source
     where shop_id = v_tok.shop_id and id = p_customer_id
    returning * into v_c;
  exception when unique_violation then
    raise exception 'external_ref_taken';
  end;
  return api_customer_json(v_c);
end;
$$;


-- メールアドレスで引いて、あれば渡した鍵だけ更新、無ければ作る（外部のマスタからの同期の窓口）。
-- email は身元なので変えない: 外部で変わったアドレスで呼ぶと、別の会員として作られる。そのとき同じ external_ref が
-- 既にあれば external_ref_taken で止まる（連携側が気づいて、運営者が管理画面で変える）。戻り値に created を付ける
create or replace function api_customer_upsert(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_email text; v_c customers%rowtype; v_key text; v_out jsonb;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key not in ('email', 'name', 'default_address', 'attributes', 'external_ref', 'marketing_consent') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  v_email := lower(btrim(coalesce(p_values->>'email', '')));
  if jsonb_typeof(p_values->'email') <> 'string' or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  -- 同じアドレスの同時の呼び出しを直列にする（2 人作らない）
  perform pg_advisory_xact_lock(hashtext('customer_upsert:' || v_tok.shop_id::text || ':' || v_email));
  select * into v_c from customers where shop_id = v_tok.shop_id and lower(email) = v_email for update;
  if found then
    v_out := api_customer_update(p_token_hash, v_c.id, p_values - 'email');
    return v_out || jsonb_build_object('created', false);
  end if;
  v_out := api_customer_create(p_token_hash, p_values);
  return v_out || jsonb_build_object('created', true);
end;
$$;

revoke execute on function api_customers_list(text, text, text, integer, integer, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke execute on function api_customer_create(text, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_update(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function api_customers_list(text, text, text, integer, integer, text, text, timestamptz, boolean) to service_role;
grant execute on function api_customer_create(text, jsonb) to service_role;
grant execute on function api_customer_update(text, uuid, jsonb) to service_role;
grant execute on function api_customer_upsert(text, jsonb) to service_role;

-- ---------- 復元（0047 を差し替え: 同意も戻す） ----------
create or replace function restore_customer_master(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer := 0; v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb); v_ref jsonb; v_attrs jsonb; v_consent boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_customer_master: service_role only' using errcode = '42501';
  end if;
  if jsonb_typeof(v_customers) <> 'array' then raise exception 'invalid_export'; end if;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    if jsonb_typeof(v_row) <> 'object' or (v_row->>'id') is null then continue; end if;
    v_ref := case when banto_external_ref_ok(v_row->'external_ref') then v_row->'external_ref' end;
    v_attrs := case when jsonb_typeof(v_row->'attributes') = 'object' then v_row->'attributes' else '{}'::jsonb end;
    v_consent := case when jsonb_typeof(v_row->'marketing_consent') = 'boolean' then (v_row->>'marketing_consent')::boolean end;
    if v_ref is null and v_attrs = '{}'::jsonb and v_consent is null then continue; end if;
    begin
      update customers set external_ref = v_ref, attributes = v_attrs,
                           marketing_consent = v_consent,
                           marketing_consent_at = case when v_consent is null then null else coalesce((v_row->>'marketing_consent_at')::timestamptz, now()) end,
                           marketing_consent_source = case when v_consent is null then null when (v_row->>'marketing_consent_source') in ('checkout', 'account', 'import', 'api', 'admin') then v_row->>'marketing_consent_source' else 'import' end
       where shop_id = p_shop_id and id = (v_row->>'id')::uuid;
      if found then v_n := v_n + 1; end if;
    exception when unique_violation or invalid_text_representation then
      null;
    end;
  end loop;
  return jsonb_build_object('customer_master', v_n);
end;
$$;
revoke execute on function restore_customer_master(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_customer_master(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0050_marketing_consent');
