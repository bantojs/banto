-- Banto 0036_api_coupons_customers: AI 用トークン（/api/v1・/mcp）でクーポンと会員（顧客）を扱う。docs/ai-access.md
-- 前方専用。WordPress のプラグインなど、外部のサーバーからクーポンの管理と会員の参照・管理をするための窓口。
--
-- 新しいスコープと、発行者に求める項目（0028 の banto_scope_perm に足す。管理画面と同じ項目）:
--   coupons:read    クーポン（キャンペーン）と発行済みのクーポンの参照        → marketing
--   coupons:write   クーポンの作成・更新・削除、発行・取り消し                → marketing
--   customers:read  会員の参照（メールアドレス・氏名・住所。個人情報そのもの）  → customers
--   customers:write 会員の作成・氏名と住所の更新・削除（退会）                → customers
--
-- 方針:
--  - 判定は SQL だけ（api_require）。Worker は形を整えて渡すだけ。
--  - クーポンはモジュール coupons が ON のショップだけ（OFF なら module_disabled）。管理画面と同じ。
--  - 会員のメールアドレスは API では変えられない。会員はメールのコードで入るので、アドレスを変えられることは
--    乗っ取りの入り口になる（トークンが漏れたときの被害を広げない）。変更は管理画面（member_set_email、前後に通知）だけ。
--  - パスワードのハッシュ・ログインの世代などは返さない。
--  - 使用済み・使用中のクーポンは削除させない（履歴が消えるため。止めるときは active = false）。
--  - 発行済みのクーポンを会員に配るのは会員 ID で（メールアドレスでは受けない。coupons:write だけのトークンで
--    「このアドレスは会員か」を調べられないように。アドレスから ID を引くのは customers:read の仕事）。

-- ---------- スコープ ----------
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write']::text[]
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
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- ---------- 共通 ----------
-- LIKE の特殊文字を文字として扱う（検索語の % や _ で全件に当たらないように）
create or replace function banto_like_escape(p text)
returns text language sql immutable as $$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_');
$$;
revoke execute on function banto_like_escape(text) from public, anon, authenticated;

-- クーポンのモジュールが ON か（管理画面の moduleEnabled と同じ: settings.modules.coupons が true）
create or replace function banto_api_coupons_require(p_token_hash text, p_scope text)
returns api_tokens
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, p_scope);
  if not exists (select 1 from shops where id = v_tok.shop_id and settings->'modules'->'coupons' = 'true'::jsonb) then
    raise exception 'module_disabled';
  end if;
  return v_tok;
end;
$$;
revoke execute on function banto_api_coupons_require(text, text) from public, anon, authenticated;

-- ---------- クーポン: JSON ----------
create or replace function api_coupon_json(p_c coupon_campaigns)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'name', p_c.name, 'code', p_c.code, 'kind', p_c.kind, 'value', p_c.value,
    'starts_at', p_c.starts_at, 'ends_at', p_c.ends_at,
    'usage_limit', p_c.usage_limit, 'per_customer_limit', p_c.per_customer_limit,
    'combinable', p_c.combinable, 'audience', p_c.audience, 'conditions', p_c.conditions, 'active', p_c.active,
    'grant_valid_days', p_c.grant_valid_days, 'auto_grant', p_c.auto_grant, 'claimable', p_c.claimable,
    'external_ref', p_c.external_ref, 'created_at', p_c.created_at, 'updated_at', p_c.updated_at,
    'usage', (select jsonb_build_object('used', count(*) filter (where r.status = 'used'), 'held', count(*) filter (where r.status = 'held'))
                from coupon_redemptions r where r.shop_id = p_c.shop_id and r.campaign_id = p_c.id),
    'grants', (select jsonb_build_object('available', count(*) filter (where g.status = 'available'), 'held', count(*) filter (where g.status = 'held'),
                                         'used', count(*) filter (where g.status = 'used'), 'revoked', count(*) filter (where g.status = 'revoked'))
                 from coupon_grants g where g.campaign_id = p_c.id)
  );
$$;
revoke execute on function api_coupon_json(coupon_campaigns) from public, anon, authenticated;

