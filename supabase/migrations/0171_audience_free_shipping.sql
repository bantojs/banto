-- 0171: 会員の条件ごとの送料無料の金額（メンテナの決定 2026-11-23、docs/shipping.md「会員の条件ごとの送料無料」）
-- ショップの設定 shipping.free_over_by_audience: [{ audience_id, free_over_jpy, label }]（0 = いつでも送料無料、10 件まで）。
-- 同梱モジュール「会員の条件」（0097）が ON で、ログイン中の会員が条件に合うときだけ効く。当てはまる決まりが複数なら低い金額。
-- 送料の計算は Worker（src/commerce/shipping.ts）だけ。会員が条件に合うかは DB の最新の独自項目で、判定の正の banto_audience_ok で決める
-- （Cookie・会員トークンに入れた値は数分前のものなので、送料の判定には使わない）。表示用の条件（URL のパラメータ）は使わない。
-- 消した会員の条件を指す決まりは、ここで結べないので効かない（設定から外すのは管理画面の保存のとき）。

create or replace function member_free_shipping_over(p_shop_id uuid, p_customer_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_settings jsonb; v_rules jsonb; v_attrs jsonb; v_min integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_free_shipping_over: service_role only' using errcode = '42501';
  end if;
  select s.settings into v_settings from shops s where s.id = p_shop_id;
  if v_settings is null or coalesce(v_settings->'modules'->>'audiences', 'false') <> 'true' then return null; end if;
  v_rules := v_settings->'shipping'->'free_over_by_audience';
  if v_rules is null or jsonb_typeof(v_rules) <> 'array' or jsonb_array_length(v_rules) = 0 then return null; end if;
  select c.attributes into v_attrs from customers c where c.shop_id = p_shop_id and c.id = p_customer_id;
  if not found then return null; end if;
  select min((r->>'free_over_jpy')::integer) into v_min
    from (select r from jsonb_array_elements(v_rules) r limit 10) x
    join audiences a on a.shop_id = p_shop_id and a.id::text = x.r->>'audience_id'
   where jsonb_typeof(x.r) = 'object'
     and jsonb_typeof(x.r->'free_over_jpy') = 'number'
     and (x.r->>'free_over_jpy') ~ '^[0-9]{1,7}$'
     and not banto_audience_display_only(a.condition)
     and banto_audience_ok(a.condition, true, coalesce(v_attrs, '{}'::jsonb));
  return v_min;
end;
$$;
revoke execute on function member_free_shipping_over(uuid, uuid) from public, anon, authenticated;
grant execute on function member_free_shipping_over(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0171_audience_free_shipping');
