-- Banto 0141_inventory_low_manual: 人が在庫を減らして閾値以下になったときも inventory.low を積む
-- 今までは注文の確定（confirm_reservation）だけが積んでいた。商品の画面（set_stock）・在庫の画面の出荷と棚卸し（stock_adjust / stock_count、0136）・
-- AI 用トークン・取り込みで在庫を減らしても届かず、在庫の少なさを見るプラグイン（発注・LINE の知らせなど）が気づけなかった。
--   - 人の操作（運営者・スタッフの JWT、AI 用トークン）で、閾値より多かった数が閾値以下になったとき（またいだとき）だけ積む。
--     閾値以下のまま数を直しただけでは積まない（棚卸しで 2 → 1 に合わせるたびに知らせない）
--   - 購入の予約・期限切れの解放・取り置き（service_role）は今までどおり積まない（注文の確定が積む）
--   - 閾値は今までと同じ shops.settings.low_stock_threshold（既定 3）。ペイロードも同じ形（shop_id・sku_id・product_id・available・threshold）
--   - product.updated（0075）は今までどおり。人の操作では product.updated と inventory.low の両方が届く
--   - 配信を積むところを 1 つにする: 役割を確かめない内部の関数 banto_enqueue_hook_internal（だれにも EXECUTE させない）に切り出し、
--     enqueue_hook（呼び手の役割と項目を確かめてから）とトリガーの両方から呼ぶ。enqueue_hook のふるまいは変えない
-- 配信を積む（役割・項目は確かめない。呼ぶのは enqueue_hook と DB のトリガーだけ）
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
          and d.payload->>'product_id' = p_payload->>'product_id'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function banto_enqueue_hook_internal(uuid, text, jsonb) from public, anon, authenticated, service_role;

-- enqueue_hook（0129 を差し替え）: 確かめ方は同じ。積むのは内部の関数
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
    -- ペイロードの id（uuid の形のもの）はそのショップの行だけ（別のショップの商品・無い注文で受け手を動かさない）
    if (p_payload->>'order_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from orders o where o.shop_id = p_shop_id and o.id::text = p_payload->>'order_id') then
      raise exception 'invalid_payload' using detail = 'order_id';
    end if;
    if (p_payload->>'product_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from products p where p.shop_id = p_shop_id and p.id::text = p_payload->>'product_id') then
      raise exception 'invalid_payload' using detail = 'product_id';
    end if;
    if (p_payload->>'customer_id') ~ '^[0-9a-f-]{36}$' and not exists (select 1 from customers c where c.shop_id = p_shop_id and c.id::text = p_payload->>'customer_id') then
      raise exception 'invalid_payload' using detail = 'customer_id';
    end if;
  end if;
  return banto_enqueue_hook_internal(p_shop_id, p_event, p_payload);
end;
$$;

create or replace function banto_inventory_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_k skus%rowtype;
  v_human boolean;
  v_threshold integer;
begin
  if new.available is not distinct from old.available then return null; end if;
  -- auth.role() は JWT が無ければ null（is not distinct from で false にそろえる）
  v_human := auth.role() is not distinct from 'authenticated' or coalesce(current_setting('banto.actor', true), '') like 'api_token:%';
  if not v_human and (coalesce(old.available, 0) > 0) = (coalesce(new.available, 0) > 0) then
    return null;
  end if;
  select * into v_k from skus where id = new.sku_id;
  if v_k.id is null then return null; end if;
  perform banto_enqueue_product_updated(v_k.shop_id, v_k.product_id);
  if v_human then
    select coalesce(case when s.settings->>'low_stock_threshold' ~ '^\d{1,9}$' then (s.settings->>'low_stock_threshold')::integer end, 3)
      into v_threshold from shops s where s.id = v_k.shop_id;
    if coalesce(old.available, 0) > v_threshold and coalesce(new.available, 0) <= v_threshold then
      -- enqueue_hook は JWT からの inventory.low を断る（呼び手が出来事を作れないように）ので、確かめた後の内部の関数を直接呼ぶ
      perform banto_enqueue_hook_internal(v_k.shop_id, 'inventory.low',
        jsonb_build_object('shop_id', v_k.shop_id, 'sku_id', v_k.id, 'available', coalesce(new.available, 0), 'threshold', v_threshold));
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function banto_inventory_changed() from public, anon, authenticated;

insert into banto_migrations (version) values ('0141_inventory_low_manual');
