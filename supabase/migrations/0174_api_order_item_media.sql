-- 0174: AI 用 API の注文の明細に、SKU の選択肢（カラー・サイズなど）と画像（メンテナの決定 2026-11-25）
-- 外部プラグインが注文のメールの明細に商品の画像とカラー・サイズを出せるように、api_order_json の明細の各行に足す（今の値は変えない）。
--   - options: SKU の選択肢を商品の軸（option_axes）の順に [{ key, name, value }]。名前は shops.option_names、無ければ key。注文の一覧にも付く
--   - 画像: 1 件の注文の応答（取得・状態の変更・取り消し・入金の記録・印）だけ。DB は候補（その商品の画像の options と置き場の鍵）を返し、
--     選ぶのは Worker の firstImageForSku（お店の画面・商品フィードと同じ一本道）、URL も Worker（MEDIA_BASE_URL）が組む。
--     一覧は件数が多いので候補を付けない（DB の手間を増やさない）
--   - どちらも商品の情報で個人情報ではないので orders:read のまま。
--   - 写しは残さず、今の SKU と画像から組む（注文のある SKU は消せない。画像が消えていれば null）
-- 旗の無い api_order_json(orders, boolean, boolean, boolean) は候補なしの形を呼ぶ（候補を付けるのは、下で定義し直す 1 件の注文の api_* だけ）。

create or replace function api_order_json(p_order orders, p_contact boolean, p_address boolean, p_note boolean, p_images boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'total_jpy', p_order.total_jpy, 'shipping_jpy', p_order.shipping_jpy,
    'discount_jpy', p_order.discount_jpy,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_order.discounts, '[]'::jsonb)) d),
    'payment_provider', p_order.payment_provider, 'payment_ref', p_order.payment_ref, 'customer_id', p_order.customer_id,
    'shipped_at', p_order.shipped_at, 'created_at', p_order.created_at, 'updated_at', p_order.updated_at,
    'payment_status', p_order.payment_status, 'paid_at', p_order.paid_at, 'cancel_reason', p_order.cancel_reason, 'fee_jpy', p_order.fee_jpy,
    'tracking', case when p_order.tracking_number is null then null
      else jsonb_build_object('carrier', coalesce(p_order.tracking_carrier, 'other'), 'number', p_order.tracking_number) end,
    'tags', to_jsonb(p_order.tags),
    'customer', case
      when p_contact and p_address then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      when p_contact then jsonb_build_object(
        'name', p_order.customer_name, 'email', p_order.customer_email, 'phone', p_order.shipping_address->>'phone', 'prefecture', p_order.shipping_address->>'state')
      when p_address then jsonb_build_object(
        'name', p_order.customer_name,
        'shipping_address', case when p_order.shipping_address is null then null else jsonb_strip_nulls(jsonb_build_object(
          'name', p_order.shipping_address->'name', 'postal_code', p_order.shipping_address->'postal_code', 'country', p_order.shipping_address->'country',
          'state', p_order.shipping_address->'state', 'city', p_order.shipping_address->'city',
          'line1', p_order.shipping_address->'line1', 'line2', p_order.shipping_address->'line2')) end)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy,
                 -- SKU の選択肢を商品の軸の順に（軸に無い鍵は後ろに鍵の順）。表示名はショップの名前の表、無ければ key
                 'options', (select coalesce(jsonb_agg(jsonb_build_object('key', e.key, 'name', coalesce(s.option_names->>e.key, e.key), 'value', e.value #>> '{}')
                                     order by coalesce((select ax.ord from jsonb_array_elements(case when jsonb_typeof(p.option_axes) = 'array' then p.option_axes else '[]'::jsonb end)
                                                         with ordinality ax(a, ord) where ax.a->>'key' = e.key limit 1), 1000), e.key), '[]'::jsonb)
                                from jsonb_each(case when jsonb_typeof(k.options) = 'object' then k.options else '{}'::jsonb end) e))
               || case when p_images then jsonb_build_object(
                 -- 画像の候補（並べ順のまま）。どれを 1 枚目にするかは Worker の firstImageForSku（src/products/images.ts）が決め、
                 -- 置き場の鍵を MEDIA_BASE_URL の URL に直して image にし、image_candidates は外へ返さない
                 'image_candidates', (select coalesce(jsonb_agg(jsonb_build_object('options', i.options, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                                         'width', i.width, 'height', i.height) order by i.sort_order, i.created_at, i.id), '[]'::jsonb)
                              from product_images i where i.product_id = k.product_id))
                 else '{}'::jsonb end
               order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
                left join shops s on s.id = p_order.shop_id
               where oi.order_id = p_order.id)
  ) || case when p_note then jsonb_build_object('note', p_order.note) else '{}'::jsonb end;
$$;
revoke execute on function api_order_json(orders, boolean, boolean, boolean, boolean) from public, anon, authenticated;

