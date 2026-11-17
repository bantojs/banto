-- 0151_tryon_extend: お店で試着の取り置きの期限を、会員が自分で延ばす（同梱モジュール store_tryon、docs/store-tryon.md「取り置きの延長」）
--   - ショップの設定 store_tryon.extend_max（延ばせる回数、既定 0 = 延ばせない）・extend_days（1 回に延ばす日数、既定 3）
--   - 延ばせるのは店舗に届いた（ready）申し込みで、取り置きの期限が今日か先のものだけ。回数は tryon_requests.extend_count に数える
--   - 新しい期限は今の期限から extend_days 日後。店舗の休みの日（曜日の営業時間・臨時休業）なら次の営業日へ
--     （管理画面の既定値の holdUntil、src/modules/store-tryon/index.ts と同じ決まり。決めるのは DB）
--   - 延ばしたら hooks の tryon.updated（status は ready のまま、extended: true と前の期限）。同梱のメール・LINE がお客様とお店に知らせる
--   - 会員の申し込みの一覧（member_tryon_requests）に extend_count を足す

alter table tryon_requests add column if not exists extend_count integer not null default 0;
alter table tryon_requests drop constraint if exists tryon_requests_extend_count_check;
alter table tryon_requests add constraint tryon_requests_extend_count_check check (extend_count between 0 and 20);

-- その日かそれより後の最初の営業日（60 日先までに無ければ null）。臨時休業・臨時営業が曜日の営業時間より優先
create or replace function banto_store_next_open_day(p_store_id uuid, p_from date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_hours jsonb; v_special jsonb; v_d date; v_sp jsonb;
begin
  select hours, special_days into v_hours, v_special from stores where id = p_store_id;
  if not found then return null; end if;
  for i in 0..60 loop
    v_d := p_from + i;
    select e into v_sp from jsonb_array_elements(coalesce(v_special, '[]'::jsonb)) e where e->>'date' = to_char(v_d, 'YYYY-MM-DD') limit 1;
    if v_sp is not null then
      if not coalesce((v_sp->>'closed')::boolean, false)
         and jsonb_typeof(v_sp->'hours') = 'array' and jsonb_array_length(v_sp->'hours') > 0 then
        return v_d;
      end if;
    elsif jsonb_typeof(v_hours->(extract(dow from v_d)::integer::text)) = 'array'
          and jsonb_array_length(v_hours->(extract(dow from v_d)::integer::text)) > 0 then
      return v_d;
    end if;
    v_sp := null;
  end loop;
  return null;
end;
$$;
revoke execute on function banto_store_next_open_day(uuid, date) from public, anon, authenticated, service_role;

-- 会員が取り置きを延ばす。p_today はショップの時間帯の今日（tryon_expire と同じく Worker が渡す）。
-- 返り値: { ok: true, hold_until, extend_count } か { ok: false, reason: session | not_found | not_extendable | limit }
create or replace function member_tryon_extend(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_number integer, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r tryon_requests%rowtype;
  v_max integer;
  v_days integer;
  v_prev date;
  v_until date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_tryon_extend: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  select * into v_r from tryon_requests where shop_id = p_shop_id and customer_id = p_customer_id and number = p_number for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_r.status <> 'ready' or v_r.hold_until is null or p_today is null or v_r.hold_until < p_today then
    return jsonb_build_object('ok', false, 'reason', 'not_extendable');
  end if;
  v_max := least(banto_shop_limit(p_shop_id, 'store_tryon', 'extend_max', 0), 5);
  v_days := least(greatest(banto_shop_limit(p_shop_id, 'store_tryon', 'extend_days', 3), 1), 30);
  if v_r.extend_count >= v_max then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  v_prev := v_r.hold_until;
  v_until := coalesce(banto_store_next_open_day(v_r.store_id, v_prev + v_days), v_prev + v_days);
  update tryon_requests set hold_until = v_until, extend_count = extend_count + 1, updated_at = now()
   where id = v_r.id returning * into v_r;
  perform banto_enqueue_tryon_hook(p_shop_id, 'tryon.updated',
    jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', p_shop_id, 'store_id', v_r.store_id, 'status', v_r.status,
                       'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id,
                       'extended', true, 'previous_hold_until', v_prev, 'extend_count', v_r.extend_count));
  return jsonb_build_object('ok', true, 'hold_until', v_r.hold_until, 'extend_count', v_r.extend_count);
end;
$$;
revoke execute on function member_tryon_extend(uuid, uuid, integer, integer, date) from public, anon, authenticated;
grant execute on function member_tryon_extend(uuid, uuid, integer, integer, date) to service_role;

-- 会員の申し込みの一覧（0026 と同じ。extend_count を足す）
create or replace function member_tryon_requests(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_tryon_requests: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'number', r.number, 'status', r.status, 'store_id', r.store_id, 'store_name', st.name, 'visit_date', r.visit_date, 'hold_until', r.hold_until,
            'created_at', r.created_at, 'extend_count', r.extend_count,
            'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', t.qty) order by t.id), '[]'::jsonb)
                        from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = r.id))
          order by r.created_at desc), '[]'::jsonb)
            from (select * from tryon_requests where shop_id = p_shop_id and customer_id = p_customer_id order by created_at desc limit 50) r
            join stores st on st.id = r.store_id);
end;
$$;
revoke execute on function member_tryon_requests(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function member_tryon_requests(uuid, uuid, integer) to service_role;

insert into banto_migrations (version) values ('0151_tryon_extend');
