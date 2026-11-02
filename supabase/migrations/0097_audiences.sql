-- 0097_audiences: 会員の条件（見せる相手）の土台（同梱モジュール audiences。メンテナの決定 2026-11-02、docs/audiences.md）
--   - 条件は会員の独自項目（customers.attributes、定義は shops.settings.customer_fields）の組み合わせ。入れ子の JSON:
--       { "member": true }                         ログイン中の会員
--       { "attr": "rank", "in": ["gold", ...] }    独自項目がどれかの値（大文字小文字を区別しない）
--       { "attr": "points", "gte": 10000 }         数の大小（gte / lte）
--       { "attr": "rank", "set": true }            値が入っている
--       { "all": [...] } / { "any": [...] } / { "not": {...} }
--     深さ 4・葉 20 まで。鍵は定義にあるものだけ。ゲスト（会員でない人）は独自項目を持たない（attr の葉はすべて偽）
--   - 判定の正はここ（banto_audience_ok）。画面を描くときの TS（src/members/audience.ts）は同じ答え合わせの表のテストで縛る
--   - 条件は名前を付けてショップごとに登録する（audiences）。ブロック・商品・ページ・価格の決まりはこの id で使う（0098 以降）
--   - 会員の Cookie・会員トークンには、どこかの条件で使っている独自項目の値だけを入れる（member_session_check_attrs）。
--     画面のたびに会員の情報を取りに行かないため。買える・単価は DB が最新の値で判定し直す（0098・0099）

-- ---------- 形を確かめて組み直す ----------
create or replace function banto_audience_normalize(p jsonb, p_keys text[], p_depth integer default 1)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_child jsonb;
  v_vals jsonb := '[]'::jsonb;
  v_v jsonb;
  v_op text;
