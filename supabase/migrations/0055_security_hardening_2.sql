-- Banto 0055_security_hardening_2: 2026-10-25 の監査で見つかった「権限の項目（0024）の追従漏れ」を SQL で閉じる。前方専用。
--
-- 直すもの（すべて「判定は SQL」の原則どおり、Worker の分岐に頼らない）:
--   1. AI 用トークン: api_require が返すスコープを、発行者が今も持つ項目のものだけに絞る（orders:pii の分岐が
--      scopes 配列だけを見ていたため、発行者から customers の項目を外した後も個人情報が返っていた）。
--   2. AI 用トークンの失効・帰属: 組織の owner / admin が member の発行したトークンを失効できなかった（with check の
--      owner_id = auth.uid() が UPDATE にも効いていた）。逆に integrations の member は他人の行を DELETE・帰属を付け替え・
--      失効を取り消せた。INSERT と UPDATE のポリシーを分け、変えてよい列を revoked_at（null → 時刻）と name だけにする。DELETE は無し。
--   3. organizations.require_mfa: admin が直接 UPDATE で切り替えられた（owner + aal2 + 監査の org_set_require_mfa の迂回）。列の権限で止める。
--   4. products.attributes: 「非公開（public: false）」の独自項目の値が anon キーで直接読めた。anon には列を見せず、
--      お店の画面と公開 API は product_public_get（公開の項目だけ）で読む。public の settings に出す product_fields も公開の項目だけ。
--   5. import_member_passwords: 既にログインしたことのある会員（コードやリンクで入っている普通の会員）には書かない
--      （WordPress からの取り込みはログイン前の会員だけが対象。入口の項目は Worker で owner / admin に上げた）。
--   6. 降格された初代 owner が org_id の無いショップを作れた → 組織に属する人は org_id 必須。
--   7. settings の項目だけの member が headless（戻り先・中継元の IP）と oauth を書けた → integrations が要る。
--   8. member_passkeys_reset は owner / admin だけ（member_set_email と同じ線。乗っ取りの救済は両方を合わせて使う）。
--   9. orders.shipped_at を過去に書いて 180 日マスクを前倒しできた → 今の時刻の近くだけ。
--  10. プランの上限の判定を advisory lock で直列にする（並行の INSERT で上限を越えられた）。
--  11. skus / product_images の product_id に (product_id, shop_id) の複合 FK（catalog の項目で他ショップの商品に行を差し込めた）。
-- 検査は scripts/check-rls.mjs（列の権限・トリガーの存在）と test/db/hardening2.test.ts。

-- ---------- 1. api_require: 発行者が今も持つ項目のスコープだけを返す ----------
-- 0051 の api_require と同じ判定に「返す scopes の絞り込み」を足す。api_* の 'orders:pii' = any(v_tok.scopes) はそのままで
-- 発行者の項目を再評価したことになる（語彙に無いスコープは絞らない）。
create or replace function api_require(p_token_hash text, p_scope text)
returns api_tokens
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_require: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash
     and revoked_at is null
     and (expires_at is null or expires_at > now());
  if not found or not (p_scope = any(v_tok.scopes)) or not banto_token_scope_ok(v_tok.owner_id, v_tok.shop_id, p_scope) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  v_tok.scopes := coalesce(array(select s from unnest(v_tok.scopes) s
                                  where banto_scope_perm(s) is null or banto_token_scope_ok(v_tok.owner_id, v_tok.shop_id, s)), '{}'::text[]);
  -- 最終利用は1分に1回だけ更新（書き込みを減らす）
  if v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute' then
    update api_tokens set last_used_at = now() where id = v_tok.id;
  end if;
  perform set_config('banto.actor', 'api_token:' || v_tok.id::text, true);
  return v_tok;
end;
$$;

-- ---------- 2. api_tokens: 発行は自分の名義だけ、失効は integrations を持つ人なら誰でも、削除と書き換えは無し ----------
drop policy if exists api_tokens_integrations on api_tokens;
create policy api_tokens_select on api_tokens for select using (banto_shop_perm(shop_id, 'integrations'));
create policy api_tokens_insert on api_tokens for insert with check (banto_shop_perm(shop_id, 'integrations') and owner_id = auth.uid());
create policy api_tokens_update on api_tokens for update
  using (banto_shop_perm(shop_id, 'integrations')) with check (banto_shop_perm(shop_id, 'integrations'));
revoke delete on api_tokens from authenticated;

-- 発行時: 発行者が持たない項目のスコープは付けられない（0028）。更新時: 変えてよいのは name と revoked_at（null → 時刻）だけ。
create or replace function banto_api_tokens_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not banto_token_scopes_ok(new.owner_id, new.shop_id, new.scopes) then
      raise exception 'scope_not_permitted' using errcode = '42501';
    end if;
    return new;
  end if;
  if auth.role() = 'authenticated' then
    if new.owner_id is distinct from old.owner_id or new.shop_id is distinct from old.shop_id or new.token_hash is distinct from old.token_hash
       or new.prefix is distinct from old.prefix or new.scopes is distinct from old.scopes or new.expires_at is distinct from old.expires_at
       or new.created_at is distinct from old.created_at or new.last_used_at is distinct from old.last_used_at then
      raise exception 'token_immutable' using errcode = '42501';
    end if;
    -- 失効は取り消せない（最初の失効の時刻を保つ。もう一度「失効」を押しても変わらない）
    if old.revoked_at is not null then new.revoked_at := old.revoked_at; end if;
  elsif new.scopes is distinct from old.scopes or new.owner_id is distinct from old.owner_id or new.shop_id is distinct from old.shop_id then
    if not banto_token_scopes_ok(new.owner_id, new.shop_id, new.scopes) then
      raise exception 'scope_not_permitted' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function banto_api_tokens_guard() from public, anon, authenticated;
