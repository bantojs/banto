-- Banto 0085_app_data_custom: 拡張データに形を決めない種類 custom.v1 を足す（メンテナの決定 2026-11-01、docs/app-data.md §3）。前方専用。
--   - reviews.v1 のように Banto が形を知っている種類は、Banto 自身が描く（既定のテーマ・構造化データ）。
--     それ以外のプラグインのデータは、Banto の更新を待たずに custom.v1 で置ける。Banto 自身は描かず、Liquid のテーマとヘッドレスだけが読む
--   - custom.v1 は名前（key）ごとに 1 行。1 つのプラグインが 1 つの商品に「サイズ表」「採寸の仕方」のように分けて置ける（20 まで）
--   - 形は決めないが、大きさ・入れ子の深さ・鍵の名前・文字の長さを確かめる。url / *_url の鍵は https:// だけ、
--     どの文字も javascript: などで始まるものは受けない（テーマが href にそのまま使っても危なくないように）
--   - 誰のデータかは今までどおり連携（endpoint_id）で分かれ、お客様の画面には app（連携の名前）と key を付けて渡す

-- ---------- 名前（key） ----------
alter table app_data add column if not exists key text not null default '';
alter table app_data drop constraint if exists app_data_kind_check;
alter table app_data add constraint app_data_kind_check check (kind in ('reviews.v1', 'custom.v1'));
alter table app_data drop constraint if exists app_data_key_check;
alter table app_data add constraint app_data_key_check check (
  case when kind = 'custom.v1' then key ~ '^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$' else key = '' end
);
alter table app_data drop constraint if exists app_data_pkey;
alter table app_data add constraint app_data_pkey primary key (endpoint_id, product_id, kind, key);

-- ---------- custom.v1 の形の検査（中身は変えずに確かめるだけ） ----------
create or replace function banto_app_data_custom_check(v jsonb, p_depth integer, p_name text)
returns void language plpgsql immutable as $$
declare k text; e jsonb; s text;
begin
  if p_depth > 5 then raise exception 'invalid_app_data_too_deep'; end if;
  case jsonb_typeof(v)
    when 'object' then
      if (select count(*) from jsonb_object_keys(v)) > 50 then raise exception 'invalid_app_data_too_many_keys'; end if;
      for k, e in select * from jsonb_each(v) loop
        if k !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'invalid_app_data_key_name'; end if;
        perform banto_app_data_custom_check(e, p_depth + 1, k);
      end loop;
    when 'array' then
      if jsonb_array_length(v) > 100 then raise exception 'invalid_app_data_too_many_items'; end if;
      for e in select x from jsonb_array_elements(v) x loop
        perform banto_app_data_custom_check(e, p_depth + 1, p_name);
      end loop;
    when 'string' then
      s := v #>> '{}';
      if char_length(s) > 5000 then raise exception 'invalid_app_data_string_too_long'; end if;
      if s ~* '^[[:space:][:cntrl:]]*(javascript|vbscript|data|file):' then raise exception 'invalid_app_data_url'; end if;
      if (p_name = 'url' or p_name like '%\_url') and s !~ '^https://[^[:space:]<>"''`]+$' then raise exception 'invalid_app_data_url'; end if;
    else
      null; -- number / boolean / null
  end case;
end;
$$;
revoke execute on function banto_app_data_custom_check(jsonb, integer, text) from public, anon, authenticated;

create or replace function banto_app_data_normalize(p_kind text, p jsonb)
returns jsonb language plpgsql immutable as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_count numeric;
  v_avg numeric;
  v_rating numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_app_data'; end if;
  if octet_length(p::text) > 65536 then raise exception 'invalid_app_data_too_large'; end if;
  if p_kind = 'custom.v1' then
    perform banto_app_data_custom_check(p, 1, '');
    return p;
  end if;
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
    return jsonb_build_object('rating_avg', round(v_avg, 2), 'rating_count', v_count::bigint, 'items', v_items);
  end if;
  raise exception 'invalid_app_data_kind';
end;
$$;
revoke execute on function banto_app_data_normalize(text, jsonb) from public, anon, authenticated;

