-- Banto 0054_operator_mfa: 運営者（管理画面）の二段階認証（人間の決定 2026-10-24、docs/knowledge/02-decisions.md）
--
-- 方式: Supabase Auth（GoTrue）の二段階認証（TOTP。認証アプリの 6 桁）。二段階目を済ませた JWT は aal = 'aal2'。
-- 強制は DB で行う: 画面で求めるだけでは、パスワードを知る人が GoTrue に直接ログインして aal1 の JWT で PostgREST を叩ける
-- （SUPABASE_URL と anon キーは公開されている）。PostgREST がすべてのリクエストの前に呼ぶ関数（db_pre_request）で、
--   - 二段階認証を登録している人の aal1 の JWT        → 'mfa_required:challenge' で止める
--   - 「全員必須」の組織にいて、まだ登録していない人 → 'mfa_required:enroll' で止める（登録は GoTrue だけで済むので詰まない）
-- テーブルも RPC もまとめて 1 か所で止まる。anon（お客様の画面）と service_role（Worker の特権経路・AI 用トークンの api_*）は対象外。
-- 会員（customers）は Supabase Auth を使わないので関係ない。
--
-- 登録していない人は今までどおり使える（任意で始める。組織の owner が「全員必須」にできる）。
-- 認証アプリをなくしたとき: 同じ組織の owner / admin が外せる（org_member_mfa_reset_authorize → Worker が GoTrue の Admin API で消す）。
-- owner が 1 人だけのときは、docs/hardening.md の SQL で外す。

-- ---------- 組織の設定: 全員必須 ----------
alter table organizations add column if not exists require_mfa boolean not null default false;

-- ---------- 今の JWT の状態 ----------
-- ok / challenge（登録済みなのに aal1）/ enroll（組織が必須なのに未登録）
create or replace function banto_mfa_state()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then 'ok'
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then 'ok'
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified') then 'challenge'
    when exists (select 1 from org_members m join organizations o on o.id = m.org_id where m.user_id = auth.uid() and o.require_mfa) then 'enroll'
    else 'ok'
  end;
$$;

-- PostgREST のリクエストの前に必ず通る（下で authenticator に設定する）
create or replace function banto_pre_request()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_state text;
begin
  if auth.role() is distinct from 'authenticated' then return; end if;
  v_state := banto_mfa_state();
  if v_state <> 'ok' then
    raise exception 'mfa_required:%', v_state using errcode = '42501';
  end if;
end;
$$;

-- ---------- 組織の owner: 全員必須にする / 外す ----------
-- 必須にするのは、自分が二段階認証を済ませた（aal2 の）owner だけ（自分の登録の無いまま全員を締め出さないため）
create or replace function org_set_require_mfa(p_org_id uuid, p_required boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_members where org_id = p_org_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_required and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'mfa_self_first';
  end if;
  update organizations set require_mfa = p_required where id = p_org_id;
  perform banto_audit(p_org_id, null, 'org.require_mfa', 'organization', p_org_id::text, jsonb_build_object('required', p_required));
end;
$$;

-- ---------- メンバーの二段階認証の有無（組織の owner / admin が見る） ----------
create or replace function org_members_mfa(p_org_id uuid)
returns table (user_id uuid, has_mfa boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status::text = 'verified')
    from org_members m
   where m.org_id = p_org_id and banto_org_admin(p_org_id);
$$;

-- ---------- 認証アプリをなくした人の登録を外す（許可と記録。消すのは Worker が GoTrue の Admin API で） ----------
-- 呼べるのは、相手と同じ組織の owner / admin。相手が owner なら owner だけ。自分自身は外せない（自分は管理画面から）。
-- 許せば監査ログに書いて true（同じ組織が複数あれば、それぞれに書く）
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
  for v_org in
    select me.org_id, me.role as my_role, them.role as their_role
      from org_members me join org_members them on them.org_id = me.org_id
     where me.user_id = auth.uid() and them.user_id = p_user_id and me.role in ('owner', 'admin')
  loop
    if v_org.their_role = 'owner' and v_org.my_role <> 'owner' then continue; end if;
    perform banto_audit(v_org.org_id, null, 'org_member.mfa_reset', 'user', p_user_id::text, '{}'::jsonb);
    v_ok := true;
  end loop;
  if not v_ok then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return true;
end;
$$;

-- ---------- 権限 ----------
-- banto_pre_request は PostgREST がリクエストの役割のまま呼ぶので、anon と authenticated にも EXECUTE が要る（中身は JWT を読むだけ）
revoke execute on function banto_mfa_state() from public;
revoke execute on function banto_pre_request() from public;
grant execute on function banto_mfa_state() to anon, authenticated, service_role;
grant execute on function banto_pre_request() to anon, authenticated, service_role;
revoke execute on function org_set_require_mfa(uuid, boolean) from public, anon;
revoke execute on function org_members_mfa(uuid) from public, anon;
revoke execute on function org_member_mfa_reset_authorize(uuid) from public, anon;
grant execute on function org_set_require_mfa(uuid, boolean) to authenticated, service_role;
grant execute on function org_members_mfa(uuid) to authenticated, service_role;
grant execute on function org_member_mfa_reset_authorize(uuid) to authenticated, service_role;

-- ---------- PostgREST に「リクエストの前の関数」を設定する ----------
-- Supabase・selfhost/ とも PostgREST は authenticator で接続し、DB の設定（pgrst.*）を読む。テスト用の素の PostgreSQL には authenticator が無い
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.banto_pre_request''';
  end if;
end;
$$;
notify pgrst, 'reload config';

insert into banto_migrations (version) values ('0054_operator_mfa');
