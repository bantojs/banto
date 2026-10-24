-- 0026_tryon_api: お店で試着を AI 用トークン・会員から使う（docs/store-tryon.md、docs/ai-access.md）と、AI 用トークンの発行者の確認
--
-- - AI 用トークン（api_*）: 試着の申し込みは注文に準じて orders:read（一覧・1 件）・orders:write（状態を進める）、
--   お客様の名前・メール・電話・ご要望は orders:pii があるときだけ返す。終わった申し込みの在庫を EC に戻す操作も orders:write で出す
--   （人間の決定 2026-10-17。実店舗のスタッフには戻させない決定はそのまま）。
--   実店舗の一覧（営業時間・臨時休業）は shop:read。
-- - 会員（service_role の member_*、世代を確かめる）: 自分の申し込みの一覧と、取り置きが終わる前の取り消し。
-- - AI 用トークンは、発行した人がそのショップの integrations の項目（組織の owner / admin を含む）を持っている間だけ使える
--   （0024 で招待したメンバーを外したり項目を外したりしても、トークンが残って使えてしまうのを防ぐ）。
-- 状態の遷移は 1 か所（banto_tryon_transition）、在庫を戻すのも 1 か所（banto_tryon_restock）にまとめ、管理画面と AI が同じものを通る。

-- ---------- AI 用トークンの発行者の確認 ----------
create or replace function banto_token_issuer_ok(p_owner_id uuid, p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shops s
     where s.id = p_shop_id
       and ((s.org_id is null and s.owner_id = p_owner_id)
            or (s.org_id is not null and (
                  exists (select 1 from org_members m where m.org_id = s.org_id and m.user_id = p_owner_id and m.role in ('owner', 'admin'))
                  or exists (select 1 from org_member_shops ms where ms.org_id = s.org_id and ms.shop_id = s.id and ms.user_id = p_owner_id and 'integrations' = any(ms.perms))))));
$$;

create or replace function api_require(p_token_hash text, p_scope text)
returns api_tokens
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_require: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash
     and revoked_at is null
     and (expires_at is null or expires_at > now());
  if not found or not (p_scope = any(v_tok.scopes)) or not banto_token_issuer_ok(v_tok.owner_id, v_tok.shop_id) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  -- 最終利用は1分に1回だけ更新（書き込みを減らす）
  if v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute' then
    update api_tokens set last_used_at = now() where id = v_tok.id;
  end if;
  return v_tok;
end;
$$;

create or replace function api_has_scope(p_token_hash text, p_scope text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from api_tokens
     where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now())
       and p_scope = any(scopes) and banto_token_issuer_ok(owner_id, shop_id)
  );
$$;

