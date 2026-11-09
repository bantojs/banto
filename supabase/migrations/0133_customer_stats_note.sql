-- Banto 0133_customer_stats_note: 会員の購入の集計の列と、会員の社内メモ（メンテナの決定 2026-11-08・2026-11-09、docs/knowledge/02-decisions.md）。前方専用。
--
-- 購入の集計（customers.orders_count / total_spent_jpy / last_order_at）:
--   一覧の表示・今後の絞り込みと並び替えのたびに注文から数えないため、会員の行に持つ。数えるのは支払い済み・発送済みの注文だけ
--   （キャンセル・返金は除く）。直すのは注文の表の文単位のトリガーだけ（確定・状態の変更・会員との結び付け・削除）で、Worker では数えない。
--   会員の行を作ったときも数える（復元・取り込みで注文が先に入っていても合うように）。個人情報のマスクでは数を残す（個人情報ではない）。
--   集計の列が変わっても updated_at は動かさない（会員の情報が変わったわけではないため）。customer.* の hooks は 0050 の列の許可リストで判定するので出ない。
-- 社内メモ（customers.note、2,000 字）:
--   注文のメモ（orders.note、0106）と同じ扱い。書くのは customer_set_note（項目 customers）だけ。hooks の列の許可リストには足さない。
--   退会（行の削除）で一緒に消え、個人情報のマスク（mask_customer）でも消す（メモに個人情報が入りうるため）。JSON の書き出しと復元に含める。

alter table customers
  add column if not exists orders_count integer not null default 0,
  add column if not exists total_spent_jpy bigint not null default 0,
  add column if not exists last_order_at timestamptz,
  add column if not exists note text check (note is null or char_length(note) <= 2000);
grant select (orders_count, total_spent_jpy, last_order_at, note) on customers to authenticated;

-- ---------- 集計 ----------
-- 渡した会員の集計を注文から数え直す（変わった行だけ書く）。トリガーとこのマイグレーションから呼ぶ
create or replace function banto_customer_stats_refresh(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update customers c
     set orders_count = s.n, total_spent_jpy = s.total, last_order_at = s.last
    from (select c2.id, count(o.id)::integer as n, coalesce(sum(o.total_jpy), 0)::bigint as total, max(o.created_at) as last
            from customers c2
            left join orders o on o.shop_id = c2.shop_id and o.customer_id = c2.id and o.status in ('paid', 'shipped')
           where c2.id = any(p_ids)
           group by c2.id) s
   where c.id = s.id
     and (c.orders_count, c.total_spent_jpy, c.last_order_at) is distinct from (s.n, s.total, s.last);
$$;
revoke execute on function banto_customer_stats_refresh(uuid[]) from public, anon, authenticated;

create or replace function banto_orders_customer_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct customer_id) into v_ids from new_rows where customer_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct customer_id) into v_ids from old_rows where customer_id is not null;
  else
    select array_agg(distinct x) into v_ids from (select customer_id as x from new_rows union select customer_id from old_rows) u where x is not null;
  end if;
  if v_ids is not null then perform banto_customer_stats_refresh(v_ids); end if;
  return null;
end;
$$;
revoke execute on function banto_orders_customer_stats() from public, anon, authenticated;

drop trigger if exists orders_customer_stats_insert on orders;
create trigger orders_customer_stats_insert after insert on orders referencing new table as new_rows
  for each statement execute function banto_orders_customer_stats();
drop trigger if exists orders_customer_stats_update on orders;
create trigger orders_customer_stats_update after update on orders referencing old table as old_rows new table as new_rows
  for each statement execute function banto_orders_customer_stats();
drop trigger if exists orders_customer_stats_delete on orders;
create trigger orders_customer_stats_delete after delete on orders referencing old table as old_rows
  for each statement execute function banto_orders_customer_stats();

-- 会員の行を作ったとき（復元・取り込みで、結び付く注文が先に入っている場合）
create or replace function banto_customers_stats_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_ids uuid[];
begin
  select array_agg(id) into v_ids from new_rows n
   where exists (select 1 from orders o where o.shop_id = n.shop_id and o.customer_id = n.id);
  if v_ids is not null then perform banto_customer_stats_refresh(v_ids); end if;
  return null;