-- ---------- クーポン: 値の検査 ----------
-- p_values の鍵だけを p_c に当てて返す（作成は既定値の行、更新は今の行に）。知らない鍵・型の違い・範囲外は invalid_<鍵>。
-- 条件（conditions）は src/commerce/discounts.ts の CouponConditions の鍵だけ。商品・カテゴリーはこのショップのものだけ。
create or replace function banto_api_coupon_apply(p_shop_id uuid, p_c coupon_campaigns, p_values jsonb)
returns coupon_campaigns
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text; v_val jsonb; v_cond jsonb; v_ck text; v_cv jsonb; v_ids uuid[]; v_n integer; v_s text;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key, v_val in select * from jsonb_each(p_values) loop
    case v_key
      when 'name' then
        v_s := btrim(coalesce(v_val #>> '{}', ''));
        if jsonb_typeof(v_val) <> 'string' or length(v_s) not between 1 and 100 then raise exception 'invalid_name'; end if;
        p_c.name := v_s;
      when 'code' then
        if jsonb_typeof(v_val) = 'null' or btrim(v_val #>> '{}') = '' then p_c.code := null;
        else
          v_s := upper(btrim(v_val #>> '{}'));
          if jsonb_typeof(v_val) <> 'string' or v_s !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then raise exception 'invalid_code'; end if;
          p_c.code := v_s;
        end if;
      when 'kind' then
        if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' not in ('percent', 'fixed', 'free_shipping') then raise exception 'invalid_kind'; end if;
        p_c.kind := v_val #>> '{}';
      when 'value' then
        if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}') !~ '^\d+$' then raise exception 'invalid_value'; end if;
        p_c.value := (v_val #>> '{}')::integer;
      when 'starts_at', 'ends_at' then
        if jsonb_typeof(v_val) not in ('string', 'null') then raise exception 'invalid_%', v_key; end if;
        begin
          if v_key = 'starts_at' then p_c.starts_at := (v_val #>> '{}')::timestamptz; else p_c.ends_at := (v_val #>> '{}')::timestamptz; end if;
        exception when others then raise exception 'invalid_%', v_key;
        end;
      when 'usage_limit', 'per_customer_limit', 'grant_valid_days' then
        if jsonb_typeof(v_val) = 'null' then v_n := null;
        elsif jsonb_typeof(v_val) = 'number' and (v_val #>> '{}') ~ '^\d{1,7}$' then v_n := (v_val #>> '{}')::integer;
        else raise exception 'invalid_%', v_key;
        end if;
        if v_key = 'usage_limit' then
          if v_n is not null and v_n not between 1 and 100000 then raise exception 'invalid_usage_limit'; end if;
          p_c.usage_limit := v_n;
        elsif v_key = 'per_customer_limit' then
          if v_n is not null and v_n not between 1 and 1000 then raise exception 'invalid_per_customer_limit'; end if;
          p_c.per_customer_limit := v_n;
        else
          if v_n is not null and v_n not between 1 and 3650 then raise exception 'invalid_grant_valid_days'; end if;
          p_c.grant_valid_days := v_n;
        end if;
      when 'combinable', 'active', 'claimable' then
        if jsonb_typeof(v_val) <> 'boolean' then raise exception 'invalid_%', v_key; end if;
        if v_key = 'combinable' then p_c.combinable := v_val::boolean;
        elsif v_key = 'active' then p_c.active := v_val::boolean;
        else p_c.claimable := v_val::boolean;
        end if;
      when 'audience' then
        if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' not in ('public', 'members') then raise exception 'invalid_audience'; end if;
        p_c.audience := v_val #>> '{}';
      when 'auto_grant' then
        if jsonb_typeof(v_val) = 'null' then p_c.auto_grant := null;
        elsif jsonb_typeof(v_val) = 'string' and v_val #>> '{}' in ('first_login', 'after_purchase') then p_c.auto_grant := v_val #>> '{}';
        else raise exception 'invalid_auto_grant';
        end if;
      when 'external_ref' then
        if jsonb_typeof(v_val) = 'null' or btrim(v_val #>> '{}') = '' then p_c.external_ref := null;
        elsif jsonb_typeof(v_val) = 'string' and length(btrim(v_val #>> '{}')) <= 100 then p_c.external_ref := btrim(v_val #>> '{}');
        else raise exception 'invalid_external_ref';
        end if;
      when 'conditions' then
        if jsonb_typeof(v_val) = 'null' then v_val := '{}'::jsonb; end if;
        if jsonb_typeof(v_val) <> 'object' then raise exception 'invalid_conditions'; end if;
        v_cond := '{}'::jsonb;
        for v_ck, v_cv in select * from jsonb_each(v_val) loop
          if jsonb_typeof(v_cv) = 'null' then continue; end if;
          case v_ck
            when 'product_ids', 'exclude_product_ids', 'category_ids', 'exclude_category_ids' then
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 200
                 or exists (select 1 from jsonb_array_elements(v_cv) e
                             where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              select coalesce(array_agg(distinct (e #>> '{}')::uuid), '{}') into v_ids from jsonb_array_elements(v_cv) e;
              if v_ck in ('product_ids', 'exclude_product_ids') then
                if (select count(*) from products where shop_id = p_shop_id and id = any(v_ids)) <> coalesce(array_length(v_ids, 1), 0) then raise exception 'invalid_conditions_unknown_products'; end if;
              else
                if (select count(*) from categories where shop_id = p_shop_id and id = any(v_ids)) <> coalesce(array_length(v_ids, 1), 0) then raise exception 'invalid_conditions_unknown_categories'; end if;
              end if;
              if coalesce(array_length(v_ids, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object(v_ck, to_jsonb(v_ids)); end if;
            when 'exclude_sale' then
              if jsonb_typeof(v_cv) <> 'boolean' then raise exception 'invalid_conditions_exclude_sale'; end if;
              if v_cv::boolean then v_cond := v_cond || jsonb_build_object('exclude_sale', true); end if;
            when 'min_subtotal_jpy', 'max_subtotal_jpy', 'min_qty' then
              -- 上限: 点数は 999、金額は 1 億円（管理画面と同じ）
              v_n := 100000000;
              if v_ck = 'min_qty' then v_n := 999; end if;
              if jsonb_typeof(v_cv) <> 'number' or (v_cv #>> '{}') !~ '^\d{1,9}$' or (v_cv #>> '{}')::integer > v_n then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              v_cond := v_cond || jsonb_build_object(v_ck, (v_cv #>> '{}')::integer);
            else raise exception 'invalid_conditions_unknown_key';
          end case;
        end loop;
        p_c.conditions := v_cond;
      else raise exception 'invalid_field_%', left(v_key, 40);
    end case;
  end loop;
  -- 種類と値の組み合わせ（テーブルの CHECK と同じ。わかりやすい理由で返す）
  if p_c.kind = 'free_shipping' then p_c.value := 0;
  elsif p_c.kind = 'percent' and p_c.value not between 1 and 100 then raise exception 'invalid_value';
  elsif p_c.kind = 'fixed' and p_c.value not between 1 and 10000000 then raise exception 'invalid_value';
  end if;
  if p_c.starts_at is not null and p_c.ends_at is not null and p_c.starts_at >= p_c.ends_at then raise exception 'invalid_ends_at'; end if;
  return p_c;
end;
$$;
revoke execute on function banto_api_coupon_apply(uuid, coupon_campaigns, jsonb) from public, anon, authenticated;

-- ---------- クーポン: RPC ----------
create or replace function api_coupons_list(p_token_hash text, p_query text default null, p_active boolean default null,
                                            p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_q text;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:read');
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_q := case when nullif(btrim(p_query), '') is not null then '%' || banto_like_escape(btrim(p_query)) || '%' end;
  select count(*) into v_total from coupon_campaigns c
   where c.shop_id = v_tok.shop_id and (p_active is null or c.active = p_active)
     and (v_q is null or c.name ilike v_q or c.code ilike v_q);
  select coalesce(jsonb_agg(api_coupon_json(c) order by c.created_at desc), '[]'::jsonb) into v_items
    from (select * from coupon_campaigns c
           where c.shop_id = v_tok.shop_id and (p_active is null or c.active = p_active)
             and (v_q is null or c.name ilike v_q or c.code ilike v_q)
           order by c.created_at desc limit v_limit offset v_offset) c;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- id かコードで 1 件
create or replace function api_coupon_get(p_token_hash text, p_campaign_id uuid default null, p_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c coupon_campaigns%rowtype;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:read');
  if p_campaign_id is not null then
    select * into v_c from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id;
  else
    select * into v_c from coupon_campaigns where shop_id = v_tok.shop_id and code = upper(btrim(coalesce(p_code, '')));
  end if;
  if not found then raise exception 'not_found'; end if;
  return api_coupon_json(v_c);
end;
$$;

create or replace function api_coupon_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c coupon_campaigns%rowtype;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  if not (p_values ? 'name') then raise exception 'invalid_name'; end if;
  if not (p_values ? 'kind') then raise exception 'invalid_kind'; end if;
  -- 既定値（管理画面の新規作成と同じ）
  v_c.id := gen_random_uuid();
  v_c.shop_id := v_tok.shop_id;
  v_c.value := 0;
  v_c.combinable := false;
  v_c.audience := 'public';
  v_c.conditions := '{}'::jsonb;
  v_c.active := true;
  v_c.claimable := false;
  v_c := banto_api_coupon_apply(v_tok.shop_id, v_c, p_values);
  insert into coupon_campaigns (id, shop_id, name, code, kind, value, starts_at, ends_at, usage_limit, per_customer_limit,
                                combinable, audience, conditions, active, grant_valid_days, auto_grant, claimable, external_ref)
  values (v_c.id, v_c.shop_id, v_c.name, v_c.code, v_c.kind, v_c.value, v_c.starts_at, v_c.ends_at, v_c.usage_limit, v_c.per_customer_limit,
          v_c.combinable, v_c.audience, v_c.conditions, v_c.active, v_c.grant_valid_days, v_c.auto_grant, v_c.claimable, v_c.external_ref)
  returning * into v_c;
  return api_coupon_json(v_c);
end;
$$;

create or replace function api_coupon_update(p_token_hash text, p_campaign_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c coupon_campaigns%rowtype;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:write');
  select * into v_c from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id for update;
  if not found then raise exception 'not_found'; end if;
  v_c := banto_api_coupon_apply(v_tok.shop_id, v_c, p_values);
  update coupon_campaigns
     set name = v_c.name, code = v_c.code, kind = v_c.kind, value = v_c.value, starts_at = v_c.starts_at, ends_at = v_c.ends_at,
         usage_limit = v_c.usage_limit, per_customer_limit = v_c.per_customer_limit, combinable = v_c.combinable,
         audience = v_c.audience, conditions = v_c.conditions, active = v_c.active, grant_valid_days = v_c.grant_valid_days,
         auto_grant = v_c.auto_grant, claimable = v_c.claimable, external_ref = v_c.external_ref
   where id = v_c.id and shop_id = v_tok.shop_id
  returning * into v_c;
  return api_coupon_json(v_c);
end;
$$;

-- 使われた（使用中の）ことのないクーポンだけ消せる。使ったものは active = false で止める
create or replace function api_coupon_delete(p_token_hash text, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:write');
  perform 1 from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id for update;
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from coupon_redemptions where campaign_id = p_campaign_id and status in ('held', 'used'))
     or exists (select 1 from coupon_grants where campaign_id = p_campaign_id and status in ('held', 'used')) then
    raise exception 'coupon_in_use';
  end if;
  delete from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id;
  return jsonb_build_object('deleted', true, 'id', p_campaign_id);
end;
$$;

-- ---------- 発行済みのクーポン（0019） ----------
create or replace function api_coupon_grants_list(p_token_hash text, p_campaign_id uuid, p_status text default null,
                                                  p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer; v_offset integer; v_total integer; v_items jsonb;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:read');
  if not exists (select 1 from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id) then raise exception 'not_found'; end if;
  if p_status is not null and p_status not in ('available', 'held', 'used', 'revoked') then raise exception 'invalid_status'; end if;
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  select count(*) into v_total from coupon_grants g where g.campaign_id = p_campaign_id and (p_status is null or g.status = p_status);
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'code', g.code, 'customer_id', g.customer_id, 'status', g.status,
                                               'expires_at', g.expires_at, 'created_at', g.created_at, 'used_at', g.used_at)
                            order by g.created_at desc), '[]'::jsonb) into v_items
    from (select * from coupon_grants g where g.campaign_id = p_campaign_id and (p_status is null or g.status = p_status)
           order by g.created_at desc limit v_limit offset v_offset) g;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- 会員（ID）ごとに 1 枚と、誰でも 1 回使えるコードを p_count 枚。1 回 500 枚まで。発行したものを返す。
-- 会員が同じキャンペーンの使っていないクーポンを持っていれば、その人には発行しない（管理画面の発行と同じ）
create or replace function api_coupon_grants_issue(p_token_hash text, p_campaign_id uuid, p_customer_ids uuid[] default null, p_count integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens; v_c coupon_campaigns%rowtype; v_expires timestamptz; v_cid uuid; v_i integer; v_code text;
  v_g coupon_grants%rowtype; v_out jsonb := '[]'::jsonb; v_skipped integer := 0;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:write');
  select * into v_c from coupon_campaigns where shop_id = v_tok.shop_id and id = p_campaign_id;
  if not found then raise exception 'not_found'; end if;
  if coalesce(p_count, 0) < 0 or coalesce(p_count, 0) + coalesce(array_length(p_customer_ids, 1), 0) > 500 then raise exception 'invalid_count'; end if;
  if coalesce(p_count, 0) + coalesce(array_length(p_customer_ids, 1), 0) = 0 then raise exception 'invalid_count'; end if;
  v_expires := case when v_c.grant_valid_days is not null then now() + make_interval(days => v_c.grant_valid_days) end;
  if v_c.ends_at is not null and (v_expires is null or v_expires > v_c.ends_at) then v_expires := v_c.ends_at; end if;
  foreach v_cid in array coalesce(p_customer_ids, '{}'::uuid[]) loop
    -- 他のショップの会員・存在しない ID・既に持っている人は飛ばす（数だけ返す。存在を言い分けない）
    if not exists (select 1 from customers where shop_id = v_tok.shop_id and id = v_cid)
       or exists (select 1 from coupon_grants where campaign_id = v_c.id and customer_id = v_cid and status in ('available', 'held')) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    loop
      v_code := banto_grant_code();
      begin
        insert into coupon_grants (shop_id, campaign_id, code, customer_id, expires_at) values (v_tok.shop_id, v_c.id, v_code, v_cid, v_expires) returning * into v_g;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    v_out := v_out || jsonb_build_object('id', v_g.id, 'code', v_g.code, 'customer_id', v_g.customer_id, 'expires_at', v_g.expires_at);
  end loop;
  for v_i in 1 .. coalesce(p_count, 0) loop
    loop
      v_code := banto_grant_code();
      begin
        insert into coupon_grants (shop_id, campaign_id, code, expires_at) values (v_tok.shop_id, v_c.id, v_code, v_expires) returning * into v_g;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    v_out := v_out || jsonb_build_object('id', v_g.id, 'code', v_g.code, 'customer_id', null, 'expires_at', v_g.expires_at);
  end loop;
  return jsonb_build_object('issued', jsonb_array_length(v_out), 'skipped', v_skipped, 'grants', v_out);
end;
$$;

create or replace function api_coupon_grant_revoke(p_token_hash text, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_status text;
begin
  v_tok := banto_api_coupons_require(p_token_hash, 'coupons:write');
  select status into v_status from coupon_grants where shop_id = v_tok.shop_id and id = p_grant_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_status = 'available' then
    update coupon_grants set status = 'revoked' where id = p_grant_id;
    v_status := 'revoked';
  elsif v_status <> 'revoked' then
    raise exception 'invalid_transition';
  end if;
  return jsonb_build_object('id', p_grant_id, 'status', v_status);
end;
$$;

-- ---------- 会員（顧客） ----------
-- 返すのは画面に出している項目だけ（パスワードのハッシュ・世代は返さない）。注文の件数と合計は確定済み（paid / shipped）
create or replace function api_customer_json(p_c customers)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'email', p_c.email, 'name', p_c.name, 'default_address', p_c.default_address,
    'created_at', p_c.created_at, 'updated_at', p_c.updated_at, 'last_login_at', p_c.last_login_at,
    'orders', (select jsonb_build_object('count', count(*), 'total_jpy', coalesce(sum(o.total_jpy), 0), 'last_order_at', max(o.created_at))
                 from orders o where o.shop_id = p_c.shop_id and o.customer_id = p_c.id and o.status in ('paid', 'shipped'))
  );
$$;
revoke execute on function api_customer_json(customers) from public, anon, authenticated;

-- 住所: 決まった鍵の文字列だけ（各 200 文字まで）。null で消す
create or replace function banto_api_address(p jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare v_k text; v_v jsonb; v_out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'invalid_default_address'; end if;
  for v_k, v_v in select * from jsonb_each(p) loop
    if v_k not in ('name', 'phone', 'postal_code', 'country', 'state', 'city', 'line1', 'line2') then raise exception 'invalid_default_address'; end if;
    if jsonb_typeof(v_v) = 'null' then continue; end if;
    if jsonb_typeof(v_v) <> 'string' or length(v_v #>> '{}') > 200 then raise exception 'invalid_default_address'; end if;
    v_out := v_out || jsonb_build_object(v_k, btrim(v_v #>> '{}'));
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_api_address(jsonb) from public, anon, authenticated;

-- 一覧・検索。p_query はメールアドレス・氏名の部分一致、p_email は完全一致（大文字小文字は区別しない）
create or replace function api_customers_list(p_token_hash text, p_query text default null, p_email text default null,
                                              p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_q text; v_email text;
begin
  v_tok := api_require(p_token_hash, 'customers:read');
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_q := case when nullif(btrim(p_query), '') is not null then '%' || banto_like_escape(btrim(p_query)) || '%' end;
  v_email := nullif(lower(btrim(p_email)), '');
  select count(*) into v_total from customers c
   where c.shop_id = v_tok.shop_id
     and (v_email is null or lower(c.email) = v_email)
     and (v_q is null or c.email ilike v_q or c.name ilike v_q);
  select coalesce(jsonb_agg(api_customer_json(c) order by c.created_at desc), '[]'::jsonb) into v_items
    from (select * from customers c
           where c.shop_id = v_tok.shop_id
             and (v_email is null or lower(c.email) = v_email)
             and (v_q is null or c.email ilike v_q or c.name ilike v_q)
           order by c.created_at desc limit v_limit offset v_offset) c;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- 1 件。orders:read もあるトークンには、最近の注文（20 件、個人情報なし）を付ける
create or replace function api_customer_get(p_token_hash text, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c customers%rowtype; v_out jsonb;
begin
  v_tok := api_require(p_token_hash, 'customers:read');
  select * into v_c from customers where shop_id = v_tok.shop_id and id = p_customer_id;
  if not found then raise exception 'not_found'; end if;
  v_out := api_customer_json(v_c);
  if 'orders:read' = any(v_tok.scopes) and banto_token_scope_ok(v_tok.owner_id, v_tok.shop_id, 'orders:read') then
    v_out := v_out || jsonb_build_object('recent_orders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'total_jpy', o.total_jpy, 'created_at', o.created_at)
                                order by o.created_at desc), '[]'::jsonb)
        from (select * from orders o where o.shop_id = v_tok.shop_id and o.customer_id = v_c.id order by o.created_at desc limit 20) o));
  end if;
  return v_out;
end;
$$;

-- 作る。同じメールアドレスの会員があれば email_taken（上書きしない）。Banto からは何も知らせない
create or replace function api_customer_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_email text; v_name text; v_c customers%rowtype; v_key text;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key not in ('email', 'name', 'default_address') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  v_email := lower(btrim(coalesce(p_values->>'email', '')));
  if jsonb_typeof(p_values->'email') <> 'string' or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if p_values ? 'name' and jsonb_typeof(p_values->'name') not in ('string', 'null') then raise exception 'invalid_name'; end if;
  v_name := nullif(btrim(coalesce(p_values->>'name', '')), '');
  if length(v_name) > 200 then raise exception 'invalid_name'; end if;
  if exists (select 1 from customers where shop_id = v_tok.shop_id and lower(email) = v_email) then raise exception 'email_taken'; end if;
  insert into customers (shop_id, email, name, default_address)
  values (v_tok.shop_id, v_email, v_name, banto_api_address(p_values->'default_address'))
  returning * into v_c;
  return api_customer_json(v_c);
end;
$$;

-- 氏名と住所だけ変える。メールアドレスは変えない（email_change_not_allowed。管理画面の「メールアドレスの変更」で）
create or replace function api_customer_update(p_token_hash text, p_customer_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_c customers%rowtype; v_key text; v_name text;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_body'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key = 'email' then raise exception 'email_change_not_allowed'; end if;
    if v_key not in ('name', 'default_address') then raise exception 'invalid_field_%', left(v_key, 40); end if;
  end loop;
  select * into v_c from customers where shop_id = v_tok.shop_id and id = p_customer_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_values ? 'name' then
    if jsonb_typeof(p_values->'name') not in ('string', 'null') then raise exception 'invalid_name'; end if;
    v_name := nullif(btrim(coalesce(p_values->>'name', '')), '');
    if length(v_name) > 200 then raise exception 'invalid_name'; end if;
    v_c.name := v_name;
  end if;
  if p_values ? 'default_address' then v_c.default_address := banto_api_address(p_values->'default_address'); end if;
  update customers set name = v_c.name, default_address = v_c.default_address
   where shop_id = v_tok.shop_id and id = p_customer_id
  returning * into v_c;
  return api_customer_json(v_c);
end;
$$;

-- 削除（退会）。注文は残る（管理画面の削除と同じ）。会員のクーポン・ログインの記録は会員と一緒に消える
create or replace function api_customer_delete(p_token_hash text, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'customers:write');
  delete from customers where shop_id = v_tok.shop_id and id = p_customer_id;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('deleted', true, 'id', p_customer_id);
end;
$$;

-- ---------- 実行権限（service_role だけ。Worker は src/db/privileged.ts の apiRpc から呼ぶ） ----------
revoke execute on function api_coupons_list(text, text, boolean, integer, integer) from public, anon, authenticated;
revoke execute on function api_coupon_get(text, uuid, text) from public, anon, authenticated;
revoke execute on function api_coupon_create(text, jsonb) from public, anon, authenticated;
revoke execute on function api_coupon_update(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function api_coupon_delete(text, uuid) from public, anon, authenticated;
revoke execute on function api_coupon_grants_list(text, uuid, text, integer, integer) from public, anon, authenticated;
revoke execute on function api_coupon_grants_issue(text, uuid, uuid[], integer) from public, anon, authenticated;
revoke execute on function api_coupon_grant_revoke(text, uuid) from public, anon, authenticated;
revoke execute on function api_customers_list(text, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function api_customer_get(text, uuid) from public, anon, authenticated;
revoke execute on function api_customer_create(text, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_update(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function api_customer_delete(text, uuid) from public, anon, authenticated;
grant execute on function api_coupons_list(text, text, boolean, integer, integer) to service_role;
grant execute on function api_coupon_get(text, uuid, text) to service_role;
grant execute on function api_coupon_create(text, jsonb) to service_role;
grant execute on function api_coupon_update(text, uuid, jsonb) to service_role;
grant execute on function api_coupon_delete(text, uuid) to service_role;
grant execute on function api_coupon_grants_list(text, uuid, text, integer, integer) to service_role;
grant execute on function api_coupon_grants_issue(text, uuid, uuid[], integer) to service_role;
grant execute on function api_coupon_grant_revoke(text, uuid) to service_role;
grant execute on function api_customers_list(text, text, text, integer, integer) to service_role;
grant execute on function api_customer_get(text, uuid) to service_role;
grant execute on function api_customer_create(text, jsonb) to service_role;
grant execute on function api_customer_update(text, uuid, jsonb) to service_role;
grant execute on function api_customer_delete(text, uuid) to service_role;

insert into banto_migrations (version) values ('0036_api_coupons_customers');
