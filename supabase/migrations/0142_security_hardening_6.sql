-- Banto 0142_security_hardening_6: 守りの締め直し 6
-- 前方専用。
--
-- 1. hooks の送信先の URL: 権限の部分（ホストとポート）に使える文字を絞る。
--    今までの検査は正規表現でホストを取り出していたが、URL パーサー（Worker が実際に送るときの読み方）は
--    バックスラッシュを区切りに読み、全角の数字・% の符号化・途中のタブを直してから読むので、DB とは別のホストになる書き方があった。
--    つないだ連携（0088）の「送信先のホストは変えられない」も同じ取り出し方に頼っていた。
--    ホストは ASCII の名前か [IPv6] だけ、利用者情報（user@）・空白・制御文字・バックスラッシュは受けない。国際化ドメインは punycode（xn--）で書く。
-- 2. 送信先を足したときも監査ログに残す（今までは変更と削除だけ。出来事を別のホストへ流す行を足しても残らなかった）。
-- 3. shops.settings.low_stock_threshold は 0 以上の整数だけ（数でない値が入ると、注文の確定の最後で型の誤りになり、確定が全部戻る）。
-- 4. inventory.low は、同じ送信先・同じ SKU の未配信があれば積まない（product.updated と同じ。入出庫をくり返して通知を積み上げられないように）。
-- 5. enqueue_hook のペイロードの id の確かめを、大文字の UUID にも（今までは小文字のときだけ確かめていた）。
-- 6. checkout_status: 返金して済んだ予約（0128 の refunded）は、完了画面には今までどおり released で返す（「成立しなかった・返金される」の文面）。

-- ---------- 1. hooks の送信先の URL ----------
create or replace function banto_hook_url_shape_ok(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url is not null
     and length(p_url) <= 2000
     and p_url !~ '[[:space:][:cntrl:]\\]'
     and lower(substring(p_url from '^https?://([^/?#]*)')) ~ '^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.?)(:[0-9]{1,5})?$';
$$;
revoke execute on function banto_hook_url_shape_ok(text) from public, anon, authenticated;

create or replace function banto_hook_endpoints_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.url is null or new.url !~ '^https?://' then raise exception 'invalid_url'; end if;
  if new.url like 'https://banto.invalid/%' then
    -- 外部の送信先として登録した行を同梱の内部 URL に書き換えることは運営者にはさせない（0031 の守りの抜け）
    if tg_op = 'UPDATE' and old.url not like 'https://banto.invalid/%' and auth.role() is distinct from 'service_role' then
      raise exception 'invalid_url';
    end if;
    return new;
  end if;
  -- URL の形（足すとき・URL を変えるときだけ。前からある行のほかの列の更新は止めない）
  if (tg_op = 'INSERT' or new.url is distinct from old.url) and not banto_hook_url_shape_ok(new.url) then
    raise exception 'invalid_url';
  end if;
  if banto_hook_url_private(new.url) then raise exception 'invalid_url'; end if;
  -- つないだ連携（0088）の送信先のホストは変えられない（前の相手に渡したトークンとシークレットが残るため。つなぎ直すか外す）
  if tg_op = 'UPDATE' and auth.role() is distinct from 'service_role'
     and banto_hook_host(new.url) is distinct from banto_hook_host(old.url)
     and exists (select 1 from app_connections where endpoint_id = old.id) then
    raise exception 'app_connected_url_locked' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_hook_endpoints_guard() from public, anon, authenticated;

-- ---------- 2. 送信先を足したときの監査 ----------
create or replace function banto_audit_hook_endpoints()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_detail jsonb := '{}'::jsonb; v_changed boolean := false;
begin
  if tg_op = 'DELETE' then
    perform banto_audit(banto_shop_org(old.shop_id), old.shop_id, 'hook_endpoint.deleted', 'hook_endpoint', old.id::text,
                        jsonb_build_object('name', left(old.name, 100), 'host', banto_hook_host(old.url)));
    return old;
  end if;
  if tg_op = 'INSERT' then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'hook_endpoint.created', 'hook_endpoint', new.id::text,
                        jsonb_build_object('name', left(new.name, 100), 'host', banto_hook_host(new.url), 'enabled', new.enabled, 'events', to_jsonb(new.events)));
    return new;
  end if;
  if new.url is distinct from old.url then
    v_detail := v_detail || jsonb_build_object('host_from', banto_hook_host(old.url), 'host_to', banto_hook_host(new.url));
    v_changed := true;
  end if;
  if new.enabled is distinct from old.enabled then
    v_detail := v_detail || jsonb_build_object('enabled', new.enabled);
    v_changed := true;
  end if;
  if new.events is distinct from old.events then
    v_detail := v_detail || jsonb_build_object('events', to_jsonb(new.events));
    v_changed := true;
  end if;
  -- マニフェストの取り直し（Cron、service_role）はログにしない。運営者が差し替えたときだけ
  if new.manifest is distinct from old.manifest and auth.role() is distinct from 'service_role' then
    v_detail := v_detail || jsonb_build_object('manifest', true);
    v_changed := true;
  end if;
  if v_changed then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'hook_endpoint.changed', 'hook_endpoint', new.id::text,
                        jsonb_build_object('name', left(new.name, 100)) || v_detail);
  end if;
  return new;
