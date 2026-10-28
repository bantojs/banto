-- Banto 0070_mod_passkey_headless_add: ヘッドレスの会員がパスキーを追加する（同梱モジュール passkey、人間の決定 2026-10-28）。前方専用。
--   パスキーはショップのドメインに結びつく（RP ID）ので、追加もショップのドメインの画面で行う。流れ:
--     1. 連携サイトが会員トークンで「追加の券」を受け取る（member_passkey_ticket_create。2 分・1 回限り）
--     2. 会員のブラウザをショップのドメインの追加の画面へ送る。ボタンで券を使う（member_passkey_ticket_take）と、
--        その端末に新しい web のセッションを作り、パスキーを追加して連携サイトへ戻る（追加の後にそのセッションは取り消す）
--   盗まれたトークンから居座れないように（0057 と同じ決まり）、券を出せるのは **ログインしてから 15 分以内の api のセッション** だけ。
--   券を使うときも、そのセッションがまだ生きていることを確かめる。券のトークンは Worker の HMAC だけを置く

create table if not exists member_passkey_tickets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  customer_id uuid not null,
  session_epoch integer not null,
  api_session_id uuid not null references member_sessions(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  foreign key (shop_id, customer_id) references customers(shop_id, id) on delete cascade
);
create index if not exists member_passkey_tickets_customer on member_passkey_tickets (shop_id, customer_id, created_at);
alter table member_passkey_tickets enable row level security;
create policy member_passkey_tickets_none on member_passkey_tickets for select using (false);
revoke all on member_passkey_tickets from anon, authenticated;

-- 券を出す。戻り値: { ok: true, id } / { ok: false, reason: 'disabled' | 'session' | 'reauth' | 'limited' }
create or replace function member_passkey_ticket_create(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_ticket_create: service_role only' using errcode = '42501';
  end if;
  if banto_passkey_shop(p_shop_id) is null then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_token'; end if;
  if p_session_id is null or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id)
     or not exists (select 1 from member_sessions where id = p_session_id and kind = 'api') then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  if not exists (select 1 from member_sessions where id = p_session_id and created_at > now() - interval '15 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'reauth');
  end if;
  if (select count(*) from member_passkey_tickets where shop_id = p_shop_id and customer_id = p_customer_id and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  delete from member_passkey_tickets where expires_at < now() - interval '1 day';
  insert into member_passkey_tickets (shop_id, customer_id, session_epoch, api_session_id, token_hash, expires_at)
  values (p_shop_id, p_customer_id, p_epoch, p_session_id, p_token_hash, now() + interval '2 minutes')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke execute on function member_passkey_ticket_create(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function member_passkey_ticket_create(uuid, uuid, integer, uuid, text) to service_role;

-- 券を使う（1 回限り）。戻り値: { ok: true, customer_id, session_epoch, email } / { ok: false }
create or replace function member_passkey_ticket_take(p_shop_id uuid, p_ticket_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_t member_passkey_tickets%rowtype; v_email text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_passkey_ticket_take: service_role only' using errcode = '42501';
  end if;
  select * into v_t from member_passkey_tickets
   where id = p_ticket_id and shop_id = p_shop_id and token_hash = coalesce(p_token_hash, '') and used_at is null and expires_at > now()
   for update;
  if not found then return jsonb_build_object('ok', false); end if;
  update member_passkey_tickets set used_at = now() where id = v_t.id;
  -- 券を出した後にログアウト・全端末からログアウト・退会していれば使えない
  if not banto_member_session_live(p_shop_id, v_t.customer_id, v_t.session_epoch, v_t.api_session_id) then return jsonb_build_object('ok', false); end if;
  select email into v_email from customers where shop_id = p_shop_id and id = v_t.customer_id;
  return jsonb_build_object('ok', true, 'customer_id', v_t.customer_id, 'session_epoch', v_t.session_epoch, 'email', v_email);
end;
$$;
revoke execute on function member_passkey_ticket_take(uuid, uuid, text) from public, anon, authenticated;
grant execute on function member_passkey_ticket_take(uuid, uuid, text) to service_role;

insert into banto_migrations (version) values ('0070_mod_passkey_headless_add');
