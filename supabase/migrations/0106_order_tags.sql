-- Banto 0106_order_tags: 注文の印（タグ）と社内のメモ（メンテナの決定 2026-11-04、docs/ai-access.md §13）。前方専用。
--   - orders.tags: 自由入力の印（20 個まで・1 つ 40 字まで、前後の空白を落として重なりを消す）。管理画面の一覧で絞り込み、AI 用 API でも読み書き。
--   - orders.note: 運営者だけが見る社内のメモ（2,000 字まで）。お客様には見せない。個人情報が書かれがちなので、
--     AI 用 API で読み書きするには orders:pii も要り、注文の個人情報をマスキングしたとき（mask_shipped_orders・mask_customer）に一緒に消す。
--   - 書くのは order_annotate（管理画面、項目 orders）と api_order_annotate（orders:write）だけ。運営者の JWT からの列の直接の UPDATE は許さない（0028 の列の権限のまま）。
--   - 印・メモを変えても hooks は出さない（印を付けたプラグインが、自分の付けた印でまた動くのを防ぐ）。監査ログにも残さない。

alter table orders add column if not exists tags text[] not null default '{}';
alter table orders add column if not exists note text;
alter table orders drop constraint if exists orders_note_len;
alter table orders add constraint orders_note_len check (note is null or char_length(note) between 1 and 2000);
create index if not exists orders_tags_idx on orders using gin (tags);

-- 印の並びを整える（前後の空白を落とす・空を捨てる・重なりを消す、順はそのまま）。形が違えば invalid_tags
create or replace function banto_order_tags_norm(p_tags text[])
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare v text; v_out text[] := '{}';
begin
  if p_tags is null then return '{}'; end if;
  foreach v in array p_tags loop
    v := btrim(coalesce(v, ''));
    if v = '' then continue; end if;
    if char_length(v) > 40 or v ~ '[[:cntrl:],]' then raise exception 'invalid_tags'; end if;
    if not v = any(v_out) then v_out := v_out || v; end if;
  end loop;
  if cardinality(v_out) > 20 then raise exception 'invalid_tags'; end if;
  return v_out;
end;
$$;
revoke execute on function banto_order_tags_norm(text[]) from public, anon, authenticated;

alter table orders drop constraint if exists orders_tags_valid;
-- 列の守りは数だけ（形を整えるのは書く関数。関数を CHECK に使うと、書いた人のロールに EXECUTE が要る）
alter table orders add constraint orders_tags_valid check (cardinality(tags) <= 20);

-- 個人情報を消したら（customer_name が '[masked]' になったら）メモも消す
create or replace function banto_orders_mask_note()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_name = '[masked]' and old.customer_name is distinct from '[masked]' then
    new.note := null;
  end if;
  return new;
end;
$$;
revoke execute on function banto_orders_mask_note() from public, anon, authenticated;
drop trigger if exists orders_mask_note on orders;
create trigger orders_mask_note before update of customer_name on orders for each row execute function banto_orders_mask_note();

-- 管理画面（項目 orders）。p_tags は置き換え（null なら変えない）、p_note は p_note_set のときだけ（空文字は消す）
create or replace function order_annotate(p_shop_id uuid, p_order_id uuid, p_tags text[] default null, p_note text default null, p_note_set boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders;
begin
  if not banto_shop_perm(p_shop_id, 'orders') then raise exception 'forbidden' using errcode = '42501'; end if;
  update orders
     set tags = case when p_tags is null then tags else banto_order_tags_norm(p_tags) end,
         note = case when p_note_set then nullif(btrim(coalesce(p_note, '')), '') else note end
   where id = p_order_id and shop_id = p_shop_id
  returning * into v_o;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id', v_o.id, 'tags', to_jsonb(v_o.tags), 'note', v_o.note);
end;
$$;
revoke execute on function order_annotate(uuid, uuid, text[], text, boolean) from public, anon;
grant execute on function order_annotate(uuid, uuid, text[], text, boolean) to authenticated, service_role;

-- AI 用 API（orders:write。メモは orders:pii も）。印は足す・外す・置き換えのどれか、メモは p_note_set のときだけ
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
  return api_order_json(v_o, v_pii);
end;
$$;
revoke execute on function api_order_annotate(text, uuid, text[], text[], text[], text, boolean) from public, anon, authenticated;
grant execute on function api_order_annotate(text, uuid, text[], text[], text[], text, boolean) to service_role;

-- 注文の JSON に印（いつも）とメモ（orders:pii のときだけ）を足す（0010 を差し替え）
create or replace function api_order_json(p_order orders, p_pii boolean)
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
    'tags', to_jsonb(p_order.tags),
    'customer', case when p_pii then jsonb_build_object(
        'email', p_order.customer_email, 'name', p_order.customer_name, 'shipping_address', p_order.shipping_address)
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  ) || case when p_pii then jsonb_build_object('note', p_order.note) else '{}'::jsonb end;
$$;

-- 注文の一覧を印で絞る（0105 を差し替え。p_tag を足す）
drop function if exists api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text, uuid, timestamptz, uuid);
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
  v_tok api_tokens; v_pii boolean; v_limit integer; v_offset integer; v_total integer; v_items jsonb; v_number integer;
  v_seq boolean; v_cursor jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
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
     and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')));
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
       and (p_query is null or o.number = v_number or (v_pii and (o.customer_email ilike '%' || p_query || '%' or o.customer_name ilike '%' || p_query || '%')))
     order by ord
     limit v_limit offset case when v_seq then 0 else v_offset end
  )
  select coalesce(jsonb_agg(api_order_json(o, v_pii) order by p.ord), '[]'::jsonb),
         (select jsonb_build_object('updated_since', l.updated_at, 'after', l.id) from page l order by l.ord desc limit 1)
    into v_items, v_cursor
    from page p join orders o on o.id = p.id;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', case when v_seq then 0 else v_offset end, 'pii', v_pii)
         || case when v_seq then jsonb_build_object('cursor', v_cursor, 'has_more', v_total > jsonb_array_length(v_items)) else '{}'::jsonb end;
end;
$$;
revoke execute on function api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text, uuid, timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function api_orders_list(text, text, timestamptz, timestamptz, integer, integer, text, uuid, timestamptz, uuid, text) to service_role;

insert into banto_migrations (version) values ('0106_order_tags');
