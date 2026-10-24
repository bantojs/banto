-- Banto 0049_coupon_attributes: クーポンの条件に会員の独自項目（customers.attributes、0047）を足す（人間の要望 2026-10-23）。前方専用。
--   conditions.attributes … { "<鍵>": ["値", ...] }。ログイン中の会員のその項目の値が、どれかに合うときだけ使える（鍵が複数なら全部）。
--                           ゲストには使えない。鍵はショップの設定「会員の項目」（customer_fields）にあるものだけ
-- 判定は src/commerce/discounts.ts だけ（CLAUDE.md §7 基準 (1)）。ここは値の検査（banto_api_coupon_apply、AI 用 API と CSV の取り込み）と、
-- 判定の材料（coupon_lookup）にログイン中の会員の attributes を載せるだけ。DB の往復は増やさない（速度の予算）。

-- ---------- クーポンの条件の検査（0044 を置き換える。attributes を受け付ける） ----------
create or replace function banto_api_coupon_apply(p_shop_id uuid, p_c coupon_campaigns, p_values jsonb)
returns coupon_campaigns
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text; v_val jsonb; v_cond jsonb; v_ck text; v_cv jsonb; v_ids uuid[]; v_n integer; v_s text; v_tags text[];
  v_defs jsonb; v_def jsonb; v_ak text; v_av jsonb; v_attr jsonb;
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
            when 'tags', 'exclude_tags' then
              -- タグ（0042）。商品のタグと同じ正規化（src/products/tags.ts）。20 個まで
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 20
                 or exists (select 1 from jsonb_array_elements(v_cv) e where jsonb_typeof(e) <> 'string') then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              v_tags := banto_normalize_tags(v_cv);
              if coalesce(array_length(v_tags, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object(v_ck, to_jsonb(v_tags)); end if;
            when 'brands', 'exclude_brands' then
              -- ブランド（0044）。商品のブランドと前後の空白・大文字小文字を区別せずに比べる。20 個・1 個 100 文字まで
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 20
                 or exists (select 1 from jsonb_array_elements(v_cv) e where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100) then
                raise exception 'invalid_conditions_%', v_ck;
              end if;
              select coalesce(array_agg(distinct btrim(e #>> '{}')), '{}') into v_tags from jsonb_array_elements(v_cv) e;
              if coalesce(array_length(v_tags, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object(v_ck, to_jsonb(v_tags)); end if;
            when 'payment_methods' then
              -- 支払い方法（0044）: stripe / komoju / komoju:<種類>。判定は src/commerce/discounts.ts
              if jsonb_typeof(v_cv) <> 'array' or jsonb_array_length(v_cv) > 20
                 or exists (select 1 from jsonb_array_elements(v_cv) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^(stripe|komoju|komoju:[a-z_]{1,40})$') then
                raise exception 'invalid_conditions_payment_methods';
              end if;
              select coalesce(array_agg(distinct e #>> '{}'), '{}') into v_tags from jsonb_array_elements(v_cv) e;
              if coalesce(array_length(v_tags, 1), 0) > 0 then v_cond := v_cond || jsonb_build_object('payment_methods', to_jsonb(v_tags)); end if;
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
            when 'attributes' then
              -- 会員の独自項目（0049）: { "<鍵>": ["値", ...] }。鍵はショップの設定 customer_fields にあるものだけ（10 個まで）、
              -- 値は文字列か数で 1 個 100 文字・20 個まで。select の項目は選択肢の中だけ。判定は src/commerce/discounts.ts
              if jsonb_typeof(v_cv) <> 'object' then raise exception 'invalid_conditions_attributes'; end if;
              select settings->'customer_fields' into v_defs from shops where id = p_shop_id;
              if v_defs is null or jsonb_typeof(v_defs) <> 'array' then v_defs := '[]'::jsonb; end if;
              v_attr := '{}'::jsonb;
              for v_ak, v_av in select * from jsonb_each(v_cv) loop
                if jsonb_typeof(v_av) = 'null' then continue; end if;
                select d into v_def from jsonb_array_elements(v_defs) d where jsonb_typeof(d) = 'object' and d->>'key' = v_ak limit 1;
                if v_def is null then raise exception 'invalid_conditions_attributes_%', left(v_ak, 40); end if;
                if jsonb_typeof(v_av) <> 'array' or jsonb_array_length(v_av) > 20
                   or exists (select 1 from jsonb_array_elements(v_av) e
                               where jsonb_typeof(e) not in ('string', 'number') or length(btrim(e #>> '{}')) not between 1 and 100) then
                  raise exception 'invalid_conditions_attributes_%', left(v_ak, 40);
                end if;
                select coalesce(array_agg(distinct btrim(e #>> '{}')), '{}') into v_tags from jsonb_array_elements(v_av) e;
                if v_def->>'type' = 'select' and exists (select 1 from unnest(v_tags) t where not (coalesce(v_def->'options', '[]'::jsonb) @> to_jsonb(t))) then
                  raise exception 'invalid_conditions_attributes_%', left(v_ak, 40);
                end if;
                if coalesce(array_length(v_tags, 1), 0) > 0 then v_attr := v_attr || jsonb_build_object(v_ak, to_jsonb(v_tags)); end if;
              end loop;
              if (select count(*) from jsonb_object_keys(v_attr)) > 10 then raise exception 'invalid_conditions_attributes'; end if;
              if v_attr <> '{}'::jsonb then v_cond := v_cond || jsonb_build_object('attributes', v_attr); end if;
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

-- ---------- 判定の材料（0019 を差し替え: p_customer_id を受け、会員の attributes を各行に載せる） ----------
drop function if exists coupon_lookup(uuid, text[], text);
create or replace function coupon_lookup(p_shop_id uuid, p_codes text[], p_subject text default null, p_customer_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_codes text[]; v_out jsonb; v_grants jsonb; v_attrs jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'coupon_lookup: service_role only' using errcode = '42501';
  end if;
  select array_agg(x) into v_codes from (select upper(btrim(x)) as x from unnest(coalesce(p_codes, '{}'::text[])) x limit 5) t;
  -- ログイン中の会員の独自項目（0047）。会員でなければ null（条件 attributes のあるクーポンは使えない）
  if p_customer_id is not null then
    select attributes into v_attrs from customers where shop_id = p_shop_id and id = p_customer_id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'code', c.code, 'kind', c.kind, 'value', c.value,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'usage_limit', c.usage_limit, 'per_customer_limit', c.per_customer_limit,
      'combinable', c.combinable, 'audience', c.audience, 'conditions', c.conditions, 'active', c.active,
      'used_by_subject', case when p_subject is null or c.per_customer_limit is null then 0 else (
        select count(*) from coupon_redemptions r where r.campaign_id = c.id and r.subject = p_subject and r.status <> 'released') end,
      'available', c.usage_limit is null or exists (select 1 from coupon_slots s where s.campaign_id = c.id and s.status = 'free'),
      'customer_attributes', v_attrs
    )), '[]'::jsonb)
    into v_out
    from coupon_campaigns c
   where c.shop_id = p_shop_id and c.code = any (coalesce(v_codes, '{}'::text[]));
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'code', g.code, 'kind', c.kind, 'value', c.value,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'usage_limit', null, 'per_customer_limit', null,
      'combinable', c.combinable, 'audience', c.audience, 'conditions', c.conditions, 'active', c.active,
      'used_by_subject', 0, 'available', true, 'customer_attributes', v_attrs,
      'grant', jsonb_build_object('id', g.id, 'status', g.status, 'expires_at', g.expires_at, 'customer_id', g.customer_id)
    )), '[]'::jsonb)
    into v_grants
    from coupon_grants g join coupon_campaigns c on c.id = g.campaign_id
   where g.shop_id = p_shop_id and g.code = any (coalesce(v_codes, '{}'::text[]))
     and not exists (select 1 from coupon_campaigns c2 where c2.shop_id = p_shop_id and c2.code = g.code);
  return v_out || v_grants;
end;
$$;
revoke execute on function coupon_lookup(uuid, text[], text, uuid) from public, anon, authenticated;
grant execute on function coupon_lookup(uuid, text[], text, uuid) to service_role;

insert into banto_migrations (version) values ('0049_coupon_attributes');
