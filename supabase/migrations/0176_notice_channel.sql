-- 0176: 注文・お店で試着のお知らせを「LINE だけ」で受け取れるようにする（メンテナの決定 2026-11-25、docs/line.md §2）
-- LINE と結びついた会員が、会員ページで「メールと LINE」（今まで・既定）か「LINE だけ」を選ぶ。選ぶのは本人だけ。
--   - 「LINE だけ」が効くのは、会員が LINE と結びつき、ショップが「LINE で購入者に知らせる」を使っているときだけ（banto_notice_line_ready）。
--     そうでなければ今までどおりメールも送る（何も届かない状態を作らない）
--   - 同梱の「メール通知」は、効いているお客様にはお客様あてのメールを送らない（運営者への控えは送る、店舗あての試着の知らせも送る）。
--     判定は order_contact・tryon_contact の notice_line_only（DB の banto_notice_line_only）
--   - 同梱の「LINE で購入者に知らせる」が送れなかったとき（友だちでない・ブロック・トークンが無い・最後の再送の失敗）は、
--     同じ知らせを「メール通知」にだけ配り直す（notice_line_fallback、payload に line_fallback: true）
--   - 外部プラグインは AI 用 API の会員（customers:read）の notice_channel で読める

alter table customers add column if not exists notice_channel text not null default 'all';
alter table customers drop constraint if exists customers_notice_channel_check;
alter table customers add constraint customers_notice_channel_check check (notice_channel in ('all', 'line'));
-- 運営者の画面で見る（書くのは本人の member_set_notice_channel だけ）
grant select (notice_channel) on customers to authenticated;

-- 「LINE だけ」を選べるか: 会員が LINE と結びつき、ショップの「LINE で購入者に知らせる」が有効
create or replace function banto_notice_line_ready(p_shop_id uuid, p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_customer_id is not null
     and exists (select 1 from member_identities i where i.shop_id = p_shop_id and i.customer_id = p_customer_id and i.provider = 'line')
     and exists (select 1 from hook_endpoints e where e.shop_id = p_shop_id and e.enabled
                  and e.url = 'https://banto.invalid/plugins/line_buyer_notify');
$$;
revoke execute on function banto_notice_line_ready(uuid, uuid) from public, anon, authenticated, service_role;

-- 「LINE だけ」が効いているか（選んでいて、選べる）
create or replace function banto_notice_line_only(p_shop_id uuid, p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.notice_channel = 'line' from customers c where c.shop_id = p_shop_id and c.id = p_customer_id), false)
     and banto_notice_line_ready(p_shop_id, p_customer_id);
$$;
revoke execute on function banto_notice_line_only(uuid, uuid) from public, anon, authenticated, service_role;

