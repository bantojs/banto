-- Banto 0056_rate_limits_2: 2026-10-25 の監査で見つかった「回数・資源の上限の穴」を SQL で閉じる。前方専用。
--
--   1. 0 円の注文（payment_provider = 'free'）は決済ページを作らずにその場で確定するので、「未確定（pending）の予約の数」の上限に
--      一度も数えられなかった。同じ人・同じ IP の直近 1 時間の 0 円注文も数える（0029 の reserve_stock を差し替え）。
--   2. 会員ログインの照合: 「アドレスごと 1 日の失敗 50 回」が、誰が出したチャレンジかを問わず合計されていたため、
--      第三者が 10 枚のチャレンジを出して 5 回ずつ外すと本人のコードも expired になった。失敗は出した IP ごとに数え、
--      アドレス全体の上限は別に大きく取る（0029 の member_login_verify を差し替え）。
--   3. 運営者のログインと会員のパスワードのログインのロックが (アドレス) 単位で IP を見ないため、第三者が 5 回外すだけで
--      本人を 15 分締め出せた。「同じ IP から同じアドレスへ」を先に数え、アドレス単体の上限は大きく取る（0030 / 0016 を差し替え）。
--   4. hooks の配信が Workers のプラン（0038）を見ずに 1 回 50 件を並列に送るので、無料プランでは 1 回の実行の通信の上限に当たり、
--      同じ回の後続（個人情報のマスキング・heartbeat）が止まった。取り出す数を SQL でプランに合わせる（0002 を差し替え）。

