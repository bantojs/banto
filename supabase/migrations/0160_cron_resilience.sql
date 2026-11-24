-- 0160_cron_resilience: Cron の配信を、途中で終わっても回り続けないようにする。前方専用。
--   - claim_hook_deliveries（0088 を差し替え）: 取り出したまま終わらなかった配信（回数が 5 に達した pending）は取り出さずに failed にする
--   - cron_settings: Cron が 1 回の実行の通信の予算を決めるための設定（workers_plan）。service_role だけ（src/jobs/budget.ts）
--   - image_import_claim（0039 を差し替え）: その回に進められる数（p_limit）だけ取り出す
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

-- 画像の取り込みの取り出し（0039 を差し替え: その回に進められる数 p_limit を受ける。null なら今までどおりプランの数）。
-- 取り出すと貸し出しの回数が進むので、Cron は通信の残りに入る数だけ取り出す（入らない分を取り出して回数だけ進めない）
drop function if exists image_import_claim();
create or replace function image_import_claim(p_limit integer default null)
returns table (id bigint, shop_id uuid, product_id uuid, url text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'image_import_claim: service_role only' using errcode = '42501';
  end if;
  return query
  with picked as (
    select j.id from image_import_jobs j
      join shops s on s.id = j.shop_id
     where j.status in ('pending', 'running') and j.next_attempt_at <= now()
       -- モジュールを OFF にしたショップの予約は進めない（ON に戻せば続きから）
       and s.settings->'modules'->'woo_import' = 'true'::jsonb
     order by j.next_attempt_at, j.id
     limit least(banto_image_import_batch(), greatest(0, coalesce(p_limit, banto_image_import_batch())))
     for update of j skip locked
  )
  update image_import_jobs j
     set status = 'running', attempts = j.attempts + 1, next_attempt_at = now() + interval '10 minutes'
    from picked where j.id = picked.id
  returning j.id, j.shop_id, j.product_id, j.url;
end;
$$;
revoke execute on function image_import_claim(integer) from public, anon, authenticated;
grant execute on function image_import_claim(integer) to service_role;

insert into banto_migrations (version) values ('0160_cron_resilience');
