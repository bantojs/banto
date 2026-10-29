-- Banto 0073_plan_theme_limit: プランの上限に「テーマの版の数」を足す（テーマの段階 3、人間の決定 2026-10-28、docs/themes.md）。前方専用。
-- Banto をホスティングして貸す構成（Banto Cloud など）で、プランごとに Liquid のテーマを使わせるか・いくつ置かせるかを決めるため。
--   - plan_limits.theme_versions: この Banto 全体で置けるテーマの版の数。0 なら Liquid のテーマを取り込めない（ほかの鍵と違い 0 を許す）
--   - 1 つのショップの 20 の上限（banto_theme_versions_max、0071）はそのまま。判定は 0052 / 0055 と同じ文単位の AFTER INSERT トリガー
--   - 書けるのは今までどおり service_role と JWT の無い直接の SQL だけ（site_settings_set は変えない。値の検査だけ広げる）

-- ---------- 値の検査（0053 の差し替え: theme_versions を足す） ----------
create or replace function banto_plan_limits_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare v_key text; v_val jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  for v_key, v_val in select * from jsonb_each(p_value) loop
    if v_key not in ('shops', 'products', 'customers', 'members', 'mail_per_day', 'theme_versions') then return false; end if;
    if jsonb_typeof(v_val) <> 'number' then return false; end if;
    if (v_val #>> '{}') !~ '^[0-9]+$' then return false; end if;
    -- テーマの版だけは 0（使わせない）を許す
    if (v_val #>> '{}')::bigint < (case when v_key = 'theme_versions' then 0 else 1 end) or (v_val #>> '{}')::bigint > 1000000 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke execute on function banto_plan_limits_valid(jsonb) from public, anon, authenticated;

-- ---------- 数える（0053 の差し替え: theme_versions を足す） ----------
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
    when 'mail_per_day' then v := banto_plan_mail_count();
    when 'theme_versions' then select count(*) into v from theme_versions;
    else v := 0;
  end case;
  return v;
end;
$$;
revoke execute on function banto_plan_count(text) from public, anon, authenticated;

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
      'members', banto_plan_count('members'),
      'mail_per_day', banto_plan_count('mail_per_day'),
      'theme_versions', banto_plan_count('theme_versions')));
end;
$$;
revoke execute on function banto_plan_usage() from public, anon;
grant execute on function banto_plan_usage() to authenticated, service_role;

-- ---------- 判定（0055 の banto_plan_limit_guard をそのまま使う。種類は表の名前） ----------
drop trigger if exists theme_versions_plan_limit on theme_versions;
create trigger theme_versions_plan_limit after insert on theme_versions for each statement execute function banto_plan_limit_guard();

insert into banto_migrations (version) values ('0073_plan_theme_limit');
