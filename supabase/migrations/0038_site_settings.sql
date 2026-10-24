-- Banto 0038_site_settings: デプロイ全体（運営者の Cloudflare アカウント）の設定。docs/knowledge/02-decisions.md 2026-10-19
-- 前方専用。ショップごとの設定（shops.settings）では表せない「このデプロイがどの環境で動いているか」を持つ汎用の器（CLAUDE.md §7 の基準 (2)）。
--
--   workers_plan … 'free'（既定。Cloudflare Workers の無料プラン）/ 'paid'（Workers Paid、または Node で動かすとき）
--                  裏で動く処理（Cron）が 1 回に進める量を、この値で決める（無料プランは 1 回の通信の回数の上限が小さい）
--
-- 1 行だけの表。読み書きは組織の owner / admin（/admin/update と同じ人）。書き込みは site_settings_set だけで、鍵と値を確かめる。

create table banto_site_settings (
  id boolean primary key default true check (id),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);
insert into banto_site_settings (id) values (true);

alter table banto_site_settings enable row level security;
create policy site_settings_org_admin_select on banto_site_settings for select
  using (exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')));

-- 鍵ごとに値を確かめて 1 つ変える。戻り値は変えたあとの settings
create or replace function site_settings_set(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  if not exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  case p_key
    when 'workers_plan' then
      if p_value is null or jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' not in ('free', 'paid') then raise exception 'invalid_value'; end if;
    else raise exception 'invalid_key';
  end case;
  update banto_site_settings set settings = settings || jsonb_build_object(p_key, p_value), updated_at = now() where id
  returning settings into v_out;
  return v_out;
end;
$$;
revoke execute on function site_settings_set(text, jsonb) from public, anon;
grant execute on function site_settings_set(text, jsonb) to authenticated, service_role;

-- 中で使う: Workers のプラン（未設定は free）
create or replace function banto_workers_plan()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select settings->>'workers_plan' from banto_site_settings where id), 'free');
$$;
revoke execute on function banto_workers_plan() from public, anon, authenticated;

insert into banto_migrations (version) values ('0038_site_settings');