-- ---------- 1. reserve_stock: 直近 1 時間の 0 円注文も数える ----------
create or replace function reserve_stock(p_shop_id uuid, p_items jsonb, p_ttl_seconds integer default 900,
                                         p_quote_id text default null, p_subject_hash text default null, p_ip_hash text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_sku_id uuid;
  v_qty integer;
  v_price integer;
  v_updated integer;
  v_items jsonb := '[]'::jsonb;
  v_reservation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'reserve_stock: service_role only' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_items';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_ttl';
  end if;

  -- 同じ quote で生きた予約があれば拒む（決済ページを開かずに在庫だけ押さえ続けるのを止める）
  if p_quote_id is not null and exists (select 1 from reservations where shop_id = p_shop_id and quote_id = p_quote_id and status in ('pending', 'confirmed')) then
    raise exception 'quote_already_used';
  end if;
  -- 同じ人・同じ IP の未確定の予約の数（数えてから入れるまでを直列にする）。
  -- 0 円の注文はその場で confirmed になり pending が残らないので、直近 1 時間の 0 円注文（orders.payment_provider = 'free'）も数える（0056）
  if p_subject_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation|' || p_shop_id::text || '|' || p_subject_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.subject_hash = p_subject_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_customer', 3) then
      raise exception 'too_many_reservations' using detail = 'customer';
    end if;
  end if;
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('reservation-ip|' || p_shop_id::text || '|' || p_ip_hash, 0));
    if (select count(*) from reservations r
         where r.shop_id = p_shop_id and r.ip_hash = p_ip_hash
           and (r.status = 'pending'
                or (r.status = 'confirmed' and r.created_at > now() - interval '1 hour'
                    and exists (select 1 from orders o where o.reservation_id = r.id and o.payment_provider = 'free'))))
       >= banto_shop_limit(p_shop_id, 'checkout', 'max_pending_per_ip', 20) then
      raise exception 'too_many_reservations' using detail = 'ip';
    end if;
  end if;

  -- sku_id 順に処理し、複数予約が同じ SKU 群を逆順でロックしてデッドロックするのを防ぐ
  for v_item in select e from jsonb_array_elements(p_items) e order by e->>'sku_id' loop
    v_sku_id := (v_item->>'sku_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    if v_sku_id is null or v_qty is null or v_qty <= 0 then
      raise exception 'invalid_item' using detail = coalesce(v_item::text, 'null');
    end if;

    select k.price_jpy into v_price
      from skus k
      join products p on p.id = k.product_id
      join shops s on s.id = k.shop_id
     where k.id = v_sku_id and k.shop_id = p_shop_id and p.published and s.published;
    if not found then
      raise exception 'sku_not_available' using detail = v_sku_id::text;
    end if;

    update inventory
       set available = available - v_qty, updated_at = now()
     where sku_id = v_sku_id and shop_id = p_shop_id and available >= v_qty;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'insufficient_stock' using detail = v_sku_id::text;
    end if;

    v_items := v_items || jsonb_build_object('sku_id', v_sku_id, 'qty', v_qty, 'unit_price_jpy', v_price);
  end loop;

  insert into reservations (shop_id, items, expires_at, quote_id, subject_hash, ip_hash)
  values (p_shop_id, v_items, now() + make_interval(secs => p_ttl_seconds), p_quote_id, p_subject_hash, p_ip_hash)
  returning id into v_reservation_id;

  return v_reservation_id;
end;
$$;
create index if not exists reservations_recent_confirmed_idx on reservations (shop_id, created_at) where status = 'confirmed';

-- ---------- 2. member_login_verify: 失敗はチャレンジを出した IP ごとに数える ----------
create or replace function member_login_verify(p_shop_id uuid, p_challenge_id uuid, p_code_hash text, p_link_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch member_login_challenges%rowtype;
  v_customer customers%rowtype;
  v_created boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_verify: service_role only' using errcode = '42501';
  end if;
  select * into v_ch from member_login_challenges where id = p_challenge_id and shop_id = p_shop_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_ch.consumed_at is not null or v_ch.expires_at < now() or v_ch.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  -- 同じ IP が出したチャレンジの失敗は 1 日 50 回まで（第三者の失敗が本人のチャレンジを止めない）。アドレス全体は 1 日 300 回まで
  if (select coalesce(sum(attempts), 0) from member_login_challenges
       where shop_id = p_shop_id and email = v_ch.email and ip_hash is not distinct from v_ch.ip_hash and created_at > now() - interval '1 day') >= 50
     or (select coalesce(sum(attempts), 0) from member_login_challenges
          where shop_id = p_shop_id and email = v_ch.email and created_at > now() - interval '1 day') >= 300 then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not ((p_code_hash is not null and v_ch.code_hash = p_code_hash) or (p_link_hash is not null and v_ch.link_hash = p_link_hash)) then
    update member_login_challenges
       set attempts = attempts + 1,
           consumed_at = case when attempts + 1 >= 5 then now() else consumed_at end
     where id = v_ch.id;
    return jsonb_build_object('ok', false, 'reason', case when v_ch.attempts + 1 >= 5 then 'expired' else 'invalid' end);
  end if;
  update member_login_challenges set consumed_at = now() where id = v_ch.id;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select * into v_customer from customers where shop_id = p_shop_id and lower(email) = v_ch.email;
  if not found then
    insert into customers (shop_id, email) values (p_shop_id, v_ch.email)
    on conflict (shop_id, lower(email)) where email is not null do nothing
    returning * into v_customer;
    if v_customer.id is null then
      select * into v_customer from customers where shop_id = p_shop_id and lower(email) = v_ch.email;
    else
      v_created := true;
    end if;
  end if;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_customer.id;
  return jsonb_build_object('ok', true, 'customer_id', v_customer.id, 'session_epoch', v_customer.session_epoch,
                            'email', v_customer.email, 'created', v_created, 'return_to', v_ch.return_to);
end;
$$;

-- ---------- 3. ロックは「同じ IP から同じアドレスへ」を先に ----------
-- 運営者: 同じ IP から同じアドレスへ 15 分 5 回、同じアドレス全体で 15 分 20 回、同じ IP 全体で 15 分 20 回（0030 を差し替え）
create or replace function admin_login_check(p_email_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_pair integer := 0; v_email integer; v_ip integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'admin_login_check: service_role only' using errcode = '42501';
  end if;
  select count(*) into v_email from admin_login_attempts where email_hash = p_email_hash and not success and created_at > now() - interval '15 minutes';
  if p_ip_hash is not null then
    select count(*) into v_pair from admin_login_attempts where email_hash = p_email_hash and ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes';
    select count(*) into v_ip from admin_login_attempts where ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes';
  else
    v_pair := v_email;
  end if;
  return jsonb_build_object('allowed', v_pair < 5 and v_email < 20 and v_ip < 20, 'retry_after_seconds', 900);
end;
$$;

-- 会員のパスワード: 同じ IP から同じアドレスへ 15 分 5 回、同じアドレス全体で 15 分 20 回、同じ IP 全体で 1 時間 30 回（0016 を差し替え）
create or replace function member_password_login(p_shop_id uuid, p_email text, p_password text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_c customers%rowtype;
  v_ok boolean := false;
  v_found boolean;
  v_from text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_password_login: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id
                  and coalesce(settings->>'members_enabled', 'false') = 'true'
                  and coalesce(settings->>'members_password', 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if p_password is null or length(p_password) = 0 or length(p_password) > 200 or length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member_password|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from member_login_failures where shop_id = p_shop_id and email = v_email and ip_hash is not distinct from p_ip_hash and created_at > now() - interval '15 minutes') >= 5
     or (select count(*) from member_login_failures where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 20
     or (p_ip_hash is not null and (select count(*) from member_login_failures where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30) then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  select * into v_c from customers where shop_id = p_shop_id and lower(email) = v_email for update;
  v_found := found;
  if v_found and v_c.password_hash is not null then
    v_ok := crypt(p_password, v_c.password_hash) = v_c.password_hash;
  elsif v_found and v_c.legacy_password_hash is not null and (v_c.legacy_password_expires_at is null or v_c.legacy_password_expires_at > now()) then
    -- WordPress は保存するときに前後の空白を落としている
    v_ok := banto_wp_password_matches(p_password, v_c.legacy_password_hash)
            or (btrim(p_password) <> p_password and banto_wp_password_matches(btrim(p_password), v_c.legacy_password_hash));
    if v_ok then
      update customers set password_hash = crypt(p_password, gen_salt('bf', 10)), password_updated_at = now(),
                           legacy_password_hash = null, legacy_password_expires_at = null
       where shop_id = p_shop_id and id = v_c.id;
    end if;
  else
    -- 会員がいない・パスワードが無いときも同じくらいの時間をかける（応答の時間で登録の有無が分からないように）
    perform crypt(p_password, '$2a$10$' || repeat('a', 53));
  end if;
  if not v_ok then
    insert into member_login_failures (shop_id, email, ip_hash) values (p_shop_id, v_email, p_ip_hash);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_c.id;
  -- 知らせのメールの送信元（メール通知プラグインの設定。無ければ null = 送らない）
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email, 'mail_from', v_from);
end;
$$;

-- ---------- 4. hooks の配信はプランに合わせた数だけ取り出す（0002 を差し替え） ----------
-- 無料プランの Worker は 1 回の実行で送れる通信の数が少ない（1 件 = fetch 1 + finish 1）。free は 12 件、paid は呼び手の上限（既定 50）まで
create or replace function claim_hook_deliveries(p_limit integer default 50)
returns table (
  id uuid, shop_id uuid, endpoint_id uuid, event text, payload jsonb, attempts integer,
  url text, settings jsonb, created_at timestamptz
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
  select l.id, l.shop_id, l.endpoint_id, l.event, l.payload, l.attempts, e.url, e.settings, l.created_at
    from leased l join hook_endpoints e on e.id = l.endpoint_id;
end;
$$;

insert into banto_migrations (version) values ('0056_rate_limits_2');
