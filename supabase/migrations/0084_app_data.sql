-- Banto 0084_app_data: 外部プラグインの拡張データの器（メンテナの決定 2026-11-01、docs/app-data.md）。前方専用。
--   - 外部プラグイン（hooks の送信先）が、商品に付くデータ（最初はレビューの要約 reviews.v1 だけ）を Banto に置き直す「押し込む形」。
--     お客様の画面は Banto の中のデータだけで描き、リクエストのたびにプラグインへ取りに行かない
--   - 名前の空間は送信先ごとに Banto が決める（hook_endpoints.app_handle）。プラグインが自由に名乗らないので、別のプラグインと重ならない
--   - 書く口は AI 用トークンの新しいスコープ app_data:write だけ。トークンは送信先に結び（api_tokens.endpoint_id）、
--     自分の送信先の行しか書けない。項目は新しい apps（商品の担当者 catalog に外のサービスの書き込みまで許させないため）
--   - 形は kind ごとに Banto が検査して、知っている鍵だけに組み直して置く（HTML は受けても文字として描く）
--   - お客様の画面は product_public_get が公開の分（public・送信先が有効・名前あり）を商品と一緒に返す（DB の往復を増やさない）
--   - 送信先を消したら、その送信先のトークンと拡張データも消える（外部キーの cascade）

-- ---------- 権限の項目に apps を足す（0024・0061・0071・0079） ----------
create or replace function banto_shop_perms_all()
returns text[]
language sql
immutable
as $$ select array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design', 'content', 'apps'] $$;

