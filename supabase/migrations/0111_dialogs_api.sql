-- Banto 0111_dialogs_api: お店の画面のダイアログ（0110）の段階 2。AI 用 API とつないだ外部プラグインから、ダイアログを作る・直す・止める・消す
-- （メンテナの決定 2026-11-04、docs/dialogs.md「API とプラグインから」）。前方専用。
--   - スコープ dialogs:write（項目 marketing）。モジュール dialogs が ON のショップだけ
--   - 連携に結んだトークン（api_tokens.endpoint_id、0084）で作ったものは、その連携（dialogs.endpoint_id）のもの。連携を外すと一緒に消える。
--     プラグインが触れるのは自分の連携のものだけ。運営者のトークン（連携に結ばない）が触れるのは、運営者の作ったもの（endpoint_id が無い）だけ
--   - 運営者は管理画面（RLS、項目 marketing）で、プラグインのものも見て・止めて・消せる。endpoint_id を付け替えることはできない
--   - 形の確かめは 0110 の banto_dialogs_guard（同じ一本道）

alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send','dialogs:write']::text[]
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
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

alter table dialogs add column if not exists endpoint_id uuid;
alter table dialogs drop constraint if exists dialogs_endpoint_fkey;
alter table dialogs add constraint dialogs_endpoint_fkey foreign key (endpoint_id, shop_id) references hook_endpoints (id, shop_id) on delete cascade;
create index if not exists dialogs_endpoint_idx on dialogs (endpoint_id) where endpoint_id is not null;

-- 運営者の JWT からは endpoint_id を付けない・付け替えない（だれのものかは API だけが決める）
create or replace function banto_dialogs_endpoint_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and (tg_op = 'INSERT' and new.endpoint_id is not null or tg_op = 'UPDATE' and new.endpoint_id is distinct from old.endpoint_id) then
    raise exception 'invalid_dialog:endpoint' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function banto_dialogs_endpoint_guard() from public, anon, authenticated;
drop trigger if exists dialogs_endpoint_guard on dialogs;
create trigger dialogs_endpoint_guard before insert or update of endpoint_id on dialogs for each row execute function banto_dialogs_endpoint_guard();

create or replace function banto_dialog_json(d dialogs)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', d.id, 'name', d.name, 'enabled', d.enabled, 'priority', d.priority, 'layout', d.layout,
                            'title', d.title, 'body', d.body, 'image_url', d.image_url, 'buttons', d.buttons, 'coupon_code', d.coupon_code,
                            'audience', d.audience, 'audience_id', d.audience_id, 'pages', d.pages, 'trigger', d.trigger,
                            'snooze_days', d.snooze_days, 'starts_at', d.starts_at, 'ends_at', d.ends_at,
                            'created_at', d.created_at, 'updated_at', d.updated_at);
$$;
revoke execute on function banto_dialog_json(dialogs) from public, anon, authenticated;

-- トークンを確かめ、モジュールが ON か見る
create or replace function api_dialogs_require(p_token_hash text)
returns api_tokens language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'dialogs:write');
  if not exists (select 1 from shops where id = v_tok.shop_id and settings->'modules'->'dialogs' = 'true'::jsonb) then
    raise exception 'module_disabled';
  end if;
  return v_tok;
end;
$$;
revoke execute on function api_dialogs_require(text) from public, anon, authenticated;

