-- Banto 0011_customer_import: 会員の一括取り込み（WooCommerce からの移行。docs/members.md）
-- 前方専用。
--
-- 会員 = Supabase Auth のユーザー + ショップごとの customers 行（0004）。取り込みは管理画面のインポーターが行う:
--   1. banto_users_by_email で、メールアドレスがすでに Auth にあるかを引く
--   2. 無ければ Auth の管理 API でユーザーを作る（パスワードなし、メール確認済み。会員はメールでのログインか再設定でパスワードを決める）
--   3. import_customers で customers 行を作る / 足りない項目だけ埋める（会員が自分で入れた値は上書きしない）
-- どちらも service_role だけ。呼び出し側（管理画面）が owner の JWT でショップの所有を確かめてから呼ぶ（restore_shop_data と同じ）。
-- パスワード（WordPress のハッシュ）は扱わない（形式が Supabase と合わず、Banto に機微な情報を持たないため）。

create or replace function banto_users_by_email(p_emails text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'banto_users_by_email: service_role only' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(lower(u.email), u.id), '{}'::jsonb) into v_out
    from auth.users u
   where lower(u.email) = any (select lower(btrim(x)) from unnest(coalesce(p_emails, '{}'::text[])) x limit 100);
  return v_out;
end;
$$;

-- p_rows: [{ user_id, email, name, default_address }]（最大 100 件）
create or replace function import_customers(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_exists boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'import_customers: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 100 then raise exception 'too_many_rows'; end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e loop
    if not exists (select 1 from auth.users where id = (v_row->>'user_id')::uuid) then raise exception 'user_not_found' using detail = coalesce(v_row->>'email', ''); end if;
    select exists (select 1 from customers where shop_id = p_shop_id and id = (v_row->>'user_id')::uuid) into v_exists;
    insert into customers (id, shop_id, email, name, default_address)
    values ((v_row->>'user_id')::uuid, p_shop_id, nullif(left(btrim(coalesce(v_row->>'email', '')), 200), ''),
            nullif(left(btrim(coalesce(v_row->>'name', '')), 200), ''),
            case when jsonb_typeof(v_row->'default_address') = 'object' then v_row->'default_address' end)
    on conflict (shop_id, id) do update
       set email = coalesce(customers.email, excluded.email),
           name = coalesce(customers.name, excluded.name),
           default_address = coalesce(customers.default_address, excluded.default_address);
    if v_exists then v_updated := v_updated + 1; else v_created := v_created + 1; end if;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

revoke execute on function banto_users_by_email(text[]) from public, anon, authenticated;
revoke execute on function import_customers(uuid, jsonb) from public, anon, authenticated;
grant execute on function banto_users_by_email(text[]) to service_role;
grant execute on function import_customers(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0011_customer_import');
