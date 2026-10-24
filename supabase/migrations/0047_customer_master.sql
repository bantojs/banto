-- Banto 0047_customer_master: 顧客マスタの外部連携の器（人間の決定 2026-10-23、docs/knowledge/13-external-customer-master.md）。前方専用。
--
-- 方針（項目ごとに向きを 1 つ。同じ項目を両側で直す双方向は持たない）:
--   身元（email・ログイン・セッション・世代）     … Banto が正。外へ知らせるだけ。外部から変えない（0036 と同じ）
--   氏名・住所                                     … Banto が正（本人が会員ページで直せる）。Banto → 外部
--   マーケティングの属性（ランク・同意・タグ等）   … 外部が正。外部 → Banto（customers.attributes）。Banto は読むだけ
-- 外部 → Banto は既存の AI 用トークンの API（customers:write）を通る。Banto の行が唯一の正で、入口が 2 つあるだけ。
--
-- このマイグレーションで足すもの:
--   customers.external_ref  … {"provider": "hubspot", "id": "…"}。ショップ × provider × id で一意
--   customers.attributes    … 独自項目の値。定義は shops.settings.customer_fields（products.attributes / product_fields と同じ宣言型）。
--                             定義に無い鍵は受け付けない（banto_customer_attributes）
--   hooks customer.created / customer.updated / customer.deleted … customers のトリガーで積む。ペイロードは id と external_ref だけ（個人情報なし）
--   api_customers_list      … external_ref と updated_since で絞る（同期の取り込み向け）
--   api_customer_create / update … attributes と external_ref を受ける
--   api_customer_upsert     … メールアドレスで引いて無ければ作る（email は変えない）
--   restore_customer_master … 復元の後で external_ref と attributes を戻す

-- ---------- 列 ----------
alter table customers add column if not exists external_ref jsonb;
alter table customers add column if not exists attributes jsonb not null default '{}'::jsonb;

-- external_ref の形: provider と id の 2 つの文字列だけ
create or replace function banto_external_ref_ok(p jsonb)
returns boolean language sql immutable as $$
  select p is null
      or (jsonb_typeof(p) = 'object'
          and jsonb_typeof(p->'provider') = 'string' and jsonb_typeof(p->'id') = 'string'
          and (p->>'provider') ~ '^[a-z][a-z0-9_]{0,31}$'
          and char_length(p->>'id') between 1 and 200
          and (p - 'provider' - 'id') = '{}'::jsonb)
$$;
revoke execute on function banto_external_ref_ok(jsonb) from public, anon, authenticated;

alter table customers add constraint customers_external_ref_shape check (banto_external_ref_ok(external_ref));
alter table customers add constraint customers_attributes_shape check (jsonb_typeof(attributes) = 'object');
create unique index customers_external_ref_uniq on customers (shop_id, (external_ref->>'provider'), (external_ref->>'id')) where external_ref is not null;

-- 運営者（管理画面）は読める（0028 の列ごとの権限に足す。パスワードの列は引き続き読めない）
grant select (external_ref, attributes) on customers to authenticated;

