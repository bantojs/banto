-- Banto 0003_api: AI 用トークン（MCP / REST）と api_* RPC、売上集計
-- 設計と脅威モデルは docs/ai-access.md。すべての api_* は api_require() でトークン・期限・失効・スコープを検証し、
-- トークンに紐づく shop_id だけを対象にする（CLAUDE.md §3: service_role 経路は RPC 内で shop_id を検証）。

-- ---------- トークン ----------
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  owner_id uuid not null references owners(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  -- SHA-256(hex) のみ保存。生のトークンは発行時に一度だけ表示する
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  prefix text not null check (length(prefix) between 4 and 16),
  scopes text[] not null default '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint api_tokens_scopes_valid check (
    scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read']::text[]
  )
);
create index on api_tokens(shop_id);

alter table api_tokens enable row level security;
-- owner はトークンの管理（発行・失効・削除）ができる。ハッシュ列も owner には見えるが、ハッシュから生トークンは作れない。
create policy api_tokens_owner on api_tokens for all
  using (banto_owns_shop(shop_id)) with check (banto_owns_shop(shop_id) and owner_id = auth.uid());

-- ---------- 検証ヘルパー（内部用） ----------
-- トークンを検証し、行を返す。失敗はすべて同じメッセージ（存在・失効・期限・スコープを区別させない）。
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
  if not found or not (p_scope = any(v_tok.scopes)) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  -- 最終利用は1分に1回だけ更新（書き込みを減らす）
  if v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute' then
    update api_tokens set last_used_at = now() where id = v_tok.id;
  end if;
  return v_tok;
end;
$$;

create or replace function api_has_scope(p_token_hash text, p_scope text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from api_tokens
     where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now())
       and p_scope = any(scopes)
  );
$$;