create or replace function api_order_json(p_order orders, p_contact boolean, p_address boolean, p_note boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select api_order_json(p_order, p_contact, p_address, p_note, false);
$$;
revoke execute on function api_order_json(orders, boolean, boolean, boolean) from public, anon, authenticated;

-- api_orders_list（0173 の定義から。明細に画像の候補を付けない）
create or replace function api_orders_list(p_token_hash text, p_status text default null, p_from timestamptz default null,
                                           p_to timestamptz default null, p_limit integer default 50, p_offset integer default 0,
                                           p_query text default null, p_customer_id uuid default null,
                                           p_updated_since timestamptz default null, p_after uuid default null, p_tag text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens; v_pii boolean; v_contact boolean; v_address boolean; v_note boolean; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_number integer;
  v_seq boolean; v_cursor jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_contact := banto_order_pii(v_tok.scopes, 'contact');
  v_address := banto_order_pii(v_tok.scopes, 'address');
  v_note := banto_order_pii(v_tok.scopes, 'full');
  v_pii := v_contact and v_address;
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  v_number := case when p_query ~ '^\d+$' then p_query::integer else null end;
  v_seq := p_updated_since is not null;
  if p_after is not null and not v_seq then raise exception 'invalid_cursor'; end if;

  select count(*) into v_total from orders o
   where o.shop_id = v_tok.shop_id
     and (p_status is null or o.status::text = p_status)
     and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
     and (p_customer_id is null or o.customer_id = p_customer_id)
     and (p_tag is null or o.tags @> array[btrim(p_tag)])
     and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
     and (p_query is null or o.number = v_number or ((v_contact and o.customer_email ilike '%' || banto_like_escape(p_query) || '%') or ((v_contact or v_address) and o.customer_name ilike '%' || banto_like_escape(p_query) || '%')));
  with page as (
    select o.id, o.updated_at,
           row_number() over (order by case when v_seq then o.updated_at end asc, case when v_seq then o.id end asc, o.created_at desc, o.id desc) as ord
      from orders o
     where o.shop_id = v_tok.shop_id
       and (p_status is null or o.status::text = p_status)
       and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to)
       and (p_customer_id is null or o.customer_id = p_customer_id)
       and (p_tag is null or o.tags @> array[btrim(p_tag)])
       and (not v_seq or (case when p_after is null then o.updated_at >= p_updated_since else (o.updated_at, o.id) > (p_updated_since, p_after) end))
       and (p_query is null or o.number = v_number or ((v_contact and o.customer_email ilike '%' || banto_like_escape(p_query) || '%') or ((v_contact or v_address) and o.customer_name ilike '%' || banto_like_escape(p_query) || '%')))
     order by ord
     limit v_limit offset case when v_seq then 0 else v_offset end
  )
  select coalesce(jsonb_agg(api_order_json(o, v_contact, v_address, v_note, false) order by p.ord), '[]'::jsonb),
         (select jsonb_build_object('updated_since', l.updated_at, 'after', l.id) from page l order by l.ord desc limit 1)
    into v_items, v_cursor
    from page p join orders o on o.id = p.id;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', case when v_seq then 0 else v_offset end, 'pii', v_pii, 'pii_parts', jsonb_build_object('contact', v_contact, 'address', v_address, 'note', v_note))
         || case when v_seq then jsonb_build_object('cursor', v_cursor, 'has_more', v_total > jsonb_array_length(v_items)) else '{}'::jsonb end;
end;
$$;

-- api_order_get（0173 の定義から。明細に画像の候補を付ける）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_order_cancel（0173 の定義から。明細に画像の候補を付ける）
create or replace function api_order_cancel(p_token_hash text, p_order_id uuid, p_refunded boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r jsonb; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if not banto_user_shop_perm(v_tok.owner_id, v_tok.shop_id, 'orders_cancel') then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  v_r := cancel_order(p_order_id, v_tok.shop_id, p_refunded, p_reason);
  select * into v_o from orders where id = p_order_id;
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_order_payment_record（0173 の定義から。明細に画像の候補を付ける）
create or replace function api_order_payment_record(p_token_hash text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  perform banto_order_payment_record(v_tok.shop_id, p_order_id);
  select * into v_o from orders where id = p_order_id and shop_id = v_tok.shop_id;
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_order_update_status（0173 の定義から。明細に画像の候補を付ける）
create or replace function api_order_update_status(p_token_hash text, p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_o orders%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  if p_status <> 'shipped' then raise exception 'invalid_status'; end if;
  update orders set status = 'shipped', shipped_at = now()
   where id = p_order_id and shop_id = v_tok.shop_id and status::text in ('paid', 'pending')
  returning * into v_o;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'order.shipped',
    jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', v_tok.shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status, 'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id, 'payment_status', v_o.payment_status));
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_order_annotate（0173 の定義から。明細に画像の候補を付ける）
create or replace function api_order_annotate(p_token_hash text, p_order_id uuid, p_add text[] default null, p_remove text[] default null,
                                              p_tags text[] default null, p_note text default null, p_note_set boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pii boolean; v_o orders; v_tags text[];
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  if p_note_set and not v_pii then raise exception 'pii_scope_required'; end if;
  if p_tags is not null and (p_add is not null or p_remove is not null) then raise exception 'invalid_tags'; end if;
  select * into v_o from orders where id = p_order_id and shop_id = v_tok.shop_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_tags is not null then
    v_tags := p_tags;
  else
    v_tags := array(select x from unnest(v_o.tags) x where not x = any(coalesce(banto_order_tags_norm(p_remove), '{}'))) || coalesce(p_add, '{}');
  end if;
  update orders
     set tags = banto_order_tags_norm(v_tags),
         note = case when p_note_set then nullif(btrim(coalesce(p_note, '')), '') else note end
   where id = v_o.id
  returning * into v_o;
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

insert into banto_migrations (version) values ('0174_api_order_item_media');
