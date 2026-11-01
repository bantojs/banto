-- Banto 0088_app_connect: 外部プラグインに「つなぐ」（メンテナの決定 2026-11-01、docs/hooks.md §6）。前方専用。
--   - 運営者は秘密（署名シークレット・AI 用トークン）を手で写さない。管理画面で許すと、Banto が 1 回だけ・2 分だけ使える券を付けて
--     プラグインの connect_url へ移し、プラグインは裏でその券を Banto と引き換える（AI 用トークン・接続ごとの署名シークレット・ショップの ID）
--   - 接続ごとの署名シークレットはサイトの秘密から切り離した乱数。Worker がサイトの秘密から作った鍵で AES-GCM で暗号化して置く
--     （CLAUDE.md §1-5 の例外 (c)、shop_secret_boxes と同じ作り。追加認証データはショップと "hook:<連携>"）。運営者にも暗号文の列は読ませない
--   - 引き換えで作るトークンは連携に結ぶ（api_tokens.endpoint_id）。連携を消すとトークン・接続・拡張データがまとめて消える（外す）
--   - 券は HMAC ではなく SHA-256 の値だけを置く（AI 用トークンと同じ）。引き換えたら消す。期限は 2 分
--   - 監査ログ: つないだ・外した（0051 のトリガーの作り）