-- トークンが有効なら、紐づく shop_id だけを返す（スコープ不問。画像の保存先キーの組み立てに使う）
create or replace function api_token_shop(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'api_token_shop: service_role only' using errcode = '42501';
  end if;
  select * into v_tok from api_tokens
   where token_hash = p_token_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then raise exception 'unauthorized' using errcode = '42501'; end if;
  return jsonb_build_object('shop_id', v_tok.shop_id, 'scopes', to_jsonb(v_tok.scopes), 'name', v_tok.name);
end;
$$;

-- ---------- 共通の JSON 整形 ----------
create or replace function api_product_json(p_product products, p_with_skus boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_product.id, 'slug', p_product.slug, 'name', p_product.name, 'description', p_product.description,
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'status', p_order.status, 'total_jpy', p_order.total_jpy,
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true,
        'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi
                left join skus k on k.id = oi.sku_id
                left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  );
$$;

-- ---------- ショップ ----------
create or replace function api_shop_get(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_shop shops%rowtype;
begin
  v_tok := api_require(p_token_hash, 'shop:read');
  select * into v_shop from shops where id = v_tok.shop_id;
  return jsonb_build_object(
    'id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'published', v_shop.published,
    'legal_notice', v_shop.legal_notice, 'privacy_policy', v_shop.privacy_policy, 'return_policy', v_shop.return_policy,
    'low_stock_threshold', coalesce((v_shop.settings->>'low_stock_threshold')::integer, 3),
    'stripe_connected', v_shop.stripe_account_id is not null,
    'created_at', v_shop.created_at, 'updated_at', v_shop.updated_at);
end;
$$;

-- 更新できる項目だけを受け付ける（settings 全体や stripe_account_id は触らせない）
create or replace function api_shop_update(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_threshold integer;
begin
  v_tok := api_require(p_token_hash, 'shop:write');
  if p_values ? 'low_stock_threshold' then
    v_threshold := (p_values->>'low_stock_threshold')::integer;
    if v_threshold is null or v_threshold < 0 or v_threshold > 100000 then raise exception 'invalid_low_stock_threshold'; end if;
  end if;
  update shops set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    legal_notice = case when p_values ? 'legal_notice' then nullif(btrim(p_values->>'legal_notice'), '') else legal_notice end,
    privacy_policy = case when p_values ? 'privacy_policy' then nullif(btrim(p_values->>'privacy_policy'), '') else privacy_policy end,
    return_policy = case when p_values ? 'return_policy' then nullif(btrim(p_values->>'return_policy'), '') else return_policy end,
    published = coalesce((p_values->>'published')::boolean, published),
    settings = case when v_threshold is not null then settings || jsonb_build_object('low_stock_threshold', v_threshold) else settings end
  where id = v_tok.shop_id;
  return api_shop_get(p_token_hash);
end;
$$;

-- ---------- 商品 ----------
create or replace function api_products_list(p_token_hash text, p_query text default null, p_published boolean default null,
                                             p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_limit integer; v_total integer; v_items jsonb;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  select count(*) into v_total from products p
   where p.shop_id = v_tok.shop_id
     and (p_published is null or p.published = p_published)
     and (p_query is null or p.name ilike '%' || p_query || '%' or p.slug ilike '%' || p_query || '%');
  select coalesce(jsonb_agg(api_product_json(p, true) order by p.created_at desc), '[]'::jsonb) into v_items
    from (select * from products p
           where p.shop_id = v_tok.shop_id
             and (p_published is null or p.published = p_published)
             and (p_query is null or p.name ilike '%' || p_query || '%' or p.slug ilike '%' || p_query || '%')
           order by p.created_at desc
           limit v_limit offset greatest(0, coalesce(p_offset, 0))) p;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', greatest(0, coalesce(p_offset, 0)));
end;
$$;

create or replace function api_product_get(p_token_hash text, p_product_id uuid default null, p_slug text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:read');
  select * into v_p from products where shop_id = v_tok.shop_id and (id = p_product_id or (p_product_id is null and slug = p_slug));
  if not found then raise exception 'not_found'; end if;
  return api_product_json(v_p, true);
end;
$$;

create or replace function api_product_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  insert into products (shop_id, slug, name, description, published)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false))
  returning * into v_p;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

create or replace function api_product_update(p_token_hash text, p_product_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  update products set
    slug = coalesce(p_values->>'slug', slug),
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    description = case when p_values ? 'description' then nullif(btrim(p_values->>'description'), '') else description end,
    published = coalesce((p_values->>'published')::boolean, published)
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- SKU: 作成（在庫の初期値つき）と更新（価格・名前・在庫）。在庫は set_stock と同じく値を直接セットする
create or replace function api_sku_create(p_token_hash text, p_product_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_k skus%rowtype; v_available integer;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not exists (select 1 from products where id = p_product_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  insert into skus (shop_id, product_id, code, name, price_jpy)
  values (v_tok.shop_id, p_product_id, p_values->>'code', nullif(btrim(coalesce(p_values->>'name', '')), ''), (p_values->>'price_jpy')::integer)
  returning * into v_k;
  v_available := coalesce((p_values->>'available')::integer, 0);
  if v_available < 0 then raise exception 'invalid_available'; end if;
  update inventory set available = v_available, updated_at = now() where sku_id = v_k.id;
  return api_product_get(p_token_hash, p_product_id);
end;
$$;

create or replace function api_sku_update(p_token_hash text, p_sku_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_k skus%rowtype; v_available integer;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  update skus set
    code = coalesce(p_values->>'code', code),
    name = case when p_values ? 'name' then nullif(btrim(p_values->>'name'), '') else name end,
    price_jpy = coalesce((p_values->>'price_jpy')::integer, price_jpy)
  where id = p_sku_id and shop_id = v_tok.shop_id
  returning * into v_k;
  if not found then raise exception 'not_found'; end if;
  if p_values ? 'available' then
    v_available := (p_values->>'available')::integer;
    if v_available is null or v_available < 0 then raise exception 'invalid_available'; end if;
    update inventory set available = v_available, updated_at = now() where sku_id = v_k.id;
  end if;
  return api_product_get(p_token_hash, v_k.product_id);
end;
$$;

create or replace function api_sku_delete(p_token_hash text, p_sku_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_product uuid;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  delete from skus where id = p_sku_id and shop_id = v_tok.shop_id returning product_id into v_product;
  if not found then raise exception 'not_found'; end if;
  return api_product_get(p_token_hash, v_product);
end;
$$;

-- 画像: Worker がストレージに置いたあと行を登録する / 削除して storage_key を返す（Worker がストレージから消す）
create or replace function api_image_add(p_token_hash text, p_product_id uuid, p_storage_key text, p_sort_order integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_sort integer;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  if not exists (select 1 from products where id = p_product_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  if p_storage_key !~ ('^shops/' || v_tok.shop_id::text || '/') then raise exception 'invalid_storage_key'; end if;
  select coalesce(p_sort_order, coalesce(max(sort_order), -1) + 1) into v_sort from product_images where product_id = p_product_id;
  insert into product_images (shop_id, product_id, storage_key, sort_order) values (v_tok.shop_id, p_product_id, p_storage_key, v_sort);
  return api_product_get(p_token_hash, p_product_id);
end;
$$;

create or replace function api_image_delete(p_token_hash text, p_image_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_key text;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  delete from product_images where id = p_image_id and shop_id = v_tok.shop_id returning storage_key into v_key;
  if not found then raise exception 'not_found'; end if;
  return v_key;
end;
$$;

-- ---------- 注文 ----------
create or replace function api_orders_list(p_token_hash text, p_status text default null, p_from timestamptz default null,
                                           p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer; v_total integer; v_items jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  select count(*) into v_total from orders o
   where o.shop_id = v_tok.shop_id
     and (p_status is null or o.status::text = p_status)
     and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to);
  select coalesce(jsonb_agg(api_order_json(o, v_pii) order by o.created_at desc), '[]'::jsonb) into v_items
    from (select * from orders o
           where o.shop_id = v_tok.shop_id
             and (p_status is null or o.status::text = p_status)
             and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
           order by o.created_at desc
           limit v_limit offset greatest(0, coalesce(p_offset, 0))) o;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', greatest(0, coalesce(p_offset, 0)), 'pii', v_pii);
end;
$$;

create or replace function api_order_get(p_token_hash text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  select * into v_o from orders where id = p_order_id and shop_id = v_tok.shop_id;
  if not found then raise exception 'not_found'; end if;
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

create or replace function api_order_update_status(p_token_hash text, p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if p_status not in ('shipped', 'cancelled') then raise exception 'invalid_status'; end if;
  update orders set status = p_status::order_status,
                    shipped_at = case when p_status = 'shipped' then now() else shipped_at end
   where id = p_order_id and shop_id = v_tok.shop_id and status = 'paid'
  returning * into v_o;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'order.' || p_status,
    jsonb_build_object('order_id', v_o.id, 'shop_id', v_tok.shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status, 'shipped_at', v_o.shipped_at));
  return api_order_json(v_o, 'orders:pii' = any(v_tok.scopes));
end;
$$;

-- ---------- 集計（owner の管理画面と AI で共用） ----------
-- p_group_by: 'day' | 'month' | 'product'。キャンセル・返金は除く。
create or replace function sales_summary_for_shop(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_rows jsonb; v_total jsonb;
begin
  if p_group_by not in ('day', 'month', 'product') then raise exception 'invalid_group_by'; end if;
  select jsonb_build_object(
    'orders', count(*), 'revenue_jpy', coalesce(sum(o.total_jpy), 0),
    'items', coalesce((select sum(oi.qty) from order_items oi join orders o2 on o2.id = oi.order_id
                        where o2.shop_id = p_shop_id and o2.status in ('paid','shipped') and o2.created_at >= p_from and o2.created_at < p_to), 0),
    'avg_order_jpy', coalesce(round(avg(o.total_jpy)), 0))
    into v_total
    from orders o where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to;

  if p_group_by = 'product' then
    select coalesce(jsonb_agg(r order by (r->>'revenue_jpy')::bigint desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('product_id', p.id, 'product_name', coalesce(p.name, '(削除済み)'), 'sku_code', k.code,
                                'qty', sum(oi.qty), 'revenue_jpy', sum(oi.qty * oi.unit_price_jpy)) as r
        from order_items oi
        join orders o on o.id = oi.order_id
        left join skus k on k.id = oi.sku_id
        left join products p on p.id = k.product_id
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by p.id, p.name, k.code) x;
  else
    select coalesce(jsonb_agg(r order by r->>'period'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('period', to_char(date_trunc(p_group_by, o.created_at at time zone 'Asia/Tokyo'), case when p_group_by = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
                                'orders', count(*), 'revenue_jpy', sum(o.total_jpy)) as r
        from orders o
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by date_trunc(p_group_by, o.created_at at time zone 'Asia/Tokyo')) x;
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'group_by', p_group_by, 'timezone', 'Asia/Tokyo', 'total', v_total, 'rows', v_rows);
end;
$$;

-- owner（管理画面）用
create or replace function sales_summary(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text default 'day')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return sales_summary_for_shop(p_shop_id, p_from, p_to, p_group_by);
end;
$$;

-- AI 用
create or replace function api_sales_summary(p_token_hash text, p_from timestamptz, p_to timestamptz, p_group_by text default 'day')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'stats:read');
  return sales_summary_for_shop(v_tok.shop_id, p_from, p_to, p_group_by);
end;
$$;

create or replace function api_inventory_low(p_token_hash text, p_threshold integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_threshold integer;
begin
  v_tok := api_require(p_token_hash, 'stats:read');
  select coalesce(p_threshold, coalesce((s.settings->>'low_stock_threshold')::integer, 3)) into v_threshold from shops s where s.id = v_tok.shop_id;
  return (select coalesce(jsonb_agg(jsonb_build_object('sku_id', k.id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', p.id, 'product_name', p.name,
                                                       'available', inv.available, 'published', p.published) order by inv.available, p.name), '[]'::jsonb)
            from inventory inv join skus k on k.id = inv.sku_id join products p on p.id = k.product_id
           where inv.shop_id = v_tok.shop_id and inv.available <= v_threshold);
end;
$$;

-- ---------- 実行権限 ----------
-- api_* と内部ヘルパーは service_role 専用。sales_summary は owner（authenticated）。
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname like 'api\_%' or p.proname = 'sales_summary_for_shop')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
revoke execute on function sales_summary(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function sales_summary(uuid, timestamptz, timestamptz, text) to authenticated, service_role;

insert into banto_migrations (version) values ('0003_api');