alter table org_member_shops drop constraint if exists org_member_shops_perms_check;
alter table org_member_shops add constraint org_member_shops_perms_check
  check (perms <@ array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations', 'support', 'design', 'content', 'apps']);

-- ---------- 送信先の名前の空間 ----------
alter table hook_endpoints add column if not exists app_handle text
  check (app_handle is null or app_handle ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$|^[a-z]$');
create unique index if not exists hook_endpoints_app_handle_unique on hook_endpoints (shop_id, app_handle) where app_handle is not null;
-- トークンと拡張データの外部キー（送信先とショップの組）のため
alter table hook_endpoints drop constraint if exists hook_endpoints_id_shop_id_key;
alter table hook_endpoints add constraint hook_endpoints_id_shop_id_key unique (id, shop_id);

-- ---------- トークンを送信先に結ぶ ----------
alter table api_tokens add column if not exists endpoint_id uuid;
alter table api_tokens drop constraint if exists api_tokens_endpoint_fkey;
alter table api_tokens add constraint api_tokens_endpoint_fkey foreign key (endpoint_id, shop_id) references hook_endpoints (id, shop_id) on delete cascade;
create index if not exists api_tokens_endpoint_idx on api_tokens (endpoint_id) where endpoint_id is not null;

alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write','app_data:write']::text[]
);
-- app_data:write は送信先に結んだトークンだけ
alter table api_tokens drop constraint if exists api_tokens_app_data_endpoint;
alter table api_tokens add constraint api_tokens_app_data_endpoint check (not ('app_data:write' = any(scopes)) or endpoint_id is not null);

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
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
    when 'content:read' then 'content'
    when 'content:write' then 'content'
    when 'app_data:write' then 'apps'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- 発行したあとに送信先を付け替えさせない（0055 の判定に endpoint_id を足す）
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
       or new.created_at is distinct from old.created_at or new.last_used_at is distinct from old.last_used_at
       or new.endpoint_id is distinct from old.endpoint_id then
      raise exception 'token_immutable' using errcode = '42501';
    end if;
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

-- ---------- 表 ----------
create table if not exists app_data (
  shop_id uuid not null references shops (id) on delete cascade,
  endpoint_id uuid not null,
  product_id uuid not null,
  kind text not null check (kind in ('reviews.v1')),
  data jsonb not null,
  public boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (endpoint_id, product_id, kind),
  foreign key (endpoint_id, shop_id) references hook_endpoints (id, shop_id) on delete cascade,
  foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade
);
create index if not exists app_data_product_idx on app_data (product_id);
create index if not exists app_data_shop_idx on app_data (shop_id);

alter table app_data enable row level security;
-- 運営者は項目 apps で読める（書くのは service_role の api_app_data_* だけ）
drop policy if exists app_data_apps on app_data;
create policy app_data_apps on app_data for select using (banto_shop_perm(shop_id, 'apps'));
revoke all on app_data from anon, authenticated;
grant select on app_data to authenticated;

-- ---------- 形の検査 ----------
-- 知っている鍵だけに組み直して返す。誤りは invalid_app_data_<場所>
create or replace function banto_app_data_normalize(p_kind text, p jsonb)
returns jsonb language plpgsql immutable as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_out jsonb;
  v_count numeric;
  v_avg numeric;
  v_rating numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_app_data'; end if;
  if octet_length(p::text) > 65536 then raise exception 'invalid_app_data_too_large'; end if;
  if p_kind = 'reviews.v1' then
    if jsonb_typeof(p->'rating_count') <> 'number' then raise exception 'invalid_app_data_rating_count'; end if;
    v_count := (p->>'rating_count')::numeric;
    if v_count <> trunc(v_count) or v_count < 0 or v_count > 1000000000 then raise exception 'invalid_app_data_rating_count'; end if;
    if jsonb_typeof(p->'rating_avg') <> 'number' then raise exception 'invalid_app_data_rating_avg'; end if;
    v_avg := (p->>'rating_avg')::numeric;
    if v_avg < 0 or v_avg > 5 or (v_count > 0 and v_avg < 1) then raise exception 'invalid_app_data_rating_avg'; end if;
    if p ? 'items' then
      if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') > 20 then raise exception 'invalid_app_data_items'; end if;
      if jsonb_array_length(p->'items') > v_count then raise exception 'invalid_app_data_items'; end if;
      for v_item in select e from jsonb_array_elements(p->'items') e loop
        if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_app_data_items'; end if;
        if jsonb_typeof(v_item->'id') <> 'string' or char_length(v_item->>'id') not between 1 and 100 then raise exception 'invalid_app_data_item_id'; end if;
        if jsonb_typeof(v_item->'rating') <> 'number' then raise exception 'invalid_app_data_item_rating'; end if;
        v_rating := (v_item->>'rating')::numeric;
        if v_rating <> trunc(v_rating) or v_rating < 1 or v_rating > 5 then raise exception 'invalid_app_data_item_rating'; end if;
        if v_item ? 'title' and not (jsonb_typeof(v_item->'title') = 'null' or (jsonb_typeof(v_item->'title') = 'string' and char_length(v_item->>'title') <= 200)) then
          raise exception 'invalid_app_data_item_title';
        end if;
        if jsonb_typeof(v_item->'body') <> 'string' or char_length(v_item->>'body') > 2000 then raise exception 'invalid_app_data_item_body'; end if;
        if jsonb_typeof(v_item->'author_display') <> 'string' or char_length(btrim(v_item->>'author_display')) not between 1 and 100 then
          raise exception 'invalid_app_data_item_author_display';
        end if;
        if jsonb_typeof(v_item->'created_at') <> 'string' then raise exception 'invalid_app_data_item_created_at'; end if;
        begin
          perform (v_item->>'created_at')::timestamptz;
        exception when others then
          raise exception 'invalid_app_data_item_created_at';
        end;
        if v_item ? 'incentivized' and jsonb_typeof(v_item->'incentivized') <> 'boolean' then raise exception 'invalid_app_data_item_incentivized'; end if;
        if v_item ? 'verified_purchase' and jsonb_typeof(v_item->'verified_purchase') <> 'boolean' then raise exception 'invalid_app_data_item_verified_purchase'; end if;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_item->>'id',
          'rating', v_rating::int,
          'title', nullif(btrim(coalesce(v_item->>'title', '')), ''),
          'body', v_item->>'body',
          'author_display', btrim(v_item->>'author_display'),
          'created_at', (v_item->>'created_at')::timestamptz,
          'incentivized', coalesce((v_item->>'incentivized')::boolean, false),
          'verified_purchase', coalesce((v_item->>'verified_purchase')::boolean, false)
        ));
      end loop;
    end if;
    v_out := jsonb_build_object('rating_avg', round(v_avg, 2), 'rating_count', v_count::bigint, 'items', v_items);
    return v_out;
  end if;
  raise exception 'invalid_app_data_kind';
end;
$$;
revoke execute on function banto_app_data_normalize(text, jsonb) from public, anon, authenticated;

-- ---------- AI 用トークンの口（service_role だけ） ----------
-- トークンを確かめ、結んだ送信先（名前のあるもの）を返す
create or replace function api_app_require(p_token_hash text)
returns hook_endpoints language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_ep hook_endpoints;
begin
  v_tok := api_require(p_token_hash, 'app_data:write');
  select * into v_ep from hook_endpoints where id = v_tok.endpoint_id and shop_id = v_tok.shop_id;
  if not found then raise exception 'unauthorized' using errcode = '42501'; end if;
  if v_ep.app_handle is null then raise exception 'app_handle_required'; end if;
  return v_ep;