create or replace function api_token_shop(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype; v_acct text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_token_shop: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not found or not banto_token_issuer_ok(v_tok.owner_id, v_tok.shop_id) then raise exception 'unauthorized' using errcode = '42501'; end if;
  select stripe_account_id into v_acct from shops where id = v_tok.shop_id;
  return jsonb_build_object('shop_id', v_tok.shop_id, 'scopes', to_jsonb(v_tok.scopes), 'name', v_tok.name, 'stripe_account_id', v_acct);
end;
$$;

-- ---------- 状態の遷移（権限は呼び出し元で確かめる。内部用） ----------
-- 申し込み → 店舗へ発送済み → 取り置き中（期限） → 購入 / 購入なし / 期限切れ。終わる前ならキャンセルできる
create or replace function banto_tryon_transition(p_shop_id uuid, p_request_id uuid, p_status text, p_hold_until date)
returns tryon_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_ok boolean;
begin
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  v_ok := case p_status
    when 'sent' then v_r.status = 'requested'
    when 'ready' then v_r.status in ('requested', 'sent', 'ready')
    when 'purchased' then v_r.status in ('ready', 'expired')
    when 'not_purchased' then v_r.status in ('ready', 'expired')
    when 'expired' then v_r.status = 'ready'
    when 'cancelled' then v_r.status in ('requested', 'sent', 'ready')
    else false end;
  if not v_ok then raise exception 'invalid_transition' using detail = v_r.status || ' -> ' || coalesce(p_status, ''); end if;
  if p_status = 'ready' and p_hold_until is null then raise exception 'hold_until_required'; end if;
  update tryon_requests set status = p_status, updated_at = now(),
    hold_until = case when p_status = 'ready' then p_hold_until else hold_until end,
    closed_at = case when p_status in ('purchased', 'not_purchased', 'expired', 'cancelled') then now() end
   where id = v_r.id returning * into v_r;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.updated',
    jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', p_shop_id, 'store_id', v_r.store_id, 'status', v_r.status,
                       'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id));
  return v_r;
end;
$$;

-- 管理画面（0025 を差し替え: 遷移は banto_tryon_transition）
create or replace function tryon_update(p_shop_id uuid, p_request_id uuid, p_status text, p_hold_until date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype;
begin
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id;
  if not found or not (banto_shop_perm(p_shop_id, 'stores') or banto_store_perm(v_r.store_id, 'tryon')) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  v_r := banto_tryon_transition(p_shop_id, p_request_id, p_status, p_hold_until);
  return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'hold_until', v_r.hold_until);
end;
$$;

-- ---------- 減らした在庫を EC に戻す（権限は呼び出し元で確かめる。内部用。1 回だけ） ----------
create or replace function banto_tryon_restock(p_shop_id uuid, p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_n integer := 0;
begin
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_r.status not in ('not_purchased', 'expired', 'cancelled') then raise exception 'not_restockable'; end if;
  if v_r.restocked then return 0; end if;
  update inventory i set available = i.available + t.qty
    from (select sku_id, sum(qty)::integer as qty from tryon_items where request_id = v_r.id group by sku_id) t
   where i.sku_id = t.sku_id and i.shop_id = p_shop_id;
  get diagnostics v_n = row_count;
  update tryon_requests set restocked = true, updated_at = now() where id = v_r.id;
  return v_n;
end;
$$;

-- 管理画面（0025 を差し替え: 中身は banto_tryon_restock。ショップの stores の項目だけ）
create or replace function tryon_restock(p_shop_id uuid, p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'stores') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return banto_tryon_restock(p_shop_id, p_request_id);
end;
$$;

-- ---------- AI 用トークン ----------
create or replace function api_tryon_json(p_r tryon_requests, p_pii boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p_r.id, 'number', p_r.number, 'status', p_r.status, 'store_id', p_r.store_id,
    'store_name', (select name from stores where id = p_r.store_id),
    'visit_date', p_r.visit_date, 'hold_until', p_r.hold_until, 'customer_id', p_r.customer_id, 'restocked', p_r.restocked,
    'created_at', p_r.created_at, 'updated_at', p_r.updated_at, 'closed_at', p_r.closed_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', t.sku_id, 'sku_code', k.code, 'product_name', p.name, 'sku_name', k.name,
                                                           'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = p_r.id))
  || case when p_pii then jsonb_build_object('customer', jsonb_build_object('email', p_r.customer_email, 'name', p_r.customer_name, 'phone', p_r.customer_phone, 'note', p_r.note))
          else '{}'::jsonb end;
$$;

create or replace function api_tryon_requests_list(p_token_hash text, p_status text default null, p_store_id uuid default null,
                                                   p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer; v_total integer; v_items jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  select count(*) into v_total from tryon_requests r
   where r.shop_id = v_tok.shop_id and (p_status is null or r.status = p_status) and (p_store_id is null or r.store_id = p_store_id);
  select coalesce(jsonb_agg(api_tryon_json(r, v_pii) order by r.created_at desc), '[]'::jsonb) into v_items
    from (select * from tryon_requests r
           where r.shop_id = v_tok.shop_id and (p_status is null or r.status = p_status) and (p_store_id is null or r.store_id = p_store_id)
           order by r.created_at desc limit v_limit offset greatest(0, coalesce(p_offset, 0))) r;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', greatest(0, coalesce(p_offset, 0)), 'pii', v_pii);
end;
$$;

create or replace function api_tryon_request_get(p_token_hash text, p_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  return api_tryon_json(v_r, 'orders:pii' = any(v_tok.scopes));
end;
$$;

create or replace function api_tryon_request_update(p_token_hash text, p_number integer, p_status text, p_hold_until date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  if p_status not in ('sent', 'ready', 'purchased', 'not_purchased', 'cancelled') then raise exception 'invalid_status'; end if;
  v_r := banto_tryon_transition(v_tok.shop_id, v_r.id, p_status, p_hold_until);
  return api_tryon_json(v_r, 'orders:pii' = any(v_tok.scopes));
end;
$$;

-- 終わった申し込み（購入なし・期限切れ・取り消し）の在庫を EC に戻す。2 回目は何もしない（restocked: true のまま）
create or replace function api_tryon_request_restock(p_token_hash text, p_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype; v_n integer;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  v_n := banto_tryon_restock(v_tok.shop_id, v_r.id);
  select * into v_r from tryon_requests where id = v_r.id;
  return api_tryon_json(v_r, 'orders:pii' = any(v_tok.scopes)) || jsonb_build_object('restocked_skus', v_n);
end;
$$;

create or replace function api_stores_list(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'shop:read');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name, 'postal_code', st.postal_code, 'address', st.address, 'phone', st.phone,
                                                       'hours', st.hours, 'special_days', st.special_days, 'note', st.note, 'active', st.active,
                                                       'tryon', ss.tryon, 'sort_order', ss.sort_order)
                                    order by ss.sort_order, st.sort_order, st.name), '[]'::jsonb)
            from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = v_tok.shop_id);
end;
$$;

-- ---------- 会員（service_role。世代を確かめる） ----------
-- 自分の申し込み（新しい順に 50 件）。世代が合わなければ null
create or replace function member_tryon_requests(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_tryon_requests: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'number', r.number, 'status', r.status, 'store_id', r.store_id, 'store_name', st.name, 'visit_date', r.visit_date, 'hold_until', r.hold_until,
            'created_at', r.created_at,
            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', t.qty) order by t.id), '[]'::jsonb)
                        from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = r.id))
          order by r.created_at desc), '[]'::jsonb)
            from (select * from tryon_requests where shop_id = p_shop_id and customer_id = p_customer_id order by created_at desc limit 50) r
            join stores st on st.id = r.store_id);
