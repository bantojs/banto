-- 0176: 注文・お店で試着のお知らせを「LINE だけ」で受け取れるようにする（メンテナの決定 2026-11-25、docs/line.md §2）
-- LINE と結びついた会員が、会員ページで「メールと LINE」（今まで・既定）か「LINE だけ」を選ぶ。選ぶのは本人だけ。
--   - 「LINE だけ」が効くのは、会員が LINE と結びつき、ショップの「LINE で購入者に知らせる」が有効でその出来事を受け取るときだけ
--     （banto_notice_line_only）。そうでなければ今までどおりメールも送る（何も届かない状態を作らない）
--   - **決めるのは hooks を積むときの 1 回だけ**: hook_deliveries に入るとき（どの道から積んでも）トリガーが判定し、
--     効いていれば payload に notice_line_only: true を書く。メール通知も LINE のプラグインも、外部プラグインもこの印を読む
--     （配信の時点で設定や結びつきが変わっていても、メールと LINE の判断が食い違わない）
--   - 同梱の「メール通知」は、印のある知らせではお客様あてのメールを送らない（運営者への控え・試着の店舗あては送る）
--   - LINE で届けられなかったら、同じ知らせを「メール通知」にだけ配り直す（notice_line_fallback、payload に line_fallback: true）:
--     その場で分かるもの（友だちでない・ブロック・トークンが無い・結びつきが外れた）は LINE のプラグインが呼び、
--     再送の末の失敗（failed）・LINE のプラグインを止めた・消したときは DB のトリガーが呼ぶ。配り直しは元の配信 1 つにつき 1 回（一意の索引）

alter table customers add column if not exists notice_channel text not null default 'all';
alter table customers drop constraint if exists customers_notice_channel_check;
alter table customers add constraint customers_notice_channel_check check (notice_channel in ('all', 'line'));
-- 運営者の画面で見る（書くのは本人の member_set_notice_channel だけ）
grant select (notice_channel) on customers to authenticated;

-- 「LINE だけ」を選べるか: 会員が LINE と結びつき、ショップの「LINE で購入者に知らせる」が有効（p_event があればその出来事を受け取る）
create or replace function banto_notice_line_ready(p_shop_id uuid, p_customer_id uuid, p_event text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_customer_id is not null
     and exists (select 1 from member_identities i where i.shop_id = p_shop_id and i.customer_id = p_customer_id and i.provider = 'line')
     and exists (select 1 from hook_endpoints e where e.shop_id = p_shop_id and e.enabled
                  and e.url = 'https://banto.invalid/plugins/line_buyer_notify'
                  and (p_event is null or p_event = any(e.events)));
$$;
revoke execute on function banto_notice_line_ready(uuid, uuid, text) from public, anon, authenticated, service_role;

-- 「LINE だけ」が効いているか（選んでいて、その出来事で選べる）
create or replace function banto_notice_line_only(p_shop_id uuid, p_customer_id uuid, p_event text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.notice_channel = 'line' from customers c where c.shop_id = p_shop_id and c.id = p_customer_id), false)
     and banto_notice_line_ready(p_shop_id, p_customer_id, p_event);
$$;
revoke execute on function banto_notice_line_only(uuid, uuid, text) from public, anon, authenticated, service_role;

