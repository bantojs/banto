-- Banto 0052_plan_limits: プランの上限（人間の決定 2026-10-23、docs/knowledge/02-decisions.md）。前方専用。
--
-- デプロイ全体の設定（0038 banto_site_settings）に鍵 plan_limits を足す:
--   { "shops": 3, "products": 1000, "customers": 5000, "members": 5 }   … 鍵は任意、値は 1〜1,000,000 の整数。{} で上限なし
-- 数えるのはデプロイ全体（1 デプロイ = 1 契約）。判定は文単位の AFTER INSERT トリガーで、その鍵に上限があるときだけ count(*) する。
-- 超えていれば 'plan_limit_exceeded:<種類>:<上限>' を投げ、文ごと巻き戻る。
-- 書けるのは service_role と、JWT の無い直接の SQL（Supabase の SQL エディタ・Management API）だけ。組織の owner / admin は forbidden
-- （ホスティングで貸すとき、借り手が自分の上限を外せてはいけない）。使用量は banto_plan_usage()（組織の owner / admin）。

-- ---------- 値の検査 ----------
create or replace function banto_plan_limits_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare v_key text; v_val jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  for v_key, v_val in select * from jsonb_each(p_value) loop
    if v_key not in ('shops', 'products', 'customers', 'members') then return false; end if;
    if jsonb_typeof(v_val) <> 'number' then return false; end if;
    if (v_val #>> '{}') !~ '^[0-9]+$' then return false; end if;
    if (v_val #>> '{}')::bigint < 1 or (v_val #>> '{}')::bigint > 1000000 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke execute on function banto_plan_limits_valid(jsonb) from public, anon, authenticated;

-- ---------- site_settings_set（0038 の差し替え: plan_limits を足す） ----------
create or replace function site_settings_set(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_out jsonb; v_role text := auth.role();
begin
  if p_key = 'plan_limits' then
    -- service_role（ホスティングの提供者・Worker の特権経路）か、JWT の無い直接の SQL（SQL エディタ・Management API）だけ
    if v_role is not null and v_role <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
    if not banto_plan_limits_valid(p_value) then raise exception 'invalid_value'; end if;
  else
    if not exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    case p_key
      when 'workers_plan' then
        if p_value is null or jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' not in ('free', 'paid') then raise exception 'invalid_value'; end if;
      else raise exception 'invalid_key';
    end case;
  end if;
  update banto_site_settings set settings = settings || jsonb_build_object(p_key, p_value), updated_at = now() where id
  returning settings into v_out;
  return v_out;
end;
$$;
revoke execute on function site_settings_set(text, jsonb) from public, anon;
grant execute on function site_settings_set(text, jsonb) to authenticated, service_role;

-- ---------- 上限と使用量 ----------
create or replace function banto_plan_limits()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select settings->'plan_limits' from banto_site_settings where id), '{}'::jsonb);
$$;
revoke execute on function banto_plan_limits() from public, anon, authenticated;

create or replace function banto_plan_count(p_kind text)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare v bigint;
begin
  case p_kind
    when 'shops' then select count(*) into v from shops;
    when 'products' then select count(*) into v from products;
    when 'customers' then select count(*) into v from customers;
    when 'members' then select count(*) into v from org_members;
    else v := 0;
  end case;
  return v;
end;
$$;
revoke execute on function banto_plan_count(text) from public, anon, authenticated;

-- 管理画面（/admin/site）用。組織の owner / admin と service_role
create or replace function banto_plan_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_limits jsonb := banto_plan_limits();
begin
  if auth.role() is distinct from 'service_role'
     and not exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'limits', v_limits,
    'usage', jsonb_build_object(
      'shops', banto_plan_count('shops'),
      'products', banto_plan_count('products'),
      'customers', banto_plan_count('customers'),
      'members', banto_plan_count('members')));
end;
$$;
revoke execute on function banto_plan_usage() from public, anon;
grant execute on function banto_plan_usage() to authenticated, service_role;

-- ---------- 判定（文単位の AFTER INSERT） ----------
create or replace function banto_plan_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_kind text; v_limit bigint; v_count bigint;
begin
  v_kind := case tg_table_name when 'org_members' then 'members' else tg_table_name end;
  v_limit := nullif(banto_plan_limits()->>v_kind, '')::bigint;
  if v_limit is null then return null; end if;
  v_count := banto_plan_count(v_kind);
  if v_count > v_limit then
    raise exception 'plan_limit_exceeded:%:%', v_kind, v_limit using errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke execute on function banto_plan_limit_guard() from public, anon, authenticated;

drop trigger if exists shops_plan_limit on shops;
create trigger shops_plan_limit after insert on shops for each statement execute function banto_plan_limit_guard();
drop trigger if exists products_plan_limit on products;
create trigger products_plan_limit after insert on products for each statement execute function banto_plan_limit_guard();
drop trigger if exists customers_plan_limit on customers;
create trigger customers_plan_limit after insert on customers for each statement execute function banto_plan_limit_guard();
drop trigger if exists org_members_plan_limit on org_members;
create trigger org_members_plan_limit after insert on org_members for each statement execute function banto_plan_limit_guard();

insert into banto_migrations (version) values ('0052_plan_limits');
