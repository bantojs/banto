-- 0169: 項目の定義（商品の product_fields・会員の customer_fields）を読むスコープを広げる（メンテナの決定 2026-11-23）
-- 定義は個人情報ではない。customers:read（会員の名簿そのもの）を持たない連携（customers:write で attributes を書く・
-- customers:links で結ぶ）も、書く前に定義を読めるようにする。商品も同じく products:write で読める。
-- どのスコープも発行者の項目（customers / catalog）を api_require が確かめるのは今までどおり。書き込み（api_field_defs_set）は変えない。

create or replace function api_field_defs_get(p_token_hash text, p_kind text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_defs jsonb; v_scopes text[]; v_scope text;
begin
  if p_kind not in ('product', 'customer') then raise exception 'invalid_fields:kind'; end if;
  -- トークンが持っている、読める スコープのうち最初のもので確かめる（無ければ今までのスコープで断る）
  select t.scopes into v_scopes from api_tokens t where t.token_hash = p_token_hash;
  select s into v_scope
    from unnest(case when p_kind = 'product' then array['products:read', 'products:write']
                     else array['customers:read', 'customers:write', 'customers:links'] end) with ordinality as u(s, n)
   where s = any(coalesce(v_scopes, '{}'::text[]))
   order by n
   limit 1;
  v_tok := api_require(p_token_hash, coalesce(v_scope, case when p_kind = 'product' then 'products:read' else 'customers:read' end));
  select s.settings->(p_kind || '_fields') into v_defs from shops s where s.id = v_tok.shop_id;
  return jsonb_build_object('fields', case when jsonb_typeof(v_defs) = 'array' then v_defs else '[]'::jsonb end);
end;
$$;
revoke execute on function api_field_defs_get(text, text) from public, anon, authenticated;
grant execute on function api_field_defs_get(text, text) to service_role;

insert into banto_migrations (version) values ('0169_field_defs_read_scopes');
