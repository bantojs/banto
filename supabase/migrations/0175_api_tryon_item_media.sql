-- 0175: AI 用 API のお店で試着の明細に、SKU の選択肢（カラー・サイズなど）と画像（メンテナの決定 2026-11-25）
-- 0174 の注文と同じ作り。外部プラグインがお店で試着の受付のメールの明細に、商品の画像とカラー・サイズを出せるようにする（今の値は変えない）。
--   - options: SKU の選択肢を商品の軸の順に [{ key, name, value }]。一覧にも付く
--   - 画像: 1 件の申し込みの応答（取得・状態の変更・在庫を戻す）だけ。DB は候補を返し、1 枚目を選んで URL にするのは Worker
--   - どちらも商品の情報なので orders:read のまま。写しは残さない
-- 旗の無い api_tryon_json(tryon_requests, boolean, boolean, boolean) は候補なしの形を呼ぶ（一覧はそのまま候補なし）。

create or replace function api_tryon_json(p_r tryon_requests, p_contact boolean, p_address boolean, p_note boolean, p_images boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p_r.id, 'number', p_r.number, 'status', p_r.status, 'store_id', p_r.store_id,
    'store_name', (select name from stores where id = p_r.store_id),
    'visit_date', p_r.visit_date, 'hold_until', p_r.hold_until, 'customer_id', p_r.customer_id, 'restocked', p_r.restocked,
    'created_at', p_r.created_at, 'updated_at', p_r.updated_at, 'closed_at', p_r.closed_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', t.sku_id, 'sku_code', k.code, 'product_name', p.name, 'sku_name', k.name,
                                                           'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy,
                 -- SKU の選択肢を商品の軸の順に（軸に無い鍵は後ろに鍵の順）。表示名はショップの名前の表、無ければ key（0174 の注文と同じ）
                 'options', (select coalesce(jsonb_agg(jsonb_build_object('key', e.key, 'name', coalesce(s.option_names->>e.key, e.key), 'value', e.value #>> '{}')
                                     order by coalesce((select ax.ord from jsonb_array_elements(case when jsonb_typeof(p.option_axes) = 'array' then p.option_axes else '[]'::jsonb end)
                                                         with ordinality ax(a, ord) where ax.a->>'key' = e.key limit 1), 1000), e.key), '[]'::jsonb)
                                from jsonb_each(case when jsonb_typeof(k.options) = 'object' then k.options else '{}'::jsonb end) e))
               || case when p_images then jsonb_build_object(
                 -- 画像の候補（並べ順のまま）。1 枚目を選んで URL にするのは Worker（src/orders/item-media.ts）、候補は外へ返さない
                 'image_candidates', (select coalesce(jsonb_agg(jsonb_build_object('options', i.options, 'storage_key', i.storage_key, 'thumb_key', i.thumb_key,
                                                                         'width', i.width, 'height', i.height) order by i.sort_order, i.created_at, i.id), '[]'::jsonb)
                              from product_images i where i.product_id = k.product_id))
                 else '{}'::jsonb end
               order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id
                left join shops s on s.id = p_r.shop_id
               where t.request_id = p_r.id))
  || case when p_contact or p_address or p_note then jsonb_build_object('customer',
          case when p_contact then jsonb_build_object('email', p_r.customer_email, 'phone', p_r.customer_phone) else '{}'::jsonb end
          || case when p_contact or p_address then jsonb_build_object('name', p_r.customer_name) else '{}'::jsonb end
          || case when p_note then jsonb_build_object('note', p_r.note) else '{}'::jsonb end)
          else '{}'::jsonb end;
$$;
revoke execute on function api_tryon_json(tryon_requests, boolean, boolean, boolean, boolean) from public, anon, authenticated, service_role;

create or replace function api_tryon_json(p_r tryon_requests, p_contact boolean, p_address boolean, p_note boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select api_tryon_json(p_r, p_contact, p_address, p_note, false);
$$;
revoke execute on function api_tryon_json(tryon_requests, boolean, boolean, boolean) from public, anon, authenticated, service_role;

-- api_tryon_request_get（0173 の定義から。明細に画像の候補を付ける）
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
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

-- api_tryon_request_restock（0173 の定義から。明細に画像の候補を付ける）
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
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true) || jsonb_build_object('restocked_skus', v_n);
end;
$$;

-- api_tryon_request_update（0173 の定義から。明細に画像の候補を付ける）
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
  return api_tryon_json(v_r, banto_order_pii(v_tok.scopes, 'contact'), banto_order_pii(v_tok.scopes, 'address'), banto_order_pii(v_tok.scopes, 'full'), true);
end;
$$;

insert into banto_migrations (version) values ('0175_api_tryon_item_media');
