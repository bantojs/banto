-- 0173: 注文の個人情報のスコープを分ける（メンテナの決定 2026-11-24、docs/ai-access.md「個人情報のスコープ」）。
--
-- 今までの orders:pii は「購入者の個人情報をすべて」で、メールを送るだけの連携にも住所まで渡っていた。
-- トークンが漏れたときに出る範囲を小さくするため、次の 2 つを足す。orders:pii は両方と社内のメモ（orders.note）として残す
-- （今のトークン・連携はそのまま動く）。どれも発行者の項目は customers。
--   orders:contact … 購入者のメールアドレスと電話番号
--   orders:address … 購入者の氏名とお届け先の住所（電話番号は除く）
-- 社内のメモ・お問い合わせの添付は、何が書かれるか分からないので orders:pii（両方を含む）のときだけ。
-- 使うところ: 注文（読む・一覧・メールや氏名での検索・状態の変更・取り消し・入金の記録・印とメモ）、お店で試着の連絡先、
-- お問い合わせの連絡先。判定は banto_order_pii(scopes, part) だけ。

-- スコープ（0167 の定義に orders:contact・orders:address を足す）
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (scopes <@ array[
  'products:read','products:write','orders:read','orders:pii','orders:contact','orders:address','orders:write','shop:read','shop:write','stats:read',
  'coupons:read','coupons:write','customers:read','customers:write','customers:links','inquiries:read','inquiries:write',
  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send','dialogs:write','stores:write',
  'member_news:write'
]::text[]);

-- 発行者の項目: orders:contact・orders:address も customers（個人情報を読める人だけが付けられる）
create or replace function banto_scope_perm(p_scope text)
returns text
language sql
immutable
as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'orders:contact' then 'customers'
    when 'orders:address' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'customers:links' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
    when 'content:read' then 'content'
    when 'content:write' then 'content'
    when 'app_data:write' then 'apps'
    when 'line:send' then 'marketing'
    when 'dialogs:write' then 'marketing'
    when 'stores:write' then 'stores'
    when 'member_news:write' then 'marketing'
  end;
$$;

revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- 個人情報のどこまでを返すか（scopes は api_require が発行者の項目で絞ったもの）
--   contact … orders:contact か orders:pii
--   address … orders:address か orders:pii
--   full    … orders:pii（社内のメモ・お問い合わせの添付）
create or replace function banto_order_pii(p_scopes text[], p_part text)
returns boolean
language sql
immutable
as $$
  select case p_part
    when 'contact' then coalesce(p_scopes, '{}'::text[]) && array['orders:pii', 'orders:contact']::text[]
    when 'address' then coalesce(p_scopes, '{}'::text[]) && array['orders:pii', 'orders:address']::text[]
    when 'full' then 'orders:pii' = any(coalesce(p_scopes, '{}'::text[]))
    else false
  end;
$$;
revoke execute on function banto_order_pii(text[], text) from public, anon, authenticated;

-- 注文の JSON（0172 の定義の customer と note を、部分ごとに返すようにした）
--   両方: email・name・shipping_address（今までの orders:pii と同じ）
--   連絡先だけ: email・phone（お届け先の電話）・prefecture
--   住所だけ: name・shipping_address（電話は除く）
--   どちらも無し: masked と prefecture（今までと同じ）
create or replace function api_order_json(p_order orders, p_contact boolean, p_address boolean, p_note boolean)
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
        'email', p_order.customer_email, 'phone', p_order.shipping_address->>'phone', 'prefecture', p_order.shipping_address->>'state')
      when p_address then jsonb_build_object(
        'name', p_order.customer_name, 'shipping_address', p_order.shipping_address - 'phone')
      else jsonb_build_object('masked', true, 'prefecture', p_order.shipping_address->>'state') end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku_id', oi.sku_id, 'sku_code', k.code, 'sku_name', k.name, 'product_id', k.product_id, 'product_name', p.name,
                 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy, 'discount_jpy', oi.discount_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id
               where oi.order_id = p_order.id)
  ) || case when p_note then jsonb_build_object('note', p_order.note) else '{}'::jsonb end;
$$;
revoke execute on function api_order_json(orders, boolean, boolean, boolean) from public, anon, authenticated;

