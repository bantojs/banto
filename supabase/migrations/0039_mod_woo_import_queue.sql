-- Banto 0039_mod_woo_import_queue: 同梱モジュール woo_import の「画像を裏で取り込む」。docs/woo-import.md
-- 前方専用。ブラウザで画像の URL の一覧を予約し、Cron（src/modules/woo-import/job.ts）が少しずつ取得 → ストレージ → 商品に紐づける。
-- ページを閉じても進む。1 回に進める枚数はデプロイの設定（0038 の workers_plan）で決める: free 12 枚 / paid 150 枚。
--
-- 予約に置くのは公開の画像の URL だけ（WooCommerce の API キーは置かない。CLAUDE.md §1-5）。
-- 状態: pending（待ち）→ running（取り出し済み。10 分のリース。切れたらまた取り出す）→ done / failed（理由は last_error）。
-- 一時的な失敗（つながらない・429・5xx・保存の失敗）は 3 回までやり直す（10 分・20 分あけて）。

create table image_import_jobs (
  id bigint generated always as identity primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  url text not null check (url ~ '^https?://' and length(url) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or last_error ~ '^[a-z0-9_]{1,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, url)
);
create index image_import_jobs_due on image_import_jobs (next_attempt_at, id) where status in ('pending', 'running');
create index on image_import_jobs (shop_id, status);
create trigger image_import_jobs_updated_at before update on image_import_jobs for each row execute function banto_set_updated_at();

alter table image_import_jobs enable row level security;
-- 読めるのは商品を扱う人だけ（書き込みは下の関数だけ）
create policy image_import_jobs_catalog_select on image_import_jobs for select using (banto_shop_perm(shop_id, 'catalog'));

-- 1 回に進める枚数（無料プランは 1 回の Cron の通信が 50 回まで: 1 枚で取得と保存の 2 回、ほかのジョブの分を残す）
create or replace function banto_image_import_batch()
returns integer language sql stable security definer set search_path = public as $$
  select case banto_workers_plan() when 'paid' then 150 else 12 end;
$$;
revoke execute on function banto_image_import_batch() from public, anon, authenticated;

-- ---------- 管理画面（authenticated、catalog の項目） ----------
-- p_items: [{ slug, urls: [{ url, tag }] }]（1 回 100 商品・1 商品 50 枚まで）。tag は Worker が URL から作る置き場所のキーの目印（/wc-<hash>.）。
-- 商品の画像にその目印のキーが既にあれば取り込み済みとして飛ばす。予約の取り込み済み（done）はそのまま、失敗（failed）は待ちに戻す。
-- Banto に無い商品は missing に数える
create or replace function image_import_enqueue(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_item jsonb; v_u jsonb; v_pid uuid; v_url text; v_tag text; v_n integer := 0; v_skipped integer := 0; v_missing integer := 0; v_hit integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then raise exception 'invalid_items'; end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item->'urls') <> 'array' or jsonb_array_length(v_item->'urls') > 50 then raise exception 'invalid_items'; end if;
    select id into v_pid from products where shop_id = p_shop_id and slug = v_item->>'slug';
    if v_pid is null then v_missing := v_missing + 1; continue; end if;
    for v_u in select e from jsonb_array_elements(v_item->'urls') e loop
      v_url := v_u->>'url';
      v_tag := v_u->>'tag';
      if v_url is null or v_url !~ '^https?://' or length(v_url) > 2000 or v_tag is null or v_tag !~ '^/wc-[0-9a-z]{1,13}\.$' then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if exists (select 1 from product_images where product_id = v_pid and position(v_tag in storage_key) > 0) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      insert into image_import_jobs (shop_id, product_id, url) values (p_shop_id, v_pid, v_url)
      on conflict (product_id, url) do update set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
        where image_import_jobs.status = 'failed';
      get diagnostics v_hit = row_count;
      if v_hit > 0 then v_n := v_n + 1; else v_skipped := v_skipped + 1; end if;
    end loop;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skipped, 'missing', v_missing);
end;
$$;

