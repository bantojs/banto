-- 0159_member_address_from_order: 会員の注文のお届け先を、会員の既定の住所（customers.default_address）に写す。前方専用。
--   - 既定の住所がまだ無い会員: 注文が確定したときに、その注文のお届け先をそのまま入れる（初回の注文の後、次から入力しなくてよい）
--   - 既定の住所がある会員: レジで「この住所を次回も使う」を選んだとき（予約の購入者情報の save_address = true）だけ上書きする
--   - ゲストの注文・予約の無い注文（復元 restore_shop_data など）は何もしない。氏名が空の会員には注文の氏名も入れる
--   形は会員ページの保存（member_save_address）と同じ: name・phone・postal_code・country・state・city・line1・line2

create or replace function banto_orders_member_address_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_save boolean; v_addr jsonb;
begin
  if new.customer_id is null or new.reservation_id is null or jsonb_typeof(new.shipping_address) <> 'object' then
    return null;
  end if;
  select coalesce(r.customer->>'save_address', '') = 'true' into v_save from reservations r where r.id = new.reservation_id;
  -- 知っている鍵だけ（文字か null）。都道府県は注文の確定までに確かめてある
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_addr
    from jsonb_each(new.shipping_address) e(k, v)
   where k in ('name', 'phone', 'postal_code', 'country', 'state', 'city', 'line1', 'line2')
     and jsonb_typeof(v) in ('string', 'null');
  if v_addr = '{}'::jsonb then return null; end if;
  update customers
     set default_address = v_addr,
         name = coalesce(nullif(btrim(coalesce(name, '')), ''), nullif(left(btrim(coalesce(new.customer_name, '')), 200), ''))
   where shop_id = new.shop_id and id = new.customer_id
     and (default_address is null or jsonb_typeof(default_address) <> 'object' or default_address = '{}'::jsonb or coalesce(v_save, false));
  return null;
end;
$$;
revoke execute on function banto_orders_member_address_after() from public, anon, authenticated;
drop trigger if exists orders_member_address_after on orders;
create trigger orders_member_address_after after insert on orders for each row execute function banto_orders_member_address_after();

insert into banto_migrations (version) values ('0159_member_address_from_order');