drop trigger if exists api_tokens_guard on api_tokens;
create trigger api_tokens_guard before insert or update on api_tokens for each row execute function banto_api_tokens_guard();

-- ---------- 3. organizations: authenticated が直接変えてよい列は name だけ ----------
revoke update on organizations from authenticated;
grant update (name) on organizations to authenticated;

-- ---------- 4. products.attributes は anon に見せない ----------
-- 0028 の shops と同じ形: 表の権限を剥奪して、列を選んで付け直す。products に列を足すときはここにも足す（check-rls.mjs が attributes を検査する）。
revoke all on products from anon;
grant select (id, shop_id, slug, name, description, published, created_at, updated_at, tags, category_id, brand, tax_class, extra_category_ids) on products to anon;

-- 公開の項目だけに絞った attributes（product_fields の public が false でない鍵）。定義の読み方は src/products/fields.ts と同じ
create or replace function banto_public_product_attributes(p_settings jsonb, p_attributes jsonb)
returns jsonb language sql immutable as $$
  select coalesce((
    select jsonb_object_agg(a.k, a.v)
      from jsonb_each(case when jsonb_typeof(p_attributes) = 'object' then p_attributes else '{}'::jsonb end) a(k, v)
     where exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_settings->'product_fields') = 'array' then p_settings->'product_fields' else '[]'::jsonb end) f
                    where jsonb_typeof(f) = 'object' and f->>'key' = a.k and f->'public' is distinct from 'false'::jsonb)
  ), '{}'::jsonb);
$$;
revoke execute on function banto_public_product_attributes(jsonb, jsonb) from public, anon, authenticated;

-- お店の画面・公開 API の商品詳細（anon）。公開中のショップの公開中の商品だけ。attributes は公開の項目だけ
create or replace function product_public_get(p_shop_id uuid, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(p) - 'attributes' || jsonb_build_object('attributes', banto_public_product_attributes(s.settings, p.attributes))
    from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
   limit 1;
$$;
revoke execute on function product_public_get(uuid, text) from public;
grant execute on function product_public_get(uuid, text) to anon, authenticated, service_role;

-- 公開の settings に出す product_fields は公開の項目だけ（非公開の項目は定義（表示名）も見せない。0050 を差し替え）
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent')), '{}'::jsonb)
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb)))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