-- 同梱プラグイン向け: LINE で送れなかった知らせを「メール通知」にだけ配り直す。
-- 元の配信（LINE の送信先のもの）1 つにつき 1 回だけ。中身は元の配信と同じに line_fallback と fallback_of を足す。
-- 「メール通知」が無い・無効・その出来事を受け取らないなら何もしない（0 を返す）
create or replace function notice_line_fallback(p_delivery_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_d hook_deliveries%rowtype; v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'notice_line_fallback: service_role only' using errcode = '42501';
  end if;
  select d.* into v_d from hook_deliveries d join hook_endpoints e on e.id = d.endpoint_id
   where d.id = p_delivery_id and e.url = 'https://banto.invalid/plugins/line_buyer_notify';
  if not found then return 0; end if;
  if v_d.event not in ('order.created', 'order.paid', 'order.shipped', 'tryon.requested', 'tryon.updated') then return 0; end if;
  if exists (select 1 from hook_deliveries d where d.shop_id = v_d.shop_id and d.payload->>'fallback_of' = p_delivery_id::text) then return 0; end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, v_d.event, v_d.payload || jsonb_build_object('line_fallback', true, 'fallback_of', p_delivery_id::text)
    from hook_endpoints e
   where e.shop_id = v_d.shop_id and e.enabled and v_d.event = any(e.events)
     and e.url = 'https://banto.invalid/plugins/email_resend';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function notice_line_fallback(uuid) from public, anon, authenticated;
grant execute on function notice_line_fallback(uuid) to service_role;

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
  if p_channel = 'line' and not banto_notice_line_ready(p_shop_id, p_customer_id) then
    return 'line_unavailable';
  end if;
  update customers set notice_channel = p_channel where shop_id = p_shop_id and id = p_customer_id;
  return 'ok';
end;
$$;
revoke execute on function member_set_notice_channel(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function member_set_notice_channel(uuid, uuid, integer, text) to service_role;

-- ---------- 同梱プラグインが読む関数に「LINE だけ」を足す（当てる前の DB では鍵が無く、今までどおりメールも送る） ----------

-- order_contact（0157 の定義から。notice_line_only を足した）
create or replace function order_contact(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'created_at', v_o.created_at,
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'fee_jpy', v_o.fee_jpy, 'payment_status', v_o.payment_status, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'shipping_tax_rate', v_o.shipping_tax_rate, 'tax_rounding', v_o.tax_rounding,
    'tracking', case when v_o.tracking_number is not null then jsonb_build_object('carrier', v_o.tracking_carrier, 'number', v_o.tracking_number) end,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    -- 0066: 会員の注文か（メールのリンクの目印）と、注文照会のページ（連携サイト）。どちらも鍵ではない
    'member', v_o.customer_id is not null,
    -- 0176: お客様が「LINE だけ」を選んでいて、それが効いているか（メール通知はお客様あてを送らない）
    'notice_line_only', banto_notice_line_only(p_shop_id, v_o.customer_id),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                               'order_page_url', v_s.settings->'headless'->>'order_page_url',
                               'return_origins', coalesce(v_s.settings->'headless'->'return_origins', '[]'::jsonb),
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy,
                               'tax', jsonb_build_object('tax_rate', v_s.settings->'tax_rate', 'tax_rate_reduced', v_s.settings->'tax_rate_reduced', 'tax_rounding', v_s.settings->'tax_rounding')),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy,
                                                           'tax_rate', oi.tax_rate, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;


-- tryon_contact（0147 の定義から。notice_line_only を足した）
create or replace function tryon_contact(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_st stores%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_st from stores where id = v_r.store_id;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'request_id', v_r.id, 'number', v_r.number, 'status', v_r.status, 'visit_date', v_r.visit_date, 'hold_until', v_r.hold_until,
    'customer_email', v_r.customer_email, 'customer_name', v_r.customer_name, 'customer_phone', v_r.customer_phone, 'note', v_r.note,
    -- 0176: お客様が「LINE だけ」を選んでいて、それが効いているか（メール通知はお客様あてを送らない。店舗あては送る）
    'notice_line_only', banto_notice_line_only(p_shop_id, v_r.customer_id),
    'store', jsonb_build_object('name', v_st.name, 'postal_code', v_st.postal_code, 'address', v_st.address, 'phone', v_st.phone,
                                'email', v_st.email, 'notify_email', v_st.notify_email, 'hours', v_st.hours, 'special_days', v_st.special_days),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain, 'contact_email', v_s.settings->>'contact_email', 'settings', v_s.settings->'store_tryon',
                               'storefront', jsonb_build_object('mode', v_s.settings->'storefront'->>'mode', 'site_url', v_s.settings->'storefront'->>'site_url'),
                               'option_names', v_s.option_names),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'code', k.code, 'options', k.options, 'axes', p.option_axes,
                                                           'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = v_r.id));
end;
$$;


-- order_line_recipient（0021 の定義から。line_only を足した: 送れなかったときにメールへ配り直すか）
create or replace function order_line_recipient(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_line_recipient: service_role only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('line_user_id', i.subject, 'number', o.number, 'total_jpy', o.total_jpy, 'shop_name', s.name, 'status', o.status,
                              'line_only', banto_notice_line_only(o.shop_id, o.customer_id))
      from orders o join shops s on s.id = o.shop_id
      join member_identities i on i.shop_id = o.shop_id and i.customer_id = o.customer_id and i.provider = 'line'
     where o.id = p_order_id and o.shop_id = p_shop_id and o.customer_id is not null
     limit 1);
end;
$$;


-- tryon_line_recipient（0025 の定義から。line_only を足した）
create or replace function tryon_line_recipient(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_line_recipient: service_role only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('line_user_id', i.subject, 'number', r.number, 'status', r.status, 'hold_until', r.hold_until,
                              'store_name', st.name, 'shop_name', s.name, 'line_only', banto_notice_line_only(r.shop_id, r.customer_id))
      from tryon_requests r join shops s on s.id = r.shop_id join stores st on st.id = r.store_id
      join member_identities i on i.shop_id = r.shop_id and i.customer_id = r.customer_id and i.provider = 'line'
     where r.id = p_request_id and r.shop_id = p_shop_id and r.customer_id is not null
     limit 1);
end;
$$;


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
                                   'notice_line_available', banto_notice_line_ready(p_shop_id, v_c.id),
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
