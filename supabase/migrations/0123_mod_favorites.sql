-- Banto 0123_mod_favorites: 会員のお気に入り（同梱モジュール favorites、既定 OFF）。メンテナの決定 2026-11-06（docs/favorites.md）。前方専用。
--   - 1 行 = 1 人の会員 × 1 つの商品。1 人 200 個まで。商品・会員が消えたら一緒に消える
--   - 書くのは本人だけ（service_role の member_favorite_*。セッションの行と世代を確かめる）。AI 用 API からは書かせない
--   - 運営者は項目 customers で読める（RLS）。商品ごとの人数だけは項目 catalog でも（product_favorite_counts）
--   - AI 用 API（customers:read）で読める: 会員ごと（api_customer_favorites）と、足した順にたどる一覧（api_favorites_list）
--   - hooks: favorite.added / favorite.removed（会員 ID と商品 ID だけ。個人情報は載せない）
--   - 行動の中継（0107）で渡せる種類に favorite_add / favorite_remove を足す

create table if not exists customer_favorites (
  shop_id uuid not null references shops (id) on delete cascade,
  customer_id uuid not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (customer_id, product_id),
  -- 同じショップの会員と商品だけ（会員の主キーは (shop_id, id)）
  foreign key (shop_id, customer_id) references customers (shop_id, id) on delete cascade,
  foreign key (product_id, shop_id) references products (id, shop_id) on delete cascade
);
create index if not exists customer_favorites_product_idx on customer_favorites (shop_id, product_id);
create index if not exists customer_favorites_created_idx on customer_favorites (shop_id, created_at, customer_id, product_id);
alter table customer_favorites enable row level security;

drop policy if exists customer_favorites_read on customer_favorites;
create policy customer_favorites_read on customer_favorites for select using (banto_shop_perm(shop_id, 'customers'));
revoke all on customer_favorites from anon;
revoke insert, update, delete on customer_favorites from authenticated;
grant select on customer_favorites to authenticated;

create or replace function banto_favorites_limit() returns integer language sql immutable as $$ select 200 $$;
revoke execute on function banto_favorites_limit() from public, anon, authenticated;

-- 1 人 200 個まで
create or replace function banto_customer_favorites_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from customer_favorites where customer_id = new.customer_id) >= banto_favorites_limit() then
    raise exception 'favorites_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function banto_customer_favorites_guard() from public, anon, authenticated;
drop trigger if exists customer_favorites_guard on customer_favorites;
create trigger customer_favorites_guard before insert on customer_favorites for each row execute function banto_customer_favorites_guard();

-- hooks（favorite.added / favorite.removed）。会員・商品を消したときの連鎖の削除では送らない（customer.deleted・商品の削除で分かる）
create or replace function banto_customer_favorites_hook()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_row customer_favorites; v_event text;
begin
  if tg_op = 'INSERT' then
    v_row := new; v_event := 'favorite.added';
  else
    v_row := old; v_event := 'favorite.removed';
    if not exists (select 1 from customers where id = old.customer_id) or not exists (select 1 from products where id = old.product_id) then
      return null;
    end if;
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, v_event, jsonb_build_object('shop_id', v_row.shop_id, 'customer_id', v_row.customer_id, 'product_id', v_row.product_id)
    from hook_endpoints e
   where e.shop_id = v_row.shop_id and e.enabled and v_event = any(e.events);
  return null;
end;
$$;
revoke execute on function banto_customer_favorites_hook() from public, anon, authenticated;
drop trigger if exists customer_favorites_hook on customer_favorites;
create trigger customer_favorites_hook after insert or delete on customer_favorites for each row execute function banto_customer_favorites_hook();

-- ---------- 本人（service_role だけ） ----------

-- 本人のお気に入り（新しい順）。見える商品だけ（公開中・会員の条件に合う）。id と URL の名前
create or replace function member_favorites(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_favorites: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('product_id', p.id, 'slug', p.slug, 'created_at', f.created_at) order by f.created_at desc, p.id)
      from customer_favorites f join products p on p.id = f.product_id
     where f.shop_id = p_shop_id and f.customer_id = p_customer_id and p.published
       and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))), '[]'::jsonb);
end;
$$;
revoke execute on function member_favorites(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_favorites(uuid, uuid, integer, uuid) to service_role;

-- 足す・外す（p_on）。足すのは本人に見える商品だけ。セッションが生きていなければ null
create or replace function member_favorite_set(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_product_id uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_favorite_set: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  if p_on is not true then
    delete from customer_favorites where shop_id = p_shop_id and customer_id = p_customer_id and product_id = p_product_id;
    return true;
  end if;
  v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  if not exists (select 1 from products p where p.id = p_product_id and p.shop_id = p_shop_id and p.published
                   and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))) then
    raise exception 'product_not_found';
  end if;
  insert into customer_favorites (shop_id, customer_id, product_id) values (p_shop_id, p_customer_id, p_product_id)
  on conflict (customer_id, product_id) do nothing;
  return true;