begin
  if p_depth > 4 then raise exception 'invalid_audience_depth'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_audience'; end if;
  if p ? 'all' or p ? 'any' then
    v_op := case when p ? 'all' then 'all' else 'any' end;
    if (select count(*) from jsonb_object_keys(p)) <> 1 then raise exception 'invalid_audience'; end if;
    if jsonb_typeof(p->v_op) <> 'array' or jsonb_array_length(p->v_op) not between 1 and 20 then raise exception 'invalid_audience'; end if;
    for v_child in select e from jsonb_array_elements(p->v_op) e loop
      v_out := v_out || jsonb_build_array(banto_audience_normalize(v_child, p_keys, p_depth + 1));
    end loop;
    return jsonb_build_object(v_op, v_out);
  end if;
  if p ? 'not' then
    if (select count(*) from jsonb_object_keys(p)) <> 1 then raise exception 'invalid_audience'; end if;
    return jsonb_build_object('not', banto_audience_normalize(p->'not', p_keys, p_depth + 1));
  end if;
  if p ? 'member' then
    if (select count(*) from jsonb_object_keys(p)) <> 1 or p->'member' <> 'true'::jsonb then raise exception 'invalid_audience'; end if;
    return '{"member": true}'::jsonb;
  end if;
  if p ? 'attr' then
    if jsonb_typeof(p->'attr') <> 'string' or not ((p->>'attr') = any(p_keys)) then raise exception 'invalid_audience_attr'; end if;
    if (select count(*) from jsonb_object_keys(p)) <> 2 then raise exception 'invalid_audience'; end if;
    if p ? 'in' then
      if jsonb_typeof(p->'in') <> 'array' or jsonb_array_length(p->'in') not between 1 and 100 then raise exception 'invalid_audience'; end if;
      for v_v in select e from jsonb_array_elements(p->'in') e loop
        if jsonb_typeof(v_v) not in ('string', 'number') or char_length(btrim(v_v #>> '{}')) not between 1 and 200 then raise exception 'invalid_audience'; end if;
        v_vals := v_vals || to_jsonb(btrim(v_v #>> '{}'));
      end loop;
      return jsonb_build_object('attr', p->>'attr', 'in', v_vals);
    end if;
    if p ? 'gte' or p ? 'lte' then
      v_op := case when p ? 'gte' then 'gte' else 'lte' end;
      if jsonb_typeof(p->v_op) <> 'number' then raise exception 'invalid_audience'; end if;
      return jsonb_build_object('attr', p->>'attr', v_op, p->v_op);
    end if;
    if p ? 'set' then
      if p->'set' <> 'true'::jsonb then raise exception 'invalid_audience'; end if;
      return jsonb_build_object('attr', p->>'attr', 'set', true);
    end if;
  end if;
  -- URL のクエリのパラメータ（表示の出し分けだけ。商品・価格の条件には使えない: banto_audience_display_only）。
  -- remember: 同じ訪問のあいだ覚えた値でも合う（覚えるのは画面の Cookie。DB は渡された値で判定する）
  if p ? 'param' then
    if jsonb_typeof(p->'param') <> 'string' or lower(p->>'param') !~ '^[a-z0-9_]{1,40}$' then raise exception 'invalid_audience_param'; end if;
    if p ? 'remember' and p->'remember' <> 'true'::jsonb then raise exception 'invalid_audience'; end if;
    if (select count(*) from jsonb_object_keys(p)) <> 2 + (case when p ? 'remember' then 1 else 0 end) then raise exception 'invalid_audience'; end if;
    v_out := jsonb_build_object('param', lower(p->>'param')) || case when p ? 'remember' then '{"remember": true}'::jsonb else '{}'::jsonb end;
    if p ? 'in' then
      if jsonb_typeof(p->'in') <> 'array' or jsonb_array_length(p->'in') not between 1 and 100 then raise exception 'invalid_audience'; end if;
      for v_v in select e from jsonb_array_elements(p->'in') e loop
        if jsonb_typeof(v_v) not in ('string', 'number') or char_length(btrim(v_v #>> '{}')) not between 1 and 200 then raise exception 'invalid_audience'; end if;
        v_vals := v_vals || to_jsonb(btrim(v_v #>> '{}'));
      end loop;
      return v_out || jsonb_build_object('in', v_vals);
    end if;
    if p ? 'gte' or p ? 'lte' then
      v_op := case when p ? 'gte' then 'gte' else 'lte' end;
      if jsonb_typeof(p->v_op) <> 'number' then raise exception 'invalid_audience'; end if;
      return v_out || jsonb_build_object(v_op, p->v_op);
    end if;
    if p ? 'set' then
      if p->'set' <> 'true'::jsonb then raise exception 'invalid_audience'; end if;
      return v_out || '{"set": true}'::jsonb;
    end if;
  end if;
  raise exception 'invalid_audience';
end;
$$;
revoke execute on function banto_audience_normalize(jsonb, text[], integer) from public, anon, authenticated;

-- 葉の数（20 まで）
create or replace function banto_audience_leaves(p jsonb)
returns integer language sql immutable as $$
  select count(*)::integer from jsonb_path_query(p, 'strict $.**') x(v)
   where jsonb_typeof(x.v) = 'object' and (x.v ? 'attr' or x.v ? 'member' or x.v ? 'param');
$$;
revoke execute on function banto_audience_leaves(jsonb) from public, anon, authenticated;

-- URL のパラメータを含む条件（表示の出し分けだけに使う。買える・単価・見せない行の条件にはしない。URL はだれでも付けられるため）
create or replace function banto_audience_display_only(p jsonb)
returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_path_query(p, 'strict $.**') x(v) where jsonb_typeof(x.v) = 'object' and x.v ? 'param');
$$;
revoke execute on function banto_audience_display_only(jsonb) from public, anon, authenticated;

-- ショップの会員の独自項目の鍵
create or replace function banto_customer_field_keys(p_settings jsonb)
returns text[] language sql immutable as $$
  select coalesce(array_agg(f->>'key'), '{}')
    from jsonb_array_elements(case when jsonb_typeof(p_settings->'customer_fields') = 'array' then p_settings->'customer_fields' else '[]'::jsonb end) f
   where jsonb_typeof(f) = 'object' and jsonb_typeof(f->'key') = 'string';
$$;
revoke execute on function banto_customer_field_keys(jsonb) from public, anon, authenticated;

-- ---------- 判定（正） ----------
-- p_member: ログイン中の会員か。p_attrs: 会員の独自項目（ゲストは {}）。
-- p_params: URL のクエリ（名前 → 値の配列、名前は小文字）。お店の画面のブロックだけが渡す（商品・価格の判定では空）
drop function if exists banto_audience_ok(jsonb, boolean, jsonb);
create or replace function banto_audience_ok(p jsonb, p_member boolean, p_attrs jsonb, p_params jsonb default '{}'::jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_child jsonb;
  v_val jsonb;
  v_vals jsonb;
  v_num numeric;
begin
  if p is null then return true; end if;
  if p ? 'all' then
    for v_child in select e from jsonb_array_elements(p->'all') e loop
      if not banto_audience_ok(v_child, p_member, p_attrs, p_params) then return false; end if;
    end loop;
    return true;
  end if;
  if p ? 'any' then
    for v_child in select e from jsonb_array_elements(p->'any') e loop
      if banto_audience_ok(v_child, p_member, p_attrs, p_params) then return true; end if;
    end loop;
    return false;
  end if;
  if p ? 'not' then return not banto_audience_ok(p->'not', p_member, p_attrs, p_params); end if;
  if p ? 'member' then return coalesce(p_member, false); end if;
  if p ? 'param' then
    v_vals := case when jsonb_typeof(p_params) = 'object' and jsonb_typeof(p_params->(p->>'param')) = 'array' then p_params->(p->>'param') else '[]'::jsonb end;
    if p ? 'set' then return exists (select 1 from jsonb_array_elements(v_vals) e where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> ''); end if;
    if p ? 'in' then
      return exists (select 1 from jsonb_array_elements(v_vals) e, jsonb_array_elements(p->'in') w
                      where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '' and lower(btrim(e #>> '{}')) = lower(btrim(w #>> '{}')));
    end if;
    -- 数は最初の値だけ（数として読めなければ合わない）
    v_val := v_vals->0;
    if v_val is null or jsonb_typeof(v_val) <> 'string' or btrim(v_val #>> '{}') !~* '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)(e[+-]?[0-9]+)?$' then return false; end if;
    v_num := btrim(v_val #>> '{}')::numeric;
    if p ? 'gte' then return v_num >= (p->>'gte')::numeric; end if;
    if p ? 'lte' then return v_num <= (p->>'lte')::numeric; end if;
    return false;
  end if;
  if p ? 'attr' then
    if not coalesce(p_member, false) then return false; end if;
    v_val := case when jsonb_typeof(p_attrs) = 'object' then p_attrs->(p->>'attr') end;
    if v_val is null or jsonb_typeof(v_val) not in ('string', 'number', 'boolean') or btrim(v_val #>> '{}') = '' then return false; end if;
    if p ? 'set' then return true; end if;
    if p ? 'in' then
      return exists (select 1 from jsonb_array_elements(p->'in') e where lower(btrim(e #>> '{}')) = lower(btrim(v_val #>> '{}')));
    end if;
    begin
      v_num := (v_val #>> '{}')::numeric;
    exception when others then
      return false;
    end;
    if p ? 'gte' then return v_num >= (p->>'gte')::numeric; end if;
    if p ? 'lte' then return v_num <= (p->>'lte')::numeric; end if;
  end if;
  return false;
end;
$$;
revoke execute on function banto_audience_ok(jsonb, boolean, jsonb, jsonb) from public, anon, authenticated;

-- ---------- 名前を付けた条件 ----------
create table if not exists audiences (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  condition jsonb not null check (jsonb_typeof(condition) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, name),
  unique (id, shop_id)
);
create index if not exists audiences_shop_idx on audiences (shop_id);
alter table audiences enable row level security;
drop policy if exists audiences_read on audiences;
create policy audiences_read on audiences for select
  using (banto_shop_perm(shop_id, 'marketing') or banto_shop_perm(shop_id, 'catalog') or banto_shop_perm(shop_id, 'content') or banto_shop_perm(shop_id, 'customers'));
drop policy if exists audiences_insert on audiences;
create policy audiences_insert on audiences for insert with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists audiences_update on audiences;
create policy audiences_update on audiences for update using (banto_shop_perm(shop_id, 'marketing')) with check (banto_shop_perm(shop_id, 'marketing'));
drop policy if exists audiences_delete on audiences;
create policy audiences_delete on audiences for delete using (banto_shop_perm(shop_id, 'marketing'));
revoke all on audiences from anon;
grant select, insert, update, delete on audiences to authenticated;

-- 書くときに形を確かめて組み直す（鍵はショップの会員の独自項目の定義にあるものだけ）
create or replace function banto_audiences_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_settings jsonb;
begin
  if tg_op = 'UPDATE' and new.shop_id is distinct from old.shop_id then raise exception 'shop_immutable' using errcode = '42501'; end if;
  select settings into v_settings from shops where id = new.shop_id;
  new.name := btrim(new.name);
  new.condition := banto_audience_normalize(new.condition, banto_customer_field_keys(coalesce(v_settings, '{}'::jsonb)));
  if banto_audience_leaves(new.condition) > 20 then raise exception 'invalid_audience_size'; end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function banto_audiences_guard() from public, anon, authenticated;
drop trigger if exists audiences_guard on audiences;
create trigger audiences_guard before insert or update on audiences for each row execute function banto_audiences_guard();

-- どこかの条件で使っている独自項目の鍵（会員の Cookie・トークンに入れる値を絞る）
create or replace function banto_audience_keys(p_shop_id uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct k), '{}')
    from audiences a, jsonb_path_query(a.condition, 'strict $.**.attr') x(v), lateral (select x.v #>> '{}' as k) kk
   where a.shop_id = p_shop_id and jsonb_typeof(x.v) = 'string';
$$;
revoke execute on function banto_audience_keys(uuid) from public, anon, authenticated;

-- 会員の独自項目のうち、条件で使っている鍵だけ
create or replace function banto_member_audience_attrs(p_shop_id uuid, p_attrs jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_attrs) = 'object' then p_attrs else '{}'::jsonb end) e
   where e.key = any(banto_audience_keys(p_shop_id)) and jsonb_typeof(e.value) in ('string', 'number', 'boolean');
$$;
revoke execute on function banto_member_audience_attrs(uuid, jsonb) from public, anon, authenticated;

-- ---------- 会員のセッション: 確かめ直すときに条件で使う値も返す ----------
-- 0045 の member_session_check と同じ確かめ。戻り値は { ok, attrs }
create or replace function member_session_check_attrs(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_attrs jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_check_attrs: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return jsonb_build_object('ok', false); end if;
  update member_sessions set last_seen_at = now() where id = p_session_id;
  select banto_member_audience_attrs(p_shop_id, attributes) into v_attrs from customers where shop_id = p_shop_id and id = p_customer_id;
  return jsonb_build_object('ok', true, 'attrs', coalesce(v_attrs, '{}'::jsonb));
end;
$$;
revoke execute on function member_session_check_attrs(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_session_check_attrs(uuid, uuid, integer, uuid) to service_role;

-- 会員トークンの refresh（0045）でも同じ値を返す。ほかは 0045 と同じ
create or replace function member_session_refresh(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_gen integer, p_grace_seconds integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_s member_sessions; v_attrs jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_session_refresh: service_role only' using errcode = '42501';
  end if;
  select * into v_s from member_sessions
   where id = p_session_id and shop_id = p_shop_id and customer_id = p_customer_id and kind = 'api'
   for update;
  if not found or not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select banto_member_audience_attrs(p_shop_id, attributes) into v_attrs from customers where shop_id = p_shop_id and id = p_customer_id;
  if p_gen = v_s.refresh_gen then
    update member_sessions set refresh_gen = refresh_gen + 1, rotated_at = now(), last_seen_at = now()
     where id = p_session_id returning * into v_s;
    return jsonb_build_object('ok', true, 'gen', v_s.refresh_gen, 'expires_at', v_s.expires_at, 'attrs', coalesce(v_attrs, '{}'::jsonb));
  end if;
  if p_gen = v_s.refresh_gen - 1 and v_s.rotated_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 0), 0)) then
    update member_sessions set last_seen_at = now() where id = p_session_id;
    return jsonb_build_object('ok', true, 'gen', v_s.refresh_gen, 'expires_at', v_s.expires_at, 'attrs', coalesce(v_attrs, '{}'::jsonb));
  end if;
  update member_sessions set revoked_at = now(), revoked_reason = 'reuse' where id = p_session_id;
  return jsonb_build_object('ok', false, 'reason', 'reuse');
end;
$$;
revoke execute on function member_session_refresh(uuid, uuid, integer, uuid, integer, integer) from public, anon, authenticated;
grant execute on function member_session_refresh(uuid, uuid, integer, uuid, integer, integer) to service_role;

-- ---------- お店の画面で本文のブロックを出し分けるための条件の一覧（Worker が短くキャッシュする） ----------
-- 条件の中身（独自項目の鍵）はお客様に見せないので anon には読ませない。モジュールが OFF なら空
create or replace function shop_audiences_render(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'shop_audiences_render: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops s where s.id = p_shop_id and coalesce(s.settings->'modules'->>'audiences', 'false') = 'true') then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'condition', a.condition) order by a.name) from audiences a where a.shop_id = p_shop_id), '[]'::jsonb);
end;
$$;
revoke execute on function shop_audiences_render(uuid) from public, anon, authenticated;
grant execute on function shop_audiences_render(uuid) to service_role;

insert into banto_migrations (version) values ('0097_audiences');
