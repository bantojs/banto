-- 0019_coupon_grants: 配布型のクーポン（発行済みのクーポン）。docs/knowledge/09-coupons.md §5-2、docs/coupons.md
--
--   coupon_grants … 1 枚ずつの発行済みクーポン。コード（ショップの中で一意）を必ず持つ。
--                   customer_id があればその会員だけが使える（会員への発行）。無ければコードを知っている人が 1 回だけ使える（使い捨てコード）。
--                   available → held（予約中）→ used（確定）。決済ページの期限切れ・キャンセルで available に戻る。revoked は運営者が取り消した。
--                   1 枚ごとの期限 expires_at（キャンペーンの grant_valid_days 日。無ければキャンペーンの期間だけ）。
-- 判定は今までどおり src/commerce/discounts.ts（coupon_lookup がコードからキャンペーンと発行済みのクーポンを返す）。
-- 回数は「発行済みの行そのものが枠」: apply_reservation_discounts がその行を FOR UPDATE で取る（全体の上限・1 人あたりは見ない）。
-- 確定・解放は coupon_redemptions の状態が変わったときのトリガーで写す（確定・解放の関数は触らない）。

alter table coupon_campaigns add column if not exists grant_valid_days integer check (grant_valid_days is null or grant_valid_days between 1 and 3650);