end;
$$;
revoke execute on function member_favorite_set(uuid, uuid, integer, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function member_favorite_set(uuid, uuid, integer, uuid, uuid, boolean) to service_role;

-- ゲストのお気に入り（ブラウザに覚えた分、50 まで）をログインした会員へ移す。見えない商品・上限を超える分は捨てる。移した数
create or replace function member_favorites_merge(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_product_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_aud uuid[]; v_room integer; v_n integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_favorites_merge: service_role only' using errcode = '42501';
  end if;
  if not banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then return null; end if;
  if coalesce(array_length(p_product_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_product_ids, 1) > 50 then raise exception 'invalid_favorites'; end if;
  v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  v_room := banto_favorites_limit() - (select count(*) from customer_favorites where customer_id = p_customer_id);
  if v_room <= 0 then return 0; end if;
  insert into customer_favorites (shop_id, customer_id, product_id)
  select p_shop_id, p_customer_id, p.id
    from (select distinct on (x.id) x.id, x.n from unnest(p_product_ids) with ordinality x(id, n) order by x.id, x.n) ids
    join products p on p.id = ids.id
   where p.shop_id = p_shop_id and p.published
     and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(v_aud))
     and not exists (select 1 from customer_favorites f where f.customer_id = p_customer_id and f.product_id = p.id)
   order by ids.n
   limit v_room
  on conflict (customer_id, product_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function member_favorites_merge(uuid, uuid, integer, uuid, uuid[]) from public, anon, authenticated;
grant execute on function member_favorites_merge(uuid, uuid, integer, uuid, uuid[]) to service_role;

-- ---------- 運営者 ----------

-- 商品ごとのお気に入りの人数（項目 catalog か customers。だれかは返さない）。{ "<商品 id>": 人数 }
create or replace function product_favorite_counts(p_shop_id uuid, p_product_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (banto_shop_perm(p_shop_id, 'catalog') or banto_shop_perm(p_shop_id, 'customers')) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if coalesce(array_length(p_product_ids, 1), 0) > 200 then raise exception 'invalid_products'; end if;
  return coalesce((select jsonb_object_agg(product_id, n) from (
    select f.product_id, count(*) as n from customer_favorites f
     where f.shop_id = p_shop_id and f.product_id = any(p_product_ids) group by f.product_id) x), '{}'::jsonb);
end;
$$;
revoke execute on function product_favorite_counts(uuid, uuid[]) from public, anon;
grant execute on function product_favorite_counts(uuid, uuid[]) to authenticated, service_role;

-- ---------- AI 用 API（customers:read） ----------

create or replace function api_favorite_json(p_customer_id uuid, p_product_id uuid, p_created_at timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('customer_id', p_customer_id, 'product_id', p_product_id,
    'product_slug', (select slug from products where id = p_product_id), 'created_at', p_created_at);
$$;
revoke execute on function api_favorite_json(uuid, uuid, timestamptz) from public, anon, authenticated;

-- 会員 1 人のお気に入り（新しい順、200 まで）
create or replace function api_customer_favorites(p_token_hash text, p_customer_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'customers:read');
  if not exists (select 1 from customers where id = p_customer_id and shop_id = v_tok.shop_id) then raise exception 'not_found'; end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(api_favorite_json(f.customer_id, f.product_id, f.created_at) order by f.created_at desc, f.product_id)
    from customer_favorites f where f.shop_id = v_tok.shop_id and f.customer_id = p_customer_id), '[]'::jsonb));
end;
$$;
revoke execute on function api_customer_favorites(text, uuid) from public, anon, authenticated;
grant execute on function api_customer_favorites(text, uuid) to service_role;

-- 足した順にたどる（キーセット: created_at・customer_id・product_id）。商品で絞れる。続きは応答の cursor（since と after）
create or replace function api_favorites_list(p_token_hash text, p_product_id uuid default null, p_since timestamptz default null,
  p_after_customer uuid default null, p_after_product uuid default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500); v_items jsonb; v_more boolean; v_last jsonb;
begin
  v_tok := api_require(p_token_hash, 'customers:read');
  if (p_after_customer is null) <> (p_after_product is null) or (p_after_customer is not null and p_since is null) then
    raise exception 'invalid_cursor';
  end if;
  with page as (
    select f.customer_id, f.product_id, f.created_at, row_number() over (order by f.created_at, f.customer_id, f.product_id) as n from (
      select * from customer_favorites f
       where f.shop_id = v_tok.shop_id
         and (p_product_id is null or f.product_id = p_product_id)
         and (p_since is null or f.created_at >= p_since)
         and (p_after_customer is null or (f.created_at, f.customer_id, f.product_id) > (p_since, p_after_customer, p_after_product))
       order by f.created_at, f.customer_id, f.product_id
       limit v_limit + 1) f)
  select coalesce(jsonb_agg(api_favorite_json(page.customer_id, page.product_id, page.created_at) order by page.n) filter (where page.n <= v_limit), '[]'::jsonb), count(*) > v_limit
    into v_items, v_more from page;
  if v_more then
    v_last := v_items->-1;
    return jsonb_build_object('items', v_items, 'has_more', true,
      'cursor', jsonb_build_object('since', v_last->'created_at', 'after', (v_last->>'customer_id') || ':' || (v_last->>'product_id')));
  end if;
  return jsonb_build_object('items', v_items, 'has_more', false, 'cursor', null);
end;
$$;
revoke execute on function api_favorites_list(text, uuid, timestamptz, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function api_favorites_list(text, uuid, timestamptz, uuid, uuid, integer) to service_role;

-- 行動の中継（0107・0110）で渡せる種類に、お気に入りを足した・外したを足す
create or replace function banto_relay_event_types()
returns text[] language sql immutable as $$
  select array['product_view', 'article_view', 'page_view', 'cart_add', 'cart_view', 'checkout_start', 'purchase', 'dialog_view', 'dialog_close', 'dialog_click', 'favorite_add', 'favorite_remove']::text[];
$$;
revoke execute on function banto_relay_event_types() from public, anon, authenticated;

insert into banto_migrations (version) values ('0123_mod_favorites');
