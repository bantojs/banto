-- Banto 0045_member_sessions: 会員のセッションを端末ごとに持つ（監査 M9）。前方専用。
--
-- これまで会員のセッション（Cookie・ヘッドレスのトークン）はサーバーに状態が無く、取り消せるのは「全端末からログアウト」（世代を上げる）だけだった。
-- ログアウトしても盗まれた Cookie は 30 日使えたし、ヘッドレスの refresh は回転もしなかった。
--   - ログインのたびに 1 行（member_sessions）。Cookie とトークンにはこの行の ID（sid）を入れる。
--   - Cookie は数分ごとに member_session_check で行を確かめる（毎回は問い合わせない。速度の予算、src/routes/storefront/members.ts）。
--   - ヘッドレスの refresh は 1 回ごとに回す（refresh_gen）。前の世代を使い回したら、その行ごと取り消す（盗まれたと見なす）。
--     同時に refresh したとき（タブを 2 つ開いていた等）のために、回した直後の短い間だけ 1 つ前の世代も通す。
--   - 行には絶対の期限（expires_at）がある。開くたびに延びるのは Cookie の期限だけで、行の期限は延ばさない。
--   - 世代（customers.session_epoch）は今までどおり。上げれば、それより前の世代の行はすべて通らなくなる。
-- 行に置くのは端末の目安（ブラウザと OS の名前だけ。Worker が User-Agent から作る）と日時だけ。IP・User-Agent そのものは置かない。
-- すべて service_role だけ。呼び出しは src/db/privileged.ts から。

create table member_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null,
  -- 作ったときの customers.session_epoch。今の世代と違えば通らない
  session_epoch integer not null,
  -- web: お店の画面の Cookie / api: ヘッドレスのトークン
  kind text not null check (kind in ('web', 'api')),
  label text check (char_length(label) <= 60),
  -- ヘッドレスの refresh の世代（web では使わない）
  refresh_gen integer not null default 0,
  rotated_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('logout', 'revoked', 'reuse', 'limit')),
  -- 退会（customers 行の削除）で消える
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade
);
create index member_sessions_customer_idx on member_sessions (shop_id, customer_id, created_at);
create index member_sessions_expires_idx on member_sessions (expires_at);
alter table member_sessions enable row level security;
-- 誰にも見せない（service_role は RLS を通らない。関数からだけ触る）
create policy member_sessions_none on member_sessions for select using (false);

-- 1 人の会員が同時に持てるセッションの数。超えたら古いものから取り消す（行が際限なく増えないように）
create or replace function banto_member_session_limit() returns integer language sql immutable as $$ select 20 $$;

