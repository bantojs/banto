-- 0160_cron_resilience: Cron の配信を、途中で終わっても回り続けないようにする。前方専用。
--   - claim_hook_deliveries（0088 を差し替え）: 取り出したまま終わらなかった配信（回数が 5 に達した pending）は取り出さずに failed にする
--   - cron_settings: Cron が 1 回の実行の通信の予算を決めるための設定（workers_plan）。service_role だけ（src/jobs/budget.ts）
--   - release_hook_deliveries: 取り出したが通信の残りに入らず送らなかった配信を、回数を戻して返す。service_role だけ

create or replace function claim_hook_deliveries(p_limit integer default 50)
returns table (
  id uuid, shop_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer,
  url text, settings jsonb, created_at timestamptz, secret_box text
)
language plpgsql
security definer
set search_path = public
as $$
declare v_limit integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'claim_hook_deliveries: service_role only' using errcode = '42501';
  end if;
  v_limit := greatest(1, least(p_limit, case when banto_workers_plan() = 'paid' then 500 else 12 end));
  -- 取り出したまま終わらなかった配信（Cron の実行が通信の上限などで途中で終わった）を、回数で打ち切る。
  -- 失敗の判定（attempts >= 5）は finish_hook_delivery にしか無いので、取り出すたびに回数だけ増えていつまでも pending のままになっていた
  update hook_deliveries d
     set status = 'failed',
         last_error = 'interrupted: the cron run ended before this delivery finished (' || d.attempts || ' attempts)'
   where d.status = 'pending' and d.attempts >= 5 and d.next_attempt_at <= now();
  return query
  with picked as (
    select d.id from hook_deliveries d
      join hook_endpoints e on e.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and e.enabled
     order by d.next_attempt_at
     limit v_limit
     for update of d skip locked
  ),
  leased as (
    update hook_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from picked
     where d.id = picked.id
    returning d.id, d.shop_id, d.endpoint_id, d.event, d.payload, d.attempts, d.created_at
  )
  select l.id, l.shop_id, l.endpoint_id, l.event, l.payload, l.attempts, e.url, e.settings, l.created_at, c.secret_box
    from leased l join hook_endpoints e on e.id = l.endpoint_id
    left join app_connections c on c.endpoint_id = l.endpoint_id;
end;
$$;

create or replace function cron_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'cron_settings: service_role only' using errcode = '42501';
  end if;
  return jsonb_build_object('workers_plan', banto_workers_plan());
end;
$$;
revoke execute on function cron_settings() from public, anon, authenticated;
grant execute on function cron_settings() to service_role;

-- 取り出したが、その回の通信の残りに入らず送らなかった配信を返す（回数を戻し、すぐ取り出せるように）。service_role だけ
create or replace function release_hook_deliveries(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'release_hook_deliveries: service_role only' using errcode = '42501';
  end if;
  update hook_deliveries
     set attempts = greatest(0, attempts - 1), next_attempt_at = now()
   where id = any(coalesce(p_ids, '{}')) and status = 'pending';
end;
$$;
revoke execute on function release_hook_deliveries(uuid[]) from public, anon, authenticated;
grant execute on function release_hook_deliveries(uuid[]) to service_role;

insert into banto_migrations (version) values ('0160_cron_resilience');
