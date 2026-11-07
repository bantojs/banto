-- Banto 0126_store_fields: 実店舗の独自項目と外部コード。メンテナの決定 2026-11-07（docs/stores.md「独自項目」）。前方専用。
--   - 定義は組織ごと（organizations.store_fields。実店舗は組織の正本で、いくつものショップが同じ店舗を使う）。
--     1 行 = { key, label, type: text | textarea | number | url | select | image, options (select), private }、20 まで。書くのは組織の owner / admin（store_fields_set）
--   - 値は stores.fields（定義にある鍵だけ。形はトリガー banto_store_fields_norm が整える）。private の項目はお客様の画面・ヘッドレスに出さない
--   - 外部コード stores.external_ref（社内システムの店舗コード。組織の中で重ならない。お客様には出さない）
--   - AI 用 API: api_stores_list に fields（private も）と external_ref、api_store_update（スコープ stores:write、項目 stores）で
--     そのショップで使っている店舗の項目の値と外部コードだけを書く。店名・住所・営業時間などの決まった欄は管理画面だけ

alter table organizations add column if not exists store_fields jsonb not null default '[]'::jsonb;
alter table stores add column if not exists fields jsonb not null default '{}'::jsonb;
alter table stores add column if not exists external_ref text;
alter table stores drop constraint if exists stores_fields_object;
alter table stores add constraint stores_fields_object check (jsonb_typeof(fields) = 'object');
alter table stores drop constraint if exists stores_external_ref_format;
alter table stores add constraint stores_external_ref_format check (external_ref is null or external_ref ~ '^[A-Za-z0-9._:-]{1,64}$');
create unique index if not exists stores_external_ref_uniq on stores (org_id, external_ref) where external_ref is not null;