-- 一覧（このトークンが触れるものだけ。優先の高い順）
create or replace function api_dialogs_list(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_dialogs_require(p_token_hash);
  return coalesce((select jsonb_agg(banto_dialog_json(d) order by d.priority desc, d.created_at)
                     from dialogs d where d.shop_id = v_tok.shop_id and d.endpoint_id is not distinct from v_tok.endpoint_id), '[]'::jsonb);
end;
$$;
revoke execute on function api_dialogs_list(text) from public, anon, authenticated;
grant execute on function api_dialogs_list(text) to service_role;

-- 作る（p_values の鍵は管理画面と同じ。知らない鍵は 'unknown_field'。形の確かめは banto_dialogs_guard）
create or replace function api_dialog_create(p_token_hash text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_row dialogs; v_k text;
begin
  v_tok := api_dialogs_require(p_token_hash);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_dialog:values' using errcode = '22023'; end if;
  for v_k in select jsonb_object_keys(p_values) loop
    if v_k not in ('name', 'enabled', 'priority', 'layout', 'title', 'body', 'image_url', 'buttons', 'coupon_code', 'audience', 'audience_id', 'pages', 'trigger', 'snooze_days', 'starts_at', 'ends_at') then
      raise exception 'invalid_dialog:unknown_field:%', v_k using errcode = '22023';
    end if;
  end loop;
  insert into dialogs (shop_id, endpoint_id, name, enabled, priority, layout, title, body, image_url, buttons, coupon_code, audience, audience_id, pages, trigger, snooze_days, starts_at, ends_at)
  values (v_tok.shop_id, v_tok.endpoint_id, p_values->>'name', coalesce((p_values->>'enabled')::boolean, true), coalesce((p_values->>'priority')::integer, 0),
          coalesce(p_values->>'layout', 'bar'), p_values->>'title', coalesce(p_values->>'body', ''), p_values->>'image_url',
          coalesce(p_values->'buttons', '[]'::jsonb), p_values->>'coupon_code', coalesce(p_values->>'audience', 'all'), (p_values->>'audience_id')::uuid,
          coalesce(p_values->'pages', '{"kinds":["all"]}'::jsonb), coalesce(p_values->'trigger', '{}'::jsonb), coalesce((p_values->>'snooze_days')::integer, 7),
          (p_values->>'starts_at')::timestamptz, (p_values->>'ends_at')::timestamptz)
  returning * into v_row;
  return banto_dialog_json(v_row);
end;
$$;
revoke execute on function api_dialog_create(text, jsonb) from public, anon, authenticated;
grant execute on function api_dialog_create(text, jsonb) to service_role;

-- 直す（渡した鍵だけを変える。null で空にできるのは body 以外の任意の欄）
create or replace function api_dialog_update(p_token_hash text, p_id uuid, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_row dialogs; v_k text;
begin
  v_tok := api_dialogs_require(p_token_hash);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'invalid_dialog:values' using errcode = '22023'; end if;
  for v_k in select jsonb_object_keys(p_values) loop
    if v_k not in ('name', 'enabled', 'priority', 'layout', 'title', 'body', 'image_url', 'buttons', 'coupon_code', 'audience', 'audience_id', 'pages', 'trigger', 'snooze_days', 'starts_at', 'ends_at') then
      raise exception 'invalid_dialog:unknown_field:%', v_k using errcode = '22023';
    end if;
  end loop;
  select * into v_row from dialogs where id = p_id and shop_id = v_tok.shop_id and endpoint_id is not distinct from v_tok.endpoint_id for update;
  if not found then raise exception 'not_found'; end if;
  update dialogs set
    name = case when p_values ? 'name' then p_values->>'name' else name end,
    enabled = case when p_values ? 'enabled' then (p_values->>'enabled')::boolean else enabled end,
    priority = case when p_values ? 'priority' then coalesce((p_values->>'priority')::integer, 0) else priority end,
    layout = case when p_values ? 'layout' then p_values->>'layout' else layout end,
    title = case when p_values ? 'title' then p_values->>'title' else title end,
    body = case when p_values ? 'body' then coalesce(p_values->>'body', '') else body end,
    image_url = case when p_values ? 'image_url' then p_values->>'image_url' else image_url end,
    buttons = case when p_values ? 'buttons' then coalesce(p_values->'buttons', '[]'::jsonb) else buttons end,
    coupon_code = case when p_values ? 'coupon_code' then p_values->>'coupon_code' else coupon_code end,
    audience = case when p_values ? 'audience' then p_values->>'audience' else audience end,
    audience_id = case when p_values ? 'audience_id' then (p_values->>'audience_id')::uuid else audience_id end,
    pages = case when p_values ? 'pages' then p_values->'pages' else pages end,
    trigger = case when p_values ? 'trigger' then coalesce(p_values->'trigger', '{}'::jsonb) else trigger end,
    snooze_days = case when p_values ? 'snooze_days' then coalesce((p_values->>'snooze_days')::integer, 7) else snooze_days end,
    starts_at = case when p_values ? 'starts_at' then (p_values->>'starts_at')::timestamptz else starts_at end,
    ends_at = case when p_values ? 'ends_at' then (p_values->>'ends_at')::timestamptz else ends_at end
  where id = v_row.id
  returning * into v_row;
  return banto_dialog_json(v_row);
end;
$$;
revoke execute on function api_dialog_update(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function api_dialog_update(text, uuid, jsonb) to service_role;

-- 消す（無ければ not_found）
create or replace function api_dialog_delete(p_token_hash text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_dialogs_require(p_token_hash);
  delete from dialogs where id = p_id and shop_id = v_tok.shop_id and endpoint_id is not distinct from v_tok.endpoint_id;
  if not found then raise exception 'not_found'; end if;
  return true;
end;
$$;
revoke execute on function api_dialog_delete(text, uuid) from public, anon, authenticated;
grant execute on function api_dialog_delete(text, uuid) to service_role;

insert into banto_migrations (version) values ('0111_dialogs_api');