-- ---------- 独自項目の値の検査 ----------
-- 定義（shops.settings.customer_fields: [{key, label, type, options}]）にある鍵だけ。型は product_fields と同じ
-- text / textarea / number / url / select。null の値は「消す」（戻り値に含めない）。知らない鍵は invalid_attribute_<鍵>
create or replace function banto_customer_attributes(p_shop_id uuid, p_values jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_defs jsonb; v_def jsonb; v_k text; v_v jsonb; v_out jsonb := '{}'::jsonb; v_type text; v_s text; v_max integer;
begin
  if p_values is null or jsonb_typeof(p_values) = 'null' then return '{}'::jsonb; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_attributes'; end if;
  select settings->'customer_fields' into v_defs from shops where id = p_shop_id;
  if v_defs is null or jsonb_typeof(v_defs) <> 'array' then v_defs := '[]'::jsonb; end if;
  for v_k, v_v in select * from jsonb_each(p_values) loop
    select d into v_def from jsonb_array_elements(v_defs) d
     where jsonb_typeof(d) = 'object' and d->>'key' = v_k and (d->>'key') ~ '^[a-z][a-z0-9_]{0,39}$' limit 1;
    if v_def is null then raise exception 'invalid_attribute_%', left(v_k, 40); end if;
    if jsonb_typeof(v_v) = 'null' then continue; end if;
    v_type := coalesce(v_def->>'type', 'text');
    if v_type = 'number' then
      if jsonb_typeof(v_v) = 'number' then
        v_out := v_out || jsonb_build_object(v_k, v_v);
      elsif jsonb_typeof(v_v) = 'string' and btrim(v_v #>> '{}') ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then
        v_out := v_out || jsonb_build_object(v_k, (btrim(v_v #>> '{}'))::numeric);
      else
        raise exception 'invalid_attribute_%', left(v_k, 40);
      end if;
    else
      if jsonb_typeof(v_v) not in ('string', 'number') then raise exception 'invalid_attribute_%', left(v_k, 40); end if;
      v_s := btrim(v_v #>> '{}');
      if v_s = '' then continue; end if;
      v_max := 200; if v_type = 'textarea' then v_max := 500; end if;
      if char_length(v_s) > v_max then raise exception 'invalid_attribute_%', left(v_k, 40); end if;
      if v_type = 'url' and v_s !~ '^https?://' then raise exception 'invalid_attribute_%', left(v_k, 40); end if;
      if v_type = 'select' and not (jsonb_typeof(v_def->'options') = 'array' and v_def->'options' @> to_jsonb(v_s)) then
        raise exception 'invalid_attribute_%', left(v_k, 40);
      end if;
      v_out := v_out || jsonb_build_object(v_k, v_s);
    end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_customer_attributes(uuid, jsonb) from public, anon, authenticated;

-- 今の値に p_values を重ねる（null の鍵は消す）
create or replace function banto_customer_attributes_merge(p_shop_id uuid, p_current jsonb, p_values jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_clean jsonb; v_out jsonb;
begin
  v_clean := banto_customer_attributes(p_shop_id, p_values);
  v_out := coalesce(p_current, '{}'::jsonb);
  if p_values is not null and jsonb_typeof(p_values) = 'object' then
    v_out := v_out - array(select jsonb_object_keys(p_values));
  end if;
  return v_out || v_clean;
end;
$$;
revoke execute on function banto_customer_attributes_merge(uuid, jsonb, jsonb) from public, anon, authenticated;

-- external_ref の入力（API）。null で外す。形が違えば invalid_external_ref
create or replace function banto_customer_external_ref(p jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare v jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'provider') <> 'string' or jsonb_typeof(p->'id') <> 'string' then raise exception 'invalid_external_ref'; end if;
  v := jsonb_build_object('provider', btrim(p->>'provider'), 'id', btrim(p->>'id'));
  if not banto_external_ref_ok(v) or (p - 'provider' - 'id') <> '{}'::jsonb then raise exception 'invalid_external_ref'; end if;
  return v;
end;
$$;
revoke execute on function banto_customer_external_ref(jsonb) from public, anon, authenticated;

-- ---------- hooks: customer.created / customer.updated / customer.deleted ----------
-- enqueue_hook は呼び手の役割で積めるイベントを絞る（0028 の M11）ので、トリガーは hook_deliveries に直接積む。
-- 行が変わるのは RLS か service_role の RPC を通ったときだけなので、ここで権限を見直す必要は無い。
-- updated はプロフィール（email・name・default_address・attributes・external_ref）が変わったときだけ。
-- ログインの時刻・世代・パスワードの列では積まない。ペイロードに個人情報は載せない（要るプラグインは customers:read で引く）。
create or replace function banto_customers_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_id uuid; v_event text; v_ref jsonb;
begin
  if tg_op = 'DELETE' then
    v_shop := old.shop_id; v_id := old.id; v_ref := old.external_ref; v_event := 'customer.deleted';
  elsif tg_op = 'INSERT' then
    v_shop := new.shop_id; v_id := new.id; v_ref := new.external_ref; v_event := 'customer.created';
  else
    if new.email is not distinct from old.email and new.name is not distinct from old.name
       and new.default_address is not distinct from old.default_address
       and new.attributes is not distinct from old.attributes
       and new.external_ref is not distinct from old.external_ref then
      return null;
    end if;
    v_shop := new.shop_id; v_id := new.id; v_ref := new.external_ref; v_event := 'customer.updated';
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, v_event, jsonb_build_object('customer_id', v_id, 'shop_id', v_shop, 'external_ref', v_ref)
    from hook_endpoints e
   where e.shop_id = v_shop and e.enabled and v_event = any(e.events);
  return null;
end;
$$;
revoke execute on function banto_customers_hook() from public, anon, authenticated;
drop trigger if exists customers_hooks on customers;
create trigger customers_hooks after insert or update or delete on customers for each row execute function banto_customers_hook();

-- ---------- AI 用 API（0036 を差し替え） ----------
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
    'created_at', p_c.created_at, 'updated_at', p_c.updated_at, 'last_login_at', p_c.last_login_at,
    'orders', (select jsonb_build_object('count', count(*), 'total_jpy', coalesce(sum(o.total_jpy), 0), 'last_order_at', max(o.created_at))
                 from orders o where o.shop_id = p_c.shop_id and o.customer_id = p_c.id and o.status in ('paid', 'shipped'))
  );
$$;
revoke execute on function api_customer_json(customers) from public, anon, authenticated;

-- 一覧・検索。external_ref（provider と id の完全一致。id を省けば provider だけ）と updated_since（その時刻以後に変わった会員、updated_at の昇順）を足す
drop function if exists api_customers_list(text, text, text, integer, integer);
create or replace function api_customers_list(p_token_hash text, p_query text default null, p_email text default null,
                                              p_limit integer default 50, p_offset integer default 0,
                                              p_external_provider text default null, p_external_id text default null,
                                              p_updated_since timestamptz default null)
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
     and (p_updated_since is null or c.updated_at >= p_updated_since);
  select coalesce(jsonb_agg(api_customer_json(c)), '[]'::jsonb) into v_items
    from (select * from customers c
           where c.shop_id = v_tok.shop_id
             and (v_email is null or lower(c.email) = v_email)
             and (v_q is null or c.email ilike v_q or c.name ilike v_q)
             and (v_prov is null or c.external_ref->>'provider' = v_prov)
             and (v_ext is null or c.external_ref->>'id' = v_ext)
             and (p_updated_since is null or c.updated_at >= p_updated_since)
           order by case when p_updated_since is null then null else c.updated_at end asc,
                    case when p_updated_since is null then c.created_at end desc, c.id
           limit v_limit offset v_offset) c;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- 作る。attributes と external_ref も受ける
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
    if v_key not in ('email', 'name', 'default_address', 'attributes', 'external_ref') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  v_email := lower(btrim(coalesce(p_values->>'email', '')));
  if jsonb_typeof(p_values->'email') <> 'string' or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if p_values ? 'name' and jsonb_typeof(p_values->'name') not in ('string', 'null') then raise exception 'invalid_name'; end if;
  v_name := nullif(btrim(coalesce(p_values->>'name', '')), '');
  if length(v_name) > 200 then raise exception 'invalid_name'; end if;
  if exists (select 1 from customers where shop_id = v_tok.shop_id and lower(email) = v_email) then raise exception 'email_taken'; end if;
  begin
    insert into customers (shop_id, email, name, default_address, attributes, external_ref)
    values (v_tok.shop_id, v_email, v_name, banto_api_address(p_values->'default_address'),
            banto_customer_attributes(v_tok.shop_id, p_values->'attributes'), banto_customer_external_ref(p_values->'external_ref'))
    returning * into v_c;
  exception when unique_violation then
    raise exception 'external_ref_taken';
  end;
  return api_customer_json(v_c);
end;
$$;

-- 氏名・住所・属性・外部の ID を変える。メールアドレスは変えない（email_change_not_allowed）。attributes は渡した鍵だけ重ねる（null で消す）
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
    if v_key not in ('name', 'default_address', 'attributes', 'external_ref') then raise exception 'invalid_field_%', left(v_key, 40); end if;
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
  begin
    update customers set name = v_c.name, default_address = v_c.default_address, attributes = v_c.attributes, external_ref = v_c.external_ref
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
    if v_key not in ('email', 'name', 'default_address', 'attributes', 'external_ref') then raise exception 'invalid_field_%', left(v_key, 40); end if;
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

revoke execute on function api_customers_list(text, text, text, integer, integer, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function api_customer_create(text, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_update(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function api_customers_list(text, text, text, integer, integer, text, text, timestamptz) to service_role;
grant execute on function api_customer_create(text, jsonb) to service_role;
grant execute on function api_customer_update(text, uuid, jsonb) to service_role;
grant execute on function api_customer_upsert(text, jsonb) to service_role;

-- ---------- 復元 ----------
-- restore_shop_data（0012）の後に呼ぶ。会員は同じ id で戻っているので、id で突き合わせて external_ref と attributes を戻す。
-- 形の合わない external_ref・重なる external_ref は飛ばす（attributes は定義を通さずそのまま戻す。書き出したときの値のため）
create or replace function restore_customer_master(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer := 0; v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb); v_ref jsonb; v_attrs jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_customer_master: service_role only' using errcode = '42501';
  end if;
  if jsonb_typeof(v_customers) <> 'array' then raise exception 'invalid_export'; end if;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    if jsonb_typeof(v_row) <> 'object' or (v_row->>'id') is null then continue; end if;
    v_ref := case when banto_external_ref_ok(v_row->'external_ref') then v_row->'external_ref' end;
    v_attrs := case when jsonb_typeof(v_row->'attributes') = 'object' then v_row->'attributes' else '{}'::jsonb end;
    if v_ref is null and v_attrs = '{}'::jsonb then continue; end if;
    begin
      update customers set external_ref = v_ref, attributes = v_attrs
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

insert into banto_migrations (version) values ('0047_customer_master');
