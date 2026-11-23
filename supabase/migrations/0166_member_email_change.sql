-- 0166_member_email_change: 会員が自分でメールアドレスを変える。前方専用。メンテナの決定 2026-11-23（docs/members.md、docs/knowledge/10-members-identity.md）。
--   - 会員機能が ON のどのショップでも使える（設定の印は足さない）。ログインを確かめてから 15 分以内のセッションだけ（パスワードの設定と同じ）
--   - 新しいアドレスに 6 桁のコードを送り、会員ページで入れてもらって初めて変わる（コードは Worker が HMAC にした値だけを置く。15 分・5 回まで）
--   - 変わったら世代を上げ、今の端末のセッションの行だけを新しい世代に付け替える（ほかの端末はログアウト）。前後のアドレスに Worker が知らせる。
--     監査ログは 0051 の customers のトリガーが書く（アドレスはハッシュの先頭だけ）
--   - 同じショップのほかの会員が使っているアドレスには変えない。始めるときは「送った」と同じ答え（使われているかを探らせない）
--   - 送ったコードの行はプランの 1 日のメール（plan_limits.mail_per_day、0053）にも数える
--   - AI 用 API からは変えない（CLAUDE.md §7b のまま）。会員本人のセッションだけ

create table if not exists member_email_changes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null,
  -- 変えた後のアドレス（小文字）
  new_email text not null check (length(new_email) between 3 and 254),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade
);
create index if not exists member_email_changes_customer_idx on member_email_changes (shop_id, customer_id, created_at);
create index if not exists member_email_changes_ip_idx on member_email_changes (shop_id, ip_hash, created_at) where ip_hash is not null;
alter table member_email_changes enable row level security;
-- 誰にも見せない（service_role は RLS を通らない。関数からだけ触る）
drop policy if exists member_email_changes_none on member_email_changes;
create policy member_email_changes_none on member_email_changes for select using (false);
revoke all on member_email_changes from anon, authenticated;

-- ---------- プランの 1 日のメール（0061 の差し替え: アドレスの変更のコードも数える） ----------
create or replace function banto_plan_mail_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from member_login_challenges where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from org_invitations where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from inquiry_mails where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from member_email_changes where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
$$;
revoke execute on function banto_plan_mail_count() from public, anon, authenticated;
drop trigger if exists member_email_changes_plan_mail on member_email_changes;
create trigger member_email_changes_plan_mail after insert on member_email_changes for each statement execute function banto_plan_mail_guard();

-- ---------- 始める: 新しいアドレスにコードを送る ----------
-- 戻り値: { ok: true, send, mail_from } / { ok: false, reason: 'session' | 'reauth' | 'same' }
-- send = false: 回数の上限・ほかの会員が使っているアドレス（応答は送ったときと同じにする）
create or replace function member_email_change_start(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid,
                                                     p_new_email text, p_code_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_new_email, '')));
  v_from text;
  v_current text;
  v_limited boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_email_change_start: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    raise exception 'members_disabled';
  end if;
  v_from := banto_member_mail_from(p_shop_id);
  if v_from is null then raise exception 'mail_not_configured'; end if;
  if p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_code_hash'; end if;
  select lower(coalesce(email, '')) into v_current from customers where shop_id = p_shop_id and id = p_customer_id;
  if v_current = v_email then return jsonb_build_object('ok', false, 'reason', 'same'); end if;

  perform pg_advisory_xact_lock(hashtextextended('member_email_change|' || p_shop_id::text || '|' || p_customer_id::text, 0));
  -- 古い行の後始末（この会員の 2 日より前のもの）
  delete from member_email_changes where shop_id = p_shop_id and customer_id = p_customer_id and created_at < now() - interval '2 days';
  -- 回数の上限: この会員に 15 分で 3 回・1 日 10 回、同じ IP から 1 時間に 30 回
  v_limited := (select count(*) from member_email_changes where shop_id = p_shop_id and customer_id = p_customer_id and created_at > now() - interval '15 minutes') >= 3
            or (select count(*) from member_email_changes where shop_id = p_shop_id and customer_id = p_customer_id and created_at > now() - interval '1 day') >= 10
            or (p_ip_hash is not null and (select count(*) from member_email_changes where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30);
  -- ほかの会員が使っているアドレス: 送らない（答えは同じ。確かめで変えようとしても unavailable で断る）
  if v_limited or exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_email and id <> p_customer_id) then
    return jsonb_build_object('ok', true, 'send', false, 'mail_from', v_from);
  end if;
  -- 有効なコードはいつも 1 つ（前のものは無効にする）
  update member_email_changes set consumed_at = now()
   where shop_id = p_shop_id and customer_id = p_customer_id and consumed_at is null;
  insert into member_email_changes (shop_id, customer_id, new_email, code_hash, ip_hash, expires_at)
  values (p_shop_id, p_customer_id, v_email, p_code_hash, nullif(p_ip_hash, ''), now() + interval '15 minutes');
  return jsonb_build_object('ok', true, 'send', true, 'mail_from', v_from);