-- 今までの形（orders, boolean）は「すべてか無しか」として残す（呼ぶところは下で新しい形に変えた）
create or replace function api_order_json(p_order orders, p_pii boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select api_order_json(p_order, coalesce(p_pii, false), coalesce(p_pii, false), coalesce(p_pii, false));
$$;

-- お問い合わせの JSON（0089 の定義の p_pii を、連絡先 p_contact と添付 p_attach に分けた）
create or replace function api_inquiry_json(p_i inquiries, p_contact boolean, p_attach boolean, p_messages boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'number', p_i.number, 'status', p_i.status, 'category', p_i.category, 'origin', p_i.origin, 'verified', p_i.email_verified_at is not null,
    'customer_id', p_i.customer_id, 'claimed_order_number', p_i.claimed_order_number, 'masked', p_i.masked_at is not null,
    'order', (select jsonb_build_object('number', o.number, 'status', o.status, 'total_jpy', o.total_jpy, 'created_at', o.created_at) from orders o where o.id = p_i.order_id),
    'assignee', (select jsonb_build_object('user_id', u.id, 'label', split_part(coalesce(u.email, ''), '@', 1)) from auth.users u where u.id = p_i.assignee_id),
    'created_at', p_i.created_at, 'last_message_at', p_i.last_message_at, 'closed_at', p_i.closed_at)
  || case when p_messages then jsonb_build_object('messages', coalesce((
          select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at,
                                              'attachments', banto_inquiry_message_attachments(m.id, p_attach)) order by m.created_at, m.id)
            from inquiry_messages m where m.inquiry_id = p_i.id), '[]'::jsonb)) else '{}'::jsonb end
  || case when p_contact then jsonb_build_object('contact', jsonb_build_object('email', p_i.contact_email, 'name', p_i.contact_name)) else '{}'::jsonb end;
$$;
revoke execute on function api_inquiry_json(inquiries, boolean, boolean, boolean) from public, anon, authenticated;

