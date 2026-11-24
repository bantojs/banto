-- 0159_member_address_from_order: 会員の注文のお届け先を、会員の既定の住所（customers.default_address）に写す。前方専用。
--   - 既定の住所がまだ無い会員: 注文が確定したときに、その注文のお届け先をそのまま入れる（初回の注文の後、次から入力しなくてよい）
--   - 既定の住所がある会員: レジで「この住所を次回も使う」を選んだとき（予約の購入者情報の save_address = true）だけ上書きする
--   - ゲストの注文・予約の無い注文（復元 restore_shop_data など）は何もしない。氏名が空の会員には注文の氏名も入れる
--   - 予約したときのログインの世代（予約の購入者情報の address_epoch）が会員の今の世代と同じときだけ（すべての端末からログアウトした後に
--     確定した注文では写さない。コンビニ払いなど確定まで日が空く支払いのため）
--   - 個人情報のマスク（mask_customer）は会員の既定の住所と氏名も消す（自動で写すようになったので、注文と一緒に消す。0133 を差し替え）
--   形は会員ページの保存（member_save_address）と同じ: name・phone・postal_code・country・state・city・line1・line2

create or replace function banto_orders_member_address_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_save boolean; v_epoch text; v_addr jsonb;
begin
  if new.customer_id is null or new.reservation_id is null or jsonb_typeof(new.shipping_address) <> 'object' then
    return null;
  end if;
  select coalesce(r.customer->>'save_address', '') = 'true', r.customer->>'address_epoch' into v_save, v_epoch
    from reservations r where r.id = new.reservation_id;
  if v_epoch is null or v_epoch !~ '^-?[0-9]{1,9}$' then return null; end if;
  -- 知っている鍵だけ（文字か null）。都道府県は注文の確定までに確かめてある
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_addr
    from jsonb_each(new.shipping_address) e(k, v)
   where k in ('name', 'phone', 'postal_code', 'country', 'state', 'city', 'line1', 'line2')
     and jsonb_typeof(v) in ('string', 'null');
  if v_addr = '{}'::jsonb then return null; end if;
  update customers
     set default_address = v_addr,
         name = coalesce(nullif(btrim(coalesce(name, '')), ''), nullif(left(btrim(coalesce(new.customer_name, '')), 200), ''))
   where shop_id = new.shop_id and id = new.customer_id and session_epoch = v_epoch::integer
     and (default_address is null or jsonb_typeof(default_address) <> 'object' or default_address = '{}'::jsonb or coalesce(v_save, false));
  return null;
end;
$$;
revoke execute on function banto_orders_member_address_after() from public, anon, authenticated;
drop trigger if exists orders_member_address_after on orders;
create trigger orders_member_address_after after insert on orders for each row execute function banto_orders_member_address_after();

-- 個人情報のマスク（0133 を差し替え: 会員の既定の住所と氏名も消す）
create or replace function mask_customer(p_shop_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer; v_tryon integer; v_inq integer;
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
  update inquiry_messages m set body = '[masked]'
    from inquiries i
   where m.inquiry_id = i.id and i.shop_id = p_shop_id and lower(i.contact_email) = lower(btrim(p_email));
  delete from inquiry_attachments a using inquiries i
   where a.inquiry_id = i.id and i.shop_id = p_shop_id and lower(i.contact_email) = lower(btrim(p_email));
  update inquiries
     set contact_email = null, contact_name = '[masked]', ip_hash = null, masked_at = now(), updated_at = now(),
         status = 'closed', closed_at = coalesce(closed_at, now())
   where shop_id = p_shop_id and lower(contact_email) = lower(btrim(p_email));
  get diagnostics v_inq = row_count;
  update customers set note = null where shop_id = p_shop_id and lower(email) = lower(btrim(p_email)) and note is not null;
  -- 0159: 注文から写した既定の住所と氏名も消す（会員の行そのものは残す。退会は行の削除）
  update customers set default_address = null, name = null
   where shop_id = p_shop_id and lower(email) = lower(btrim(p_email)) and (default_address is not null or name is not null);
  -- 誰が・いつ・何件を。アドレスはハッシュの先頭だけ（0051 と同じ）
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'customer.masked', 'customer', banto_audit_email_hash(p_email),
                      jsonb_build_object('email_hash', banto_audit_email_hash(p_email), 'orders', v_count, 'tryon_requests', v_tryon, 'inquiries', v_inq));
  return v_count + v_tryon + v_inq;
end;
$$;

insert into banto_migrations (version) values ('0159_member_address_from_order');