end;
$$;
revoke execute on function banto_audit_hook_endpoints() from public, anon, authenticated;
drop trigger if exists hook_endpoints_audit on hook_endpoints;
create trigger hook_endpoints_audit after insert or update of url, enabled, events, manifest or delete on hook_endpoints
  for each row execute function banto_audit_hook_endpoints();

-- ---------- 3. 在庫僅少の閾値 ----------
-- 前からある誤った値は外す（既定の 3 になる）
update shops set settings = settings - 'low_stock_threshold'
 where settings ? 'low_stock_threshold' and coalesce(settings->>'low_stock_threshold', '') !~ '^\d{1,9}$';
alter table shops drop constraint if exists shops_low_stock_threshold;
alter table shops add constraint shops_low_stock_threshold
  check (not (settings ? 'low_stock_threshold') or coalesce(settings->>'low_stock_threshold', '') ~ '^\d{1,9}$');

-- ---------- 4. inventory.low の重複 ----------
create or replace function banto_enqueue_hook_internal(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_product uuid;
begin
  -- inventory.low に商品の id を足す（SKU から引く。足せなければそのまま）
  if p_event = 'inventory.low' and coalesce(p_payload, '{}'::jsonb) ? 'sku_id' and not (p_payload ? 'product_id') then
    select k.product_id into v_product from skus k where k.shop_id = p_shop_id and k.id::text = p_payload->>'sku_id';
    if v_product is not null then p_payload := p_payload || jsonb_build_object('product_id', v_product); end if;
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events)
     and not (p_event = 'product.updated' and coalesce(p_payload, '{}'::jsonb) ? 'product_id' and exists (
       select 1 from hook_deliveries d
        where d.endpoint_id = e.id and d.status = 'pending' and d.attempts = 0 and d.event = 'product.updated'
          and d.payload->>'product_id' = p_payload->>'product_id'))
     and not (p_event = 'inventory.low' and coalesce(p_payload, '{}'::jsonb) ? 'sku_id' and exists (
       select 1 from hook_deliveries d
        where d.endpoint_id = e.id and d.status = 'pending' and d.attempts = 0 and d.event = 'inventory.low'
          and d.payload->>'sku_id' = p_payload->>'sku_id'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function banto_enqueue_hook_internal(uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ---------- 5. enqueue_hook の id の確かめ ----------
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_perm text;
begin
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  if auth.role() is distinct from 'service_role' then
    v_perm := case p_event when 'product.updated' then 'catalog' when 'order.shipped' then 'orders' end;
    if v_perm is null then
      raise exception 'event_not_permitted' using errcode = '42501';
    end if;
    if not banto_shop_perm(p_shop_id, v_perm) then
      raise exception 'shop_not_found' using errcode = '42501';
    end if;
    -- ペイロードの id（uuid の形のもの。大文字でも）はそのショップの行だけ（別のショップの商品・無い注文で受け手を動かさない）
    if lower(p_payload->>'order_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from orders o where o.shop_id = p_shop_id and o.id::text = lower(p_payload->>'order_id')) then
      raise exception 'invalid_payload' using detail = 'order_id';
    end if;
    if lower(p_payload->>'product_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from products p where p.shop_id = p_shop_id and p.id::text = lower(p_payload->>'product_id')) then
      raise exception 'invalid_payload' using detail = 'product_id';
    end if;
    if lower(p_payload->>'customer_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from customers c where c.shop_id = p_shop_id and c.id::text = lower(p_payload->>'customer_id')) then
      raise exception 'invalid_payload' using detail = 'customer_id';
    end if;
  end if;
  return banto_enqueue_hook_internal(p_shop_id, p_event, p_payload);
end;
$$;

-- ---------- 6. 完了画面の照会 ----------
create or replace function checkout_status(p_shop_id uuid, p_quote_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r reservations%rowtype; v_o orders%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'checkout_status: service_role only' using errcode = '42501';
  end if;
  select * into v_r from reservations where shop_id = p_shop_id and quote_id = p_quote_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('status', 'not_found', 'order', null, 'expires_at', null); end if;
  select * into v_o from orders where reservation_id = v_r.id;
  if found then
    return jsonb_build_object('status', 'confirmed', 'expires_at', v_r.expires_at,
      'order', jsonb_build_object('number', v_o.number, 'status', v_o.status, 'total_jpy', v_o.total_jpy, 'payment_provider', v_o.payment_provider, 'created_at', v_o.created_at));
  end if;
  -- 返金して済んだ予約は、購入者には「成立しなかった」（released）と同じ
  return jsonb_build_object('status', case when v_r.status::text = 'refunded' then 'released' else v_r.status::text end, 'order', null, 'expires_at', v_r.expires_at);
end;
$$;
revoke execute on function checkout_status(uuid, text) from public, anon, authenticated;
grant execute on function checkout_status(uuid, text) to service_role;

insert into banto_migrations (version) values ('0142_security_hardening_6');