end;
$$;

-- 自分の申し込みを取り消す（取り置きが終わる前: 申し込み・発送済み・取り置き中）。戻り値: { ok } | { ok: false, reason: session | not_found | not_cancellable }
-- 在庫は今までどおり、ショップの担当者が「EC の在庫に戻す」を押したときに戻る（商品が店舗に向かっていることがあるため）
create or replace function member_tryon_cancel(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_tryon_cancel: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  select * into v_r from tryon_requests where shop_id = p_shop_id and customer_id = p_customer_id and number = p_number for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_r.status not in ('requested', 'sent', 'ready') then return jsonb_build_object('ok', false, 'reason', 'not_cancellable'); end if;
  perform banto_tryon_transition(p_shop_id, v_r.id, 'cancelled', null);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function banto_token_issuer_ok(uuid, uuid) from public, anon, authenticated;
revoke execute on function api_require(text, text) from public, anon, authenticated;
grant execute on function api_require(text, text) to service_role;
revoke execute on function api_has_scope(text, text) from public, anon, authenticated;
grant execute on function api_has_scope(text, text) to service_role;
revoke execute on function api_token_shop(text) from public, anon, authenticated;
grant execute on function api_token_shop(text) to service_role;
revoke execute on function banto_tryon_transition(uuid, uuid, text, date) from public, anon, authenticated, service_role;
revoke execute on function tryon_update(uuid, uuid, text, date) from public, anon;
grant execute on function tryon_update(uuid, uuid, text, date) to authenticated;
revoke execute on function api_tryon_json(tryon_requests, boolean) from public, anon, authenticated, service_role;
revoke execute on function api_tryon_requests_list(text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function api_tryon_requests_list(text, text, uuid, integer, integer) to service_role;
revoke execute on function api_tryon_request_get(text, integer) from public, anon, authenticated;
grant execute on function api_tryon_request_get(text, integer) to service_role;
revoke execute on function api_tryon_request_update(text, integer, text, date) from public, anon, authenticated;
grant execute on function api_tryon_request_update(text, integer, text, date) to service_role;
revoke execute on function banto_tryon_restock(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function tryon_restock(uuid, uuid) from public, anon;
grant execute on function tryon_restock(uuid, uuid) to authenticated;
revoke execute on function api_tryon_request_restock(text, integer) from public, anon, authenticated;
grant execute on function api_tryon_request_restock(text, integer) to service_role;
revoke execute on function api_stores_list(text) from public, anon, authenticated;
grant execute on function api_stores_list(text) to service_role;
revoke execute on function member_tryon_requests(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function member_tryon_requests(uuid, uuid, integer) to service_role;
revoke execute on function member_tryon_cancel(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function member_tryon_cancel(uuid, uuid, integer, integer) to service_role;

insert into banto_migrations (version) values ('0026_tryon_api');
