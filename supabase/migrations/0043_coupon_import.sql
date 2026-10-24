-- Banto 0043_coupon_import: クーポンの CSV 取り込み（同梱モジュール coupons の「CSV から取り込む」。docs/coupon-csv.md）
-- 前方専用。人間の要望 2026-10-20（ほかのカートのプラグイン独自の制限を、人や AI が Banto の形に直して入れる口）。
--   Worker は CSV を行ごとの JSON に直して 1 回で渡すだけ（Workers のサブリクエストの上限に当たらない）。
--   値の検査は AI 用 API と同じ banto_api_coupon_apply（0036 / 0042）。商品・カテゴリーは slug でこのショップのものだけ。
--   member_emails（この会員だけが使える）は、全員がこのショップの会員でなければ、その行を作らない（制限を外して作らない）。
--   既にあるクーポン（同じコード、または同じ external_ref）は作らない（何度流しても重複しない）。
--   p_dry_run = true なら何も書かずに、行ごとの結果だけを返す（確認の画面）。

create or replace function import_coupons(p_shop_id uuid, p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_values jsonb; v_cond jsonb; v_c coupon_campaigns%rowtype; v_new coupon_campaigns%rowtype;
  v_slugs text[]; v_missing text[]; v_ids uuid[]; v_emails text[]; v_key text;
  v_out jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_result jsonb; v_grants integer; v_code text; v_ref text;
  v_total_emails integer := 0;
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if not exists (select 1 from shops where id = p_shop_id and settings->'modules'->'coupons' = 'true'::jsonb) then raise exception 'module_disabled'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too_many_rows'; end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_result := jsonb_build_object('line', v_row->'line');
    begin
      if jsonb_typeof(v_row->'values') <> 'object' then raise exception 'invalid_row'; end if;
      v_values := v_row->'values';
      v_cond := case when jsonb_typeof(v_row->'conditions') = 'object' then v_row->'conditions' else '{}'::jsonb end;

      -- 商品・カテゴリー（slug → id）。ひとつでも見つからなければ作らない（対象を変えて作らない）
      foreach v_key in array array['product_slugs', 'exclude_product_slugs', 'category_slugs', 'exclude_category_slugs'] loop
        if jsonb_typeof(v_row->v_key) <> 'array' or jsonb_array_length(v_row->v_key) = 0 then continue; end if;
        if jsonb_array_length(v_row->v_key) > 200 then raise exception 'too_many_%', v_key; end if;
        select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_slugs from jsonb_array_elements_text(v_row->v_key) x where btrim(x) <> '';
        if v_key like '%product%' then
          select coalesce(array_agg(id), '{}') into v_ids from products where shop_id = p_shop_id and slug = any(v_slugs);
          select coalesce(array_agg(s order by s), '{}') into v_missing from unnest(v_slugs) s where not exists (select 1 from products where shop_id = p_shop_id and slug = s);
          if cardinality(v_missing) > 0 then raise exception 'unknown_products: %', array_to_string(v_missing[1:10], ', '); end if;
        else
          select coalesce(array_agg(id), '{}') into v_ids from categories where shop_id = p_shop_id and slug = any(v_slugs);
          select coalesce(array_agg(s order by s), '{}') into v_missing from unnest(v_slugs) s where not exists (select 1 from categories where shop_id = p_shop_id and slug = s);
          if cardinality(v_missing) > 0 then raise exception 'unknown_categories: %', array_to_string(v_missing[1:10], ', '); end if;
        end if;
        v_cond := v_cond || jsonb_build_object(replace(v_key, '_slugs', '_ids'), to_jsonb(v_ids));
      end loop;
      v_values := v_values || jsonb_build_object('conditions', v_cond);

      -- この会員だけが使えるクーポン: 共通のコードは作らず、会員ごとに発行する。全員が会員でなければ作らない
      v_emails := '{}';
      if jsonb_typeof(v_row->'member_emails') = 'array' and jsonb_array_length(v_row->'member_emails') > 0 then
        if jsonb_array_length(v_row->'member_emails') > 5000 then raise exception 'too_many_member_emails'; end if;
        select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_emails from jsonb_array_elements_text(v_row->'member_emails') x where btrim(x) <> '';
        v_total_emails := v_total_emails + cardinality(v_emails);
        if v_total_emails > 20000 then raise exception 'too_many_member_emails'; end if;
        select coalesce(array_agg(e order by e), '{}') into v_missing from unnest(v_emails) e
         where not exists (select 1 from customers where shop_id = p_shop_id and lower(email) = e);
        if cardinality(v_missing) > 0 then
          raise exception 'not_members: % (%)', array_to_string(v_missing[1:10], ', '), cardinality(v_missing);
        end if;
        v_code := nullif(upper(btrim(coalesce(v_values->>'code', ''))), '');
        if not (v_values ? 'external_ref') and v_code is not null then v_values := v_values || jsonb_build_object('external_ref', 'csv:' || v_code); end if;
        v_values := v_values || jsonb_build_object('code', null);
      end if;

      -- 値の検査（AI 用 API と同じ）。既定値は管理画面の新規作成と同じ
      if not (v_values ? 'name') then raise exception 'invalid_name'; end if;
      if not (v_values ? 'kind') then raise exception 'invalid_kind'; end if;
      v_c := null;
      v_c.id := gen_random_uuid();
      v_c.shop_id := p_shop_id;
      v_c.value := 0;
      v_c.combinable := false;
      v_c.audience := 'public';
      v_c.conditions := '{}'::jsonb;
      v_c.active := true;
      v_c.claimable := false;
      v_c := banto_api_coupon_apply(p_shop_id, v_c, v_values);

      -- 既にあるもの（同じコード・同じ external_ref。このファイルの中の重なりも）
      v_ref := v_c.external_ref;
      if (v_c.code is not null and (exists (select 1 from coupon_campaigns where shop_id = p_shop_id and code = v_c.code) or ('code:' || v_c.code) = any(v_seen)))
         or (v_ref is not null and (exists (select 1 from coupon_campaigns where shop_id = p_shop_id and external_ref = v_ref) or ('ref:' || v_ref) = any(v_seen))) then
        v_out := v_out || (v_result || jsonb_build_object('status', 'existing', 'code', v_c.code, 'name', v_c.name));
        continue;
      end if;
      if v_c.code is not null then v_seen := v_seen || ('code:' || v_c.code); end if;
      if v_ref is not null then v_seen := v_seen || ('ref:' || v_ref); end if;

      v_grants := cardinality(v_emails);
      if not p_dry_run then
        insert into coupon_campaigns (id, shop_id, name, code, kind, value, starts_at, ends_at, usage_limit, per_customer_limit,
                                      combinable, audience, conditions, active, grant_valid_days, auto_grant, claimable, external_ref)
        values (v_c.id, v_c.shop_id, v_c.name, v_c.code, v_c.kind, v_c.value, v_c.starts_at, v_c.ends_at, v_c.usage_limit, v_c.per_customer_limit,
                v_c.combinable, v_c.audience, v_c.conditions, v_c.active, v_c.grant_valid_days, v_c.auto_grant, v_c.claimable, v_c.external_ref)
        returning * into v_new;
        if cardinality(v_emails) > 0 then
          select count(*) into v_grants from jsonb_array_elements(coupon_grants_for_emails(p_shop_id, v_new.id, v_emails)) g where (g->>'member')::boolean;
        end if;
      end if;
      v_out := v_out || (v_result || jsonb_build_object('status', case when p_dry_run then 'ok' else 'created' end, 'code', v_c.code, 'name', v_c.name,
                                                        'campaign_id', case when p_dry_run then null else v_c.id end, 'members', v_grants, 'active', v_c.active));
    exception when others then
      -- この行だけ取り消して続ける（plpgsql の例外ブロックはセーブポイントとして働く）
      v_out := v_out || (v_result || jsonb_build_object('status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_out;
end;
$$;
revoke execute on function import_coupons(uuid, jsonb, boolean) from public, anon;
grant execute on function import_coupons(uuid, jsonb, boolean) to authenticated;

insert into banto_migrations (version) values ('0043_coupon_import');