create table if not exists app_connections (
  endpoint_id uuid primary key,
  shop_id uuid not null references shops (id) on delete cascade,
  -- 運営者が許したスコープ（引き換えのときにこの通りのトークンを作る）
  scopes text[] not null default '{}',
  -- 許した人（作るトークンの owner。この人の項目までしか付かない）
  created_by uuid not null,
  ticket_hash text unique check (ticket_hash is null or ticket_hash ~ '^[0-9a-f]{64}$'),
  ticket_expires_at timestamptz,
  secret_box text check (secret_box is null or secret_box ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  token_id uuid references api_tokens (id) on delete set null,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (endpoint_id, shop_id) references hook_endpoints (id, shop_id) on delete cascade
);
create index if not exists app_connections_shop_idx on app_connections (shop_id);

alter table app_connections enable row level security;
drop policy if exists app_connections_integrations on app_connections;
create policy app_connections_integrations on app_connections for select using (banto_shop_perm(shop_id, 'integrations'));
-- 運営者が読めるのは「つないだか・何を許したか」だけ（券と暗号文の列は読めない）。書くのは下の関数だけ
revoke all on app_connections from anon, authenticated;
grant select (endpoint_id, shop_id, scopes, created_by, ticket_expires_at, connected_at, created_at, updated_at) on app_connections to authenticated;

-- ---------- 始める（運営者。管理画面の「つなぐ」「つなぎ直す」） ----------
create or replace function app_connect_begin(p_shop_id uuid, p_endpoint_id uuid, p_scopes text[], p_ticket_hash text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_exp timestamptz := now() + interval '2 minutes';
begin
  if auth.uid() is null or not banto_shop_perm(p_shop_id, 'integrations') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_ep from hook_endpoints where id = p_endpoint_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  if v_ep.url like 'https://banto.invalid/%' then raise exception 'not_found'; end if;
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_ticket'; end if;
  -- スコープは語彙のもので、許す人が持つ項目まで（AI 用トークンの決まりと同じ）
  if exists (select 1 from unnest(coalesce(p_scopes, '{}'::text[])) s where banto_scope_perm(s) is null) then raise exception 'invalid_scopes'; end if;
  if not banto_token_scopes_ok(auth.uid(), p_shop_id, coalesce(p_scopes, '{}'::text[])) then
    raise exception 'scope_not_permitted' using errcode = '42501';
  end if;
  if 'app_data:write' = any(coalesce(p_scopes, '{}'::text[])) and v_ep.app_handle is null then raise exception 'app_handle_required'; end if;
  insert into app_connections (endpoint_id, shop_id, scopes, created_by, ticket_hash, ticket_expires_at)
  values (p_endpoint_id, p_shop_id, coalesce(p_scopes, '{}'::text[]), auth.uid(), p_ticket_hash, v_exp)
  on conflict (endpoint_id) do update
    set scopes = excluded.scopes, created_by = excluded.created_by, ticket_hash = excluded.ticket_hash,
        ticket_expires_at = excluded.ticket_expires_at, updated_at = now();
  return v_exp;
end;
$$;
revoke execute on function app_connect_begin(uuid, uuid, text[], text) from public, anon;
grant execute on function app_connect_begin(uuid, uuid, text[], text) to authenticated;

-- ---------- 引き換える（プラグインの裏の呼び出し。Worker が service_role で） ----------
-- Worker が作った生のトークンのハッシュと、暗号化した署名シークレットを受け取り、券を消してトークンを作る。
-- つなぎ直しなら、前のトークンは取り消す
create or replace function app_connect_exchange(p_ticket_hash text, p_token_hash text, p_token_prefix text, p_secret_box text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_c app_connections; v_ep hook_endpoints; v_tok uuid; v_shop shops;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'app_connect_exchange: service_role only' using errcode = '42501';
  end if;
  select * into v_c from app_connections
   where ticket_hash = p_ticket_hash and ticket_expires_at > now()
   for update;
  if not found then raise exception 'invalid_ticket'; end if;
  select * into v_ep from hook_endpoints where id = v_c.endpoint_id;
  select * into v_shop from shops where id = v_c.shop_id;
  if v_c.token_id is not null then
    update api_tokens set revoked_at = now() where id = v_c.token_id and revoked_at is null;
  end if;
  -- 作るトークンは許した人の項目まで（api_tokens_guard が確かめる。項目が外れていれば scope_not_permitted で引き換えも失敗）
  insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, endpoint_id)
  values (v_c.shop_id, v_c.created_by, left('連携: ' || v_ep.name, 100), p_token_hash, p_token_prefix, v_c.scopes, v_c.endpoint_id)
  returning id into v_tok;
  update app_connections
     set ticket_hash = null, ticket_expires_at = null, secret_box = p_secret_box, token_id = v_tok,
         connected_at = now(), updated_at = now()
   where endpoint_id = v_c.endpoint_id;
  perform banto_audit(banto_shop_org(v_c.shop_id), v_c.shop_id, 'app.connected', 'hook_endpoint', v_c.endpoint_id::text,
                      jsonb_build_object('scopes', v_c.scopes, 'app', v_ep.app_handle));
  return jsonb_build_object('shop_id', v_c.shop_id, 'shop_slug', v_shop.slug, 'shop_name', v_shop.name, 'endpoint_id', v_c.endpoint_id,
                            'app', v_ep.app_handle, 'scopes', v_c.scopes, 'token_id', v_tok);
end;
$$;
revoke execute on function app_connect_exchange(text, text, text, text) from public, anon, authenticated;
grant execute on function app_connect_exchange(text, text, text, text) to service_role;

-- 券の行き先（service_role。引き換えの前に、暗号化の追加認証データに使うショップと連携を知るため。券は消さない）
create or replace function app_connect_ticket(p_ticket_hash text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'app_connect_ticket: service_role only' using errcode = '42501';
  end if;
  return (select jsonb_build_object('shop_id', shop_id, 'endpoint_id', endpoint_id) from app_connections
           where ticket_hash = p_ticket_hash and ticket_expires_at > now());
end;
$$;
revoke execute on function app_connect_ticket(text) from public, anon, authenticated;
grant execute on function app_connect_ticket(text) to service_role;

-- 接続の署名シークレットの暗号文（service_role。配信・テスト送信・プラグインの画面の券に使う）
create or replace function app_connection_secret_box(p_endpoint_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'app_connection_secret_box: service_role only' using errcode = '42501';
  end if;
  return (select secret_box from app_connections where endpoint_id = p_endpoint_id);
end;
$$;
revoke execute on function app_connection_secret_box(uuid) from public, anon, authenticated;
grant execute on function app_connection_secret_box(uuid) to service_role;

-- ---------- 監査ログ: 外した ----------
create or replace function banto_audit_app_connections()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform banto_audit(banto_shop_org(old.shop_id), old.shop_id, 'app.disconnected', 'hook_endpoint', old.endpoint_id::text,
                      jsonb_build_object('scopes', old.scopes));
  return old;
end;
$$;
revoke execute on function banto_audit_app_connections() from public, anon, authenticated;
drop trigger if exists app_connections_audit_delete on app_connections;
create trigger app_connections_audit_delete after delete on app_connections for each row execute function banto_audit_app_connections();

-- ---------- 配信: 接続ごとの署名シークレットの暗号文も返す（0056 の形に secret_box を足す） ----------
drop function if exists claim_hook_deliveries(integer);
create or replace function claim_hook_deliveries(p_limit integer default 50)
returns table (
  id uuid, shop_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer,
  url text, settings jsonb, created_at timestamptz, secret_box text
)
language plpgsql
security definer
set search_path = public
as $$
declare v_limit integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'claim_hook_deliveries: service_role only' using errcode = '42501';
  end if;
  v_limit := greatest(1, least(p_limit, case when banto_workers_plan() = 'paid' then 500 else 12 end));
  return query
  with picked as (
    select d.id from hook_deliveries d
      join hook_endpoints e on e.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and e.enabled
     order by d.next_attempt_at
     limit v_limit
     for update of d skip locked
  ),
  leased as (
    update hook_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from picked
     where d.id = picked.id
    returning d.id, d.shop_id, d.endpoint_id, d.event, d.payload, d.attempts, d.created_at
  )
  select l.id, l.shop_id, l.endpoint_id, l.event, l.payload, l.attempts, e.url, e.settings, l.created_at, c.secret_box
    from leased l join hook_endpoints e on e.id = l.endpoint_id
    left join app_connections c on c.endpoint_id = l.endpoint_id;
end;
$$;
revoke execute on function claim_hook_deliveries(integer) from public, anon, authenticated;
grant execute on function claim_hook_deliveries(integer) to service_role;

insert into banto_migrations (version) values ('0088_app_connect');
