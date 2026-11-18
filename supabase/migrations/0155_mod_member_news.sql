-- Banto 0155_mod_member_news: 会員へのお知らせと既読（同梱モジュール member_news、既定 OFF）。メンテナの決定 2026-11-18（docs/member-news.md）。前方専用。
--   - Banto は「置かれたお知らせを出す・既読を覚える」だけ。だれに・いつ置くかは決めない（自動で作るお知らせは持たない。0105 の line:send と同じ線）
--   - お知らせは 2 種類: 全員向け（customer_id が空。期間と会員の条件 audiences で絞れる）と、会員 1 人あて（customer_id）
--   - 書き手: 管理画面（全員向け。項目 marketing）と AI 用 API（スコープ member_news:write → 項目 marketing。連携に結んだトークンのものは
--     その連携 endpoint_id に結び、連携を外すと消える。プラグインが触れるのは自分の連携のものだけ）
--   - 読み手: 本人（service_role の member_news_list / member_news_read。セッションの行と世代を確かめる）。運営者は項目 marketing で読める
--   - 本文は文字だけ（HTML を置かない）。リンクは https か、お店の中のパス（/ で始まり // ではない）
--   - 1 人あては 1 人・書き手（連携か運営者）ごとに 200 件まで（超えたら、その書き手が置いた古いもの（置いた順）から消す。ほかの書き手のものは消さない）。
--     全員向けは 1 ショップ 100 件まで
--   - 会員の条件は同じショップの、表示用でない（URL のパラメータを使わない）ものだけ。使っている条件は消せない（商品・ページと同じ restrict）
--   - 運営者が読めるのは、全員向けは項目 marketing、1 人あてと既読は項目 customers（会員ごとの中身なので。お気に入りと同じ）

create table if not exists member_news (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops (id) on delete cascade,
  customer_id uuid,
  title text not null check (char_length(title) between 1 and 100),
  body text not null default '' check (char_length(body) <= 1000),
  url text check (url is null or (char_length(url) <= 500 and url !~ '[\\[:cntrl:]]' and (url ~ '^https://[^\s]+$' or url ~ '^/[^/\s][^\s]*$' or url = '/'))),
  starts_at timestamptz not null default now(),
  ends_at timestamptz check (ends_at is null or ends_at > starts_at),
  audience_id uuid,
  endpoint_id uuid,
  -- 置いた順（同じトランザクションの中でも順になるよう clock_timestamp）。1 人あての上限で古いものから消すのに使う
  created_at timestamptz not null default clock_timestamp(),
  check (customer_id is null or audience_id is null),
  -- 条件を消すと全員に見えてしまうので、使っている条件は消せない（0098・0100 と同じ）
  foreign key (audience_id, shop_id) references audiences (id, shop_id) on delete restrict,
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade,
  foreign key (endpoint_id, shop_id) references hook_endpoints (id, shop_id) on delete cascade
);
create index if not exists member_news_customer_idx on member_news (customer_id, starts_at desc) where customer_id is not null;
create index if not exists member_news_writer_idx on member_news (customer_id, endpoint_id, created_at desc) where customer_id is not null;
create index if not exists member_news_shop_idx on member_news (shop_id, starts_at desc) where customer_id is null;
alter table member_news enable row level security;
drop policy if exists member_news_marketing on member_news;
create policy member_news_marketing on member_news for select
  using (case when customer_id is null then banto_shop_perm(shop_id, 'marketing') else banto_shop_perm(shop_id, 'customers') end);
revoke all on member_news from anon, authenticated;
grant select on member_news to authenticated;