end;
$$;
revoke execute on function api_app_require(text) from public, anon, authenticated;

create or replace function banto_app_data_json(d app_data, p_handle text)
returns jsonb language sql stable as $$
  select jsonb_build_object('app', p_handle, 'product_id', d.product_id, 'kind', d.kind, 'public', d.public, 'data', d.data, 'updated_at', d.updated_at);
$$;
revoke execute on function banto_app_data_json(app_data, text) from public, anon, authenticated;

-- 置き直す（同じ商品・同じ形の行は丸ごと入れ替える）
create or replace function api_app_data_set(p_token_hash text, p_product_id uuid, p_kind text, p_data jsonb, p_public boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_row app_data; v_data jsonb;
begin
  v_ep := api_app_require(p_token_hash);
  if p_kind is null or p_kind not in ('reviews.v1') then raise exception 'invalid_app_data_kind'; end if;
  if not exists (select 1 from products where id = p_product_id and shop_id = v_ep.shop_id) then raise exception 'not_found'; end if;
  v_data := banto_app_data_normalize(p_kind, p_data);
  insert into app_data (shop_id, endpoint_id, product_id, kind, data, public, updated_at)
  values (v_ep.shop_id, v_ep.id, p_product_id, p_kind, v_data, coalesce(p_public, true), now())
  on conflict (endpoint_id, product_id, kind) do update set data = excluded.data, public = excluded.public, updated_at = now()
  returning * into v_row;
  return banto_app_data_json(v_row, v_ep.app_handle);
end;
$$;
revoke execute on function api_app_data_set(text, uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function api_app_data_set(text, uuid, text, jsonb, boolean) to service_role;

-- 消す（無ければ false）。p_kind が null ならその商品の自分の行をすべて
create or replace function api_app_data_delete(p_token_hash text, p_product_id uuid, p_kind text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_n integer;
begin
  v_ep := api_app_require(p_token_hash);
  delete from app_data where endpoint_id = v_ep.id and product_id = p_product_id and (p_kind is null or kind = p_kind);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke execute on function api_app_data_delete(text, uuid, text) from public, anon, authenticated;
grant execute on function api_app_data_delete(text, uuid, text) to service_role;

-- 自分の送信先が置いた行（商品を指定すればその商品だけ）。置き直しの確かめ用
create or replace function api_app_data_list(p_token_hash text, p_product_id uuid, p_limit integer, p_offset integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_items jsonb; v_total bigint;
begin
  v_ep := api_app_require(p_token_hash);
  select count(*) into v_total from app_data where endpoint_id = v_ep.id and (p_product_id is null or product_id = p_product_id);
  select coalesce(jsonb_agg(banto_app_data_json(d, v_ep.app_handle) order by d.updated_at desc, d.product_id), '[]'::jsonb) into v_items
    from (select * from app_data where endpoint_id = v_ep.id and (p_product_id is null or product_id = p_product_id)
           order by updated_at desc, product_id
           limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) d;
  return jsonb_build_object('app', v_ep.app_handle, 'items', v_items, 'total', v_total);
end;
$$;
revoke execute on function api_app_data_list(text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function api_app_data_list(text, uuid, integer, integer) to service_role;

-- ---------- お客様の画面: 商品と一緒に公開の分を返す（0055 の形に app_data を足す） ----------
create or replace function banto_public_app_data(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('app', e.app_handle, 'kind', d.kind, 'data', d.data, 'updated_at', d.updated_at) order by e.app_handle, d.kind), '[]'::jsonb)
    from app_data d join hook_endpoints e on e.id = d.endpoint_id and e.shop_id = d.shop_id
   where d.product_id = p_product_id and d.public and e.enabled and e.app_handle is not null;
$$;
revoke execute on function banto_public_app_data(uuid) from public, anon, authenticated;

create or replace function product_public_get(p_shop_id uuid, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(p) - 'attributes'
         || jsonb_build_object('attributes', banto_public_product_attributes(s.settings, p.attributes), 'app_data', banto_public_app_data(p.id))
    from products p join shops s on s.id = p.shop_id
   where p.shop_id = p_shop_id and p.slug = p_slug and p.published and s.published
   limit 1;
$$;
revoke execute on function product_public_get(uuid, text) from public;
grant execute on function product_public_get(uuid, text) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0084_app_data');
