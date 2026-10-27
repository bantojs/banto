-- Banto 0061_mod_inquiries: 同梱モジュール「お問い合わせ」（inquiries、既定 OFF。docs/inquiries.md、docs/knowledge/14-inquiries.md）。前方専用。
--
-- お客様のお問い合わせをチケットにし、運営者とのやり取りを Banto の中で続ける（人間の決定 2026-10-27）。
--  - メールはお知らせとチケットへのリンクだけ。本文は載せない。メールへの返信は受けない（受信の仕組みを持たない）
--  - ログインしていない人・注文に結ばない問い合わせも受ける。ゲストはアドレスに届いたリンクを押した時点で「確認済み」
--  - 注文に結ぶのは、会員の自分の注文・注文時のアドレス（注文から問い合わせた）・注文番号とメールアドレスが合ったときだけ。
--    合わなければ「申告された注文番号」の文字として残す。会員に結ぶのは、確認済みで会員のアドレスと一致したときだけ
--  - 送った人には「会員か」「どちらが違ったか」を返さない
--  - 運営側の権限は新しい項目 support（組織のメンバーのショップごとの項目）
--
-- 表（書くのは下の関数だけ。運営側は support の項目で読む。お客様の経路は service_role の関数だけ）:
--   inquiries         … チケット 1 件。連絡先は個人情報（終わったものは mask_inquiries で消す。未確認のまま 30 日で消す）
--   inquiry_messages  … やり取り（お客様 / 運営者）。本文はテキスト（HTML は描画しない）
--   inquiry_links     … チケットを開くリンクのトークン（Worker が HMAC にしたものだけ。30 日）
--   inquiry_mails     … 送ったメールの記録（回数の制限と、プランの 1 日のメールの上限 0053 に数える。宛先は SHA-256 だけ）
--   inquiry_checks    … 「注文を確かめる」「リンクを送り直す」の試行（回数の制限。メールアドレスは Worker の HMAC だけ）
-- hooks: inquiry.created（アドレスが確認されたとき）・inquiry.updated（やり取り・状態）。ペイロードに個人情報は載せない
-- AI 用トークン: inquiries:read / inquiries:write（→ support の項目）。連絡先は orders:pii もあるときだけ（下の api_inquiry_*）
-- バックアップ: 書き出しは RLS の経路（運営者の JWT）、復元は restore_inquiries（注文番号・メールアドレスで結び直す）

alter table shops add column if not exists inquiry_seq integer not null default 0;

-- ---------- 権限の項目に support を足す（0024） ----------
create or replace function banto_shop_perms_all()
returns text[]
language sql
immutable
as $$ select array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support'] $$;

