-- 0145_api_field_definitions: 商品の項目（shops.settings.product_fields）と会員の項目（customer_fields）の定義を AI 用 API で読み書きする（docs/ai-access.md §19）
--   - 移行のスクリプトで値（attributes）を入れても、定義が無いとお店の画面と会員の一覧に出ないため。定義の形は管理画面と同じ（src/products/fields.ts）
--   - 書き込みは丸ごと置き換え。形の検査は DB（banto_field_defs_norm）で、管理画面の読み手（fieldDefinitions）が黙って捨てる行を、ここでは捨てずに断る
--     （何番目の何が違うかを invalid_fields:<番号>:<理由> で返す。移行のスクリプトが気づけるように）
--   - スコープ: 商品は products:read / products:write（項目 catalog）、会員は customers:read / customers:write（項目 customers）。
--     管理画面の shops.settings の鍵ごとの項目（banto_shop_settings_perm、0129）と同じ割り当て
--   - 定義を消しても値（attributes）は残る（管理画面と同じ）

-- 前後の空白を JS の String.prototype.trim と同じ集合で落とす（btrim は半角スペースしか落とさない。全角スペース・タブ・改行・NBSP・BOM も落とす。
-- 管理画面の読み手 fieldDefinitions と同じ値にしないと、会員の select の値（banto_customer_attributes の一致）が管理画面から入れられなくなる）
create or replace function banto_js_trim(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(p, '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g');
$$;
revoke execute on function banto_js_trim(text) from public, anon, authenticated;

-- 定義の配列を検査して、管理画面と同じ形に組み直す。p_kind は product か customer。
-- 文字数はコードポイントで数える（読み手も Array.from で数える）
--   行の鍵: key（必須、^[a-z][a-z0-9_]{0,39}$、重ならない）・label（1〜60 文字、無ければ key）・type・options（select だけ、1〜60 文字を 50 個まで）・
--   public・card（商品だけ。card は public のときだけ）。会員の項目は image を使えず、public は false（お客様の画面に出さない）
create or replace function banto_field_defs_norm(p jsonb, p_kind text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_out jsonb := '[]'::jsonb; v_row jsonb; v_i integer := 0; v_key text; v_type text; v_label text; v_opts jsonb; v_opt jsonb;
  v_public boolean; v_card boolean; v_keys text[] := '{}'; v_item jsonb;
begin
  if p_kind not in ('product', 'customer') then raise exception 'invalid_fields:kind'; end if;
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'invalid_fields:not_array' using errcode = '22023'; end if;
  if jsonb_array_length(p) > 150 then raise exception 'invalid_fields:too_many' using errcode = '22023'; end if;
  for v_row in select value from jsonb_array_elements(p) loop
    v_i := v_i + 1;
    if jsonb_typeof(v_row) <> 'object' then raise exception 'invalid_fields:%:not_object', v_i using errcode = '22023'; end if;
    if exists (select 1 from jsonb_object_keys(v_row) k where k not in ('key', 'label', 'type', 'options', 'public', 'card')) then
      raise exception 'invalid_fields:%:unknown_property', v_i using errcode = '22023';
    end if;
    v_key := case when jsonb_typeof(v_row->'key') = 'string' then v_row->>'key' end;
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'invalid_fields:%:key', v_i using errcode = '22023'; end if;
    if v_key = any(v_keys) then raise exception 'invalid_fields:%:duplicate_key', v_i using errcode = '22023'; end if;
    v_keys := v_keys || v_key;
    v_type := case when jsonb_typeof(v_row->'type') = 'string' then v_row->>'type' end;
    if v_type is null or v_type not in ('text', 'textarea', 'number', 'url', 'select', 'image')
       or (p_kind = 'customer' and v_type = 'image') then
      raise exception 'invalid_fields:%:type', v_i using errcode = '22023';
    end if;
    if v_row ? 'label' and jsonb_typeof(v_row->'label') <> 'null' then
      if jsonb_typeof(v_row->'label') <> 'string' then raise exception 'invalid_fields:%:label', v_i using errcode = '22023'; end if;
      v_label := banto_js_trim(v_row->>'label');
      if v_label = '' or char_length(v_label) > 60 then raise exception 'invalid_fields:%:label', v_i using errcode = '22023'; end if;
    else
      v_label := v_key;
    end if;
    v_opts := null;
    if v_row ? 'options' and jsonb_typeof(v_row->'options') <> 'null' then
      if v_type <> 'select' then raise exception 'invalid_fields:%:options_not_select', v_i using errcode = '22023'; end if;
      if jsonb_typeof(v_row->'options') <> 'array' or jsonb_array_length(v_row->'options') > 50 then
        raise exception 'invalid_fields:%:options', v_i using errcode = '22023';
      end if;
      v_opts := '[]'::jsonb;
      for v_opt in select value from jsonb_array_elements(v_row->'options') loop
        if jsonb_typeof(v_opt) <> 'string' or banto_js_trim(v_opt #>> '{}') = '' or char_length(banto_js_trim(v_opt #>> '{}')) > 60 then
          raise exception 'invalid_fields:%:options', v_i using errcode = '22023';
        end if;
        v_opts := v_opts || to_jsonb(banto_js_trim(v_opt #>> '{}'));
      end loop;
    end if;
    if v_row ? 'public' and jsonb_typeof(v_row->'public') not in ('boolean', 'null') then raise exception 'invalid_fields:%:public', v_i using errcode = '22023'; end if;
    if v_row ? 'card' and jsonb_typeof(v_row->'card') not in ('boolean', 'null') then raise exception 'invalid_fields:%:card', v_i using errcode = '22023'; end if;
    if p_kind = 'customer' then
      -- 会員の項目はお客様の画面に出さない（src/customers/fields.ts と同じ）
      if coalesce((v_row->>'public')::boolean, false) then raise exception 'invalid_fields:%:public', v_i using errcode = '22023'; end if;
      if coalesce((v_row->>'card')::boolean, false) then raise exception 'invalid_fields:%:card', v_i using errcode = '22023'; end if;
      v_public := false; v_card := false;
    else
      v_public := coalesce((v_row->>'public')::boolean, true);
      v_card := coalesce((v_row->>'card')::boolean, false);
      if v_card and not v_public then raise exception 'invalid_fields:%:card', v_i using errcode = '22023'; end if;
    end if;
    v_item := jsonb_build_object('key', v_key, 'label', v_label, 'type', v_type)
              || case when v_opts is not null and v_type = 'select' then jsonb_build_object('options', v_opts) else '{}'::jsonb end
              || jsonb_build_object('public', v_public)
              || case when v_card then jsonb_build_object('card', true) else '{}'::jsonb end;
    v_out := v_out || jsonb_build_array(v_item);
  end loop;
  return v_out;
end;
$$;
revoke execute on function banto_field_defs_norm(jsonb, text) from public, anon, authenticated;

-- 読み取り: 保存されている定義をそのまま返す（古い行の読み替えは Worker の fieldDefinitions が管理画面と同じ決まりで行う）
create or replace function api_field_defs_get(p_token_hash text, p_kind text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_defs jsonb;
begin
  if p_kind not in ('product', 'customer') then raise exception 'invalid_fields:kind'; end if;
  v_tok := api_require(p_token_hash, case when p_kind = 'product' then 'products:read' else 'customers:read' end);
  select s.settings->(p_kind || '_fields') into v_defs from shops s where s.id = v_tok.shop_id;
  return jsonb_build_object('fields', case when jsonb_typeof(v_defs) = 'array' then v_defs else '[]'::jsonb end);
end;
$$;
revoke execute on function api_field_defs_get(text, text) from public, anon, authenticated;
grant execute on function api_field_defs_get(text, text) to service_role;

-- 書き込み: 丸ごと置き換え（[] で全部消す）
create or replace function api_field_defs_set(p_token_hash text, p_kind text, p_fields jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_defs jsonb;
begin
  if p_kind not in ('product', 'customer') then raise exception 'invalid_fields:kind'; end if;
  v_tok := api_require(p_token_hash, case when p_kind = 'product' then 'products:write' else 'customers:write' end);
  v_defs := banto_field_defs_norm(p_fields, p_kind);
  update shops set settings = jsonb_set(coalesce(settings, '{}'::jsonb), array[p_kind || '_fields'], v_defs, true)
   where id = v_tok.shop_id;
  return jsonb_build_object('fields', v_defs);
end;
$$;
revoke execute on function api_field_defs_set(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_field_defs_set(text, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0145_api_field_definitions');
