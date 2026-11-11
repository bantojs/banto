-- Banto 0141_inventory_low_manual: 人が在庫を減らして閾値以下になったときも inventory.low を積む
-- 今までは注文の確定（confirm_reservation）だけが積んでいた。商品の画面（set_stock）・在庫の画面の出荷と棚卸し（stock_adjust / stock_count、0136）・
-- AI 用トークン・取り込みで在庫を減らしても届かず、在庫の少なさを見るプラグイン（発注・LINE の知らせなど）が気づけなかった。
--   - 人の操作（運営者・スタッフの JWT、AI 用トークン）で、閾値より多かった数が閾値以下になったとき（またいだとき）だけ積む。
--     閾値以下のまま数を直しただけでは積まない（棚卸しで 2 → 1 に合わせるたびに知らせない）
--   - 購入の予約・期限切れの解放・取り置き（service_role）は今までどおり積まない（注文の確定が積む）
--   - 閾値は今までと同じ shops.settings.low_stock_threshold（既定 3）。ペイロードも同じ形（shop_id・sku_id・product_id・available・threshold）
--   - product.updated（0075）は今までどおり。人の操作では product.updated と inventory.low の両方が届く
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
      -- enqueue_hook は JWT からの inventory.low を断る（呼び手が出来事を作れないように）ので、トリガーが同じ形で直接積む
      insert into hook_deliveries (shop_id, endpoint_id, event, payload)
      select e.shop_id, e.id, 'inventory.low',
             jsonb_build_object('shop_id', v_k.shop_id, 'sku_id', v_k.id, 'available', coalesce(new.available, 0), 'threshold', v_threshold, 'product_id', v_k.product_id)
        from hook_endpoints e
       where e.shop_id = v_k.shop_id and e.enabled and 'inventory.low' = any(e.events);
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function banto_inventory_changed() from public, anon, authenticated;

insert into banto_migrations (version) values ('0141_inventory_low_manual');
