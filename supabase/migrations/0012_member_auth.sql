-- Banto 0012_member_auth: 会員のアカウントを店ごとに Banto が持つ（docs/knowledge/10-members-identity.md）
-- 前方専用。
--
-- 会員 = ショップごとの customers 行（Supabase Auth のユーザーではなくなる）。運営者は今までどおり Supabase Auth。
-- ログインはパスワードなし: メールに届く 6 桁のコードか、ログインのリンク。
--   - コード・リンクのトークン・IP は Worker が HMAC（サイトの秘密）にしてから渡す。生の値は DB に来ない。
--     DB だけが漏れても 6 桁のコードを逆算できないようにするため（素の SHA-256 なら一瞬で総当たりできる）。
--   - 照合・回数の制限・失効・使い捨ては、すべてこのファイルの関数の中で行う（Worker の書き間違いで制限をすり抜けられないように）。
--   - セッションは Worker の署名付き Cookie / トークン。customers.session_epoch を上げると、それより前のセッションは一斉に無効。
-- すべて service_role だけ（member_set_email は owner）。呼び出しは src/db/privileged.ts から。
-- 実稼働の前に入れたので、Supabase Auth 版の会員（0004 の RLS の経路・0011 の取り込み）は残さず消す。

-- ---------- customers: Auth のユーザーとの結びつきを外す ----------
alter table customers drop constraint if exists customers_id_fkey;
alter table customers alter column id set default gen_random_uuid();
alter table customers add column if not exists session_epoch integer not null default 0;
alter table customers add column if not exists last_login_at timestamptz;
-- 店の中でメールアドレスは 1 人（大文字小文字を区別しない）。照合はこの索引で引く
create unique index if not exists customers_shop_email_key on customers (shop_id, lower(email)) where email is not null;

-- ---------- ログインのチャレンジ（発行したコードとリンク） ----------
create table member_login_challenges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  -- 送り先（小文字）。初回のログインで会員を作るときにも使う
  email text not null check (length(email) between 3 and 254),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  link_hash text not null check (link_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  -- ヘッドレスのリンクの戻り先（Worker が許可リストで確かめたもの）
  return_to text,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index member_login_challenges_email_idx on member_login_challenges (shop_id, email, created_at);
create index member_login_challenges_ip_idx on member_login_challenges (shop_id, ip_hash, created_at) where ip_hash is not null;
alter table member_login_challenges enable row level security;
-- 誰にも見せない（service_role は RLS を通らない。関数からだけ触る）
create policy member_login_challenges_none on member_login_challenges for select using (false);

-- ---------- ログインを始める ----------
-- 回数の制限（10-members-identity.md §6）: 同じ人（店 × メールアドレス）に 15 分で 5 回・1 日 20 回、同じ IP から 1 時間に 30 回。
-- 超えたら送らない。応答の形は変えない（send = false と、使われない ID）。
-- 送信元は、そのショップで有効な同梱のメールプラグイン（Resend）の「送信元」。無ければ mail_not_configured。
-- 戻り値: { send, challenge_id, mail_from }
create or replace function member_login_start(p_shop_id uuid, p_email text, p_code_hash text, p_link_hash text, p_ip_hash text, p_return_to text, p_ttl_seconds integer default 900)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_from text;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_start: service_role only' using errcode = '42501';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    raise exception 'members_disabled';
  end if;
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  if v_from is null then raise exception 'mail_not_configured'; end if;

  -- 同じ人の同時の申込みだけを直列にする（数えてから入れるまでの間に割り込まれないように）
  perform pg_advisory_xact_lock(hashtextextended('member_login|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5
     or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '1 day') >= 20
     or (p_ip_hash is not null and (select count(*) from member_login_challenges where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30) then
    return jsonb_build_object('send', false, 'challenge_id', gen_random_uuid(), 'mail_from', v_from);
  end if;

  -- 有効なコードは常に 1 つ（前のコードを無効にする。出し直しで試せる数を増やさない）
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email = v_email and consumed_at is null;
  insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, return_to, expires_at)
  values (p_shop_id, v_email, p_code_hash, p_link_hash, p_ip_hash, nullif(left(p_return_to, 500), ''),
          now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 900), 3600))))
  returning id into v_id;
  return jsonb_build_object('send', true, 'challenge_id', v_id, 'mail_from', v_from);
