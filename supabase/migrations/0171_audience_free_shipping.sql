-- 0171: 会員の条件ごとの送料無料の金額（メンテナの決定 2026-11-23、docs/audiences.md「会員の条件ごとの送料無料」）
-- ショップの設定 shipping.free_over_by_audience: [{ audience_id, free_over_jpy, label }]（0 = いつでも送料無料、10 件まで）。
-- 同梱モジュール「会員の条件」（0097）が ON で、ログイン中の会員が条件に合うときだけ効く。当てはまる決まりが複数なら低い金額。
-- 送料の計算は Worker（src/commerce/shipping.ts）だけ。会員が条件に合うかは DB の最新の独自項目で、判定の正の banto_audience_ok で決める
-- （Cookie・会員トークンに入れた値は数分前のものなので、送料の判定には使わない）。表示用の条件（URL のパラメータ）は使わない。
-- 消した会員の条件を指す決まりは、ここで結べないので効かない（設定から外すのは管理画面の保存のとき）。
-- 決まりの読み方（形の違う行・重なる条件を捨てて先頭の 10 件、金額は 0〜1,000,000）は Worker の audienceFreeRules と同じ（banto_audience_free_rules）。
-- お客様に公開する設定（banto_shop_public_settings）には、名前を付けた決まりの名前と金額だけを出す（会員の条件の id は出さない）。

-- 決まりを読む（Worker の src/commerce/shipping.ts の audienceFreeRules と同じ）。形の違う行・重なる条件を捨て、先頭の 10 件
create or replace function banto_audience_free_rules(p jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('audience_id', y.id, 'free_over_jpy', y.over, 'label', y.label) order by y.n), '[]'::jsonb)
    from (
      select x.id, x.over, x.label, x.n
        from (
          select distinct on (lower(e->>'audience_id'))
                 lower(e->>'audience_id') as id,
                 (e->>'free_over_jpy')::integer as over,
                 nullif(left(btrim(case when jsonb_typeof(e->'label') = 'string' then e->>'label' else '' end), 40), '') as label,
                 t.n
            from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality as t(e, n)
           where jsonb_typeof(e) = 'object'
             and jsonb_typeof(e->'audience_id') = 'string'
             and lower(e->>'audience_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and jsonb_typeof(e->'free_over_jpy') = 'number'
             and (e->>'free_over_jpy') ~ '^[0-9]{1,7}$'
             and (e->>'free_over_jpy')::integer <= 1000000
           order by lower(e->>'audience_id'), t.n
        ) x
       order by x.n
       limit 10
    ) y;
$$;
revoke execute on function banto_audience_free_rules(jsonb) from public, anon, authenticated;

-- お客様に公開する送料の設定: 会員の条件ごとの決まりは、名前を付けたものの名前と金額だけ（id は出さない）。
-- member_free は決まりがあるか（Worker が会員の判定を DB に聞くかどうかに使う。金額・条件は出さない）
create or replace function banto_public_shipping(s jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select (s - 'free_over_by_audience' - 'member_free')
         || case when jsonb_array_length(q.r) > 0
                 then jsonb_build_object('member_free', true,
                        'free_over_by_audience', coalesce((select jsonb_agg(jsonb_build_object('label', x->>'label', 'free_over_jpy', (x->>'free_over_jpy')::integer) order by t.n)
                                                             from jsonb_array_elements(q.r) with ordinality as t(x, n)
                                                            where x->>'label' is not null), '[]'::jsonb))
                 else '{}'::jsonb end
    from (select banto_audience_free_rules(s->'free_over_by_audience') as r) q;
$$;
revoke execute on function banto_public_shipping(jsonb) from public, anon, authenticated;

-- 公開する settings（0170 を差し替え）。shipping だけ banto_public_shipping を通す
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding', 'storefront', 'analytics', 'marketing_consent', 'page_layouts', 'cod',
                                'checkout_members_only', 'payment_fees')), '{}'::jsonb)
      || case when jsonb_typeof(p->'shipping') = 'object'
              then jsonb_build_object('shipping', banto_public_shipping(p->'shipping'))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'product_fields') = 'array'
              then jsonb_build_object('product_fields', coalesce((select jsonb_agg(f) from jsonb_array_elements(p->'product_fields') f
                                                                    where jsonb_typeof(f) = 'object' and f->'public' is distinct from 'false'::jsonb), '[]'::jsonb))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb))
                                                || case when jsonb_typeof(p->'headless'->'order_page_url') = 'string'
                                                        then jsonb_build_object('order_page_url', p->'headless'->'order_page_url') else '{}'::jsonb end
                                                || case when jsonb_typeof(p->'headless'->'account_page_url') = 'string'
                                                        then jsonb_build_object('account_page_url', p->'headless'->'account_page_url') else '{}'::jsonb end)
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;

-- 会員が当てはまる決まりのいちばん低い金額。セッション（世代・行）を確かめる（ほかの member_* と同じ。切れていれば null = 送料がかかる）
create or replace function member_free_shipping_over(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
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
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  select s.settings into v_settings from shops s where s.id = p_shop_id;
  if v_settings is null or coalesce(v_settings->'modules'->>'audiences', 'false') <> 'true' then return null; end if;
  v_rules := banto_audience_free_rules(v_settings->'shipping'->'free_over_by_audience');
  if jsonb_array_length(v_rules) = 0 then return null; end if;
  select c.attributes into v_attrs from customers c where c.shop_id = p_shop_id and c.id = p_customer_id;
  if not found then return null; end if;
  select min((x.r->>'free_over_jpy')::integer) into v_min
    from jsonb_array_elements(v_rules) x(r)
    join audiences a on a.shop_id = p_shop_id and a.id::text = x.r->>'audience_id'
   where not banto_audience_display_only(a.condition)
     and banto_audience_ok(a.condition, true, coalesce(v_attrs, '{}'::jsonb));
  return v_min;
end;
$$;
revoke execute on function member_free_shipping_over(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_free_shipping_over(uuid, uuid, integer, uuid) to service_role;

-- お店の画面の会員の条件の一覧（0097 を差し替え）: 条件ごとの送料無料の金額 free_over_jpy を添える（決まりが無い・表示用の条件なら付けない）。
-- カートの「あと○円で送料無料」の目安だけに使う（覚えた一覧と会員の Cookie・会員トークンの独自項目で判定。お金は member_free_shipping_over）
create or replace function shop_audiences_render(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_settings jsonb; v_rules jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'shop_audiences_render: service_role only' using errcode = '42501';
  end if;
  select s.settings into v_settings from shops s where s.id = p_shop_id;
  if v_settings is null or coalesce(v_settings->'modules'->>'audiences', 'false') <> 'true' then
    return '[]'::jsonb;
  end if;
  v_rules := banto_audience_free_rules(v_settings->'shipping'->'free_over_by_audience');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'condition', a.condition)
             || case when f.over is not null and not banto_audience_display_only(a.condition) then jsonb_build_object('free_over_jpy', f.over) else '{}'::jsonb end
           order by a.name)
      from audiences a
      left join lateral (select min((x->>'free_over_jpy')::integer) as over from jsonb_array_elements(v_rules) x where x->>'audience_id' = a.id::text) f on true
     where a.shop_id = p_shop_id), '[]'::jsonb);
end;
$$;
revoke execute on function shop_audiences_render(uuid) from public, anon, authenticated;
grant execute on function shop_audiences_render(uuid) to service_role;

insert into banto_migrations (version) values ('0171_audience_free_shipping');
