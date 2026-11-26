-- 0182: お支払いのお願いを外部プラグインが送るための口（メンテナの決定 2026-11-26、docs/ai-access.md「お支払いのお願い」）。
--   注文のメールを外部プラグインに任せたショップ（メール通知の skip_orders）では、hooks checkout.payment_pending（0181）を受けても
--   宛先と中身を読む口が無く、お支払いのお願いを送れなかった。AI 用 API に、予約 1 件分の中身を返す口を足す。
--   - スコープは orders:read。宛先・お名前（予約に一時保持した連絡先）は orders:contact か orders:pii があるときだけ（0173 と同じ線）
--   - 返すのはまだ払える予約だけ（確定・解放・期限切れは not_found）。品目・数・単価・合計・期限
--   - お支払いに進むリンク（payment_link）は Worker が署名して足す（同梱プラグインと同じ券）。宛先を返すとき（orders:contact）だけ
--     （リンクはお客様に渡すもので、開くと「お支払いに進む・取りやめる」ができるため。宛先の無い連携には渡さない）

create or replace function api_reservation_payment_reminder(p_token_hash text, p_reservation_id uuid)
returns jsonb
language plpgsql
-- volatile（既定）: api_require がトークンの最終利用時刻を書くので、stable にすると PostgREST の読み取り専用の取引で落ちる（0093）
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r reservations%rowtype; v_s shops%rowtype; v_contact boolean;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  select * into v_r from reservations where id = p_reservation_id and shop_id = v_tok.shop_id;
  if not found or v_r.status <> 'pending' or v_r.payment_session is null or v_r.expires_at <= now()
     or exists (select 1 from orders o where o.reservation_id = v_r.id) then
    raise exception 'not_found';
  end if;
  select * into v_s from shops where id = v_tok.shop_id;
  v_contact := banto_order_pii(v_tok.scopes, 'contact');
  return jsonb_build_object(
    'reservation_id', v_r.id, 'shop_id', v_r.shop_id, 'customer_id', v_r.customer_id,
    'created_at', v_r.created_at, 'expires_at', v_r.expires_at, 'total_jpy', banto_reservation_total(v_r),
    'payment_method', v_r.payment_method,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('product_name', pr.name, 'sku_name', k.name, 'sku_code', k.code,
                                                           'qty', (i->>'qty')::integer, 'unit_price_jpy', (i->>'unit_price_jpy')::integer)), '[]'::jsonb)
                from jsonb_array_elements(v_r.items) i left join skus k on k.id = (i->>'sku_id')::uuid left join products pr on pr.id = k.product_id),
    'shop', jsonb_build_object('slug', v_s.slug, 'domain', v_s.domain))
    || case when v_contact then jsonb_build_object('email', nullif(v_r.customer->>'customer_email', ''), 'name', nullif(v_r.customer->>'customer_name', '')) else '{}'::jsonb end;
end;
$$;
revoke execute on function api_reservation_payment_reminder(text, uuid) from public, anon, authenticated;
grant execute on function api_reservation_payment_reminder(text, uuid) to service_role;

insert into banto_migrations (version) values ('0182_api_payment_reminder');
