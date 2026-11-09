-- Banto 0135_admin_views: 管理画面の一覧の「ビュー」（よく使う条件に名前を付けて保存。メンテナの決定 2026-11-08、docs/knowledge/02-decisions.md）。前方専用。
--
-- ビューはショップのメンバーで共有する（人ごとにしない）。置き場は shops.settings のいちばん上の、画面ごとの鍵:
--   views_orders（項目 orders）・views_customers（customers）・views_products（catalog）・views_inquiries（support）
-- 保存できるのはその画面の項目を持つ人。member が shops の行を直接更新するには RLS（0024 の shops_member_update）が settings の
-- 項目を求めるので、書くのは専用の関数 views_set だけにする（security definer。その画面の項目を確かめ、その鍵だけを書き換える）。
-- 鍵は banto_shop_settings_perm（0129）にも画面の項目で登録し、直接の更新に対する守り（banto_shops_guard）にも効かせる。
-- お客様の画面に渡す設定の許可リスト（banto_shop_public_settings）には入れない。
--
-- 1 つのビュー: { "name": 1〜40 字, "query": { 条件の名前: 文字 } }。1 画面 20 まで。条件の名前は英小文字・_（20 字まで）、値は 200 字まで、
-- 12 個まで。条件の意味（どの名前が使えるか）は画面が決める（形の違う条件は画面と admin_search_ids が捨てる）。

create or replace function banto_shop_settings_perm(p_key text, p_module text)
returns text
language sql
immutable
as $$
  select case
    when p_key = 'modules' then case p_module
      when 'coupons' then 'marketing' when 'dialogs' then 'marketing' when 'audiences' then 'marketing' when 'product_feed' then 'marketing'
      when 'inquiries' then 'support'
      when 'pages' then 'content' when 'blog' then 'content'
      when 'care_labels' then 'catalog' when 'size_charts' then 'catalog' when 'embed' then 'catalog' when 'woo_import' then 'catalog'
      when 'event_relay' then 'integrations' when 'line_login' then 'integrations' when 'google_login' then 'integrations' when 'passkey' then 'integrations'
      when 'shipping_labels' then 'orders'
      when 'store_tryon' then 'stores'
      when 'favorites' then 'customers'
      else null end
    when p_key in ('headless', 'oauth') then 'integrations'
    when p_key = 'page_layouts' then 'content'
    when p_key = 'product_fields' then 'catalog'
    when p_key = 'customer_fields' then 'customers'
    when p_key = 'views_orders' then 'orders'
    when p_key = 'views_customers' then 'customers'
    when p_key = 'views_products' then 'catalog'
    when p_key = 'views_inquiries' then 'support'
    when p_key in ('members_login_limits', 'checkout', 'inquiries', 'order_lookup', 'line_marketing_limit', 'storefront',
                   'members_password', 'members_enabled', 'marketing_consent', 'images', 'store_tryon', 'legal_links') then 'admin'
    else null end;
$$;
revoke execute on function banto_shop_settings_perm(text, text) from public, anon, authenticated;

-- 画面 → 鍵と項目
create or replace function banto_view_screen_perm(p_screen text)
returns text
language sql
immutable
as $$
  select case p_screen when 'orders' then 'orders' when 'customers' then 'customers' when 'products' then 'catalog' when 'inquiries' then 'support' end;
$$;
revoke execute on function banto_view_screen_perm(text) from public, anon, authenticated;

-- ビューの並びを置き換える（空の配列で全部消す）。返り値は保存した並び
create or replace function views_set(p_shop_id uuid, p_screen text, p_views jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perm text := banto_view_screen_perm(p_screen);
  v_out jsonb := '[]'::jsonb;
  v_view jsonb;
  v_name text;
  v_query jsonb;
  v_k text;
  v_v jsonb;
begin
  if v_perm is null then raise exception 'invalid_screen' using errcode = '22023'; end if;
  if not banto_shop_perm(p_shop_id, v_perm) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_views) is distinct from 'array' or jsonb_array_length(p_views) > 20 then raise exception 'invalid_views' using errcode = '22023'; end if;
  for v_view in select * from jsonb_array_elements(p_views) loop
    if jsonb_typeof(v_view) <> 'object' or jsonb_typeof(v_view->'name') <> 'string' or jsonb_typeof(v_view->'query') <> 'object' then
      raise exception 'invalid_views' using errcode = '22023';
    end if;
    v_name := btrim(v_view->>'name');
    if char_length(v_name) not between 1 and 40 then raise exception 'invalid_view_name' using errcode = '22023'; end if;
    if (select count(*) from jsonb_object_keys(v_view->'query')) > 12 then raise exception 'invalid_views' using errcode = '22023'; end if;
    v_query := '{}'::jsonb;
    for v_k, v_v in select * from jsonb_each(v_view->'query') loop
      if v_k !~ '^[a-z_]{1,20}$' or jsonb_typeof(v_v) <> 'string' or char_length(v_v #>> '{}') > 200 then
        raise exception 'invalid_views' using errcode = '22023';
      end if;
      if (v_v #>> '{}') <> '' then v_query := v_query || jsonb_build_object(v_k, v_v); end if;
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object('name', v_name, 'query', v_query));
  end loop;
  update shops set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('views_' || p_screen, v_out) where id = p_shop_id;
  return v_out;
end;
$$;
revoke execute on function views_set(uuid, text, jsonb) from public, anon;
grant execute on function views_set(uuid, text, jsonb) to authenticated;

insert into banto_migrations (version) values ('0135_admin_views');