create table coupon_grants (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  campaign_id uuid not null references coupon_campaigns(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  customer_id uuid,
  status text not null default 'available' check (status in ('available', 'held', 'used', 'revoked')),
  expires_at timestamptz,
  reservation_id uuid references reservations(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  foreign key (shop_id, customer_id) references customers(shop_id, id) on delete cascade
);
create unique index coupon_grants_code on coupon_grants(shop_id, code);
create index coupon_grants_customer on coupon_grants(shop_id, customer_id) where customer_id is not null and status = 'available';
create index on coupon_grants(campaign_id);
create index on coupon_grants(reservation_id) where reservation_id is not null;

alter table coupon_grants enable row level security;
-- owner は自ショップの発行済みクーポンを読む（書くのは下の関数だけ）。購入者は直接読めない
create policy coupon_grants_owner_select on coupon_grants for select using (banto_owns_shop(shop_id));

alter table coupon_redemptions add column if not exists grant_id uuid references coupon_grants(id) on delete set null;

-- ---------- 使用の記録の状態を発行済みのクーポンに写す ----------
create or replace function banto_coupon_grant_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.grant_id is null or new.status = old.status then return new; end if;
  if new.status = 'used' then
    update coupon_grants set status = 'used', used_at = now() where id = new.grant_id and status in ('held', 'available');
  elsif new.status = 'released' then
    -- 解放・キャンセル: この予約が押さえていた（使っていた）ものだけを戻す
    update coupon_grants set status = 'available', reservation_id = null, used_at = null
     where id = new.grant_id and status in ('held', 'used') and reservation_id = new.reservation_id;
  end if;
  return new;
end;
$$;
drop trigger if exists coupon_redemptions_grant on coupon_redemptions;
create trigger coupon_redemptions_grant after update of status on coupon_redemptions for each row execute function banto_coupon_grant_status();
revoke execute on function banto_coupon_grant_status() from public, anon, authenticated;

-- ---------- 発行（owner） ----------
-- p_customer_ids があれば会員ごとに 1 枚（その会員に使っていない同じキャンペーンのクーポンがあれば足さない）、
-- p_count があればコードだけのクーポンを p_count 枚（最大 5000）。戻り値: { issued }
create or replace function coupon_grants_issue(p_shop_id uuid, p_campaign_id uuid, p_customer_ids uuid[], p_count integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c coupon_campaigns%rowtype;
  v_expires timestamptz;
  v_n integer := 0;
  v_cid uuid;
  v_i integer;
  v_code text;
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  select * into v_c from coupon_campaigns where id = p_campaign_id and shop_id = p_shop_id;
  if not found then raise exception 'campaign_not_found'; end if;
  if coalesce(p_count, 0) < 0 or coalesce(p_count, 0) > 5000 or coalesce(array_length(p_customer_ids, 1), 0) > 5000 then raise exception 'too_many'; end if;
  v_expires := case when v_c.grant_valid_days is not null then now() + make_interval(days => v_c.grant_valid_days) end;
  if v_c.ends_at is not null and (v_expires is null or v_expires > v_c.ends_at) then v_expires := v_c.ends_at; end if;
  foreach v_cid in array coalesce(p_customer_ids, '{}'::uuid[]) loop
    if not exists (select 1 from customers where shop_id = p_shop_id and id = v_cid) then continue; end if;
    if exists (select 1 from coupon_grants where campaign_id = v_c.id and customer_id = v_cid and status in ('available', 'held')) then continue; end if;
    loop
      v_code := banto_grant_code();
      begin
        insert into coupon_grants (shop_id, campaign_id, code, customer_id, expires_at) values (p_shop_id, v_c.id, v_code, v_cid, v_expires);
        exit;
      exception when unique_violation then null; -- まれにコードが重なったら作り直す
      end;
    end loop;
    v_n := v_n + 1;
  end loop;
  for v_i in 1 .. coalesce(p_count, 0) loop
    loop
      v_code := banto_grant_code();
      begin
        insert into coupon_grants (shop_id, campaign_id, code, expires_at) values (p_shop_id, v_c.id, v_code, v_expires);
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('issued', v_n);
end;
$$;

-- 推測されにくいコード（XXXX-XXXX-XXXX、0/O・1/I を使わない 32 文字から。gen_random_uuid の乱数を使う）
create or replace function banto_grant_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_hex text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_out text := '';
  v_i integer;
begin
  for v_i in 0 .. 11 loop
    v_out := v_out || substr(v_alpha, (('x' || substr(v_hex, v_i * 2 + 1, 2))::bit(8)::integer % 32) + 1, 1);
    if v_i in (3, 7) then v_out := v_out || '-'; end if;
  end loop;
  return v_out;
end;
$$;

-- 取り消し（owner）。使っていないものだけ
create or replace function coupon_grant_revoke(p_shop_id uuid, p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  update coupon_grants set status = 'revoked' where id = p_grant_id and shop_id = p_shop_id and status = 'available';
  return found;
end;
$$;

-- ---------- 会員のマイクーポン（service_role、世代を確かめる） ----------
create or replace function member_coupons(p_shop_id uuid, p_customer_id uuid, p_epoch integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_coupons: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('code', g.code, 'name', c.name, 'kind', c.kind, 'value', c.value, 'expires_at', coalesce(g.expires_at, c.ends_at))
                     order by coalesce(g.expires_at, c.ends_at) nulls last, g.created_at)
      from coupon_grants g join coupon_campaigns c on c.id = g.campaign_id
     where g.shop_id = p_shop_id and g.customer_id = p_customer_id and g.status = 'available' and c.active
       and (g.expires_at is null or g.expires_at > now()) and (c.ends_at is null or c.ends_at > now())), '[]'::jsonb);
end;
$$;

-- ---------- 判定の材料（0010 を差し替え: 発行済みのクーポンのコードも引く） ----------
-- キャンペーンのコードに無いコードは、発行済みのクーポンから引く。そのときは code に発行済みのコード、grant に状態を入れて返す
create or replace function coupon_lookup(p_shop_id uuid, p_codes text[], p_subject text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_codes text[]; v_out jsonb; v_grants jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'coupon_lookup: service_role only' using errcode = '42501';
  end if;
  select array_agg(x) into v_codes from (select upper(btrim(x)) as x from unnest(coalesce(p_codes, '{}'::text[])) x limit 5) t;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'code', c.code, 'kind', c.kind, 'value', c.value,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'usage_limit', c.usage_limit, 'per_customer_limit', c.per_customer_limit,
      'combinable', c.combinable, 'audience', c.audience, 'conditions', c.conditions, 'active', c.active,
      'used_by_subject', case when p_subject is null or c.per_customer_limit is null then 0 else (
        select count(*) from coupon_redemptions r where r.campaign_id = c.id and r.subject = p_subject and r.status <> 'released') end,
      'available', c.usage_limit is null or exists (select 1 from coupon_slots s where s.campaign_id = c.id and s.status = 'free')
    )), '[]'::jsonb)
    into v_out
    from coupon_campaigns c
   where c.shop_id = p_shop_id and c.code = any (coalesce(v_codes, '{}'::text[]));
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'code', g.code, 'kind', c.kind, 'value', c.value,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'usage_limit', null, 'per_customer_limit', null,
      'combinable', c.combinable, 'audience', c.audience, 'conditions', c.conditions, 'active', c.active,
      'used_by_subject', 0, 'available', true,
      'grant', jsonb_build_object('id', g.id, 'status', g.status, 'expires_at', g.expires_at, 'customer_id', g.customer_id)
    )), '[]'::jsonb)
    into v_grants
    from coupon_grants g join coupon_campaigns c on c.id = g.campaign_id
   where g.shop_id = p_shop_id and g.code = any (coalesce(v_codes, '{}'::text[]))
     and not exists (select 1 from coupon_campaigns c2 where c2.shop_id = p_shop_id and c2.code = g.code);
  return v_out || v_grants;
end;
$$;