-- ---------- セッションを作る（ログインの直後に Worker が呼ぶ） ----------
-- 世代が今と違えば（ログインの途中で全端末からログアウトされた等）null。戻り値は sid
create or replace function member_session_start(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_kind text, p_label text, p_ttl_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_start: service_role only' using errcode = '42501';
  end if;
  if p_kind not in ('web', 'api') or p_ttl_seconds is null or p_ttl_seconds not between 60 and 366 * 86400 then
    raise exception 'invalid_session';
  end if;
  perform 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch for update;
  if not found then return null; end if;
  -- この会員の終わった行を片付ける
  delete from member_sessions
   where shop_id = p_shop_id and customer_id = p_customer_id
     and (expires_at < now() or revoked_at < now() - interval '1 day' or session_epoch <> p_epoch);
  insert into member_sessions (shop_id, customer_id, session_epoch, kind, label, expires_at)
  values (p_shop_id, p_customer_id, p_epoch, p_kind, nullif(left(btrim(coalesce(p_label, '')), 60), ''), now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  update member_sessions set revoked_at = now(), revoked_reason = 'limit'
   where id in (
     select id from member_sessions
      where shop_id = p_shop_id and customer_id = p_customer_id and revoked_at is null
      order by created_at desc, id
      offset banto_member_session_limit());
  return v_id;
end;
$$;

-- 生きているか（取り消されていない・期限内・世代が今と同じ）
create or replace function banto_member_session_live(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from member_sessions s join customers c on c.id = s.customer_id
     where s.id = p_session_id and s.shop_id = p_shop_id and s.customer_id = p_customer_id
       and s.session_epoch = p_epoch and c.session_epoch = p_epoch and c.shop_id = p_shop_id
       and s.revoked_at is null and s.expires_at > now());
$$;

-- ---------- Cookie のセッションを確かめる（数分ごと） ----------
create or replace function member_session_check(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_check: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return false; end if;
  update member_sessions set last_seen_at = now() where id = p_session_id;
  return true;
end;
$$;

-- ---------- ヘッドレスの refresh を回す ----------
-- p_gen はトークンに入っていた世代。今の世代なら 1 つ進めて返す。
-- 1 つ前の世代でも、回してから p_grace_seconds 秒以内なら今の世代を返す（同時に refresh した 2 つ目の呼び出し）。
-- それより古い世代 = 使い回し。行を取り消して reuse を返す（盗んだ側と本人のどちらが先に使ったかは分からないので、両方を止める）。
-- 戻り値: { ok: true, gen, expires_at } / { ok: false, reason: 'invalid' | 'reuse' }
create or replace function member_session_refresh(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_gen integer, p_grace_seconds integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_s member_sessions;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_refresh: service_role only' using errcode = '42501';
  end if;
  select * into v_s from member_sessions
   where id = p_session_id and shop_id = p_shop_id and customer_id = p_customer_id and kind = 'api'
   for update;
  if not found or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_gen = v_s.refresh_gen then
    update member_sessions set refresh_gen = refresh_gen + 1, rotated_at = now(), last_seen_at = now()
     where id = p_session_id returning * into v_s;
    return jsonb_build_object('ok', true, 'gen', v_s.refresh_gen, 'expires_at', v_s.expires_at);
  end if;
  if p_gen = v_s.refresh_gen - 1 and v_s.rotated_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 0), 0)) then
    update member_sessions set last_seen_at = now() where id = p_session_id;
    return jsonb_build_object('ok', true, 'gen', v_s.refresh_gen, 'expires_at', v_s.expires_at);
  end if;
  update member_sessions set revoked_at = now(), revoked_reason = 'reuse' where id = p_session_id;
  return jsonb_build_object('ok', false, 'reason', 'reuse');
end;
$$;

-- ---------- 取り消す ----------
-- 自分のセッション（ログアウト）か、自分のほかの端末（ログイン中の端末の一覧から）。p_epoch は呼び出し側のセッションの世代。
-- 世代が合わない（呼び出し側がもう無効）なら何もしない
create or replace function member_session_revoke(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_reason text default 'revoked')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_revoke: service_role only' using errcode = '42501';
  end if;
  if p_reason not in ('logout', 'revoked') then raise exception 'invalid_reason'; end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return false;
  end if;
  update member_sessions set revoked_at = now(), revoked_reason = p_reason
   where id = p_session_id and shop_id = p_shop_id and customer_id = p_customer_id and revoked_at is null;
  return found;
end;
$$;

-- ---------- ログイン中の端末の一覧 ----------
-- 世代が合わなければ null。今の世代の、取り消されていない・期限内の行だけ（新しく使った順）
create or replace function member_sessions_list(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_sessions_list: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'label', label, 'created_at', created_at, 'last_seen_at', last_seen_at) order by last_seen_at desc, id)
      from member_sessions
     where shop_id = p_shop_id and customer_id = p_customer_id and session_epoch = p_epoch
       and revoked_at is null and expires_at > now()), '[]'::jsonb);
end;
$$;

-- ---------- 片付け（Cron） ----------
create or replace function member_session_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_cleanup: service_role only' using errcode = '42501';
  end if;
  delete from member_sessions s
   where s.expires_at < now()
      or s.revoked_at < now() - interval '1 day'
      or exists (select 1 from customers c where c.id = s.customer_id and c.session_epoch <> s.session_epoch);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function banto_member_session_limit() from public, anon, authenticated;
revoke execute on function banto_member_session_live(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function member_session_start(uuid, uuid, integer, text, text, integer) from public, anon, authenticated;
revoke execute on function member_session_check(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke execute on function member_session_refresh(uuid, uuid, integer, uuid, integer, integer) from public, anon, authenticated;
revoke execute on function member_session_revoke(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
revoke execute on function member_sessions_list(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function member_session_cleanup() from public, anon, authenticated;
grant execute on function member_session_start(uuid, uuid, integer, text, text, integer) to service_role;
grant execute on function member_session_check(uuid, uuid, integer, uuid) to service_role;
grant execute on function member_session_refresh(uuid, uuid, integer, uuid, integer, integer) to service_role;
grant execute on function member_session_revoke(uuid, uuid, integer, uuid, text) to service_role;
grant execute on function member_sessions_list(uuid, uuid, integer) to service_role;
grant execute on function member_session_cleanup() to service_role;

insert into banto_migrations (version) values ('0045_member_sessions');
