-- 0158_coupon_cod: クーポンの条件「使える支払い方法」に代金引換（cod）を足す。前方専用。
--   - banto_api_coupon_apply（0130 を差し替え。値の検査だけ。判定は src/commerce/discounts.ts、確定のとき引き直す）
--   - 0157 までは支払い方法を絞ったクーポンは代引きでは使えなかった（絞っていないクーポンは今までどおり使える）

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
                 or exists (select 1 from jsonb_array_elements(v_cv) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^(stripe|komoju|komoju:[a-z_]{1,40}|amazon_pay|cod)$') then
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

insert into banto_migrations (version) values ('0158_coupon_cod');