-- ---------- 予約に値引きを付け、回数を予約する（0010 を差し替え: 発行済みのクーポンはその行を取る） ----------
create or replace function apply_reservation_discounts(p_reservation_id uuid, p_shop_id uuid, p_subject text, p_discounts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res reservations%rowtype;
  v_a jsonb;
  v_c coupon_campaigns%rowtype;
  v_g coupon_grants%rowtype;
  v_used integer;
  v_slot bigint;
  v_grant uuid;
  v_total integer := coalesce((p_discounts->>'total_jpy')::integer, 0);
  v_lines jsonb := coalesce(p_discounts->'lines', '[]'::jsonb);
  v_subtotal integer;
  v_items jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'apply_reservation_discounts: service_role only' using errcode = '42501';
  end if;
  if p_subject is null or p_subject !~ '^(c|e):[0-9a-f-]{32,64}$' then raise exception 'invalid_subject'; end if;
  select * into v_res from reservations where id = p_reservation_id and shop_id = p_shop_id and status = 'pending' for update;
  if not found then raise exception 'reservation_not_found' using detail = p_reservation_id::text; end if;
  select coalesce(sum((e->>'qty')::integer * (e->>'unit_price_jpy')::integer), 0) into v_subtotal from jsonb_array_elements(v_res.items) e;
  if v_total < 0 or v_total > v_subtotal + v_res.shipping_jpy then raise exception 'invalid_discount'; end if;

  for v_a in select e from jsonb_array_elements(coalesce(p_discounts->'applied', '[]'::jsonb)) e loop
    select * into v_c from coupon_campaigns where id = (v_a->>'campaign_id')::uuid and shop_id = p_shop_id;
    if not found or not v_c.active or (v_c.starts_at is not null and v_c.starts_at > now()) or (v_c.ends_at is not null and v_c.ends_at < now()) then
      raise exception 'coupon_unavailable' using detail = coalesce(v_a->>'code', '');
    end if;
    if v_c.audience = 'members' and p_subject !~ '^c:' then
      raise exception 'coupon_unavailable' using detail = coalesce(v_c.code, '');
    end if;
    v_slot := null;
    v_grant := null;
    if nullif(v_a->>'grant_id', '') is not null then
      -- 発行済みのクーポン: その 1 枚を押さえる（同じコードの同時の申込みは、この行のロックで 1 つだけ通る）
      select * into v_g from coupon_grants where id = (v_a->>'grant_id')::uuid and shop_id = p_shop_id and campaign_id = v_c.id for update;
      if not found or v_g.status <> 'available' or (v_g.expires_at is not null and v_g.expires_at < now())
         or (v_g.customer_id is not null and p_subject <> 'c:' || v_g.customer_id::text) then
        raise exception 'coupon_unavailable' using detail = coalesce(v_a->>'code', '');
      end if;
      update coupon_grants set status = 'held', reservation_id = p_reservation_id where id = v_g.id;
      v_grant := v_g.id;
    else
      if v_c.per_customer_limit is not null then
        perform pg_advisory_xact_lock(hashtextextended(v_c.id::text || '|' || p_subject, 0));
        select count(*) into v_used from coupon_redemptions where campaign_id = v_c.id and subject = p_subject and status <> 'released';
        if v_used >= v_c.per_customer_limit then raise exception 'coupon_limit_reached' using detail = coalesce(v_c.code, ''); end if;
      end if;
      if v_c.usage_limit is not null then
        update coupon_slots set status = 'held', reservation_id = p_reservation_id
         where id = (select id from coupon_slots where campaign_id = v_c.id and status = 'free' limit 1 for update skip locked)
        returning id into v_slot;
        if v_slot is null then raise exception 'coupon_exhausted' using detail = coalesce(v_c.code, ''); end if;
      end if;
    end if;
    insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, slot_id, amount_jpy, grant_id)
    values (p_shop_id, v_c.id, p_reservation_id, p_subject, v_slot, greatest(0, coalesce((v_a->>'amount_jpy')::integer, 0)), v_grant);
  end loop;

  select jsonb_agg(e || jsonb_build_object('discount_jpy',
           least((e->>'qty')::integer * (e->>'unit_price_jpy')::integer,
                 greatest(0, coalesce((select (l->>'discount_jpy')::integer from jsonb_array_elements(v_lines) l where l->>'sku_id' = e->>'sku_id' limit 1), 0)))))
    into v_items from jsonb_array_elements(v_res.items) e;
  update reservations set discount_jpy = v_total, discounts = p_discounts->'applied', items = coalesce(v_items, items) where id = p_reservation_id;
  return jsonb_build_object('discount_jpy', v_total);
end;
$$;

revoke execute on function coupon_grants_issue(uuid, uuid, uuid[], integer) from public, anon;
grant execute on function coupon_grants_issue(uuid, uuid, uuid[], integer) to authenticated;
revoke execute on function banto_grant_code() from public, anon, authenticated;
revoke execute on function coupon_grant_revoke(uuid, uuid) from public, anon;
grant execute on function coupon_grant_revoke(uuid, uuid) to authenticated;
revoke execute on function member_coupons(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function member_coupons(uuid, uuid, integer) to service_role;
revoke execute on function coupon_lookup(uuid, text[], text) from public, anon, authenticated;
grant execute on function coupon_lookup(uuid, text[], text) to service_role;
revoke execute on function apply_reservation_discounts(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function apply_reservation_discounts(uuid, uuid, text, jsonb) to service_role;

insert into banto_migrations (version) values ('0019_coupon_grants');