-- 定義の形（組織の行を書くときに確かめる）
create or replace function banto_store_fields_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare d jsonb; v_keys text[] := '{}'; v_key text; v_type text;
begin
  if tg_op = 'UPDATE' and new.store_fields is not distinct from old.store_fields then return new; end if;
  if jsonb_typeof(new.store_fields) <> 'array' or jsonb_array_length(new.store_fields) > 20 then
    raise exception 'store_fields_invalid' using errcode = '22023';
  end if;
  for d in select * from jsonb_array_elements(new.store_fields) loop
    if jsonb_typeof(d) <> 'object' then raise exception 'store_fields_invalid' using errcode = '22023'; end if;
    v_key := d->>'key';
    v_type := d->>'type';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' or v_key = any(v_keys)
       or coalesce(char_length(btrim(d->>'label')), 0) not between 1 and 60
       or v_type is null or v_type not in ('text', 'textarea', 'number', 'url', 'select', 'image')
       or (d ? 'private' and jsonb_typeof(d->'private') <> 'boolean') then
      raise exception 'store_fields_invalid:%', coalesce(v_key, '') using errcode = '22023';
    end if;
    if v_type = 'select' and not coalesce(
         jsonb_typeof(d->'options') = 'array' and jsonb_array_length(d->'options') between 1 and 50
         and not exists (select 1 from jsonb_array_elements(d->'options') o where jsonb_typeof(o) <> 'string' or char_length(btrim(o #>> '{}')) not between 1 and 60), false) then
      raise exception 'store_fields_invalid:%', v_key using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
  end loop;
  return new;
end;
$$;
revoke execute on function banto_store_fields_guard() from public, anon, authenticated;
drop trigger if exists organizations_store_fields on organizations;
create trigger organizations_store_fields before insert or update of store_fields on organizations
  for each row execute function banto_store_fields_guard();

-- 値の形（定義にある鍵だけ、空は持たない）
create or replace function banto_store_fields_norm()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_defs jsonb; d jsonb; v_key text; v_type text; v jsonb; v_out jsonb := '{}'::jsonb; n numeric; s text;
begin
  if tg_op = 'UPDATE' and new.fields is not distinct from old.fields then return new; end if;
  select store_fields into v_defs from organizations where id = new.org_id;
  for d in select * from jsonb_array_elements(coalesce(v_defs, '[]'::jsonb)) loop
    v_key := d->>'key';
    v_type := d->>'type';
    v := new.fields->v_key;
    if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') then continue; end if;
    if jsonb_typeof(v) not in ('string', 'number') then raise exception 'store_field_invalid:%', v_key using errcode = '22023'; end if;
    s := btrim(v #>> '{}');
    if v_type = 'number' then
      begin
        n := s::numeric;
      exception when others then
        raise exception 'store_field_invalid:%', v_key using errcode = '22023';
      end;
      if abs(n) > 1e12 then raise exception 'store_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, n);
    elsif v_type = 'select' then
      if not (d->'options' ? s) then raise exception 'store_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, s);
    elsif v_type = 'url' then
      if char_length(s) > 500 or s !~ '^https?://[^[:space:]"''<>`\\]+$' then raise exception 'store_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, s);
    elsif v_type = 'image' then
      -- 画像の URL（Worker がこの置き場のものに整えてから書く。ここは形だけ）
      if char_length(s) > 2000 or s !~ '^(/media/|https?://)[^[:space:]"''<>`\\]+$' or position('..' in s) > 0 then
        raise exception 'store_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(v_key, s);
    else
      if char_length(s) > (case when v_type = 'textarea' then 2000 else 500 end) then raise exception 'store_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, s);
    end if;
  end loop;
  new.fields := v_out;
  return new;
end;
$$;
revoke execute on function banto_store_fields_norm() from public, anon, authenticated;
drop trigger if exists stores_fields_norm on stores;
create trigger stores_fields_norm before insert or update of fields on stores
  for each row execute function banto_store_fields_norm();

-- 公開の値（private の項目を外す）
create or replace function banto_store_public_fields(p_org_id uuid, p_fields jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(coalesce(p_fields, '{}'::jsonb)) e
                    where exists (select 1 from organizations o, jsonb_array_elements(o.store_fields) d
                                   where o.id = p_org_id and d->>'key' = e.key and coalesce((d->>'private')::boolean, false) = false)), '{}'::jsonb);
$$;
revoke execute on function banto_store_public_fields(uuid, jsonb) from public, anon, authenticated;

-- 定義を書く（組織の owner / admin）
create or replace function store_fields_set(p_org_id uuid, p_defs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not banto_org_admin(p_org_id) then raise exception 'org_not_found' using errcode = '42501'; end if;
  update organizations set store_fields = coalesce(p_defs, '[]'::jsonb) where id = p_org_id;
  return (select store_fields from organizations where id = p_org_id);
end;
$$;
revoke execute on function store_fields_set(uuid, jsonb) from public, anon;
grant execute on function store_fields_set(uuid, jsonb) to authenticated, service_role;

-- お客様の画面の店舗の一覧（0025）に公開の項目と定義（表示名・種類。private は出さない）を足す
create or replace function shop_store_list(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'shop_id', ss.shop_id, 'name', st.name, 'postal_code', st.postal_code, 'address', st.address,
                                               'phone', st.phone, 'hours', st.hours, 'special_days', st.special_days, 'note', st.note,
                                               'tryon', ss.tryon, 'active', st.active, 'sort_order', ss.sort_order,
                                               'fields', banto_store_public_fields(st.org_id, st.fields),
                                               'field_defs', (select coalesce(jsonb_agg(jsonb_build_object('key', d->>'key', 'label', d->>'label', 'type', d->>'type')), '[]'::jsonb)
                                                                from organizations o, jsonb_array_elements(o.store_fields) d
                                                               where o.id = st.org_id and coalesce((d->>'private')::boolean, false) = false))
                            order by ss.sort_order, st.sort_order, st.name), '[]'::jsonb)
    from shop_stores ss join stores st on st.id = ss.store_id join shops s on s.id = ss.shop_id
   where ss.shop_id = p_shop_id and s.published and st.active;
$$;
revoke execute on function shop_store_list(uuid) from public;
grant execute on function shop_store_list(uuid) to anon, authenticated, service_role;

-- ---------- AI 用 API ----------

alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send','dialogs:write','stores:write']::text[]
);

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
    when 'line:send' then 'marketing'
    when 'dialogs:write' then 'marketing'
    when 'stores:write' then 'stores'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

create or replace function api_store_json(st stores, ss shop_stores)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', st.id, 'name', st.name, 'postal_code', st.postal_code, 'address', st.address, 'phone', st.phone,
                            'hours', st.hours, 'special_days', st.special_days, 'note', st.note, 'active', st.active,
                            'tryon', ss.tryon, 'sort_order', ss.sort_order, 'external_ref', st.external_ref, 'fields', st.fields,
                            'field_defs', (select store_fields from organizations where id = st.org_id));
$$;
revoke execute on function api_store_json(stores, shop_stores) from public, anon, authenticated;

-- 一覧（0026）: 項目の値（private も）・定義・外部コードを足す
create or replace function api_stores_list(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'shop:read');
  return (select coalesce(jsonb_agg(api_store_json(st, ss) order by ss.sort_order, st.sort_order, st.name), '[]'::jsonb)
            from shop_stores ss join stores st on st.id = ss.store_id where ss.shop_id = v_tok.shop_id);
end;
$$;
revoke execute on function api_stores_list(text) from public, anon, authenticated;
grant execute on function api_stores_list(text) to service_role;

-- 項目の値と外部コードを書く（stores:write）。店舗は id か ext:<外部コード>、そのショップで使っている店舗だけ。fields は渡した鍵だけ重ね、null で消す
create or replace function api_store_update(p_token_hash text, p_store text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_st stores; v_ss shop_stores; v_key text; v_fields jsonb;
begin
  v_tok := api_require(p_token_hash, 'stores:write');
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_values'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if v_key not in ('fields', 'external_ref') then raise exception 'invalid_store_values'; end if;
  end loop;
  select st.* into v_st from shop_stores ss join stores st on st.id = ss.store_id
   where ss.shop_id = v_tok.shop_id
     and (case when p_store like 'ext:%' then st.external_ref = substr(p_store, 5)
               when p_store ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then st.id = p_store::uuid
               else false end)
   for update of st;
  if not found then raise exception 'not_found'; end if;
  if p_values ? 'fields' then
    if jsonb_typeof(p_values->'fields') <> 'object' then raise exception 'invalid_fields'; end if;
    v_fields := v_st.fields;
    for v_key in select jsonb_object_keys(p_values->'fields') loop
      if not exists (select 1 from organizations o, jsonb_array_elements(o.store_fields) d where o.id = v_st.org_id and d->>'key' = v_key) then
        raise exception 'store_field_invalid:%', left(v_key, 40) using errcode = '22023';
      end if;
      v_fields := case when jsonb_typeof(p_values->'fields'->v_key) = 'null' then v_fields - v_key else v_fields || jsonb_build_object(v_key, p_values->'fields'->v_key) end;
    end loop;
    v_st.fields := v_fields;
  end if;
  if p_values ? 'external_ref' then
    if not (jsonb_typeof(p_values->'external_ref') = 'null' or (jsonb_typeof(p_values->'external_ref') = 'string' and p_values->>'external_ref' ~ '^[A-Za-z0-9._:-]{1,64}$')) then
      raise exception 'invalid_external_ref';
    end if;
    v_st.external_ref := p_values->>'external_ref';
  end if;
  begin
    update stores set fields = v_st.fields, external_ref = v_st.external_ref, updated_at = now() where id = v_st.id returning * into v_st;
  exception when unique_violation then
    raise exception 'external_ref_taken';
  end;
  select * into v_ss from shop_stores where shop_id = v_tok.shop_id and store_id = v_st.id;
  return api_store_json(v_st, v_ss);
end;
$$;
revoke execute on function api_store_update(text, text, jsonb) from public, anon, authenticated;
grant execute on function api_store_update(text, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0126_store_fields');