end;
$$;

-- ---------- 照合する ----------
-- コード（p_code_hash）かリンクのトークン（p_link_hash）のどちらか。5 回間違えたらそのチャレンジは無効。
-- 失敗は例外にしない（例外にすると間違えた回数の加算まで取り消される）。
-- 成功したら使用済みにし、会員を引く（無ければ作る = 初回のログインが会員登録）。
-- 戻り値: { ok: true, customer_id, session_epoch, email, created, return_to } / { ok: false, reason: 'invalid' | 'expired' }
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
  -- 同じチャレンジを同時に照合しても、成功は 1 回だけ
  select * into v_ch from member_login_challenges where id = p_challenge_id and shop_id = p_shop_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_ch.consumed_at is not null or v_ch.expires_at < now() or v_ch.attempts >= 5 then
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

-- メールのリンクを開いた先の確認画面に出すアドレス（使わない・数えない。トークンは推測できない長さなので回数の制限は要らない）。
-- 合わない・期限切れなら null。画面にはアドレスを伏せて出す（他人のリンクを踏まされたときに気づけるように）
create or replace function member_login_peek(p_shop_id uuid, p_challenge_id uuid, p_link_hash text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.role() = 'service_role' then (
    select email from member_login_challenges
     where id = p_challenge_id and shop_id = p_shop_id and link_hash = p_link_hash
       and consumed_at is null and expires_at > now() and attempts < 5) end;
$$;

-- ---------- ログイン中の会員の読み書き（世代が合うときだけ） ----------
-- 会員の行と、このショップでの注文（新しい順に 50 件）。世代が違う・退会済みなら null
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
    'customer', jsonb_build_object('id', v_c.id, 'shop_id', v_c.shop_id, 'email', v_c.email, 'name', v_c.name, 'default_address', v_c.default_address),
    'orders', case when p_with_orders then coalesce((
      select jsonb_agg(o order by o.created_at desc) from (
        select id, number, status, total_jpy, shipping_jpy, coalesce(discount_jpy, 0) as discount_jpy, created_at, shipped_at
          from orders where shop_id = p_shop_id and customer_id = p_customer_id
         order by created_at desc limit 50) o), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

create or replace function member_save_address(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_name text, p_address jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_save_address: service_role only' using errcode = '42501';
  end if;
  update customers
     set name = nullif(left(btrim(coalesce(p_name, '')), 200), ''),
         default_address = case when jsonb_typeof(p_address) = 'object' then p_address end
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;

-- 退会: customers 行を消す（注文は残る）
create or replace function member_withdraw(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_withdraw: service_role only' using errcode = '42501';
  end if;
  delete from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;

-- 全端末からログアウト（世代を上げる）
create or replace function member_logout_all(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_logout_all: service_role only' using errcode = '42501';
  end if;
  update customers set session_epoch = session_epoch + 1
   where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch;
  return found;
end;
$$;

-- ---------- 運営者が会員のメールアドレスを変える（メールを失った会員の救済） ----------
-- owner の JWT で呼ぶ。世代を上げて今のセッションを無効にする。前後のアドレスへの知らせは Worker が送る。
-- 戻り値: { old_email, new_email }
create or replace function member_set_email(p_shop_id uuid, p_customer_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_old text;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  select email into v_old from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if not found then raise exception 'customer_not_found'; end if;
  if exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_email and id <> p_customer_id) then
    raise exception 'email_taken';
  end if;
  update customers set email = v_email, session_epoch = session_epoch + 1 where shop_id = p_shop_id and id = p_customer_id;
  -- 未使用のチャレンジは前のアドレスのものも含めて無効にする
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email in (lower(coalesce(v_old, '')), v_email) and consumed_at is null;
  return jsonb_build_object('old_email', v_old, 'new_email', v_email);
end;
$$;

-- ---------- 一括取り込み（WooCommerce から。0011 の import_customers の置き換え） ----------
-- p_rows: [{ email, name, default_address }]（最大 100 件）。メールアドレスで引き、無ければ作る。足りない項目だけ埋める
create or replace function import_members(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_email text;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_new boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'import_members: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 100 then raise exception 'too_many_rows'; end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e loop
    v_email := lower(btrim(coalesce(v_row->>'email', '')));
    if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into customers (shop_id, email, name, default_address)
    values (p_shop_id, v_email, nullif(left(btrim(coalesce(v_row->>'name', '')), 200), ''),
            case when jsonb_typeof(v_row->'default_address') = 'object' then v_row->'default_address' end)
    on conflict (shop_id, lower(email)) where email is not null do update
       set name = coalesce(customers.name, excluded.name),
           default_address = coalesce(customers.default_address, excluded.default_address)
    returning (xmax = 0) into v_new;
    if v_new then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped);
end;
$$;

-- ---------- 予約に会員を付けるときに世代を確かめる（0004 の attach を差し替え） ----------
-- p_customer.customer_id があるときは p_customer.customer_epoch が今の世代と一致すること（全端末からログアウトした後の古いセッションで注文させない）
create or replace function attach_reservation_customer(p_reservation_id uuid, p_shop_id uuid, p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shipping integer; v_customer_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'attach_reservation_customer: service_role only' using errcode = '42501';
  end if;
  v_shipping := coalesce((p_customer->>'shipping_jpy')::integer, 0);
  if v_shipping < 0 then raise exception 'invalid_shipping'; end if;
  v_customer_id := nullif(p_customer->>'customer_id', '')::uuid;
  if v_customer_id is not null and not exists (
       select 1 from customers where shop_id = p_shop_id and id = v_customer_id
          and session_epoch = coalesce(nullif(p_customer->>'customer_epoch', '')::integer, -1)) then
    raise exception 'member_session_invalid';
  end if;
  update reservations
     set customer = p_customer - 'shipping_jpy' - 'customer_id' - 'customer_epoch',
         shipping_jpy = v_shipping,
         customer_id = v_customer_id
   where id = p_reservation_id and shop_id = p_shop_id and status = 'pending';
  if not found then
    raise exception 'reservation_not_found' using detail = p_reservation_id::text;
  end if;
end;
$$;

-- ---------- 片付け（Cron） ----------
create or replace function member_login_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_cleanup: service_role only' using errcode = '42501';
  end if;
  delete from member_login_challenges where created_at < now() - interval '2 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------- Supabase Auth を前提にした会員の経路を消す（実稼働の前なので 2 段階にしない） ----------
-- 会員は auth.uid() を持たない（service_role の member_* RPC で読み書きする）。owner の経路（customers_owner_*）は残す
drop policy if exists customers_self on customers;
drop policy if exists orders_customer_select on orders;
drop policy if exists order_items_customer_select on order_items;
-- 0011 の取り込み（Auth のユーザーを作る版）は import_members に置き換えた
drop function if exists banto_users_by_email(text[]);
drop function if exists import_customers(uuid, jsonb);

-- ---------- バックアップからの復元（0006 を差し替え: 会員を auth.users と突き合わせない） ----------
create or replace function restore_shop_data(p_shop_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_products jsonb := coalesce(p_data->'products', '[]'::jsonb);
  v_skus jsonb := coalesce(p_data->'skus', '[]'::jsonb);
  v_inventory jsonb := coalesce(p_data->'inventory', '[]'::jsonb);
  v_images jsonb := coalesce(p_data->'product_images', '[]'::jsonb);
  v_orders jsonb := coalesce(p_data->'orders', '[]'::jsonb);
  v_items jsonb := coalesce(p_data->'order_items', '[]'::jsonb);
  v_customers jsonb := coalesce(p_data->'customers', '[]'::jsonb);
  v_endpoints jsonb := coalesce(p_data->'hook_endpoints', '[]'::jsonb);
  v_row jsonb;
  v_new uuid;
  v_old uuid;
  v_product_map jsonb := '{}'::jsonb;
  v_sku_map jsonb := '{}'::jsonb;
  v_order_map jsonb := '{}'::jsonb;
  v_customer_ok jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  v_skipped_items integer := 0;
  v_skipped_customers integer := 0;
  v_max_number integer;
begin
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if exists (select 1 from products where shop_id = p_shop_id) or exists (select 1 from orders where shop_id = p_shop_id) then
    raise exception 'shop_not_empty';
  end if;
  if jsonb_typeof(v_products) <> 'array' or jsonb_typeof(v_orders) <> 'array' then raise exception 'invalid_export'; end if;

  -- 商品
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_products) loop
    v_old := (v_row->>'id')::uuid;
    insert into products (shop_id, slug, name, description, published, created_at, updated_at)
      values (p_shop_id, v_row->>'slug', v_row->>'name', v_row->>'description', coalesce((v_row->>'published')::boolean, false),
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
    v_product_map := v_product_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('products', v_n);

  -- SKU（inventory 行はトリガーで作られる）→ 在庫数を戻す
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_skus) loop
    if v_product_map ? (v_row->>'product_id') then
      v_old := (v_row->>'id')::uuid;
      insert into skus (shop_id, product_id, code, name, price_jpy, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'code', v_row->>'name', (v_row->>'price_jpy')::integer,
                coalesce((v_row->>'created_at')::timestamptz, now()))
        returning id into v_new;
      v_sku_map := v_sku_map || jsonb_build_object(v_old::text, v_new::text);
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('skus', v_n);
  for v_row in select * from jsonb_array_elements(v_inventory) loop
    if v_sku_map ? (v_row->>'sku_id') then
      update inventory set available = greatest(0, coalesce((v_row->>'available')::integer, 0))
        where sku_id = (v_sku_map->>(v_row->>'sku_id'))::uuid and shop_id = p_shop_id;
    end if;
  end loop;

  -- 画像（R2 のキーはそのまま）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_images) loop
    if v_product_map ? (v_row->>'product_id') then
      insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, sort_order, created_at)
        values (p_shop_id, (v_product_map->>(v_row->>'product_id'))::uuid, v_row->>'storage_key', v_row->>'thumb_key',
                (v_row->>'width')::integer, (v_row->>'height')::integer, coalesce((v_row->>'sort_order')::integer, 0),
                coalesce((v_row->>'created_at')::timestamptz, now()));
      v_n := v_n + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('product_images', v_n);

  -- 会員: 0012 から会員は Supabase Auth と関係ないので、すべて戻す（同じ id のまま。主キーは (shop_id, id)）。
  -- 同じメールアドレスが重なる行・メールアドレスの無い行は飛ばす
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_customers) loop
    v_old := (v_row->>'id')::uuid;
    if nullif(btrim(coalesce(v_row->>'email', '')), '') is not null
       and not exists (select 1 from customers c where c.shop_id = p_shop_id and lower(c.email) = lower(btrim(v_row->>'email'))) then
      insert into customers (id, shop_id, email, name, default_address, created_at)
        values (v_old, p_shop_id, lower(btrim(v_row->>'email')), v_row->>'name', v_row->'default_address', coalesce((v_row->>'created_at')::timestamptz, now()))
        on conflict do nothing;
      v_customer_ok := v_customer_ok || jsonb_build_object(v_old::text, true);
      v_n := v_n + 1;
    else
      v_skipped_customers := v_skipped_customers + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('customers', v_n, 'customers_skipped', v_skipped_customers);

  -- 注文（予約との紐づけは切る。番号は維持）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_orders) loop
    v_old := (v_row->>'id')::uuid;
    insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, number, customer_email, customer_name, shipping_address,
                        payment_provider, payment_ref, shipped_at, customer_id, created_at, updated_at)
      values (p_shop_id, null, coalesce((v_row->>'status')::order_status, 'paid'), coalesce((v_row->>'total_jpy')::integer, 0),
              coalesce((v_row->>'shipping_jpy')::integer, 0), (v_row->>'number')::integer, v_row->>'customer_email', v_row->>'customer_name',
              v_row->'shipping_address', v_row->>'payment_provider', v_row->>'payment_ref', (v_row->>'shipped_at')::timestamptz,
              case when v_customer_ok ? (v_row->>'customer_id') then (v_row->>'customer_id')::uuid else null end,
              coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'updated_at')::timestamptz, now()))
      returning id into v_new;
    v_order_map := v_order_map || jsonb_build_object(v_old::text, v_new::text);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('orders', v_n);
  select max(number) into v_max_number from orders where shop_id = p_shop_id;
  if v_max_number is not null then
    update shops set order_seq = greatest(order_seq, v_max_number) where id = p_shop_id;
  end if;

  -- 明細（SKU が復元されていない行は飛ばす: skus.id への FK があるため）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_items) loop
    if v_order_map ? (v_row->>'order_id') and v_sku_map ? (v_row->>'sku_id') then
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy)
        values (p_shop_id, (v_order_map->>(v_row->>'order_id'))::uuid, (v_sku_map->>(v_row->>'sku_id'))::uuid,
                (v_row->>'qty')::integer, (v_row->>'unit_price_jpy')::integer);
      v_n := v_n + 1;
    else
      v_skipped_items := v_skipped_items + 1;
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('order_items', v_n, 'order_items_skipped', v_skipped_items);

  -- 連携先（id は振り直す = 署名シークレットも変わる。外部プラグイン側の再設定が要る）
  v_n := 0;
  for v_row in select * from jsonb_array_elements(v_endpoints) loop
    insert into hook_endpoints (shop_id, name, url, events, enabled, manifest, settings, created_at)
      values (p_shop_id, v_row->>'name', v_row->>'url',
              coalesce((select array_agg(e) from jsonb_array_elements_text(coalesce(v_row->'events', '[]'::jsonb)) e), '{}'),
              coalesce((v_row->>'enabled')::boolean, true), v_row->'manifest', coalesce(v_row->'settings', '{}'::jsonb),
              coalesce((v_row->>'created_at')::timestamptz, now()));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('hook_endpoints', v_n);

  return v_counts;
