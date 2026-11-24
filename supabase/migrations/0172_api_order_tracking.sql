-- 0172: AI 用 API の注文に発送のお問い合わせ番号（メンテナの決定 2026-11-24）
-- 外部プラグインが発送のメールを送るとき、本文に運送会社とお問い合わせ番号を書けるようにする。
-- 番号は氏名・住所・連絡先ではないので orders:read で返す（orders:pii は求めない）。hooks のペイロードには載せない。
-- api_order_json は 0157 の定義に tracking を足しただけ（ほかは同じ）。

create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'total_jpy', p_order.total_jpy, 'shipping_jpy', p_order.shipping_jpy,
    'discount_jpy', p_order.discount_jpy,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_order.discounts, '[]'::jsonb)) d),
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref, 'customer_id', p_order.customer_id,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'payment_status', p_order.payment_status, 'paid_at', p_order.paid_at, 'cancel_reason', p_order.cancel_reason, 'fee_jpy', p_order.fee_jpy,
    -- 発送のお問い合わせ番号（0022）。個人情報ではないので orders:read で返す。運送会社の名前と照会ページの URL は Worker が足す
    'tracking', case when p_order.tracking_number is null then null
      else jsonb_build_object('carrier', coalesce(p_order.tracking_carrier, 'other'), 'number', p_order.tracking_number) end,
    'tags', to_jsonb(p_order.tags),
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  ) || case when p_pii then jsonb_build_object('note', p_order.note) else '{}'::jsonb end;
$$;

insert into banto_migrations (version) values ('0172_api_order_tracking');
