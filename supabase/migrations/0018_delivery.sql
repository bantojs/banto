-- 0018_delivery: 注文の「配送の指定」（汎用の器。docs/delivery-time.md）
--
-- orders.delivery jsonb … 配送の指定（同梱モジュール delivery_time が { date: 'YYYY-MM-DD' | null, slot: 'am' | '14-16' | … | null } を入れる）。
-- チェックアウトは予約の customer（attach_reservation_customer、0012）に delivery を載せ、注文を入れるときにトリガーで写す。
-- 確定の関数（confirm_reservation）は触らない。個人情報ではないのでマスキングの対象にしない。

alter table orders add column if not exists delivery jsonb check (delivery is null or jsonb_typeof(delivery) = 'object');

create or replace function banto_orders_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery is null and new.reservation_id is not null then
    select case when jsonb_typeof(r.customer->'delivery') = 'object' then r.customer->'delivery' end into new.delivery
      from reservations r where r.id = new.reservation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_delivery on orders;
create trigger orders_delivery before insert on orders for each row execute function banto_orders_delivery();
revoke execute on function banto_orders_delivery() from public, anon, authenticated;

insert into banto_migrations (version) values ('0018_delivery');
