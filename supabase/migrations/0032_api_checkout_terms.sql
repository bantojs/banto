-- Banto 0032_api_checkout_terms: 購入前の確認画面の文言（shops.settings.checkout_terms）を AI 用トークンで読み書きする
-- 前方専用。WordPress 等の連携側の管理画面から、Banto の表示を Banto に置いたまま編集するため（docs/api.md「ショップ」）。
--
--  - api_shop_get: checkout_terms（delivery / cancellation / payment_note。未設定は null）を返す
--  - api_shop_update: checkout_terms を受け付ける。渡した鍵だけ変え、null か空文字で消す。1 項目 2000 文字まで（管理画面と同じ）
--    settings 全体は今までどおり触らせない（受け付けるのはこの 3 つの鍵だけ）

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
    'checkout_terms', jsonb_build_object(
      'delivery', nullif(btrim(v_shop.settings->'checkout_terms'->>'delivery'), ''),
      'cancellation', nullif(btrim(v_shop.settings->'checkout_terms'->>'cancellation'), ''),
      'payment_note', nullif(btrim(v_shop.settings->'checkout_terms'->>'payment_note'), '')),
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
declare
  v_tok api_tokens;
  v_threshold integer;
  v_patch jsonb := '{}'::jsonb;
  v_in jsonb;
  v_terms jsonb;
  v_key text;
  v_val text;
begin
  v_tok := api_require(p_token_hash, 'shop:write');
  if p_values ? 'low_stock_threshold' then
    v_threshold := (p_values->>'low_stock_threshold')::integer;
    if v_threshold is null or v_threshold < 0 or v_threshold > 100000 then raise exception 'invalid_low_stock_threshold'; end if;
    v_patch := v_patch || jsonb_build_object('low_stock_threshold', v_threshold);
  end if;
  if p_values ? 'checkout_terms' then
    v_in := p_values->'checkout_terms';
    if jsonb_typeof(v_in) is distinct from 'object' then raise exception 'invalid_checkout_terms'; end if;
    select case when jsonb_typeof(settings->'checkout_terms') = 'object' then settings->'checkout_terms' else '{}'::jsonb end
      into v_terms from shops where id = v_tok.shop_id for update;
    foreach v_key in array array['delivery', 'cancellation', 'payment_note'] loop
      continue when not v_in ? v_key;
      case jsonb_typeof(v_in->v_key)
        when 'null' then v_val := '';
        when 'string' then v_val := btrim(replace(v_in->>v_key, E'\r\n', E'\n'));
        else raise exception 'invalid_checkout_terms';
      end case;
      if length(v_val) > 2000 then raise exception 'invalid_checkout_terms'; end if;
      v_terms := v_terms || jsonb_build_object(v_key, v_val);
    end loop;
    v_patch := v_patch || jsonb_build_object('checkout_terms', v_terms);
  end if;
  update shops set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    legal_notice = case when p_values ? 'legal_notice' then nullif(btrim(p_values->>'legal_notice'), '') else legal_notice end,
    privacy_policy = case when p_values ? 'privacy_policy' then nullif(btrim(p_values->>'privacy_policy'), '') else privacy_policy end,
    return_policy = case when p_values ? 'return_policy' then nullif(btrim(p_values->>'return_policy'), '') else return_policy end,
    published = coalesce((p_values->>'published')::boolean, published),
    settings = settings || v_patch
  where id = v_tok.shop_id;
  return api_shop_get(p_token_hash);
end;
$$;

insert into banto_migrations (version) values ('0032_api_checkout_terms');