alter table org_member_shops drop constraint if exists org_member_shops_perms_check;
alter table org_member_shops add constraint org_member_shops_perms_check
  check (perms <@ array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support']);

-- ---------- 表 ----------
create table inquiries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  number integer not null,
  category text not null check (category in ('product', 'order', 'account', 'other')),
  -- waiting_shop = 運営者の返事待ち、waiting_customer = お客様の返事待ち、closed = 完了
  status text not null default 'waiting_shop' check (status in ('waiting_shop', 'waiting_customer', 'closed')),
  -- どこから来たか: form = フォーム（ゲスト）、member = ログイン中の会員、order = 注文照会の結果・会員の注文、checkout = 購入完了の画面
  origin text not null check (origin in ('form', 'member', 'order', 'checkout')),
  contact_email text check (contact_email is null or length(contact_email) between 3 and 254),
  contact_name text check (contact_name is null or length(contact_name) <= 100),
  email_verified_at timestamptz,
  customer_id uuid,
  order_id uuid references orders(id) on delete set null,
  claimed_order_number integer check (claimed_order_number is null or claimed_order_number > 0),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  -- ヘッドレスの連携サイトのチケットの画面（Worker が return_origins の許可リストで確かめたもの）。メールのリンクの行き先
  return_to text check (return_to is null or length(return_to) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  closed_at timestamptz,
  masked_at timestamptz,
  foreign key (shop_id, customer_id) references customers(shop_id, id) on delete set null (customer_id)
);
create unique index inquiries_number on inquiries(shop_id, number);
create index on inquiries(shop_id, status, last_message_at desc);
create index on inquiries(shop_id, lower(contact_email));
create index on inquiries(shop_id, customer_id) where customer_id is not null;
create index on inquiries(shop_id, ip_hash, created_at) where ip_hash is not null;
alter table inquiries enable row level security;
create policy inquiries_select on inquiries for select using (banto_shop_perm(shop_id, 'support'));

create table inquiry_messages (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  inquiry_id uuid not null references inquiries(id) on delete cascade,
  author text not null check (author in ('customer', 'shop')),
  -- 返信した運営側の人（表示はしない。誰が返したかの記録）
  author_user uuid references auth.users(id) on delete set null,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index on inquiry_messages(inquiry_id, created_at);
alter table inquiry_messages enable row level security;
create policy inquiry_messages_select on inquiry_messages for select using (banto_shop_perm(shop_id, 'support'));

create table inquiry_links (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  inquiry_id uuid not null references inquiries(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index on inquiry_links(inquiry_id);
alter table inquiry_links enable row level security;
create policy inquiry_links_none on inquiry_links for select using (false);

create table inquiry_mails (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  inquiry_id uuid references inquiries(id) on delete set null,
  -- verify = 確認のリンク、created = 受け付けた（確認済みの人）、reply = 運営者の返事、link = リンクの送り直し、shop = 運営者へのお知らせ
  kind text not null check (kind in ('verify', 'created', 'reply', 'link', 'shop')),
  to_hash text check (to_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index on inquiry_mails(shop_id, created_at);
create index on inquiry_mails(shop_id, to_hash, created_at);
create index on inquiry_mails(created_at);
alter table inquiry_mails enable row level security;
create policy inquiry_mails_none on inquiry_mails for select using (false);

create table inquiry_checks (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash text check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index on inquiry_checks(shop_id, ip_hash, created_at);
create index on inquiry_checks(shop_id, email_hash, created_at);
alter table inquiry_checks enable row level security;
create policy inquiry_checks_none on inquiry_checks for select using (false);

revoke all on inquiries, inquiry_messages, inquiry_links, inquiry_mails, inquiry_checks from anon;
revoke insert, update, delete on inquiries, inquiry_messages, inquiry_links, inquiry_mails, inquiry_checks from authenticated;

-- ---------- 部品（関数の中からだけ使う） ----------
create or replace function banto_inquiries_on(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from shops where id = p_shop_id and published and coalesce(settings->'modules'->>'inquiries', 'false') = 'true');
$$;

-- 送信元（会員のログインのメールと同じ。同梱のメール通知プラグインの「送信元」）
create or replace function banto_inquiry_mail_from(p_shop_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select nullif(btrim(e.settings->>'from'), '') from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
$$;

-- 運営者へのお知らせの宛先（モジュールの設定 → ショップの問い合わせ先）
create or replace function banto_inquiry_notify_to(p_shop_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(settings->'inquiries'->>'notify_email'), ''), nullif(btrim(settings->>'contact_email'), '')) from shops where id = p_shop_id;
$$;

create or replace function banto_inquiry_to_hash(p_email text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'UTF8')), 'hex');
$$;

create or replace function banto_enqueue_inquiry_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns void language sql security definer set search_path = public as $$
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events);
$$;

-- メールを 1 通送ってよいか。よければ記録して true（Worker が送る）。上限を超えたら false（送らないだけ。応答の形は変えない）
--   お客様が増やせるもの（verify / link）: 同じ宛先に 1 時間 5 通・1 日 20 通
--   運営者へのお知らせ（shop）: ショップで 1 時間 settings.inquiries.shop_notices_per_hour（既定 60）
--   ショップ全体: 1 日 settings.inquiries.mails_per_day（既定 500）。デプロイ全体の上限は plan_limits.mail_per_day（0053、トリガー）
create or replace function banto_inquiry_issue_mail(p_shop_id uuid, p_inquiry_id uuid, p_kind text, p_to text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_to text;
begin
  if p_to is null or position('@' in p_to) < 2 then return false; end if;
  v_to := banto_inquiry_to_hash(p_to);
  perform pg_advisory_xact_lock(hashtextextended('inquiry_mail|' || p_shop_id::text || '|' || v_to, 0));
  if p_kind in ('verify', 'link') and (
       (select count(*) from inquiry_mails where shop_id = p_shop_id and to_hash = v_to and kind in ('verify', 'link') and created_at > now() - interval '1 hour') >= 5
       or (select count(*) from inquiry_mails where shop_id = p_shop_id and to_hash = v_to and kind in ('verify', 'link') and created_at > now() - interval '1 day') >= 20) then
    return false;
  end if;
  if p_kind = 'shop' and (select count(*) from inquiry_mails where shop_id = p_shop_id and kind = 'shop' and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'shop_notices_per_hour', 60) then
    return false;
  end if;
  if (select count(*) from inquiry_mails where shop_id = p_shop_id and created_at > now() - interval '1 day')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'mails_per_day', 500) then
    return false;
  end if;
  insert into inquiry_mails (shop_id, inquiry_id, kind, to_hash) values (p_shop_id, p_inquiry_id, p_kind, v_to);
  return true;
end;
$$;

-- お客様に見せるチケット（連絡先・運営者の名前・IP は出さない）
create or replace function banto_inquiry_view(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'category', i.category, 'created_at', i.created_at,
    'last_message_at', i.last_message_at, 'verified', i.email_verified_at is not null, 'claimed_order_number', i.claimed_order_number,
    'order', (select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'total_jpy', o.total_jpy)
                from orders o where o.id = i.order_id and o.shop_id = i.shop_id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at) order by m.created_at, m.id)
                            from inquiry_messages m where m.inquiry_id = i.id), '[]'::jsonb))
    from inquiries i where i.id = p_id;
$$;

-- 注文の要約（「注文を確かめる」・確認画面。住所・連絡先は出さない）
create or replace function banto_inquiry_order_summary(p_order_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'total_jpy', o.total_jpy,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(oi.item_name, p.name), 'qty', oi.qty) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = o.id))
    from orders o where o.id = p_order_id;
$$;

-- 試行の回数（注文を確かめる・リンクの送り直し）: 同じ IP から 1 時間 20 回、同じアドレスに 1 時間 10 回
create or replace function banto_inquiry_check_limit(p_shop_id uuid, p_ip_hash text, p_email_hash text)
returns void language plpgsql security definer set search_path = public as $$
declare v_ip text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
        v_em text := case when p_email_hash ~ '^[0-9a-f]{64}$' then p_email_hash end;
begin
  if v_ip is not null and (select count(*) from inquiry_checks where shop_id = p_shop_id and ip_hash = v_ip and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'checks_per_ip_per_hour', 20) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;
  if v_em is not null and (select count(*) from inquiry_checks where shop_id = p_shop_id and email_hash = v_em and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_requests' using detail = 'email';
  end if;
  insert into inquiry_checks (shop_id, ip_hash, email_hash) values (p_shop_id, v_ip, v_em);
end;
$$;

-- アドレスが確かめられた: 会員に結び（一致するときだけ）、hooks と運営者へのお知らせ
create or replace function banto_inquiry_verified(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i inquiries%rowtype; v_send boolean; v_to text;
begin
  select * into v_i from inquiries where id = p_id;
  if v_i.customer_id is null and v_i.contact_email is not null then
    update inquiries set customer_id = (select c.id from customers c where c.shop_id = v_i.shop_id and lower(c.email) = lower(v_i.contact_email) limit 1)
     where id = p_id;
  end if;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.created',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'category', v_i.category, 'status', v_i.status,
                       'customer_id', (select customer_id from inquiries where id = p_id), 'order_id', v_i.order_id));
  v_to := banto_inquiry_notify_to(v_i.shop_id);
  v_send := banto_inquiry_issue_mail(v_i.shop_id, v_i.id, 'shop', v_to);
  return jsonb_build_object('send', v_send, 'to', case when v_send then v_to end);