end;
$$;
revoke execute on function member_email_change_start(uuid, uuid, integer, uuid, text, text, text) from public, anon, authenticated;
grant execute on function member_email_change_start(uuid, uuid, integer, uuid, text, text, text) to service_role;

-- ---------- 確かめる: コードが合えばアドレスを変える ----------
-- 戻り値: { ok: true, old_email, new_email, epoch, mail_from, authenticated_at }
--       / { ok: false, reason: 'session' | 'reauth' | 'invalid' | 'expired' | 'unavailable' }
create or replace function member_email_change_verify(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row member_email_changes%rowtype;
  v_old text;
  v_epoch integer;
  v_auth timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_email_change_verify: service_role only' using errcode = '42501';
  end if;
  if p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not banto_member_recent_auth(p_shop_id, p_customer_id, p_epoch, p_session_id, 15) then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  select * into v_row from member_email_changes
   where shop_id = p_shop_id and customer_id = p_customer_id and consumed_at is null
   order by created_at desc limit 1
   for update;
  if not found or v_row.expires_at <= now() or v_row.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if coalesce(p_code_hash, '') <> v_row.code_hash then
    update member_email_changes set attempts = attempts + 1,
           consumed_at = case when attempts + 1 >= 5 then now() else consumed_at end
     where id = v_row.id;
    return jsonb_build_object('ok', false, 'reason', case when v_row.attempts + 1 >= 5 then 'expired' else 'invalid' end);
  end if;
  update member_email_changes set consumed_at = now() where id = v_row.id;
  -- 同じショップの会員のアドレスを並べて確かめる（同じアドレスへの変更が重ならないように）
  perform pg_advisory_xact_lock(hashtextextended('member_email|' || p_shop_id::text || '|' || v_row.new_email, 0));
  if exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_row.new_email and id <> p_customer_id) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;
  select email into v_old from customers where shop_id = p_shop_id and id = p_customer_id for update;
  update customers set email = v_row.new_email, session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch
  returning session_epoch into v_epoch;
  if v_epoch is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  -- この端末のセッションだけ新しい世代へ（ほかの端末は世代が合わなくなって止まる）。ログインを確かめた時刻は変えない
  update member_sessions set session_epoch = v_epoch where id = p_session_id returning authenticated_at into v_auth;
  -- 前後のアドレスに出ているログインのコード・リンクを無効にする
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email in (lower(coalesce(v_old, '')), v_row.new_email) and consumed_at is null;
  return jsonb_build_object('ok', true, 'old_email', v_old, 'new_email', v_row.new_email, 'epoch', v_epoch,
                            'mail_from', banto_member_mail_from(p_shop_id), 'authenticated_at', v_auth);
end;
$$;
revoke execute on function member_email_change_verify(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function member_email_change_verify(uuid, uuid, integer, uuid, text) to service_role;

insert into banto_migrations (version) values ('0166_member_email_change');