end;
$$;

-- ---------- 実行権限 ----------
revoke execute on function member_login_start(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function member_login_verify(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function member_login_peek(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function member_get(uuid, uuid, integer, boolean) from public, anon, authenticated;
revoke execute on function member_save_address(uuid, uuid, integer, text, jsonb) from public, anon, authenticated;
revoke execute on function member_withdraw(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function member_logout_all(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function member_set_email(uuid, uuid, text) from public, anon;
revoke execute on function import_members(uuid, jsonb) from public, anon, authenticated;
revoke execute on function attach_reservation_customer(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function member_login_cleanup() from public, anon, authenticated;
revoke all on function restore_shop_data(uuid, jsonb) from public, anon, authenticated;
grant execute on function member_login_start(uuid, text, text, text, text, text, integer) to service_role;
grant execute on function member_login_verify(uuid, uuid, text, text) to service_role;
grant execute on function member_login_peek(uuid, uuid, text) to service_role;
grant execute on function member_get(uuid, uuid, integer, boolean) to service_role;
grant execute on function member_save_address(uuid, uuid, integer, text, jsonb) to service_role;
grant execute on function member_withdraw(uuid, uuid, integer) to service_role;
grant execute on function member_logout_all(uuid, uuid, integer) to service_role;
grant execute on function member_set_email(uuid, uuid, text) to authenticated;
grant execute on function import_members(uuid, jsonb) to service_role;
grant execute on function attach_reservation_customer(uuid, uuid, jsonb) to service_role;
grant execute on function member_login_cleanup() to service_role;
grant execute on function restore_shop_data(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0012_member_auth');