-- ---------- 5. import_member_passwords: ログインしたことのある会員には書かない（0013 を差し替え） ----------
create or replace function import_member_passwords(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_email text;
  v_hash text;
  v_id uuid;
  v_has boolean;
  v_active boolean;
  v_imported integer := 0;
  v_created integer := 0;
  v_format integer := 0;
  v_has_password integer := 0;
  v_bad_email integer := 0;
  v_skipped_active integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'import_member_passwords: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id) then raise exception 'shop_not_found'; end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 100 then raise exception 'too_many_rows'; end if;
  for v_row in select e from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e loop
    v_email := lower(btrim(coalesce(v_row->>'email', '')));
    v_hash := btrim(coalesce(v_row->>'hash', ''));
    if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_bad_email := v_bad_email + 1; continue; end if;
    if v_hash !~ '^(\$wp)?\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' then v_format := v_format + 1; continue; end if;
    v_id := null;
    select id, password_hash is not null, last_login_at is not null into v_id, v_has, v_active
      from customers where shop_id = p_shop_id and lower(email) = v_email;
    if v_id is null then
      insert into customers (shop_id, email) values (p_shop_id, v_email) returning id into v_id;
      v_created := v_created + 1;
      v_has := false;
      v_active := false;
    end if;
    if v_has then v_has_password := v_has_password + 1; continue; end if;
    -- 既にログインしたことのある会員は Banto の会員として確立している。取り込みで入口を足さない（乗っ取りの経路になる）
    if v_active then v_skipped_active := v_skipped_active + 1; continue; end if;
    update customers set legacy_password_hash = v_hash, legacy_password_expires_at = now() + interval '180 days'
     where shop_id = p_shop_id and id = v_id;
    v_imported := v_imported + 1;
  end loop;
  return jsonb_build_object('imported', v_imported, 'created', v_created, 'skipped_format', v_format,
                            'skipped_has_password', v_has_password, 'skipped_invalid_email', v_bad_email, 'skipped_active', v_skipped_active);
end;
$$;

-- ---------- 6 / 7. shops: 組織に属する人は org_id 必須、headless / oauth は integrations（0031 を差し替え） ----------
create or replace function banto_shops_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.org_id is null and auth.uid() is not null then
      select m.org_id into new.org_id from org_members m join organizations o on o.id = m.org_id
       where m.user_id = auth.uid() and m.role in ('owner', 'admin') order by o.created_at limit 1;
      -- 0024 以降、運営者は必ず組織に属する。owner / admin の組織が無い人（降格された初代 owner）は組織の外にショップを作れない
      if new.org_id is null and auth.role() = 'authenticated' then raise exception 'org_required' using errcode = '42501'; end if;
    end if;
    if new.owner_id is not null and not exists (select 1 from owners where id = new.owner_id) then new.owner_id := null; end if;
    return new;
  end if;
  if auth.role() = 'authenticated' then
    if new.org_id is distinct from old.org_id and old.org_id is not null then raise exception 'org_immutable' using errcode = '42501'; end if;
    if new.owner_id is distinct from old.owner_id then raise exception 'owner_immutable' using errcode = '42501'; end if;
    if new.stripe_account_id is distinct from old.stripe_account_id and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
    -- 連携の設定（決済後の戻り先・中継元の IP・外部ログインの client_id）は integrations の項目（0055）
    if (new.settings->'headless' is distinct from old.settings->'headless' or new.settings->'oauth' is distinct from old.settings->'oauth')
       and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
    -- スラッグ・独自ドメイン・注文番号と試着の連番は、settings の項目では変えられない（0031）
    if (new.slug is distinct from old.slug or new.domain is distinct from old.domain
        or new.order_seq is distinct from old.order_seq or new.tryon_seq is distinct from old.tryon_seq)
       and not banto_owns_shop(old.id) then
      raise exception 'admin_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 8. member_passkeys_reset は owner / admin だけ（0046 を差し替え） ----------
create or replace function member_passkeys_reset(p_shop_id uuid, p_customer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not banto_owns_shop(p_shop_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from member_passkeys where shop_id = p_shop_id and customer_id = p_customer_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------- 9. orders.shipped_at は「今」の近くだけ（0028 を差し替え） ----------
create or replace function banto_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    if new.status is distinct from old.status and not (old.status = 'paid' and new.status = 'shipped') then
      raise exception 'use_cancel_order' using errcode = '42501';
    end if;
    -- 発送日時を過去に書くと mask_shipped_orders（180 日）が前倒しで個人情報を消す。運営者が書けるのは今の時刻の近くだけ
    if new.shipped_at is distinct from old.shipped_at
       and (new.shipped_at is null or new.shipped_at < now() - interval '1 day' or new.shipped_at > now() + interval '1 hour') then
      raise exception 'shipped_at_now' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 10. プランの上限: 数える前に advisory lock（0052 / 0053 を差し替え） ----------
create or replace function banto_plan_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_kind text; v_limit bigint; v_count bigint;
begin
  v_kind := case tg_table_name when 'org_members' then 'members' else tg_table_name end;
  v_limit := nullif(banto_plan_limits()->>v_kind, '')::bigint;
  if v_limit is null then return null; end if;
  -- 並行する INSERT は互いの未コミットの行を数えないので、数える前に直列にする（待った後の count は相手のコミットを見る）
  perform pg_advisory_xact_lock(hashtextextended('banto_plan_limit|' || v_kind, 0));
  v_count := banto_plan_count(v_kind);
  if v_count > v_limit then
    raise exception 'plan_limit_exceeded:%:%', v_kind, v_limit using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create or replace function banto_plan_mail_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_limit bigint; v_count bigint;
begin
  v_limit := nullif(banto_plan_limits()->>'mail_per_day', '')::bigint;
  if v_limit is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('banto_plan_limit|mail_per_day', 0));
  v_count := banto_plan_mail_count();
  if v_count > v_limit then
    raise exception 'plan_limit_exceeded:mail_per_day:%', v_limit using errcode = 'P0001';
  end if;
  return null;
end;
$$;

-- ---------- 11. skus / product_images は同じショップの商品にだけ付く ----------
-- 既存の FK（on delete cascade）は残し、(product_id, shop_id) の複合 FK を足す。既存の行は shop_id が一致しているはずだが、
-- 万一ずれていても適用は止めない（not valid のまま新しい行だけ検査し、validate は通れば通す）
alter table products drop constraint if exists products_id_shop_id_key;
alter table products add constraint products_id_shop_id_key unique (id, shop_id);
alter table skus drop constraint if exists skus_product_shop_fkey;
alter table skus add constraint skus_product_shop_fkey foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade not valid;
alter table product_images drop constraint if exists product_images_product_shop_fkey;
alter table product_images add constraint product_images_product_shop_fkey foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade not valid;
do $$
begin
  alter table skus validate constraint skus_product_shop_fkey;
  alter table product_images validate constraint product_images_product_shop_fkey;
exception when foreign_key_violation then
  raise notice 'banto 0055: skus / product_images に shop_id の合わない行があります。select * from skus k join products p on p.id = k.product_id where k.shop_id <> p.shop_id で確かめてください';
end;
$$;

insert into banto_migrations (version) values ('0055_security_hardening_2');
