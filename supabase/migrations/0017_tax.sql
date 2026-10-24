-- 0017_tax: 軽減税率（8%）とインボイスの領収書（docs/tax.md、docs/knowledge/02-decisions.md 2026-10-17）
--
-- - 価格はすべて税込のまま（総額表示）。税率は商品ごとの区分 products.tax_class（standard / reduced / exempt）で決める（人間の決定）。
--   税率の数値はショップの設定（settings.tax_rate = 標準・既定 10、settings.tax_rate_reduced = 軽減・既定 8）。exempt は 0%（非課税・不課税）。
-- - 注文を確定した時点の税率を残す（後で区分や設定を変えても、過去の注文の領収書は変わらない）:
--     order_items.tax_rate … 明細ごとの税率（トリガーで商品の区分から入れる）
--     orders.shipping_tax_rate … 送料の税率（標準税率）
--     orders.tax_rounding … 消費税額の端数の扱い（floor / round / ceil、ショップの設定 settings.tax_rounding、既定 floor）
--   確定の関数（confirm_reservation など）は触らない。どの経路（Webhook・0 円・復元）で入っても同じトリガーが入れる。
-- - 税率ごとの対象額と消費税額の計算は src/commerce/tax.ts だけ（インボイスの決まり: 税率ごとに 1 回だけ端数を処理する）。
-- - 0017 を適用する前の注文は税率が null。読む側は標準税率として扱う。

alter table products add column if not exists tax_class text not null default 'standard';
alter table products drop constraint if exists products_tax_class_check;
alter table products add constraint products_tax_class_check check (tax_class in ('standard', 'reduced', 'exempt'));

alter table order_items add column if not exists tax_rate numeric(5,2) check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));
alter table orders add column if not exists shipping_tax_rate numeric(5,2) check (shipping_tax_rate is null or (shipping_tax_rate >= 0 and shipping_tax_rate <= 100));
alter table orders add column if not exists tax_rounding text check (tax_rounding is null or tax_rounding in ('floor', 'round', 'ceil'));

-- ショップの設定から税率を読む（数値でなければ既定）
create or replace function banto_shop_tax_rate(p_settings jsonb, p_class text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case p_class
    when 'exempt' then 0::numeric
    when 'reduced' then case when coalesce(p_settings->>'tax_rate_reduced', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (p_settings->>'tax_rate_reduced')::numeric else 8 end
    else case when coalesce(p_settings->>'tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (p_settings->>'tax_rate')::numeric else 10 end
  end;
$$;

create or replace function banto_order_items_tax()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tax_rate is null then
    select banto_shop_tax_rate(s.settings, p.tax_class) into new.tax_rate
      from skus k join products p on p.id = k.product_id join shops s on s.id = k.shop_id
     where k.id = new.sku_id;
  end if;
  return new;
end;
$$;

create or replace function banto_orders_tax()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_settings jsonb;
begin
  select settings into v_settings from shops where id = new.shop_id;
  if new.shipping_tax_rate is null then new.shipping_tax_rate := banto_shop_tax_rate(v_settings, 'standard'); end if;
  if new.tax_rounding is null then
    new.tax_rounding := case when v_settings->>'tax_rounding' in ('floor', 'round', 'ceil') then v_settings->>'tax_rounding' else 'floor' end;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_tax on order_items;
create trigger order_items_tax before insert on order_items for each row execute function banto_order_items_tax();
drop trigger if exists orders_tax on orders;
create trigger orders_tax before insert on orders for each row execute function banto_orders_tax();

revoke execute on function banto_shop_tax_rate(jsonb, text) from public, anon, authenticated;
revoke execute on function banto_order_items_tax() from public, anon, authenticated;
revoke execute on function banto_orders_tax() from public, anon, authenticated;

-- 購入者向けの注文照会（0010 を差し替え: 領収書のために税率・端数の扱い・注文の id を足す。住所は返さない）
create or replace function lookup_order(p_shop_id uuid, p_number integer, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                            'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy, 'discount_jpy', o.discount_jpy,
                            'shipping_tax_rate', o.shipping_tax_rate, 'tax_rounding', o.tax_rounding, 'payment_provider', o.payment_provider,
                            'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                            from jsonb_array_elements(coalesce(o.discounts, '[]'::jsonb)) d),
                            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                        from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o join shops s on s.id = o.shop_id
   where o.shop_id = p_shop_id and o.number = p_number and s.published
     and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_email))
   limit 1;
$$;

-- 会員の注文 1 件（会員ページの領収書。lookup_order と同じ形）。世代が合わなければ null
create or replace function member_order(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_number integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_order: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return (
    select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'shipped_at', o.shipped_at,
                              'total_jpy', o.total_jpy, 'shipping_jpy', o.shipping_jpy, 'discount_jpy', o.discount_jpy,
                              'shipping_tax_rate', o.shipping_tax_rate, 'tax_rounding', o.tax_rounding, 'payment_provider', o.payment_provider,
                              'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                                              from jsonb_array_elements(coalesce(o.discounts, '[]'::jsonb)) d),
                              'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                                          from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
      from orders o
     where o.shop_id = p_shop_id and o.customer_id = p_customer_id and o.number = p_number);
end;
$$;

revoke execute on function lookup_order(uuid, integer, text) from public;
grant execute on function lookup_order(uuid, integer, text) to anon, authenticated, service_role;
revoke execute on function member_order(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function member_order(uuid, uuid, integer, integer) to service_role;

-- バックアップからの復元の後で、税の区分と注文の税率を戻す（restore_shop_data・restore_catalog は 0017 の列を知らない）。
-- 復元は空のショップにだけ入るので、ここで触るのは復元したばかりの行だけ。商品は slug、注文は注文番号で突き合わせる。
-- 明細の税率は、戻した商品の区分とショップの設定から入れ直す（書き出しの時点の明細の税率とは、区分を後で変えていれば違うことがある）。
create or replace function restore_tax(p_shop_id uuid, p_products jsonb, p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_p integer := 0; v_o integer := 0; v_row jsonb; v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_tax: service_role only' using errcode = '42501';
  end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) e loop
    if v_row->>'tax_class' in ('standard', 'reduced', 'exempt') then
      update products set tax_class = v_row->>'tax_class' where shop_id = p_shop_id and slug = v_row->>'slug';
      get diagnostics v_n = row_count; v_p := v_p + v_n;
    end if;
  end loop;
  update order_items oi set tax_rate = banto_shop_tax_rate(s.settings, p.tax_class)
    from skus k join products p on p.id = k.product_id join shops s on s.id = k.shop_id
   where oi.shop_id = p_shop_id and k.id = oi.sku_id;
  for v_row in select e from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) e loop
    if v_row ? 'number' and (v_row->>'number') ~ '^[0-9]+$' then
      update orders set
        shipping_tax_rate = coalesce(case when coalesce(v_row->>'shipping_tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (v_row->>'shipping_tax_rate')::numeric end, shipping_tax_rate),
        tax_rounding = coalesce(case when v_row->>'tax_rounding' in ('floor', 'round', 'ceil') then v_row->>'tax_rounding' end, tax_rounding)
       where shop_id = p_shop_id and number = (v_row->>'number')::integer;
      get diagnostics v_n = row_count; v_o := v_o + v_n;
    end if;
  end loop;
  return jsonb_build_object('tax_classes', v_p, 'order_tax', v_o);
end;
$$;

revoke execute on function restore_tax(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function restore_tax(uuid, jsonb, jsonb) to service_role;

insert into banto_migrations (version) values ('0017_tax');