-- 進み具合と、取り込めなかった画像（新しい順に 2,000 件まで）
create or replace function image_import_summary(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when banto_shop_perm(p_shop_id, 'catalog') then jsonb_build_object(
    'pending', (select count(*) from image_import_jobs where shop_id = p_shop_id and status = 'pending'),
    'running', (select count(*) from image_import_jobs where shop_id = p_shop_id and status = 'running'),
    'done', (select count(*) from image_import_jobs where shop_id = p_shop_id and status = 'done'),
    'failed', (select count(*) from image_import_jobs where shop_id = p_shop_id and status = 'failed'),
    'last_done_at', (select max(updated_at) from image_import_jobs where shop_id = p_shop_id and status = 'done'),
    'batch', banto_image_import_batch(),
    'plan', banto_workers_plan(),
    'failures', (select coalesce(jsonb_agg(jsonb_build_object('slug', p.slug, 'url', j.url, 'code', j.last_error) order by j.updated_at desc), '[]'::jsonb)
                   from (select * from image_import_jobs where shop_id = p_shop_id and status = 'failed' order by updated_at desc limit 2000) j
                   join products p on p.id = j.product_id)
  ) end;
$$;

-- 待ちと失敗を消す（取り出し中のものはそのまま終わる）。取り込み済みの記録は残す（次に予約したとき飛ばすため）
create or replace function image_import_cancel(p_shop_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  delete from image_import_jobs where shop_id = p_shop_id and status in ('pending', 'failed');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 失敗したものを待ちに戻す
create or replace function image_import_retry(p_shop_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  update image_import_jobs set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where shop_id = p_shop_id and status = 'failed';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------- Cron（service_role） ----------
-- 期限の来た待ちと、リースの切れた取り出し中を、決まった枚数だけ取り出す
create or replace function image_import_claim()
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
     limit banto_image_import_batch()
     for update of j skip locked
  )
  update image_import_jobs j
     set status = 'running', attempts = j.attempts + 1, next_attempt_at = now() + interval '10 minutes'
    from picked where j.id = picked.id
  returning j.id, j.shop_id, j.product_id, j.url;
end;
$$;

-- 結果を書く: [{ id, storage_key }] か [{ id, error }]。成功は商品の画像の末尾に足す（同じキーが既にあれば足さない）
create or replace function image_import_finish(p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r jsonb; v_j image_import_jobs%rowtype; v_key text; v_err text; v_done integer := 0; v_failed integer := 0; v_retry integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'image_import_finish: service_role only' using errcode = '42501';
  end if;
  for v_r in select e from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e loop
    select * into v_j from image_import_jobs where id = (v_r->>'id')::bigint and status = 'running' for update;
    if not found then continue; end if;
    v_key := v_r->>'storage_key';
    -- 置き場所はこのショップのこの商品の下だけ（違えば登録しない）
    if v_key is not null and left(v_key, length('shops/' || v_j.shop_id || '/products/' || v_j.product_id || '/wc-')) <> 'shops/' || v_j.shop_id || '/products/' || v_j.product_id || '/wc-' then
      v_key := null;
      v_r := v_r || '{"error":"invalid_storage_key"}'::jsonb;
    end if;
    if v_key is not null then
      if exists (select 1 from products where id = v_j.product_id)
         and not exists (select 1 from product_images where product_id = v_j.product_id and storage_key = v_key) then
        insert into product_images (shop_id, product_id, storage_key, sort_order)
        values (v_j.shop_id, v_j.product_id, v_key, (select coalesce(max(sort_order), -1) + 1 from product_images where product_id = v_j.product_id));
      end if;
      update image_import_jobs set status = 'done', last_error = null where id = v_j.id;
      v_done := v_done + 1;
    else
      v_err := coalesce(nullif(v_r->>'error', ''), 'error');
      if v_err !~ '^[a-z0-9_]{1,40}$' then v_err := 'error'; end if;
      if v_j.attempts < 3 and (v_err in ('fetch_failed', 'storage', 'http_429', 'http_408') or v_err ~ '^http_5') then
        update image_import_jobs set status = 'pending', last_error = v_err, next_attempt_at = now() + make_interval(mins => 10 * v_j.attempts) where id = v_j.id;
        v_retry := v_retry + 1;
      else
        update image_import_jobs set status = 'failed', last_error = v_err where id = v_j.id;
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('done', v_done, 'retry', v_retry, 'failed', v_failed);
end;
$$;

revoke execute on function image_import_enqueue(uuid, jsonb) from public, anon;
revoke execute on function image_import_summary(uuid) from public, anon;
revoke execute on function image_import_cancel(uuid) from public, anon;
revoke execute on function image_import_retry(uuid) from public, anon;
grant execute on function image_import_enqueue(uuid, jsonb) to authenticated, service_role;
grant execute on function image_import_summary(uuid) to authenticated, service_role;
grant execute on function image_import_cancel(uuid) to authenticated, service_role;
grant execute on function image_import_retry(uuid) to authenticated, service_role;
revoke execute on function image_import_claim() from public, anon, authenticated;
revoke execute on function image_import_finish(jsonb) from public, anon, authenticated;
grant execute on function image_import_claim() to service_role;
grant execute on function image_import_finish(jsonb) to service_role;

insert into banto_migrations (version) values ('0039_mod_woo_import_queue');