end;
$$;
revoke execute on function banto_customers_stats_on_insert() from public, anon, authenticated;
drop trigger if exists customers_stats_insert on customers;
create trigger customers_stats_insert after insert on customers referencing new table as new_rows
  for each statement execute function banto_customers_stats_on_insert();

-- 集計の列だけが変わったときは updated_at を動かさない（0004 の banto_set_updated_at の代わり）
create or replace function banto_customers_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (to_jsonb(new) - array['orders_count', 'total_spent_jpy', 'last_order_at', 'updated_at'])
     is distinct from (to_jsonb(old) - array['orders_count', 'total_spent_jpy', 'last_order_at', 'updated_at']) then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function banto_customers_updated_at() from public, anon, authenticated;
drop trigger if exists customers_updated_at on customers;
create trigger customers_updated_at before update on customers for each row execute function banto_customers_updated_at();

-- 今ある注文から最初の値を埋める（注文のある会員だけ）
select banto_customer_stats_refresh(array_agg(distinct customer_id)) from orders where customer_id is not null;

-- ---------- 社内メモ ----------
create or replace function customer_set_note(p_shop_id uuid, p_customer_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_note text := nullif(btrim(replace(coalesce(p_note, ''), E'\r\n', E'\n')), '');
begin
  if not banto_shop_perm(p_shop_id, 'customers') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if v_note is not null and char_length(v_note) > 2000 then raise exception 'note_too_long' using errcode = '22023'; end if;
  update customers set note = v_note where shop_id = p_shop_id and id = p_customer_id;
  if not found then raise exception 'customer_not_found' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function customer_set_note(uuid, uuid, text) from public, anon;
grant execute on function customer_set_note(uuid, uuid, text) to authenticated;

-- 個人情報のマスク（0089 を差し替え: 同じショップ・同じアドレスの会員の社内メモも消す。購入の集計は残す）
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
  -- 誰が・いつ・何件を。アドレスはハッシュの先頭だけ（0051 と同じ）
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'customer.masked', 'customer', banto_audit_email_hash(p_email),
                      jsonb_build_object('email_hash', banto_audit_email_hash(p_email), 'orders', v_count, 'tryon_requests', v_tryon, 'inquiries', v_inq));
  return v_count + v_tryon + v_inq;
end;
$$;
revoke execute on function mask_customer(uuid, text) from public, anon;
grant execute on function mask_customer(uuid, text) to authenticated;

-- 復元（0050 を差し替え: 社内メモも戻す）
create or replace function restore_customer_master(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer := 0; v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb); v_ref jsonb; v_attrs jsonb; v_consent boolean; v_note text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_customer_master: service_role only' using errcode = '42501';
  end if;
  if jsonb_typeof(v_customers) <> 'array' then raise exception 'invalid_export'; end if;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    if jsonb_typeof(v_row) <> 'object' or (v_row->>'id') is null then continue; end if;
    v_ref := case when banto_external_ref_ok(v_row->'external_ref') then v_row->'external_ref' end;
    v_attrs := case when jsonb_typeof(v_row->'attributes') = 'object' then v_row->'attributes' else '{}'::jsonb end;
    v_consent := case when jsonb_typeof(v_row->'marketing_consent') = 'boolean' then (v_row->>'marketing_consent')::boolean end;
    v_note := case when jsonb_typeof(v_row->'note') = 'string' then nullif(left(btrim(v_row->>'note'), 2000), '') end;
    if v_ref is null and v_attrs = '{}'::jsonb and v_consent is null and v_note is null then continue; end if;
    begin
      update customers set external_ref = v_ref, attributes = v_attrs,
                           marketing_consent = v_consent,
                           marketing_consent_at = case when v_consent is null then null else coalesce((v_row->>'marketing_consent_at')::timestamptz, now()) end,
                           marketing_consent_source = case when v_consent is null then null when (v_row->>'marketing_consent_source') in ('checkout', 'account', 'import', 'api', 'admin') then v_row->>'marketing_consent_source' else 'import' end,
                           note = v_note
       where shop_id = p_shop_id and id = (v_row->>'id')::uuid;
      if found then v_n := v_n + 1; end if;
    exception when unique_violation or invalid_text_representation then
      null;
    end;
  end loop;
  return jsonb_build_object('customer_master', v_n);
end;
$$;
revoke execute on function restore_customer_master(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_customer_master(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0133_customer_stats_note');