-- 積むときに 1 回だけ決める（どの道から hook_deliveries に入っても）。配り直しの行（fallback_of）と、もう決めてある行はそのまま
create or replace function banto_notice_line_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_customer uuid;
begin
  if new.event not in ('order.created', 'order.paid', 'order.shipped', 'tryon.requested', 'tryon.updated')
     or new.payload ? 'notice_line_only' or new.payload ? 'fallback_of' then
    return new;
  end if;
  -- order.created で知らせるのは未入金の注文（代金引換）の受付だけ（入金済みは order.paid）
  if new.event = 'order.created' and coalesce(new.payload->>'payment_status', '') <> 'unpaid' then return new; end if;
  -- 先に安い確かめ: このショップの「LINE で購入者に知らせる」が有効でこの出来事を受け取るか（ほとんどのショップ・ゲストはここで終わる）
  if not exists (select 1 from hook_endpoints e where e.shop_id = new.shop_id and e.enabled
                  and e.url = 'https://banto.invalid/plugins/line_buyer_notify' and new.event = any(e.events)) then
    return new;
  end if;
  if new.event like 'order.%' then
    if coalesce(new.payload->>'order_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
    select o.customer_id into v_customer from orders o where o.id = (new.payload->>'order_id')::uuid and o.shop_id = new.shop_id;
  else
    if coalesce(new.payload->>'request_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
    select r.customer_id into v_customer from tryon_requests r where r.id = (new.payload->>'request_id')::uuid and r.shop_id = new.shop_id;
  end if;
  if v_customer is not null and banto_notice_line_only(new.shop_id, v_customer, new.event) then
    new.payload := new.payload || jsonb_build_object('notice_line_only', true);
  end if;
  return new;
end;
$$;
revoke execute on function banto_notice_line_mark() from public, anon, authenticated, service_role;
drop trigger if exists hook_deliveries_notice_line on hook_deliveries;
create trigger hook_deliveries_notice_line before insert on hook_deliveries for each row execute function banto_notice_line_mark();

-- 配り直しは元の配信 1 つにつき 1 行（同時に呼ばれても）。探すのもこの索引
create unique index if not exists hook_deliveries_fallback_of on hook_deliveries ((payload->>'fallback_of')) where payload ? 'fallback_of';

-- LINE の送信先の配信（印のあるもの）を「メール通知」にだけ配り直す。中身は元の配信と同じに line_fallback と fallback_of を足す。
-- 「メール通知」が無い・無効・その出来事を受け取らない・もう配り直したなら何もしない（0 を返す）
create or replace function banto_notice_line_fallback(p_delivery_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_d hook_deliveries%rowtype; v_count integer;
begin
  select d.* into v_d from hook_deliveries d join hook_endpoints e on e.id = d.endpoint_id
   where d.id = p_delivery_id and e.url = 'https://banto.invalid/plugins/line_buyer_notify';
  if not found or coalesce(v_d.payload->>'notice_line_only', '') <> 'true' then return 0; end if;
  -- ショップごと消しているとき（送信先の行の削除が連なって来る）は配り直さない
  if not exists (select 1 from shops where id = v_d.shop_id) then return 0; end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, v_d.event, v_d.payload || jsonb_build_object('line_fallback', true, 'fallback_of', p_delivery_id::text)
    from hook_endpoints e
   where e.shop_id = v_d.shop_id and e.enabled and v_d.event = any(e.events)
     and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1
  on conflict ((payload->>'fallback_of')) where payload ? 'fallback_of' do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function banto_notice_line_fallback(uuid) from public, anon, authenticated, service_role;

-- 同梱の LINE のプラグイン向け（その場で届けられないと分かったとき）
create or replace function notice_line_fallback(p_delivery_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'notice_line_fallback: service_role only' using errcode = '42501';
  end if;
  return banto_notice_line_fallback(p_delivery_id);
end;
$$;
revoke execute on function notice_line_fallback(uuid) from public, anon, authenticated;
grant execute on function notice_line_fallback(uuid) to service_role;

-- 再送の末に失敗した（failed。プラグインの例外・Cron の打ち切りのどちらでも）LINE の配信は、メールへ配り直す
create or replace function banto_notice_line_failed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'failed' and old.status is distinct from 'failed' and coalesce(new.payload->>'notice_line_only', '') = 'true' then
    perform banto_notice_line_fallback(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function banto_notice_line_failed() from public, anon, authenticated, service_role;
drop trigger if exists hook_deliveries_notice_line_failed on hook_deliveries;
create trigger hook_deliveries_notice_line_failed after update of status on hook_deliveries
  for each row when (new.status = 'failed' and old.status is distinct from 'failed') execute function banto_notice_line_failed();

-- LINE のプラグインを止めた・消したら、まだ送っていない印のある配信を failed にする（上のトリガーでメールへ配り直す。
-- 後で有効に戻しても、古い LINE を遅れて送らない）
create or replace function banto_notice_line_endpoint_off()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.url = 'https://banto.invalid/plugins/line_buyer_notify' and (tg_op = 'DELETE' or (old.enabled and not new.enabled)) then
    update hook_deliveries d
       set status = 'failed', last_error = 'line_disabled: sent by email instead'
     where d.endpoint_id = old.id and d.status = 'pending' and coalesce(d.payload->>'notice_line_only', '') = 'true';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function banto_notice_line_endpoint_off() from public, anon, authenticated, service_role;
drop trigger if exists hook_endpoints_notice_line_off on hook_endpoints;
create trigger hook_endpoints_notice_line_off before update of enabled or delete on hook_endpoints
  for each row execute function banto_notice_line_endpoint_off();

-- enqueue_hook（0142 の定義から。運営者が積むときは、お知らせの受け取り方の印を外す）
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_perm text;
begin
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  if auth.role() is distinct from 'service_role' then
    v_perm := case p_event when 'product.updated' then 'catalog' when 'order.shipped' then 'orders' end;
    if v_perm is null then
      raise exception 'event_not_permitted' using errcode = '42501';
    end if;
    if not banto_shop_perm(p_shop_id, v_perm) then
      raise exception 'shop_not_found' using errcode = '42501';
    end if;
    -- 0176: お知らせの受け取り方の印は Banto だけが付ける（運営者の積む知らせで、お客様あてのメールを止めたり配り直しの枠を取ったりさせない）
    p_payload := coalesce(p_payload, '{}'::jsonb) - 'notice_line_only' - 'line_fallback' - 'fallback_of';
    -- ペイロードの id は、あるなら uuid の形（大文字でもよい）で、そのショップの行だけ（別のショップの商品・無い注文で受け手を動かさない。
    -- ハイフンの無い形・{…} の形は、受け手が uuid に直して読むと確かめをすり抜けるので受けない）
    if p_payload->>'order_id' is not null and (lower(p_payload->>'order_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (select 1 from orders o where o.shop_id = p_shop_id and o.id::text = lower(p_payload->>'order_id'))) then
      raise exception 'invalid_payload' using detail = 'order_id';
    end if;
    if p_payload->>'product_id' is not null and (lower(p_payload->>'product_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (select 1 from products p where p.shop_id = p_shop_id and p.id::text = lower(p_payload->>'product_id'))) then
      raise exception 'invalid_payload' using detail = 'product_id';
    end if;
    if p_payload->>'customer_id' is not null and (lower(p_payload->>'customer_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (select 1 from customers c where c.shop_id = p_shop_id and c.id::text = lower(p_payload->>'customer_id'))) then
      raise exception 'invalid_payload' using detail = 'customer_id';
    end if;
  end if;
  return banto_enqueue_hook_internal(p_shop_id, p_event, p_payload);
end;
$$;

-- 会員本人が選ぶ（会員ページ・ヘッドレスの会員トークン）。「LINE だけ」は選べるときだけ
create or replace function member_set_notice_channel(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_channel text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_set_notice_channel: service_role only' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('all', 'line') then raise exception 'invalid_notice_channel'; end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return 'invalid';
  end if;
  if p_channel = 'line' and not banto_notice_line_ready(p_shop_id, p_customer_id, null) then
    return 'line_unavailable';
  end if;
  update customers set notice_channel = p_channel where shop_id = p_shop_id and id = p_customer_id;
  return 'ok';
end;
$$;
revoke execute on function member_set_notice_channel(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function member_set_notice_channel(uuid, uuid, integer, text) to service_role;

-- member_get（0157 の定義から。notice_channel と notice_line_available を足した）
create or replace function member_get(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_with_orders boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_c customers%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_get: service_role only' using errcode = '42501';
  end if;
  select * into v_c from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  if not found then return null; end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'shop_id', v_c.shop_id, 'email', v_c.email, 'name', v_c.name, 'default_address', v_c.default_address,
                                   'marketing_consent', v_c.marketing_consent,
                                   -- 0176: お知らせの受け取り方と、「LINE だけ」を選べるか（LINE と結びつき、ショップが LINE で知らせている）
                                   'notice_channel', v_c.notice_channel,
                                   'notice_line_available', banto_notice_line_ready(p_shop_id, v_c.id, null),
                                   'has_password', v_c.password_hash is not null or v_c.legacy_password_hash is not null,
                                   'providers', coalesce((select jsonb_agg(provider order by provider) from member_identities
                                                           where shop_id = p_shop_id and customer_id = v_c.id), '[]'::jsonb)),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at, payment_status, fee_jpy, payment_provider
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;


-- api_customer_json（0156 の定義から。notice_channel を足した、customers:read）
create or replace function api_customer_json(p_c customers)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'email', p_c.email, 'name', p_c.name, 'default_address', p_c.default_address,
    'external_ref', p_c.external_ref, 'attributes', coalesce(p_c.attributes, '{}'::jsonb),
    'marketing_consent', p_c.marketing_consent, 'marketing_consent_at', p_c.marketing_consent_at, 'marketing_consent_source', p_c.marketing_consent_source,
    'notice_channel', p_c.notice_channel,
    'created_at', p_c.created_at, 'updated_at', p_c.updated_at, 'last_login_at', p_c.last_login_at,
    'orders', (select jsonb_build_object('count', count(*), 'total_jpy', coalesce(sum(o.total_jpy), 0), 'last_order_at', max(o.created_at))
                 from orders o where o.shop_id = p_c.shop_id and o.customer_id = p_c.id and o.status in ('paid', 'shipped') and o.payment_status = 'paid')
  );
$$;

insert into banto_migrations (version) values ('0176_notice_channel');