create table if not exists member_news_reads (
  shop_id uuid not null references shops (id) on delete cascade,
  customer_id uuid not null,
  news_id uuid not null references member_news (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (customer_id, news_id),
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade
);
alter table member_news_reads enable row level security;
drop policy if exists member_news_reads_marketing on member_news_reads;
create policy member_news_reads_marketing on member_news_reads for select using (banto_shop_perm(shop_id, 'customers'));
revoke all on member_news_reads from anon, authenticated;
grant select on member_news_reads to authenticated;

-- 会員の条件は同じショップのものだけ。1 人あては 200 件を超えたら古いものから消す。全員向けは 100 件まで
create or replace function banto_member_news_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 会員の条件: 同じショップ・表示用でない・モジュール audiences が ON（会員の判定 banto_member_audience_ids は表示用の条件を使わない）
  if new.audience_id is not null and (tg_op = 'INSERT' or new.audience_id is distinct from old.audience_id) then
    if not exists (select 1 from audiences a where a.id = new.audience_id and a.shop_id = new.shop_id and not banto_audience_display_only(a.condition)) then
      raise exception 'invalid_member_news:audience' using errcode = '22023';
    end if;
    if not exists (select 1 from shops where id = new.shop_id and settings->'modules'->'audiences' = 'true'::jsonb) then
      raise exception 'module_disabled:audiences' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'INSERT' and new.customer_id is null then
    -- 同時に足しても 100 を超えないように、ショップの行を押さえてから数える
    perform 1 from shops where id = new.shop_id for update;
    if (select count(*) from member_news where shop_id = new.shop_id and customer_id is null) >= 100 then
      raise exception 'member_news_full' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function banto_member_news_guard() from public, anon, authenticated;
drop trigger if exists member_news_guard on member_news;
create trigger member_news_guard before insert or update on member_news for each row execute function banto_member_news_guard();

create or replace function banto_member_news_prune()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is not null then
    -- 同じ書き手（連携か運営者）が置いたものだけを、置いた順の古いものから消す（足したばかりの行は最新なので残る）
    delete from member_news where id in (
      select id from member_news
       where customer_id = new.customer_id and endpoint_id is not distinct from new.endpoint_id
       order by created_at desc, id desc offset 200);
  end if;
  return null;
end;
$$;
revoke execute on function banto_member_news_prune() from public, anon, authenticated;
drop trigger if exists member_news_prune on member_news;
create trigger member_news_prune after insert on member_news for each row execute function banto_member_news_prune();

-- 値を確かめて行の形にそろえる（管理画面と API で共有）。p: { title, body?, url?, starts_at?, ends_at?, audience_id? }。知らない鍵は断る
create or replace function banto_member_news_norm(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_k text; v_title text; v_body text; v_url text; v_start timestamptz; v_end timestamptz; v_aud uuid;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_member_news:values' using errcode = '22023'; end if;
  for v_k in select jsonb_object_keys(p) loop
    if v_k not in ('title', 'body', 'url', 'starts_at', 'ends_at', 'audience_id', 'customer_id') then
      raise exception 'invalid_member_news:unknown_field:%', v_k using errcode = '22023';
    end if;
  end loop;
  v_title := case when jsonb_typeof(p->'title') = 'string' then btrim(p->>'title') end;
  if v_title is null or v_title = '' or char_length(v_title) > 100 then raise exception 'invalid_member_news:title' using errcode = '22023'; end if;
  if p ? 'body' and jsonb_typeof(p->'body') not in ('string', 'null') then raise exception 'invalid_member_news:body' using errcode = '22023'; end if;
  v_body := btrim(replace(replace(coalesce(p->>'body', ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n');
  if char_length(v_body) > 1000 then raise exception 'invalid_member_news:body' using errcode = '22023'; end if;
  if p ? 'url' and jsonb_typeof(p->'url') not in ('string', 'null') then raise exception 'invalid_member_news:url' using errcode = '22023'; end if;
  v_url := nullif(btrim(coalesce(p->>'url', '')), '');
  if v_url is not null and not (char_length(v_url) <= 500 and v_url !~ '[\\[:cntrl:]]' and (v_url ~ '^https://[^\s]+$' or v_url ~ '^/[^/\s][^\s]*$' or v_url = '/')) then
    raise exception 'invalid_member_news:url' using errcode = '22023';
  end if;
  begin
    v_start := case when jsonb_typeof(p->'starts_at') = 'string' then (p->>'starts_at')::timestamptz end;
    v_end := case when jsonb_typeof(p->'ends_at') = 'string' then (p->>'ends_at')::timestamptz end;
  exception when others then
    raise exception 'invalid_member_news:date' using errcode = '22023';
  end;
  if (p ? 'starts_at' and jsonb_typeof(p->'starts_at') not in ('string', 'null')) or (p ? 'ends_at' and jsonb_typeof(p->'ends_at') not in ('string', 'null')) then
    raise exception 'invalid_member_news:date' using errcode = '22023';
  end if;
  if v_end is not null and v_end <= coalesce(v_start, now()) then raise exception 'invalid_member_news:date' using errcode = '22023'; end if;
  begin
    v_aud := case when jsonb_typeof(p->'audience_id') = 'string' then (p->>'audience_id')::uuid end;
  exception when others then
    raise exception 'invalid_member_news:audience' using errcode = '22023';
  end;
  return jsonb_build_object('title', v_title, 'body', v_body, 'url', v_url, 'starts_at', v_start, 'ends_at', v_end, 'audience_id', v_aud);
end;
$$;
revoke execute on function banto_member_news_norm(jsonb) from public, anon, authenticated;

create or replace function banto_member_news_json(n member_news)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', n.id, 'customer_id', n.customer_id, 'title', n.title, 'body', n.body, 'url', n.url,
                            'starts_at', n.starts_at, 'ends_at', n.ends_at, 'audience_id', n.audience_id, 'created_at', n.created_at);
$$;
revoke execute on function banto_member_news_json(member_news) from public, anon, authenticated;

-- モジュールの ON/OFF は項目 marketing（0135 の定義に member_news を足す）
create or replace function banto_shop_settings_perm(p_key text, p_module text)
returns text
language sql
immutable
as $$
  select case
    when p_key = 'modules' then case p_module
      when 'coupons' then 'marketing' when 'dialogs' then 'marketing' when 'audiences' then 'marketing' when 'product_feed' then 'marketing'
      when 'inquiries' then 'support'
      when 'pages' then 'content' when 'blog' then 'content'
      when 'care_labels' then 'catalog' when 'size_charts' then 'catalog' when 'embed' then 'catalog' when 'woo_import' then 'catalog'
      when 'event_relay' then 'integrations' when 'line_login' then 'integrations' when 'google_login' then 'integrations' when 'passkey' then 'integrations'
      when 'shipping_labels' then 'orders'
      when 'store_tryon' then 'stores'
      when 'favorites' then 'customers'
      when 'member_news' then 'marketing'
      else null end
    when p_key in ('headless', 'oauth') then 'integrations'
    when p_key = 'page_layouts' then 'content'
    when p_key = 'product_fields' then 'catalog'
    when p_key = 'customer_fields' then 'customers'
    when p_key = 'views_orders' then 'orders'
    when p_key = 'views_customers' then 'customers'
    when p_key = 'views_products' then 'catalog'
    when p_key = 'views_inquiries' then 'support'
    when p_key in ('members_login_limits', 'checkout', 'inquiries', 'order_lookup', 'line_marketing_limit', 'storefront',
                   'members_password', 'members_enabled', 'marketing_consent', 'images', 'store_tryon', 'legal_links') then 'admin'
    else null end;
$$;
revoke execute on function banto_shop_settings_perm(text, text) from public, anon, authenticated;

-- ---------- 管理画面（項目 marketing。全員向けだけ書ける。プラグインのものも消せる） ----------

-- 作る（p_id が空）・直す。返り値は id
create or replace function member_news_save(p_shop_id uuid, p_id uuid, p_values jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v jsonb; v_id uuid;
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'marketing_required' using errcode = '42501'; end if;
  if p_values ? 'customer_id' then raise exception 'invalid_member_news:unknown_field:customer_id' using errcode = '22023'; end if;
  v := banto_member_news_norm(p_values);
  if p_id is null then
    insert into member_news (shop_id, title, body, url, starts_at, ends_at, audience_id)
    values (p_shop_id, v->>'title', v->>'body', v->>'url', coalesce((v->>'starts_at')::timestamptz, now()), (v->>'ends_at')::timestamptz, (v->>'audience_id')::uuid)
    returning id into v_id;
  else
    update member_news set title = v->>'title', body = v->>'body', url = v->>'url',
           starts_at = coalesce((v->>'starts_at')::timestamptz, starts_at), ends_at = (v->>'ends_at')::timestamptz, audience_id = (v->>'audience_id')::uuid
     where id = p_id and shop_id = p_shop_id and customer_id is null and endpoint_id is null
     returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function member_news_save(uuid, uuid, jsonb) from public, anon;
grant execute on function member_news_save(uuid, uuid, jsonb) to authenticated;

create or replace function member_news_delete(p_shop_id uuid, p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'marketing_required' using errcode = '42501'; end if;
  delete from member_news where id = p_id and shop_id = p_shop_id;
  return found;
end;
$$;
revoke execute on function member_news_delete(uuid, uuid) from public, anon;
grant execute on function member_news_delete(uuid, uuid) to authenticated;

-- ---------- 本人（service_role だけ） ----------

-- 本人に見えるお知らせ（新しい順、50 件まで）と未読の数。見える = 始まっていて終わっていない・本人あてか、全員向けで会員の条件に合う
create or replace function member_news_list(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_items jsonb; v_unread integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_news_list: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  -- 未読の数は見えるものすべてで数え、並べるのは新しい 50 件
  with vis as (
    select n.*, (r.news_id is not null) as is_read
      from member_news n left join member_news_reads r on r.news_id = n.id and r.customer_id = p_customer_id
     where n.shop_id = p_shop_id and n.starts_at <= now() and (n.ends_at is null or n.ends_at > now())
       and (n.customer_id = p_customer_id or (n.customer_id is null and (n.audience_id is null or n.audience_id = any(v_aud))))),
  page as (select * from vis order by starts_at desc, created_at desc, id limit 50)
  select (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body, 'url', url, 'starts_at', starts_at, 'read', is_read)
                                    order by starts_at desc, created_at desc, id), '[]'::jsonb) from page),
         (select count(*) from vis where not is_read)
    into v_items, v_unread;
  return jsonb_build_object('items', v_items, 'unread', v_unread);
end;
$$;
revoke execute on function member_news_list(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_news_list(uuid, uuid, integer, uuid) to service_role;

-- 既読にする。p_ids が空なら今見えるお知らせすべて。見えるものだけ（ほかの人あて・期間の外は無視）。既読にした数
create or replace function member_news_read(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_aud uuid[]; v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_news_read: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  if coalesce(array_length(p_ids, 1), 0) > 50 then raise exception 'invalid_member_news:ids'; end if;
  v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  insert into member_news_reads (shop_id, customer_id, news_id)
  select p_shop_id, p_customer_id, n.id
    from member_news n
   where n.shop_id = p_shop_id and n.starts_at <= now() and (n.ends_at is null or n.ends_at > now())
     and (n.customer_id = p_customer_id or (n.customer_id is null and (n.audience_id is null or n.audience_id = any(v_aud))))
     and (p_ids is null or n.id = any(p_ids))
  on conflict (customer_id, news_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function member_news_read(uuid, uuid, integer, uuid, uuid[]) from public, anon, authenticated;
grant execute on function member_news_read(uuid, uuid, integer, uuid, uuid[]) to service_role;

-- ---------- AI 用 API（member_news:write → 項目 marketing） ----------

alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (
  scopes <@ array['products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
                  'coupons:read','coupons:write','customers:read','customers:write','inquiries:read','inquiries:write',
                  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send','dialogs:write','stores:write',
                  'member_news:write']::text[]
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
    when 'member_news:write' then 'marketing'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- トークンを確かめ、モジュールが ON か見る
create or replace function api_member_news_require(p_token_hash text)
returns api_tokens language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'member_news:write');
  if not exists (select 1 from shops where id = v_tok.shop_id and settings->'modules'->'member_news' = 'true'::jsonb) then
    raise exception 'module_disabled';
  end if;
  return v_tok;
end;
$$;
revoke execute on function api_member_news_require(text) from public, anon, authenticated;

-- 置く。customer_id があれば 1 人あて（会員の条件は付けない）、無ければ全員向け。連携に結んだトークンならその連携のもの
create or replace function api_member_news_create(p_token_hash text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v jsonb; v_cid uuid; v_row member_news;
begin
  v_tok := api_member_news_require(p_token_hash);
  v := banto_member_news_norm(p_values);
  if jsonb_typeof(p_values->'customer_id') = 'string' then
    begin
      v_cid := (p_values->>'customer_id')::uuid;
    exception when others then
      raise exception 'invalid_member_news:customer' using errcode = '22023';
    end;
    if not exists (select 1 from customers where id = v_cid and shop_id = v_tok.shop_id) then raise exception 'invalid_member_news:customer' using errcode = '22023'; end if;
    if v->>'audience_id' is not null then raise exception 'invalid_member_news:audience' using errcode = '22023'; end if;
  elsif p_values ? 'customer_id' and jsonb_typeof(p_values->'customer_id') <> 'null' then
    raise exception 'invalid_member_news:customer' using errcode = '22023';
  end if;
  insert into member_news (shop_id, customer_id, title, body, url, starts_at, ends_at, audience_id, endpoint_id)
  values (v_tok.shop_id, v_cid, v->>'title', v->>'body', v->>'url', coalesce((v->>'starts_at')::timestamptz, now()), (v->>'ends_at')::timestamptz,
          (v->>'audience_id')::uuid, v_tok.endpoint_id)
  returning * into v_row;
  return banto_member_news_json(v_row);
end;
$$;
revoke execute on function api_member_news_create(text, jsonb) from public, anon, authenticated;
grant execute on function api_member_news_create(text, jsonb) to service_role;

-- このトークンが置いたもの（連携に結んだトークンは自分の連携のもの、運営者のトークンは連携に結ばないもの）。会員で絞れる。新しい順、200 件まで
create or replace function api_member_news_list(p_token_hash text, p_customer_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_member_news_require(p_token_hash);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(banto_member_news_json(x) order by x.starts_at desc, x.created_at desc, x.id) from (
      select * from member_news n
       where n.shop_id = v_tok.shop_id and n.endpoint_id is not distinct from v_tok.endpoint_id
         and (p_customer_id is null or n.customer_id = p_customer_id)
       order by n.starts_at desc, n.created_at desc, n.id limit 200) x), '[]'::jsonb));
end;
$$;
revoke execute on function api_member_news_list(text, uuid) from public, anon, authenticated;
grant execute on function api_member_news_list(text, uuid) to service_role;

create or replace function api_member_news_delete(p_token_hash text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_member_news_require(p_token_hash);
  delete from member_news where id = p_id and shop_id = v_tok.shop_id and endpoint_id is not distinct from v_tok.endpoint_id;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('deleted', true);
end;
$$;
revoke execute on function api_member_news_delete(text, uuid) from public, anon, authenticated;
grant execute on function api_member_news_delete(text, uuid) to service_role;

insert into banto_migrations (version) values ('0155_mod_member_news');
