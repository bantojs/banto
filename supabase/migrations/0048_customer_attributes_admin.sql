-- Banto 0048_customer_attributes_admin: 運営者が管理画面で会員の独自項目（customers.attributes、0047）を直す（人間の決定 2026-10-23）。前方専用。
--
-- CRM を契約しない運営者は Banto 自身を顧客マスタとして使う。そのために「会員の項目を手で直せる・絞れる・CSV に書き出せる」
-- までを管理画面に置く（docs/knowledge/13-external-customer-master.md）。メール配信や営業の進捗のような CRM の機能はコアに入れない。
-- 絞り込みと CSV は読むだけ（owner の RLS の経路、0047 で列の権限を付けた）。書くのはこの関数だけ:
--   customer_set_attributes(shop, customer, values) … 項目 customers を持つ人。値の検査は 0047 の banto_customer_attributes と同じ
--   （定義に無い鍵は受け付けない。渡した鍵だけ重ね、null で消す）。customers への直接の UPDATE は引き続き誰にも許さない。
create or replace function customer_set_attributes(p_shop_id uuid, p_customer_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_c customers%rowtype; v_out jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if not found then raise exception 'customer_not_found'; end if;
  update customers set attributes = banto_customer_attributes_merge(p_shop_id, v_c.attributes, p_values)
   where shop_id = p_shop_id and id = p_customer_id
  returning attributes into v_out;
  return v_out;
end;
$$;
revoke execute on function customer_set_attributes(uuid, uuid, jsonb) from public, anon;
grant execute on function customer_set_attributes(uuid, uuid, jsonb) to authenticated, service_role;

insert into banto_migrations (version) values ('0048_customer_attributes_admin');