-- 名前の形（custom.v1 は要る、ほかの種類は空）
create or replace function banto_app_data_key(p_kind text, p_key text)
returns text language plpgsql immutable as $$
begin
  if p_kind = 'custom.v1' then
    if p_key is null or p_key !~ '^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$' then raise exception 'invalid_app_data_key'; end if;
    return p_key;
  end if;
  if coalesce(p_key, '') <> '' then raise exception 'invalid_app_data_key'; end if;
  return '';
end;
$$;
revoke execute on function banto_app_data_key(text, text) from public, anon, authenticated;

create or replace function banto_app_data_json(d app_data, p_handle text)
returns jsonb language sql stable as $$
  select jsonb_build_object('app', p_handle, 'product_id', d.product_id, 'kind', d.kind, 'key', d.key, 'public', d.public, 'data', d.data, 'updated_at', d.updated_at);
$$;
revoke execute on function banto_app_data_json(app_data, text) from public, anon, authenticated;

-- ---------- AI 用トークンの口（名前を足す。前の版のコードは p_key を送らないので、既定の値で今までどおり動く） ----------
drop function if exists api_app_data_set(text, uuid, text, jsonb, boolean);
create or replace function api_app_data_set(p_token_hash text, p_product_id uuid, p_kind text, p_data jsonb, p_public boolean default true, p_key text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_row app_data; v_data jsonb; v_key text;
begin
  v_ep := api_app_require(p_token_hash);
  if p_kind is null or p_kind not in ('reviews.v1', 'custom.v1') then raise exception 'invalid_app_data_kind'; end if;
  v_key := banto_app_data_key(p_kind, p_key);
  if not exists (select 1 from products where id = p_product_id and shop_id = v_ep.shop_id) then raise exception 'not_found'; end if;
  v_data := banto_app_data_normalize(p_kind, p_data);
  -- 1 つの連携が 1 つの商品に置ける custom.v1 は 20 まで
  if p_kind = 'custom.v1' and not exists (select 1 from app_data where endpoint_id = v_ep.id and product_id = p_product_id and kind = p_kind and key = v_key)
     and (select count(*) from app_data where endpoint_id = v_ep.id and product_id = p_product_id and kind = p_kind) >= 20 then
    raise exception 'app_data_keys_full';
  end if;
  insert into app_data (shop_id, endpoint_id, product_id, kind, key, data, public, updated_at)
  values (v_ep.shop_id, v_ep.id, p_product_id, p_kind, v_key, v_data, coalesce(p_public, true), now())
  on conflict (endpoint_id, product_id, kind, key) do update set data = excluded.data, public = excluded.public, updated_at = now()
  returning * into v_row;
  return banto_app_data_json(v_row, v_ep.app_handle);
end;
$$;
revoke execute on function api_app_data_set(text, uuid, text, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function api_app_data_set(text, uuid, text, jsonb, boolean, text) to service_role;

-- 消す。p_key が null なら、その種類の自分の行をすべて（custom.v1 の名前をまとめて消すとき）
drop function if exists api_app_data_delete(text, uuid, text);
create or replace function api_app_data_delete(p_token_hash text, p_product_id uuid, p_kind text, p_key text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ep hook_endpoints; v_n integer;
begin
  v_ep := api_app_require(p_token_hash);
  delete from app_data where endpoint_id = v_ep.id and product_id = p_product_id and (p_kind is null or kind = p_kind) and (p_key is null or key = p_key);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke execute on function api_app_data_delete(text, uuid, text, text) from public, anon, authenticated;
grant execute on function api_app_data_delete(text, uuid, text, text) to service_role;

-- ---------- お客様の画面: key も渡す ----------
create or replace function banto_public_app_data(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('app', e.app_handle, 'kind', d.kind, 'key', d.key, 'data', d.data, 'updated_at', d.updated_at) order by e.app_handle, d.kind, d.key), '[]'::jsonb)
    from app_data d join hook_endpoints e on e.id = d.endpoint_id and e.shop_id = d.shop_id
   where d.product_id = p_product_id and d.public and e.enabled and e.app_handle is not null;
$$;
revoke execute on function banto_public_app_data(uuid) from public, anon, authenticated;

insert into banto_migrations (version) values ('0085_app_data_custom');
