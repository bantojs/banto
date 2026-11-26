-- 0183: 送料無料の金額にセール商品を含まない（メンテナの決定 2026-11-26、docs/storefront.md「送料無料とセール商品」）。
--   ショップ全体の送料無料（shipping.free_over_jpy）と会員の条件ごとの送料無料（0171 の free_over_by_audience）のそれぞれに、
--   「セール商品を金額に含まない」の印を足す（ショップ全体は shipping.free_over_excludes_sale、会員の条件ごとは各行の exclude_sale。既定はどちらも含む）。
--   セール商品 = 通常価格（compare_at_price_jpy）が価格より高い SKU（会員価格・クーポンは数えない）。比べる金額は今までどおり商品の合計（値引きの前）で、
--   印のある決まりはそこからセール商品の分を引いて比べる。当てはまる決まりが 1 つでも満たされれば送料無料。
--   送料の計算は Worker（src/commerce/shipping.ts）だけ。会員が条件に合うかは今までどおり DB が決め、当てはまる決まり（金額と印）を返す
--   member_free_shipping を足す（0171 の member_free_shipping_over は 1 つの金額しか返せないので残して使わない）。

-- 0171 と同じ。exclude_sale を足す（印が無い・true でない行は false）
create or replace function banto_audience_free_rules(p jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('audience_id', y.id, 'free_over_jpy', y.over, 'label', y.label, 'exclude_sale', y.excl) order by y.n), '[]'::jsonb)
    from (
      select x.id, x.over, x.label, x.excl, x.n
        from (
          select distinct on (lower(e->>'audience_id'))
                 lower(e->>'audience_id') as id,
                 (e->>'free_over_jpy')::integer as over,
                 nullif(left(btrim(case when jsonb_typeof(e->'label') = 'string' then e->>'label' else '' end), 40), '') as label,
                 -- 0183: セール商品（通常価格のある SKU）を金額に含まない
                 coalesce(e->'exclude_sale' = 'true'::jsonb, false) as excl,
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

-- 0171 と同じ。名前を付けた決まりに exclude_sale を足す（お客様の画面の送料の案内に「セール商品を除く」と出すため）。
-- ショップ全体の free_over_excludes_sale は shipping の中の鍵なのでそのまま出る
create or replace function banto_public_shipping(s jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select (s - 'free_over_by_audience' - 'member_free')
         || case when jsonb_array_length(q.r) > 0
                 then jsonb_build_object('member_free', true,
                        'free_over_by_audience', coalesce((select jsonb_agg(jsonb_build_object('label', x->>'label', 'free_over_jpy', (x->>'free_over_jpy')::integer, 'exclude_sale', (x->>'exclude_sale')::boolean) order by t.n)
                                                             from jsonb_array_elements(q.r) with ordinality as t(x, n)
                                                            where x->>'label' is not null), '[]'::jsonb))
                 else '{}'::jsonb end
    from (select banto_audience_free_rules(s->'free_over_by_audience') as r) q;
$$;
revoke execute on function banto_public_shipping(jsonb) from public, anon, authenticated;

-- 会員が当てはまる決まり（金額とセール商品の印）。セッション（世代・行）を確かめる（0171 の member_free_shipping_over と同じ判定）。
-- 当てはまらない・切れていれば []（送料がかかる）
create or replace function member_free_shipping(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_settings jsonb; v_rules jsonb; v_attrs jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_free_shipping: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return '[]'::jsonb; end if;
  select s.settings into v_settings from shops s where s.id = p_shop_id;
  if v_settings is null or coalesce(v_settings->'modules'->>'audiences', 'false') <> 'true' then return '[]'::jsonb; end if;
  v_rules := banto_audience_free_rules(v_settings->'shipping'->'free_over_by_audience');
  if jsonb_array_length(v_rules) = 0 then return '[]'::jsonb; end if;
  select c.attributes into v_attrs from customers c where c.shop_id = p_shop_id and c.id = p_customer_id;
  if not found then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('free_over_jpy', (x.r->>'free_over_jpy')::integer, 'exclude_sale', coalesce((x.r->>'exclude_sale')::boolean, false)))
      from jsonb_array_elements(v_rules) x(r)
      join audiences a on a.shop_id = p_shop_id and a.id::text = x.r->>'audience_id'
     where not banto_audience_display_only(a.condition)
       and banto_audience_ok(a.condition, true, coalesce(v_attrs, '{}'::jsonb))), '[]'::jsonb);
end;
$$;
revoke execute on function member_free_shipping(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_free_shipping(uuid, uuid, integer, uuid) to service_role;

-- 0171 と同じ。会員の条件ごとの送料無料の印 free_over_excludes_sale を添える（カートの「あと○円」の目安）
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
             || case when f.over is not null and not banto_audience_display_only(a.condition) then jsonb_build_object('free_over_jpy', f.over, 'free_over_excludes_sale', f.excl) else '{}'::jsonb end
           order by a.name)
      from audiences a
      left join lateral (select (x->>'free_over_jpy')::integer as over, coalesce((x->>'exclude_sale')::boolean, false) as excl
                           from jsonb_array_elements(v_rules) x where x->>'audience_id' = a.id::text limit 1) f on true
     where a.shop_id = p_shop_id), '[]'::jsonb);
end;
$$;
revoke execute on function shop_audiences_render(uuid) from public, anon, authenticated;
grant execute on function shop_audiences_render(uuid) to service_role;

insert into banto_migrations (version) values ('0183_free_shipping_exclude_sale');
