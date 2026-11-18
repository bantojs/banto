-- 0152_tryon_reminder: お店で試着の来店期限の前日のお知らせ（同梱モジュール store_tryon、docs/store-tryon.md「前日のお知らせ」）
--   - ショップの設定 store_tryon.reminder_hour（0〜23、ショップの時間帯の時刻。無ければ送らない = 既定 OFF）
--   - 取り置き中（ready）で、取り置きの期限が明日の申し込みに 1 回だけ。送るのは設定の時刻から 3 時間のあいだだけ（遅れて夜中に届かないように）。取り置きを始めてから 24 時間たっていないもの
--     （ご用意のお知らせが届いたばかり）には送らない
--   - 送るのは同梱のメール・LINE（hooks の tryon.updated に reminder: true、状態は ready のまま）。Banto は送った印（reminded_at）だけを残す
--   - 取り置きを始めた時刻は ready_at（状態が ready になったときにトリガーが入れる。0152 より前の取り置きは空 = 十分に前とみなす）

alter table tryon_requests add column if not exists ready_at timestamptz;
alter table tryon_requests add column if not exists reminded_at timestamptz;
create index if not exists tryon_requests_remind_due on tryon_requests (hold_until) where status = 'ready' and reminded_at is null;

create or replace function banto_tryon_ready_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    new.ready_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function banto_tryon_ready_at() from public, anon, authenticated;
drop trigger if exists tryon_requests_ready_at on tryon_requests;
create trigger tryon_requests_ready_at before insert or update of status on tryon_requests for each row execute function banto_tryon_ready_at();

-- 期限が明日の取り置きに前日のお知らせを積む（Cron。p_today・p_hour はショップの時間帯の今日と今の時刻、Worker が渡す）。積んだ数を返す
create or replace function tryon_remind(p_today date, p_hour integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_n integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_remind: service_role only' using errcode = '42501';
  end if;
  if p_today is null or p_hour is null or p_hour < 0 or p_hour > 23 then return 0; end if;
  for v_r in
    update tryon_requests r set reminded_at = now()
      from shops s
     where s.id = r.shop_id
       and s.settings->'modules'->'store_tryon' = 'true'::jsonb
       and jsonb_typeof(s.settings->'store_tryon'->'reminder_hour') = 'number'
       and (s.settings->'store_tryon'->>'reminder_hour') ~ '^([0-9]|1[0-9]|2[0-3])$'
       and p_hour between (s.settings->'store_tryon'->>'reminder_hour')::integer and (s.settings->'store_tryon'->>'reminder_hour')::integer + 2
       and r.status = 'ready'
       and r.hold_until = p_today + 1
       and r.reminded_at is null
       and coalesce(r.ready_at, '-infinity'::timestamptz) <= now() - interval '24 hours'
    returning r.*
  loop
    perform banto_enqueue_tryon_hook(v_r.shop_id, 'tryon.updated',
      jsonb_build_object('request_id', v_r.id, 'number', v_r.number, 'shop_id', v_r.shop_id, 'store_id', v_r.store_id, 'status', v_r.status,
                         'hold_until', v_r.hold_until, 'customer_id', v_r.customer_id, 'reminder', true));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function tryon_remind(date, integer) from public, anon, authenticated;
grant execute on function tryon_remind(date, integer) to service_role;

insert into banto_migrations (version) values ('0152_tryon_reminder');
