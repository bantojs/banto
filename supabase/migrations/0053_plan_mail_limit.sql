-- Banto 0053_plan_mail_limit: プランの上限に「1 日のメール」を足す（人間の決定 2026-10-23、docs/knowledge/02-decisions.md）。前方専用。
--
-- ホスティングの提供者がメールの送り手（Resend 等）を共有させる構成で、送り手の評判を守るため、Banto がその場で送るメールのうち
-- 外から増やせるもの（会員のログインのコード = member_login_challenges、組織への招待 = org_invitations）を
-- デプロイ全体で 1 日（UTC）いくつまで、を plan_limits.mail_per_day に置く。0029 のショップごとの上限は借り手が自分で上げられるので、その上のふた。
-- 注文メールは注文の数に比例するだけなので数えない。
-- 判定は 0052 と同じ文単位の AFTER INSERT トリガー。超えれば 'plan_limit_exceeded:mail_per_day:<上限>'。
-- 書けるのは 0052 と同じく service_role と JWT の無い直接の SQL だけ（site_settings_set は変えない。鍵の検査だけ広げる）。

-- ---------- 値の検査（0052 の差し替え: mail_per_day を足す） ----------
create or replace function banto_plan_limits_valid(p_value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare v_key text; v_val jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then return false; end if;
  for v_key, v_val in select * from jsonb_each(p_value) loop
    if v_key not in ('shops', 'products', 'customers', 'members', 'mail_per_day') then return false; end if;
    if jsonb_typeof(v_val) <> 'number' then return false; end if;
    if (v_val #>> '{}') !~ '^[0-9]+$' then return false; end if;
    if (v_val #>> '{}')::bigint < 1 or (v_val #>> '{}')::bigint > 1000000 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke execute on function banto_plan_limits_valid(jsonb) from public, anon, authenticated;

-- ---------- 今日（UTC）のメールの数 ----------
create or replace function banto_plan_mail_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from member_login_challenges where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from org_invitations where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
$$;
revoke execute on function banto_plan_mail_count() from public, anon, authenticated;

-- 0052 の banto_plan_count に mail_per_day を足す
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
    else v := 0;
  end case;
  return v;
end;
$$;
revoke execute on function banto_plan_count(text) from public, anon, authenticated;

-- ---------- 上限と使用量（0052 の差し替え: mail_per_day を足す） ----------
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
      'mail_per_day', banto_plan_count('mail_per_day')));
end;
$$;
revoke execute on function banto_plan_usage() from public, anon;
grant execute on function banto_plan_usage() to authenticated, service_role;

-- ---------- 判定（文単位の AFTER INSERT） ----------
create or replace function banto_plan_mail_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_limit bigint; v_count bigint;
begin
  v_limit := nullif(banto_plan_limits()->>'mail_per_day', '')::bigint;
  if v_limit is null then return null; end if;
  v_count := banto_plan_mail_count();
  if v_count > v_limit then
    raise exception 'plan_limit_exceeded:mail_per_day:%', v_limit using errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke execute on function banto_plan_mail_guard() from public, anon, authenticated;

drop trigger if exists member_login_challenges_plan_mail on member_login_challenges;
create trigger member_login_challenges_plan_mail after insert on member_login_challenges for each statement execute function banto_plan_mail_guard();
drop trigger if exists org_invitations_plan_mail on org_invitations;
create trigger org_invitations_plan_mail after insert on org_invitations for each statement execute function banto_plan_mail_guard();

insert into banto_migrations (version) values ('0053_plan_mail_limit');
