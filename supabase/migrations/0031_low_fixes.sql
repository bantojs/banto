-- Banto 0031_low_fixes: セキュリティ監査（2026-10-18 のコード監査）§3 の Low のうち、v0.1.0 の前に直す分（人間の決定 2026-10-18「A を進める」）
-- 前方専用。
--
--  - cancel_order: WooCommerce から取り込んだ注文・復元した注文（予約が無い）をキャンセルしても在庫を戻さない（実際には動いていない在庫が増えていた）
--  - mask_shipped_orders: 発送済みだけでなく、キャンセル・返金済みの注文も同じ日数で個人情報を消す（180 日の約束を状態で欠かさない）
--  - mask_customer: 注文だけでなく、お店で試着の申し込みの氏名・電話・メモも消す（削除依頼の対応）
--  - shops: settings の項目のメンバーは slug / domain / order_seq / tryon_seq を変えられない（注文番号の巻き戻し・ドメインの付け替えは owner / admin だけ）
--  - member_set_email: 会員のメールアドレスの変更（= ログインの乗っ取りの入口）は組織の owner / admin だけ（0012 の形に戻す）
--  - hook_endpoints: 同梱プラグインの行（https://banto.invalid/plugins/<id>）はショップごとに 1 つ（重複すると注文メール・LINE 通知が二重に届く）

-- ---------- cancel_order（0010 を差し替え） ----------
create or replace function cancel_order(p_order_id uuid, p_shop_id uuid, p_refunded boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_item record; v_restock boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cancel_order: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_o.status in ('cancelled', 'refunded') then
    return jsonb_build_object('order_id', v_o.id, 'status', v_o.status, 'already', true);
  end if;
  if v_o.status <> 'paid' then raise exception 'not_cancellable' using detail = v_o.status::text; end if;
  -- 在庫を戻すのは Banto で予約して確定した注文だけ。取り込んだ注文（external_ref）と復元した注文（予約なし）は在庫を動かしていない
  v_restock := v_o.reservation_id is not null and v_o.external_ref is null;
  if v_restock then
    for v_item in select sku_id, qty from order_items where order_id = p_order_id and sku_id is not null loop
      update inventory set available = available + v_item.qty, updated_at = now()
       where sku_id = v_item.sku_id and shop_id = p_shop_id;
    end loop;
    perform banto_release_coupons(v_o.reservation_id);
  end if;
  update orders set status = case when p_refunded then 'refunded'::order_status else 'cancelled'::order_status end
   where id = p_order_id;
  perform enqueue_hook(p_shop_id, 'order.cancelled',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy,
                       'status', case when p_refunded then 'refunded' else 'cancelled' end, 'refunded', p_refunded, 'customer_id', v_o.customer_id,
                       'restocked', v_restock));
  return jsonb_build_object('order_id', v_o.id, 'status', case when p_refunded then 'refunded' else 'cancelled' end, 'already', false,
                            'restocked', v_restock, 'payment_provider', v_o.payment_provider, 'payment_ref', v_o.payment_ref);
end;
$$;

-- ---------- mask_shipped_orders（0001 を差し替え: キャンセル・返金済みも） ----------
create or replace function mask_shipped_orders(p_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_shipped_orders: service_role only' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where ((status = 'shipped' and shipped_at < now() - make_interval(days => p_days))
          or (status in ('cancelled', 'refunded') and updated_at < now() - make_interval(days => p_days)))
     and (customer_name is distinct from '[masked]' or customer_email is not null or shipping_address is not null);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- mask_customer（0024 を差し替え: 試着の申し込みも） ----------
create or replace function mask_customer(p_shop_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_tryon integer;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where shop_id = p_shop_id and lower(customer_email) = lower(btrim(p_email));
  get diagnostics v_count = row_count;
  update tryon_requests
     set customer_email = null, customer_name = '[masked]', customer_phone = null, note = null
   where shop_id = p_shop_id and lower(customer_email) = lower(btrim(p_email));
  get diagnostics v_tryon = row_count;
  return v_count + v_tryon;
end;
$$;

-- ---------- shops: 識別と連番は owner / admin だけ（0024 の banto_shops_guard を差し替え） ----------
create or replace function banto_shops_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.org_id is null and auth.uid() is not null then
      select m.org_id into new.org_id from org_members m join organizations o on o.id = m.org_id
       where m.user_id = auth.uid() and m.role in ('owner', 'admin') order by o.created_at limit 1;
    end if;
    if new.owner_id is not null and not exists (select 1 from owners where id = new.owner_id) then new.owner_id := null; end if;
    return new;
  end if;
  if auth.role() = 'authenticated' then
    if new.org_id is distinct from old.org_id and old.org_id is not null then raise exception 'org_immutable' using errcode = '42501'; end if;
    if new.owner_id is distinct from old.owner_id then raise exception 'owner_immutable' using errcode = '42501'; end if;
    if new.stripe_account_id is distinct from old.stripe_account_id and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
    -- スラッグ・独自ドメイン・注文番号と試着の連番は、settings の項目では変えられない（0031）
    if (new.slug is distinct from old.slug or new.domain is distinct from old.domain
        or new.order_seq is distinct from old.order_seq or new.tryon_seq is distinct from old.tryon_seq)
       and not banto_owns_shop(old.id) then
      raise exception 'admin_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- member_set_email（0024 を差し替え: owner / admin だけ） ----------
create or replace function member_set_email(p_shop_id uuid, p_customer_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_old text;
begin
  -- 会員のアドレスを書き換えられる人は、その会員としてログインできる。customers の項目ではなく組織の owner / admin に限る（0031）
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  select email into v_old from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if not found then raise exception 'customer_not_found'; end if;
  if exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_email and id <> p_customer_id) then
    raise exception 'email_taken';
  end if;
  update customers set email = v_email, session_epoch = session_epoch + 1 where shop_id = p_shop_id and id = p_customer_id;
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email in (lower(coalesce(v_old, '')), v_email) and consumed_at is null;
  return jsonb_build_object('old_email', v_old, 'new_email', v_email);
end;
$$;

-- ---------- hook_endpoints: 同梱プラグインの行はショップごとに 1 つ ----------
-- 既にある重複は、いちばん古い行を残して消す（配信の履歴は endpoint_id の cascade で一緒に消える）
delete from hook_endpoints e
 using hook_endpoints d
 where e.url like 'https://banto.invalid/plugins/%' and d.shop_id = e.shop_id and d.url = e.url and d.created_at < e.created_at;
create unique index if not exists hook_endpoints_bundled_unique on hook_endpoints (shop_id, url) where url like 'https://banto.invalid/plugins/%';

insert into banto_migrations (version) values ('0031_low_fixes');
