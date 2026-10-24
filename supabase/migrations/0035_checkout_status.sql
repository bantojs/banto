-- Banto 0035_checkout_status: 決済ページから戻った画面で「この注文は確定したか」を引く（外部レビューの指摘 2026-10-18）
-- 前方専用。
--
-- 注文の確定は Webhook のみ（CLAUDE.md §5）なので、戻り先の画面はそのままでは注文番号も確定したかも知らない。
-- Worker は確定の直前に quote の識別子（reservations.quote_id、0029）を署名した照会トークン（個人情報なし、24 時間）を出し、
-- 戻り先はそれでこの関数を呼ぶ（GET /api/shops/<slug>/checkout/status、同梱テーマの /checkout/done）。
-- 返すのは注文番号・状態・合計だけ。宛先や連絡先は返さない（それは注文照会 lookup_order の仕事）。

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
  return jsonb_build_object('status', v_r.status::text, 'order', null, 'expires_at', v_r.expires_at);
end;
$$;
revoke execute on function checkout_status(uuid, text) from public, anon, authenticated;
grant execute on function checkout_status(uuid, text) to service_role;

insert into banto_migrations (version) values ('0035_checkout_status');
