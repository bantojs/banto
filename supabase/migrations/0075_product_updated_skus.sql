-- Banto 0075_product_updated_skus: SKU・在庫・商品の画像を変えたときも product.updated を積む（docs/hooks.md）。前方専用。
-- これまで product.updated は商品を保存したとき（管理画面・AI 用 API の商品の作成と更新・一括取り込み）だけだった。
-- 連携サイト（WordPress など）が商品をキャッシュしていると、SKU の価格・在庫・画像だけを変えても知らせが届かず、表示が古いまま残る。
--   - skus・product_images の追加・変更・削除: トリガーで product.updated を積む（だれが変えても。管理画面・AI 用 API・取り込み・復元）
--   - 在庫（inventory.available）: 人が変えたとき（運営者の JWT か AI 用トークン）と、「ゼロ ⇄ あり」が切り替わったとき
--     （購入で売り切れた・期限切れの予約が戻って再入荷した）。購入で数が減っただけでは積まない（注文のたびに積むと多すぎる）
--   - inventory.low のペイロードに product_id を足す（今までの項目はそのまま。連携サイトが SKU から商品を引き直さなくてよいように）
--   - まだ送っていない同じ商品の product.updated が送信先にあれば、新しく積まない（まとめて変えても 1 商品 1 通。enqueue_hook も同じ）
--   - ペイロードは今までと同じ形（product_id・shop_id・slug・name・published）。商品が消えていれば積まない

-- まだ送っていない product.updated を商品ごとに探す
create index if not exists hook_deliveries_pending_product on hook_deliveries (endpoint_id, (payload->>'product_id'))
  where status = 'pending' and attempts = 0 and event = 'product.updated';

-- 商品の product.updated を積む（中だけで使う。まだ送っていないものがある送信先には積まない）
create or replace function banto_enqueue_product_updated(p_shop_id uuid, p_product_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_p products%rowtype; v_count integer;
begin
  select * into v_p from products where id = p_product_id and shop_id = p_shop_id;
  if v_p.id is null then return 0; end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, 'product.updated',
         jsonb_build_object('product_id', v_p.id, 'shop_id', v_p.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and 'product.updated' = any(e.events)
     and not exists (
       select 1 from hook_deliveries d
        where d.endpoint_id = e.id and d.status = 'pending' and d.attempts = 0 and d.event = 'product.updated'
          and d.payload->>'product_id' = v_p.id::text);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function banto_enqueue_product_updated(uuid, uuid) from public, anon, authenticated;

-- enqueue_hook（0028 を差し替え）: product.updated だけ、まだ送っていない同じ商品のものがある送信先には積まない。判定は変えない
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_perm text; v_product uuid;
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
  end if;
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
revoke execute on function enqueue_hook(uuid, text, jsonb) from public, anon;
grant execute on function enqueue_hook(uuid, text, jsonb) to authenticated, service_role;

-- SKU・商品の画像: 行が変わったら、その商品の product.updated
create or replace function banto_product_child_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_row record;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  perform banto_enqueue_product_updated(v_row.shop_id, v_row.product_id);
  -- SKU を別の商品へ移した（ふつうは無いが）: 前の商品にも
  if tg_op = 'UPDATE' and old.product_id is distinct from new.product_id then
    perform banto_enqueue_product_updated(old.shop_id, old.product_id);
  end if;
  return null;
end;
$$;
revoke execute on function banto_product_child_changed() from public, anon, authenticated;

drop trigger if exists skus_product_updated on skus;
create trigger skus_product_updated after insert or update or delete on skus
  for each row execute function banto_product_child_changed();
drop trigger if exists product_images_product_updated on product_images;
create trigger product_images_product_updated after insert or update or delete on product_images
  for each row execute function banto_product_child_changed();

-- 在庫: 人が変えたとき（運営者・スタッフの JWT、AI 用トークン）と、ゼロ ⇄ あり が切り替わったとき（だれが変えても）
create or replace function banto_inventory_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_k skus%rowtype;
begin
  if new.available is not distinct from old.available then return null; end if;
  if auth.role() is distinct from 'authenticated' and coalesce(current_setting('banto.actor', true), '') not like 'api_token:%'
     and (coalesce(old.available, 0) > 0) = (coalesce(new.available, 0) > 0) then
    return null;
  end if;
  select * into v_k from skus where id = new.sku_id;
  if v_k.id is not null then perform banto_enqueue_product_updated(v_k.shop_id, v_k.product_id); end if;
  return null;
end;
$$;
revoke execute on function banto_inventory_changed() from public, anon, authenticated;

drop trigger if exists inventory_product_updated on inventory;
create trigger inventory_product_updated after update of available on inventory
  for each row execute function banto_inventory_changed();

insert into banto_migrations (version) values ('0075_product_updated_skus');