-- 今までの形（inquiries, boolean, boolean）は「すべてか無しか」として残す
create or replace function api_inquiry_json(p_i inquiries, p_pii boolean, p_messages boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select api_inquiry_json(p_i, coalesce(p_pii, false), coalesce(p_pii, false), p_messages);
$$;

-- ---------- 呼ぶところ（それぞれの今の定義から、個人情報の判定だけを banto_order_pii に変えた） ----------

-- api_order_get（0003 の定義から）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'));
end;
$$;

-- api_order_cancel（0156 の定義から）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'));
end;
$$;

-- api_order_payment_record（0156 の定義から）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'));
end;
$$;

-- api_order_update_status（0156 の定義から）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'));
end;
$$;

-- api_order_annotate（0106 の定義から）
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
  return api_order_json(v_o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'));
end;
$$;

-- api_orders_list（0129 の定義から）
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
  v_pii := banto_order_pii(v_tok.scopes, 'contact') and banto_order_pii(v_tok.scopes, 'address');
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
     and (p_query is null or o.number = v_number or ((banto_order_pii(v_tok.scopes, 'contact') and o.customer_email ilike '%' || banto_like_escape(p_query) || '%') or (banto_order_pii(v_tok.scopes, 'address') and o.customer_name ilike '%' || banto_like_escape(p_query) || '%')));
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
       and (p_query is null or o.number = v_number or ((banto_order_pii(v_tok.scopes, 'contact') and o.customer_email ilike '%' || banto_like_escape(p_query) || '%') or (banto_order_pii(v_tok.scopes, 'address') and o.customer_name ilike '%' || banto_like_escape(p_query) || '%')))
     order by ord
     limit v_limit offset case when v_seq then 0 else v_offset end
  )
  select coalesce(jsonb_agg(api_order_json(o, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full')) order by p.ord), '[]'::jsonb),
         (select jsonb_build_object('updated_since', l.updated_at, 'after', l.id) from page l order by l.ord desc limit 1)
    into v_items, v_cursor
    from page p join orders o on o.id = p.id;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', case when v_seq then 0 else v_offset end, 'pii', v_pii, 'pii_parts', jsonb_build_object('contact', banto_order_pii(v_tok.scopes, 'contact'), 'address', banto_order_pii(v_tok.scopes, 'address'), 'note', banto_order_pii(v_tok.scopes, 'full')))
         || case when v_seq then jsonb_build_object('cursor', v_cursor, 'has_more', v_total > jsonb_array_length(v_items)) else '{}'::jsonb end;
end;
$$;

-- api_tryon_request_get（0026 の定義から）
create or replace function api_tryon_request_get(p_token_hash text, p_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact'));
end;
$$;

-- api_tryon_request_restock（0026 の定義から）
create or replace function api_tryon_request_restock(p_token_hash text, p_number integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype; v_n integer;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  v_n := banto_tryon_restock(v_tok.shop_id, v_r.id);
  select * into v_r from tryon_requests where id = v_r.id;
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact')) || jsonb_build_object('restocked_skus', v_n);
end;
$$;

-- api_tryon_request_update（0026 の定義から）
create or replace function api_tryon_request_update(p_token_hash text, p_number integer, p_status text, p_hold_until date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_r tryon_requests%rowtype;
begin
  v_tok := api_require(p_token_hash, 'orders:write');
  select * into v_r from tryon_requests where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  if p_status not in ('sent', 'ready', 'purchased', 'not_purchased', 'cancelled') then raise exception 'invalid_status'; end if;
  v_r := banto_tryon_transition(v_tok.shop_id, v_r.id, p_status, p_hold_until);
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact'));
end;
$$;

-- api_tryon_requests_list（0026 の定義から）
create or replace function api_tryon_requests_list(p_token_hash text, p_status text default null, p_store_id uuid default null,
                                                   p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer; v_total integer; v_items jsonb;
begin
  v_tok := api_require(p_token_hash, 'orders:read');
  v_pii := banto_order_pii(v_tok.scopes, 'contact');
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));
  select count(*) into v_total from tryon_requests r
   where r.shop_id = v_tok.shop_id and (p_status is null or r.status = p_status) and (p_store_id is null or r.store_id = p_store_id);
  select coalesce(jsonb_agg(api_tryon_json(r, v_pii) order by r.created_at desc), '[]'::jsonb) into v_items
    from (select * from tryon_requests r
           where r.shop_id = v_tok.shop_id and (p_status is null or r.status = p_status) and (p_store_id is null or r.store_id = p_store_id)
           order by r.created_at desc limit v_limit offset greatest(0, coalesce(p_offset, 0))) r;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', greatest(0, coalesce(p_offset, 0)), 'pii', v_pii);
end;
$$;

-- api_inquiry_get（0061 の定義から）
create or replace function api_inquiry_get(p_token_hash text, p_number integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number;
  if not found then raise exception 'not_found'; end if;
  return api_inquiry_json(v_i, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_inquiry_set_status（0061 の定義から）
create or replace function api_inquiry_set_status(p_token_hash text, p_number integer, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  if p_status not in ('closed', 'waiting_shop', 'waiting_customer') then raise exception 'invalid_status'; end if;
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  if v_i.status <> p_status then
    update inquiries set status = p_status, updated_at = now(), closed_at = case when p_status = 'closed' then now() end where id = v_i.id;
    perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
      jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', p_status, 'change', 'status'));
    select * into v_i from inquiries where id = v_i.id;
  end if;
  return api_inquiry_json(v_i, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_inquiry_reply（0064 の定義から）
create or replace function api_inquiry_reply(p_token_hash text, p_number integer, p_body text, p_link_hash text, p_attachments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype; v_body text := left(btrim(coalesce(p_body, '')), 5000); v_send boolean := false; v_s shops%rowtype; v_msg uuid;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  if v_i.masked_at is not null then raise exception 'inquiry_masked'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (v_i.shop_id, v_i.id, 'shop', v_body) returning id into v_msg;
  perform banto_inquiry_attach(v_i.shop_id, v_i.id, v_msg, p_attachments);
  update inquiries set status = 'waiting_customer', last_message_at = now(), updated_at = now(), closed_at = null where id = v_i.id;
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (v_i.shop_id, v_i.id, p_link_hash, now() + interval '30 days');
  if v_i.contact_email is not null then v_send := banto_inquiry_issue_mail(v_i.shop_id, v_i.id, 'reply', v_i.contact_email); end if;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', 'waiting_customer', 'change', 'message', 'author', 'shop'));
  select * into v_i from inquiries where id = v_i.id;
  select * into v_s from shops where id = v_i.shop_id;
  return jsonb_build_object(
    'inquiry', api_inquiry_json(v_i, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'full'), true),
    'mail', jsonb_build_object('send', v_send, 'to', case when v_send then v_i.contact_email end, 'mail_from', banto_inquiry_mail_from(v_i.shop_id),
                               'return_to', v_i.return_to,
                               'shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                                                          'settings', jsonb_build_object('theme_settings', v_s.settings->'theme_settings', 'headless', v_s.settings->'headless'))));
end;
$$;

-- api_inquiry_assign（0068 の定義から）
create or replace function api_inquiry_assign(p_token_hash text, p_number integer, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype; v_r jsonb; v_s shops%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  v_r := banto_inquiry_assign(v_i, p_user, null);
  select * into v_i from inquiries where id = v_i.id;
  select * into v_s from shops where id = v_i.shop_id;
  return jsonb_build_object(
    'inquiry', api_inquiry_json(v_i, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'full'), false),
    'mail', v_r || jsonb_build_object('shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                                                                 'settings', jsonb_build_object('theme_settings', v_s.settings->'theme_settings'))));
end;
$$;

-- api_inquiries_list（0068 の定義から）
create or replace function api_inquiries_list(p_token_hash text, p_status text default null, p_limit integer default 50, p_offset integer default 0, p_assignee text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_offset integer := greatest(0, coalesce(p_offset, 0));
        v_total integer; v_items jsonb; v_none boolean := p_assignee = 'none'; v_user uuid;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  v_pii := banto_order_pii(v_tok.scopes, 'contact');
  if p_status is not null and p_status not in ('waiting_shop', 'waiting_customer', 'closed') then raise exception 'invalid_status'; end if;
  if p_assignee is not null and not v_none then
    if p_assignee !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_assignee'; end if;
    v_user := p_assignee::uuid;
  end if;
  select count(*) into v_total from inquiries i
   where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status)
     and (not v_none or i.assignee_id is null) and (v_user is null or i.assignee_id = v_user);
  select coalesce(jsonb_agg(api_inquiry_json(i, v_pii, banto_order_pii(v_tok.scopes, 'full'), false) order by i.last_message_at desc), '[]'::jsonb) into v_items
    from (select * from inquiries i
           where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status)
             and (not v_none or i.assignee_id is null) and (v_user is null or i.assignee_id = v_user)
           order by i.last_message_at desc limit v_limit offset v_offset) i;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'pii', v_pii);
end;
$$;


insert into banto_migrations (version) values ('0173_orders_pii_split');