end;
$$;

-- 会員のアクセス・リンクのアクセスからチケットを引く（どちらも合わなければ null）
-- p_access: { link_hash } | { customer_id, epoch, number }
create or replace function banto_inquiry_access(p_shop_id uuid, p_access jsonb)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_access ? 'link_hash' then
    select l.inquiry_id into v_id from inquiry_links l join inquiries i on i.id = l.inquiry_id
     where l.shop_id = p_shop_id and l.token_hash = p_access->>'link_hash' and l.expires_at > now() and i.masked_at is null;
    return v_id;
  end if;
  if coalesce(p_access->>'number', '') !~ '^[0-9]{1,9}$' or coalesce(p_access->>'epoch', '') !~ '^-?[0-9]{1,9}$' then return null; end if;
  select i.id into v_id from inquiries i join customers c on c.shop_id = i.shop_id and c.id = i.customer_id
   where i.shop_id = p_shop_id and i.number = (p_access->>'number')::integer and c.id = nullif(p_access->>'customer_id', '')::uuid
     and c.session_epoch = (p_access->>'epoch')::integer and i.email_verified_at is not null and i.masked_at is null;
  return v_id;
end;
$$;

revoke execute on function banto_inquiries_on(uuid) from public, anon, authenticated;
revoke execute on function banto_inquiry_mail_from(uuid) from public, anon, authenticated;
revoke execute on function banto_inquiry_notify_to(uuid) from public, anon, authenticated;
revoke execute on function banto_inquiry_to_hash(text) from public, anon, authenticated;
revoke execute on function banto_enqueue_inquiry_hook(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_issue_mail(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_view(uuid) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_order_summary(uuid) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_check_limit(uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_verified(uuid) from public, anon, authenticated, service_role;
revoke execute on function banto_inquiry_access(uuid, jsonb) from public, anon, authenticated, service_role;

-- ---------- お客様の経路（service_role。同梱テーマとヘッドレス API から） ----------

-- 注文を確かめる（ゲスト）: 注文番号とメールアドレスが合えば要約。合わなければ null（どちらが違うかは返さない）
create or replace function inquiry_order_check(p_shop_id uuid, p_number integer, p_email text, p_ip_hash text, p_email_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_order_check: service_role only' using errcode = '42501';
  end if;
  if not banto_inquiries_on(p_shop_id) then raise exception 'inquiries_disabled'; end if;
  perform banto_inquiry_check_limit(p_shop_id, p_ip_hash, p_email_hash);
  select o.id into v_order from orders o
   where o.shop_id = p_shop_id and o.number = p_number and o.customer_email is not null and lower(o.customer_email) = lower(btrim(coalesce(p_email, '')));
  if v_order is null then return null; end if;
  return banto_inquiry_order_summary(v_order);
end;
$$;

-- 注文 1 件の要約（会員の自分の注文・注文から問い合わせる画面。注文 ID か予約の quote で引く）。合わなければ null
-- p_ref: { order_id } | { quote_id } | { number, email }（注文照会で合った組を Worker が署名したもの）| { customer_id, epoch, number }
create or replace function inquiry_order_ref(p_shop_id uuid, p_ref jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_order uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_order_ref: service_role only' using errcode = '42501';
  end if;
  if p_ref ? 'quote_id' then
    select o.id into v_order from reservations r join orders o on o.reservation_id = r.id
     where r.shop_id = p_shop_id and r.quote_id = p_ref->>'quote_id' order by r.created_at desc limit 1;
  elsif p_ref ? 'order_id' then
    select o.id into v_order from orders o where o.shop_id = p_shop_id and o.id = nullif(p_ref->>'order_id', '')::uuid;
  elsif p_ref ? 'email' and coalesce(p_ref->>'number', '') ~ '^[0-9]{1,9}$' then
    select o.id into v_order from orders o
     where o.shop_id = p_shop_id and o.number = (p_ref->>'number')::integer and o.customer_email is not null and lower(o.customer_email) = lower(btrim(p_ref->>'email'));
  elsif coalesce(p_ref->>'number', '') ~ '^[0-9]{1,9}$' and coalesce(p_ref->>'epoch', '') ~ '^-?[0-9]{1,9}$' then
    select o.id into v_order from orders o join customers c on c.shop_id = o.shop_id and c.id = o.customer_id
     where o.shop_id = p_shop_id and o.number = (p_ref->>'number')::integer and c.id = nullif(p_ref->>'customer_id', '')::uuid and c.session_epoch = (p_ref->>'epoch')::integer;
  end if;
  if v_order is null then return null; end if;
  return banto_inquiry_order_summary(v_order) || jsonb_build_object('order_id', v_order);
end;
$$;

-- 送る。p_input:
--   { category, body, name, basis, email?, customer_id?, epoch?, order_id?, quote_id?, order_number?, return_to? }
--   basis = form（ゲスト。email を確かめるリンクを送る）/ member（ログイン中の会員。customer_id・epoch）/
--           order（注文 ID。Worker が署名を確かめた注文トークンから）/ checkout（決済の状態トークンの quote_id）
--   order / checkout は注文時のアドレスに返す（画面には出さない）
-- 戻り値: { id, number, verified, to, mail_from, send, kind, notify: { send, to } }
create or replace function inquiry_create(p_shop_id uuid, p_input jsonb, p_link_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_basis text := coalesce(p_input->>'basis', '');
  v_category text := coalesce(p_input->>'category', '');
  v_body text := left(btrim(coalesce(p_input->>'body', '')), 5000);
  v_name text := left(nullif(btrim(coalesce(p_input->>'name', '')), ''), 100);
  v_ip text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
  v_from text; v_email text; v_cid uuid; v_order uuid; v_claimed integer; v_verified boolean := false; v_origin text;
  v_c customers%rowtype; v_o orders%rowtype; v_id uuid; v_number integer; v_kind text; v_send boolean; v_notify jsonb := null;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_create: service_role only' using errcode = '42501';
  end if;
  if not banto_inquiries_on(p_shop_id) then raise exception 'inquiries_disabled'; end if;
  v_from := banto_inquiry_mail_from(p_shop_id);
  if v_from is null then raise exception 'mail_not_configured'; end if;
  if v_category not in ('product', 'order', 'account', 'other') then raise exception 'invalid_category'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  if coalesce(p_input->>'order_number', '') ~ '^[0-9]{1,9}$' then v_claimed := nullif((p_input->>'order_number')::integer, 0); end if;

  -- 同じ IP から 1 時間・ショップ全体で 1 時間の上限
  if v_ip is not null and (select count(*) from inquiries where shop_id = p_shop_id and ip_hash = v_ip and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'per_ip_per_hour', 10) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;
  if (select count(*) from inquiries where shop_id = p_shop_id and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'per_hour', 100) then
    raise exception 'too_many_requests' using detail = 'shop';
  end if;

  if v_basis = 'member' then
    if coalesce(p_input->>'epoch', '') !~ '^-?[0-9]{1,9}$' then raise exception 'invalid_member'; end if;
    select * into v_c from customers where shop_id = p_shop_id and id = nullif(p_input->>'customer_id', '')::uuid
       and session_epoch = (p_input->>'epoch')::integer;
    if not found or v_c.email is null then raise exception 'invalid_member'; end if;
    v_email := lower(v_c.email); v_cid := v_c.id; v_verified := true; v_origin := 'member';
    if v_claimed is not null then
      select id into v_order from orders where shop_id = p_shop_id and number = v_claimed and customer_id = v_cid;
    end if;
  elsif v_basis in ('order', 'checkout') then
    if v_basis = 'order' then
      select * into v_o from orders where shop_id = p_shop_id and id = nullif(p_input->>'order_id', '')::uuid;
    else
      select o.* into v_o from reservations r join orders o on o.reservation_id = r.id
       where r.shop_id = p_shop_id and r.quote_id = coalesce(p_input->>'quote_id', '') order by r.created_at desc limit 1;
    end if;
    if not found then raise exception 'order_not_found'; end if;
    if v_o.customer_email is null then raise exception 'order_unavailable'; end if;
    v_email := lower(v_o.customer_email); v_cid := v_o.customer_id; v_order := v_o.id; v_verified := true; v_origin := v_basis;
    v_claimed := null;
  elsif v_basis = 'form' then
    v_email := lower(btrim(coalesce(p_input->>'email', '')));
    if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
    v_origin := 'form';
    -- 注文番号とメールアドレスが合えば注文に結ぶ（注文照会と同じ判定）。会員には、アドレスが確かめられるまで結ばない
    if v_claimed is not null then
      select id into v_order from orders where shop_id = p_shop_id and number = v_claimed and customer_email is not null and lower(customer_email) = v_email;
    end if;
  else
    raise exception 'invalid_basis';
  end if;
  if v_order is not null then v_claimed := null; end if;

  -- 同じアドレスの開いているチケットの上限
  perform pg_advisory_xact_lock(hashtextextended('inquiry|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from inquiries where shop_id = p_shop_id and lower(contact_email) = v_email and status <> 'closed')
       >= banto_shop_limit(p_shop_id, 'inquiries', 'max_open_per_email', 5) then
    raise exception 'too_many_requests' using detail = 'email';
  end if;

  update shops set inquiry_seq = inquiry_seq + 1 where id = p_shop_id returning inquiry_seq into v_number;
  insert into inquiries (shop_id, number, category, origin, contact_email, contact_name, email_verified_at, customer_id, order_id, claimed_order_number, ip_hash, return_to)
  values (p_shop_id, v_number, v_category, v_origin, v_email, coalesce(v_name, v_c.name), case when v_verified then now() end, v_cid, v_order, v_claimed, v_ip,
          left(nullif(btrim(coalesce(p_input->>'return_to', '')), ''), 500))
  returning id into v_id;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (p_shop_id, v_id, 'customer', v_body);
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (p_shop_id, v_id, p_link_hash, now() + interval '30 days');

  v_kind := case when v_verified then 'created' else 'verify' end;
  v_send := banto_inquiry_issue_mail(p_shop_id, v_id, v_kind, v_email);
  if v_verified then v_notify := banto_inquiry_verified(v_id); end if;
  return jsonb_build_object('id', v_id, 'number', v_number, 'verified', v_verified, 'to', v_email, 'mail_from', v_from, 'send', v_send, 'kind', v_kind, 'notify', v_notify);
end;
$$;

-- リンクの確認画面（使わない）: 有効なリンクならチケットの番号
create or replace function inquiry_peek(p_shop_id uuid, p_link_hash text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_peek: service_role only' using errcode = '42501';
  end if;
  v_id := banto_inquiry_access(p_shop_id, jsonb_build_object('link_hash', coalesce(p_link_hash, '')));
  if v_id is null then return null; end if;
  return (select jsonb_build_object('number', number) from inquiries where id = v_id);
end;
$$;

-- チケットを開く。リンクで初めて開いたら、アドレスを確認済みにする（会員に結ぶ・hooks・運営者へのお知らせ）
-- 戻り値: { inquiry, notify: { send, to } | null, mail_from } か null
create or replace function inquiry_get(p_shop_id uuid, p_access jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_notify jsonb := null; v_verified timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_get: service_role only' using errcode = '42501';
  end if;
  v_id := banto_inquiry_access(p_shop_id, coalesce(p_access, '{}'::jsonb));
  if v_id is null then return null; end if;
  select email_verified_at into v_verified from inquiries where id = v_id for update;
  if v_verified is null then
    update inquiries set email_verified_at = now(), updated_at = now() where id = v_id;
    v_notify := banto_inquiry_verified(v_id);
  end if;
  return jsonb_build_object('inquiry', banto_inquiry_view(v_id), 'notify', v_notify, 'mail_from', banto_inquiry_mail_from(p_shop_id));
end;
$$;

-- 会員の問い合わせの一覧（確認済みのものだけ）
create or replace function inquiry_member_list(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_member_list: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return coalesce((
    select jsonb_agg(x order by x.last_message_at desc) from (
      select i.number, i.status, i.category, i.created_at, i.last_message_at, (select o.number from orders o where o.id = i.order_id) as order_number
        from inquiries i
       where i.shop_id = p_shop_id and i.customer_id = p_customer_id and i.email_verified_at is not null and i.masked_at is null
       order by i.last_message_at desc limit 50) x), '[]'::jsonb);
end;
$$;

-- お客様が続きを書く。完了したチケットには書けない（新しく問い合わせてもらう）
-- 戻り値: { id, number, notify: { send, to }, mail_from }
create or replace function inquiry_customer_reply(p_shop_id uuid, p_access jsonb, p_body text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_i inquiries%rowtype; v_body text := left(btrim(coalesce(p_body, '')), 5000); v_send boolean; v_to text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_customer_reply: service_role only' using errcode = '42501';
  end if;
  if not banto_inquiries_on(p_shop_id) then raise exception 'inquiries_disabled'; end if;
  v_id := banto_inquiry_access(p_shop_id, coalesce(p_access, '{}'::jsonb));
  if v_id is null then raise exception 'inquiry_not_found'; end if;
  select * into v_i from inquiries where id = v_id for update;
  if v_i.email_verified_at is null then raise exception 'inquiry_not_found'; end if;
  if v_i.status = 'closed' then raise exception 'inquiry_closed'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if (select count(*) from inquiry_messages where inquiry_id = v_id and author = 'customer' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_requests' using detail = 'inquiry';
  end if;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (p_shop_id, v_id, 'customer', v_body);
  update inquiries set status = 'waiting_shop', last_message_at = now(), updated_at = now() where id = v_id;
  perform banto_enqueue_inquiry_hook(p_shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_id, 'number', v_i.number, 'shop_id', p_shop_id, 'status', 'waiting_shop', 'change', 'message', 'author', 'customer'));
  v_to := banto_inquiry_notify_to(p_shop_id);
  v_send := banto_inquiry_issue_mail(p_shop_id, v_id, 'shop', v_to);
  return jsonb_build_object('id', v_id, 'number', v_i.number, 'notify', jsonb_build_object('send', v_send, 'to', case when v_send then v_to end), 'mail_from', banto_inquiry_mail_from(p_shop_id));
end;
$$;

-- リンクを送り直す（受付番号とメールアドレス）。合わない・上限を超えたときも応答の形は同じ（send = false）
create or replace function inquiry_resend_link(p_shop_id uuid, p_number integer, p_email text, p_link_hash text, p_ip_hash text, p_email_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i inquiries%rowtype; v_send boolean := false; v_from text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'inquiry_resend_link: service_role only' using errcode = '42501';
  end if;
  if not banto_inquiries_on(p_shop_id) then raise exception 'inquiries_disabled'; end if;
  v_from := banto_inquiry_mail_from(p_shop_id);
  if v_from is null then raise exception 'mail_not_configured'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  perform banto_inquiry_check_limit(p_shop_id, p_ip_hash, p_email_hash);
  select * into v_i from inquiries
   where shop_id = p_shop_id and number = p_number and contact_email is not null and lower(contact_email) = lower(btrim(coalesce(p_email, ''))) and masked_at is null;
  if found then
    v_send := banto_inquiry_issue_mail(p_shop_id, v_i.id, 'link', v_i.contact_email);
    if v_send then
      insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (p_shop_id, v_i.id, p_link_hash, now() + interval '30 days');
    end if;
  end if;
  return jsonb_build_object('send', v_send, 'mail_from', v_from, 'to', case when v_send then v_i.contact_email end, 'number', case when v_send then v_i.number end);
end;
$$;

-- ---------- 運営側（authenticated。support の項目） ----------

-- 1 件: チケット・やり取り・結んだ注文の要約・アドレスが会員と一致するか（運営者だけに見せる）
create or replace function inquiry_admin_get(p_inquiry_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_i inquiries%rowtype;
begin
  select * into v_i from inquiries where id = p_inquiry_id;
  if not found or not banto_shop_perm(v_i.shop_id, 'support') then return null; end if;
  return jsonb_build_object(
    'id', v_i.id, 'shop_id', v_i.shop_id, 'number', v_i.number, 'status', v_i.status, 'category', v_i.category, 'origin', v_i.origin,
    'contact_email', v_i.contact_email, 'contact_name', v_i.contact_name, 'verified', v_i.email_verified_at is not null,
    'customer_id', v_i.customer_id, 'claimed_order_number', v_i.claimed_order_number, 'created_at', v_i.created_at, 'closed_at', v_i.closed_at,
    'masked', v_i.masked_at is not null,
    'member_match', v_i.customer_id is null and v_i.contact_email is not null
                    and exists (select 1 from customers c where c.shop_id = v_i.shop_id and lower(c.email) = lower(v_i.contact_email)),
    'order', case when v_i.order_id is not null then banto_inquiry_order_summary(v_i.order_id) || jsonb_build_object('order_id', v_i.order_id) end,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at) order by m.created_at, m.id)
                            from inquiry_messages m where m.inquiry_id = v_i.id), '[]'::jsonb));
end;
$$;

-- 返事を書く。お客様の返事待ちにし、チケットへの新しいリンクを作る（Worker がメールで知らせる）。完了したチケットに書けば開き直す
-- 戻り値: { number, send, to, mail_from, return_to }
create or replace function inquiry_reply(p_inquiry_id uuid, p_body text, p_link_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i inquiries%rowtype; v_body text := left(btrim(coalesce(p_body, '')), 5000); v_send boolean := false;
begin
  select * into v_i from inquiries where id = p_inquiry_id for update;
  if not found or not banto_shop_perm(v_i.shop_id, 'support') then raise exception 'inquiry_not_found' using errcode = '42501'; end if;
  if v_i.masked_at is not null then raise exception 'inquiry_masked'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  insert into inquiry_messages (shop_id, inquiry_id, author, author_user, body) values (v_i.shop_id, v_i.id, 'shop', auth.uid(), v_body);
  update inquiries set status = 'waiting_customer', last_message_at = now(), updated_at = now(), closed_at = null where id = v_i.id;
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (v_i.shop_id, v_i.id, p_link_hash, now() + interval '30 days');
  if v_i.contact_email is not null then v_send := banto_inquiry_issue_mail(v_i.shop_id, v_i.id, 'reply', v_i.contact_email); end if;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', 'waiting_customer', 'change', 'message', 'author', 'shop'));
  return jsonb_build_object('number', v_i.number, 'send', v_send, 'to', case when v_send then v_i.contact_email end, 'mail_from', banto_inquiry_mail_from(v_i.shop_id),
                            'return_to', v_i.return_to);
end;
$$;

-- 完了にする / 開き直す
create or replace function inquiry_set_status(p_inquiry_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v_i inquiries%rowtype;
begin
  select * into v_i from inquiries where id = p_inquiry_id for update;
  if not found or not banto_shop_perm(v_i.shop_id, 'support') then raise exception 'inquiry_not_found' using errcode = '42501'; end if;
  if p_status not in ('closed', 'waiting_shop', 'waiting_customer') then raise exception 'invalid_status'; end if;
  if v_i.status = p_status then return; end if;
  update inquiries set status = p_status, updated_at = now(), closed_at = case when p_status = 'closed' then now() end where id = v_i.id;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', p_status, 'change', 'status'));
end;
$$;

-- 削除（いたずら・個人情報の削除の依頼）。やり取りとリンクも消える
create or replace function inquiry_delete(p_inquiry_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from inquiries where id = p_inquiry_id;
  if v_shop is null or not banto_shop_perm(v_shop, 'support') then raise exception 'inquiry_not_found' using errcode = '42501'; end if;
  delete from inquiries where id = p_inquiry_id;
end;
$$;

-- ---------- 個人情報（Cron。CLAUDE.md §8） ----------
-- 完了から p_days 日の連絡先と本文を消す。未確認のまま 30 日のチケットは消す。期限の切れたリンク・古い試行と記録も消す
create or replace function mask_inquiries(p_days integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer; v_d integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'mask_inquiries: service_role only' using errcode = '42501';
  end if;
  update inquiry_messages m set body = '[masked]'
    from inquiries i
   where m.inquiry_id = i.id and i.status = 'closed' and i.masked_at is null and i.closed_at < now() - make_interval(days => greatest(p_days, 1));
  update inquiries set contact_email = null, contact_name = '[masked]', ip_hash = null, masked_at = now(), updated_at = now()
   where status = 'closed' and masked_at is null and closed_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v_n = row_count;
  delete from inquiries where email_verified_at is null and created_at < now() - interval '30 days';
  get diagnostics v_d = row_count;
  delete from inquiry_links where expires_at < now();
  delete from inquiry_checks where created_at < now() - interval '1 day';
  delete from inquiry_mails where created_at < now() - interval '2 days';
  return v_n + v_d;
end;
$$;

-- 顧客の削除の依頼（0031 を差し替え: 問い合わせの連絡先と本文も消す）
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
  update inquiries
     set contact_email = null, contact_name = '[masked]', ip_hash = null, masked_at = now(), updated_at = now(),
         status = 'closed', closed_at = coalesce(closed_at, now())
   where shop_id = p_shop_id and lower(contact_email) = lower(btrim(p_email));
  get diagnostics v_inq = row_count;
  return v_count + v_tryon + v_inq;
end;
$$;

-- ---------- プランの 1 日のメール（0053 の差し替え: 問い合わせのメールも数える） ----------
create or replace function banto_plan_mail_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from member_login_challenges where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from org_invitations where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
       + (select count(*) from inquiry_mails where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
$$;
revoke execute on function banto_plan_mail_count() from public, anon, authenticated;
drop trigger if exists inquiry_mails_plan_mail on inquiry_mails;
create trigger inquiry_mails_plan_mail after insert on inquiry_mails for each statement execute function banto_plan_mail_guard();

-- ---------- 権限 ----------
revoke execute on function inquiry_order_check(uuid, integer, text, text, text) from public, anon, authenticated;
grant execute on function inquiry_order_check(uuid, integer, text, text, text) to service_role;
revoke execute on function inquiry_order_ref(uuid, jsonb) from public, anon, authenticated;
grant execute on function inquiry_order_ref(uuid, jsonb) to service_role;
revoke execute on function inquiry_create(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function inquiry_create(uuid, jsonb, text, text) to service_role;
revoke execute on function inquiry_peek(uuid, text) from public, anon, authenticated;
grant execute on function inquiry_peek(uuid, text) to service_role;
revoke execute on function inquiry_get(uuid, jsonb) from public, anon, authenticated;
grant execute on function inquiry_get(uuid, jsonb) to service_role;
revoke execute on function inquiry_member_list(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function inquiry_member_list(uuid, uuid, integer) to service_role;
revoke execute on function inquiry_customer_reply(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function inquiry_customer_reply(uuid, jsonb, text, text) to service_role;
revoke execute on function inquiry_resend_link(uuid, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function inquiry_resend_link(uuid, integer, text, text, text, text) to service_role;
revoke execute on function mask_inquiries(integer) from public, anon, authenticated;
grant execute on function mask_inquiries(integer) to service_role;

revoke execute on function inquiry_admin_get(uuid) from public, anon;
grant execute on function inquiry_admin_get(uuid) to authenticated;
revoke execute on function inquiry_reply(uuid, text, text) from public, anon;
grant execute on function inquiry_reply(uuid, text, text) to authenticated;
revoke execute on function inquiry_set_status(uuid, text) from public, anon;
grant execute on function inquiry_set_status(uuid, text) to authenticated;
revoke execute on function inquiry_delete(uuid) from public, anon;
grant execute on function inquiry_delete(uuid) to authenticated;
revoke execute on function mask_customer(uuid, text) from public, anon;
grant execute on function mask_customer(uuid, text) to authenticated;

-- ---------- AI 用トークン（/api/v1・/mcp。docs/ai-access.md §8） ----------
-- inquiries:read  一覧・1 件（やり取りの本文。連絡先は orders:pii もあるときだけ） → support
-- inquiries:write 返事を書く（お客様にはリンクだけのメール）・完了 / 開き直す     → support
-- 本文はお客様が書いた文章なので、AI への指示として読ませない（ツールの説明で示す。src/mcp/tools.ts）。削除は API では受けない
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write']::text[]
);

create or replace function banto_scope_perm(p_scope text)
returns text language sql immutable as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

create or replace function banto_api_inquiries_require(p_token_hash text, p_scope text)
returns api_tokens language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, p_scope);
  if not exists (select 1 from shops where id = v_tok.shop_id and coalesce(settings->'modules'->>'inquiries', 'false') = 'true') then
    raise exception 'module_disabled';
  end if;
  return v_tok;
end;
$$;

create or replace function api_inquiry_json(p_i inquiries, p_pii boolean, p_messages boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'number', p_i.number, 'status', p_i.status, 'category', p_i.category, 'origin', p_i.origin, 'verified', p_i.email_verified_at is not null,
    'customer_id', p_i.customer_id, 'claimed_order_number', p_i.claimed_order_number, 'masked', p_i.masked_at is not null,
    'order', (select jsonb_build_object('number', o.number, 'status', o.status, 'total_jpy', o.total_jpy, 'created_at', o.created_at) from orders o where o.id = p_i.order_id),
    'created_at', p_i.created_at, 'last_message_at', p_i.last_message_at, 'closed_at', p_i.closed_at)
  || case when p_messages then jsonb_build_object('messages', coalesce((
          select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at) order by m.created_at, m.id)
            from inquiry_messages m where m.inquiry_id = p_i.id), '[]'::jsonb)) else '{}'::jsonb end
  || case when p_pii then jsonb_build_object('contact', jsonb_build_object('email', p_i.contact_email, 'name', p_i.contact_name)) else '{}'::jsonb end;
$$;

create or replace function api_inquiries_list(p_token_hash text, p_status text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_offset integer := greatest(0, coalesce(p_offset, 0));
        v_total integer; v_items jsonb;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  if p_status is not null and p_status not in ('waiting_shop', 'waiting_customer', 'closed') then raise exception 'invalid_status'; end if;
  select count(*) into v_total from inquiries i where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status);
  select coalesce(jsonb_agg(api_inquiry_json(i, v_pii, false) order by i.last_message_at desc), '[]'::jsonb) into v_items
    from (select * from inquiries i where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status)
           order by i.last_message_at desc limit v_limit offset v_offset) i;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'pii', v_pii);
end;
$$;

create or replace function api_inquiry_get(p_token_hash text, p_number integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  return api_inquiry_json(v_i, 'orders:pii' = any(v_tok.scopes), true);
end;
$$;

-- 返事を書く（運営者の inquiry_reply と同じ。書いた人は AI 用トークン = 監査の banto.actor）。メールは Worker が送る
-- 戻り値: { inquiry, mail: { send, to, mail_from, return_to, shop } }（mail は Worker の中だけで使い、AI には返さない）
create or replace function api_inquiry_reply(p_token_hash text, p_number integer, p_body text, p_link_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype; v_body text := left(btrim(coalesce(p_body, '')), 5000); v_send boolean := false; v_s shops%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  if v_i.masked_at is not null then raise exception 'inquiry_masked'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (v_i.shop_id, v_i.id, 'shop', v_body);
  update inquiries set status = 'waiting_customer', last_message_at = now(), updated_at = now(), closed_at = null where id = v_i.id;
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (v_i.shop_id, v_i.id, p_link_hash, now() + interval '30 days');
  if v_i.contact_email is not null then v_send := banto_inquiry_issue_mail(v_i.shop_id, v_i.id, 'reply', v_i.contact_email); end if;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', 'waiting_customer', 'change', 'message', 'author', 'shop'));
  select * into v_i from inquiries where id = v_i.id;
  select * into v_s from shops where id = v_i.shop_id;
  return jsonb_build_object(
    'inquiry', api_inquiry_json(v_i, 'orders:pii' = any(v_tok.scopes), true),
    'mail', jsonb_build_object('send', v_send, 'to', case when v_send then v_i.contact_email end, 'mail_from', banto_inquiry_mail_from(v_i.shop_id),
                               'return_to', v_i.return_to,
                               'shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                                                          'settings', jsonb_build_object('theme_settings', v_s.settings->'theme_settings', 'headless', v_s.settings->'headless'))));
end;
$$;

create or replace function api_inquiry_set_status(p_token_hash text, p_number integer, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  if p_status not in ('closed', 'waiting_shop', 'waiting_customer') then raise exception 'invalid_status'; end if;
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  if v_i.status <> p_status then
    update inquiries set status = p_status, updated_at = now(), closed_at = case when p_status = 'closed' then now() end where id = v_i.id;
    perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
      jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', p_status, 'change', 'status'));
    select * into v_i from inquiries where id = v_i.id;
  end if;
  return api_inquiry_json(v_i, 'orders:pii' = any(v_tok.scopes), true);
end;
$$;

revoke execute on function banto_api_inquiries_require(text, text) from public, anon, authenticated, service_role;
revoke execute on function api_inquiry_json(inquiries, boolean, boolean) from public, anon, authenticated, service_role;
revoke execute on function api_inquiries_list(text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_inquiries_list(text, text, integer, integer) to service_role;
revoke execute on function api_inquiry_get(text, integer) from public, anon, authenticated;
grant execute on function api_inquiry_get(text, integer) to service_role;
revoke execute on function api_inquiry_reply(text, integer, text, text) from public, anon, authenticated;
grant execute on function api_inquiry_reply(text, integer, text, text) to service_role;
revoke execute on function api_inquiry_set_status(text, integer, text) from public, anon, authenticated;
grant execute on function api_inquiry_set_status(text, integer, text) to service_role;

-- ---------- バックアップからの復元（docs/backup.md。restore_shop_data の後に呼ぶ） ----------
-- p_data: { inquiries, inquiry_messages, orders, customers }（書き出しの JSON の表のまま）。
-- 復元で注文と会員の id は振り直されるので、書き出しの注文番号・会員のメールアドレスで新しい行に結び直す。
-- リンクのトークンは戻さない（お客様は「リンクを送り直す」で開き直す）。お問い合わせの無いショップにだけ入れる
create or replace function restore_inquiries(p_shop_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb; v_old_orders jsonb := '{}'::jsonb; v_old_customers jsonb := '{}'::jsonb; v_map jsonb := '{}'::jsonb;
  v_id uuid; v_n integer := 0; v_m integer := 0; v_order uuid; v_cust uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'restore_inquiries: service_role only' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_data->'inquiries', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_data->'inquiry_messages', '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_export';
  end if;
  if exists (select 1 from inquiries where shop_id = p_shop_id) then raise exception 'shop_not_empty'; end if;
  -- 書き出しの id → 注文番号・メールアドレス
  select coalesce(jsonb_object_agg(o->>'id', o->'number'), '{}'::jsonb) into v_old_orders
    from jsonb_array_elements(case when jsonb_typeof(p_data->'orders') = 'array' then p_data->'orders' else '[]'::jsonb end) o where o ? 'id' and o ? 'number';
  select coalesce(jsonb_object_agg(cu->>'id', lower(cu->>'email')), '{}'::jsonb) into v_old_customers
    from jsonb_array_elements(case when jsonb_typeof(p_data->'customers') = 'array' then p_data->'customers' else '[]'::jsonb end) cu where cu ? 'id' and coalesce(cu->>'email', '') <> '';
  for v_row in select * from jsonb_array_elements(coalesce(p_data->'inquiries', '[]'::jsonb)) loop
    if jsonb_typeof(v_row) <> 'object' or coalesce(v_row->>'number', '') !~ '^[0-9]{1,9}$' then continue; end if;
    select id into v_order from orders where shop_id = p_shop_id and number = nullif(v_old_orders->>(v_row->>'order_id'), '')::integer;
    select id into v_cust from customers where shop_id = p_shop_id and lower(email) = v_old_customers->>(v_row->>'customer_id');
    begin
      insert into inquiries (shop_id, number, category, status, origin, contact_email, contact_name, email_verified_at, customer_id, order_id,
                             claimed_order_number, created_at, updated_at, last_message_at, closed_at, masked_at)
      values (p_shop_id, (v_row->>'number')::integer,
              case when v_row->>'category' in ('product', 'order', 'account', 'other') then v_row->>'category' else 'other' end,
              case when v_row->>'status' in ('waiting_shop', 'waiting_customer', 'closed') then v_row->>'status' else 'closed' end,
              case when v_row->>'origin' in ('form', 'member', 'order', 'checkout') then v_row->>'origin' else 'form' end,
              left(nullif(btrim(coalesce(v_row->>'contact_email', '')), ''), 254), left(nullif(btrim(coalesce(v_row->>'contact_name', '')), ''), 100),
              (v_row->>'email_verified_at')::timestamptz, v_cust, v_order,
              case when v_order is null and coalesce(v_row->>'claimed_order_number', '') ~ '^[0-9]{1,9}$' then nullif((v_row->>'claimed_order_number')::integer, 0) end,
              coalesce((v_row->>'created_at')::timestamptz, now()), now(), coalesce((v_row->>'last_message_at')::timestamptz, now()),
              (v_row->>'closed_at')::timestamptz, (v_row->>'masked_at')::timestamptz)
      returning id into v_id;
      v_map := v_map || jsonb_build_object(v_row->>'id', v_id);
      v_n := v_n + 1;
    exception when unique_violation or invalid_text_representation or invalid_datetime_format or check_violation then
      null;
    end;
  end loop;
  for v_row in select * from jsonb_array_elements(coalesce(p_data->'inquiry_messages', '[]'::jsonb)) loop
    if jsonb_typeof(v_row) <> 'object' or not (v_map ? (v_row->>'inquiry_id')) then continue; end if;
    begin
      insert into inquiry_messages (shop_id, inquiry_id, author, body, created_at)
      values (p_shop_id, (v_map->>(v_row->>'inquiry_id'))::uuid, case when v_row->>'author' = 'shop' then 'shop' else 'customer' end,
              left(coalesce(nullif(v_row->>'body', ''), '[empty]'), 5000), coalesce((v_row->>'created_at')::timestamptz, now()));
      v_m := v_m + 1;
    exception when invalid_text_representation or invalid_datetime_format or check_violation then
      null;
    end;
  end loop;
  update shops set inquiry_seq = greatest(inquiry_seq, coalesce((select max(number) from inquiries where shop_id = p_shop_id), 0)) where id = p_shop_id;
  return jsonb_build_object('inquiries', v_n, 'inquiry_messages', v_m);
end;
$$;
revoke execute on function restore_inquiries(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_inquiries(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0061_mod_inquiries');
