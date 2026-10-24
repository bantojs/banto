-- 0020_coupon_auto: クーポンの自動発行と、先着の「クーポンを獲得する」（docs/coupons.md §7、09-coupons.md §5-3）
--
-- coupon_campaigns.auto_grant … 'first_login'（会員が初めてログインしたとき = 会員登録。取り込んだ会員は初回のログインで）
--                                'after_purchase'（会員の注文が確定したとき。次回使えるクーポン）
-- coupon_campaigns.claimable  … 先着の獲得ページ（/<ショップ>/coupons/<キャンペーン>）で、ログイン中の会員が 1 人 1 枚もらえる。
--                                全体の上限（usage_limit）があれば、獲得のときに空き枠（coupon_slots）を取り合う。
--                                獲得したらその会員のクーポン（coupon_grants）になるので、使うときに取り合いは起きない。
-- 発行はどれも「使っていない同じキャンペーンのクーポンを持っていなければ 1 枚」（0019 の発行と同じ）。

alter table coupon_campaigns add column if not exists auto_grant text check (auto_grant is null or auto_grant in ('first_login', 'after_purchase'));
alter table coupon_campaigns add column if not exists claimable boolean not null default false;

-- 1 枚発行する（中で使うだけ。外からは呼べない）。発行したら true
create or replace function banto_grant_to_customer(p_campaign coupon_campaigns, p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_expires timestamptz; v_code text;
begin
  if exists (select 1 from coupon_grants where campaign_id = p_campaign.id and customer_id = p_customer_id and status in ('available', 'held')) then
    return false;
  end if;
  v_expires := case when p_campaign.grant_valid_days is not null then now() + make_interval(days => p_campaign.grant_valid_days) end;
  if p_campaign.ends_at is not null and (v_expires is null or v_expires > p_campaign.ends_at) then v_expires := p_campaign.ends_at; end if;
  loop
    v_code := banto_grant_code();
    begin
      insert into coupon_grants (shop_id, campaign_id, code, customer_id, expires_at) values (p_campaign.shop_id, p_campaign.id, v_code, p_customer_id, v_expires);
      return true;
    exception when unique_violation then null;
    end;
  end loop;
end;
$$;
revoke execute on function banto_grant_to_customer(coupon_campaigns, uuid) from public, anon, authenticated;

-- 有効で期間内のキャンペーンだけ
create or replace function banto_campaign_live(p_c coupon_campaigns)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_c.active and (p_c.starts_at is null or p_c.starts_at <= now()) and (p_c.ends_at is null or p_c.ends_at > now());
$$;
revoke execute on function banto_campaign_live(coupon_campaigns) from public, anon, authenticated;

-- 初めてログインしたとき
create or replace function banto_coupon_first_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_c coupon_campaigns%rowtype;
begin
  if old.last_login_at is not null or new.last_login_at is null then return new; end if;
  for v_c in select * from coupon_campaigns where shop_id = new.shop_id and auto_grant = 'first_login' loop
    if banto_campaign_live(v_c) then perform banto_grant_to_customer(v_c, new.id); end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists customers_coupon_first_login on customers;
create trigger customers_coupon_first_login after update of last_login_at on customers for each row execute function banto_coupon_first_login();
revoke execute on function banto_coupon_first_login() from public, anon, authenticated;

-- 会員の注文が確定したとき（次回使えるクーポン）
create or replace function banto_coupon_after_purchase()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_c coupon_campaigns%rowtype;
begin
  if new.customer_id is null then return new; end if;
  for v_c in select * from coupon_campaigns where shop_id = new.shop_id and auto_grant = 'after_purchase' loop
    if banto_campaign_live(v_c) and exists (select 1 from customers where shop_id = new.shop_id and id = new.customer_id) then
      perform banto_grant_to_customer(v_c, new.customer_id);
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists orders_coupon_after_purchase on orders;
create trigger orders_coupon_after_purchase after insert on orders for each row execute function banto_coupon_after_purchase();
revoke execute on function banto_coupon_after_purchase() from public, anon, authenticated;

-- 先着の獲得ページに出すキャンペーン（anon。公開中のショップの、獲得できるキャンペーンの表示に要る値だけ）
create or replace function coupon_claim_info(p_shop_id uuid, p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'value', c.value, 'starts_at', c.starts_at, 'ends_at', c.ends_at,
                            'live', banto_campaign_live(c), 'conditions', jsonb_build_object('min_subtotal_jpy', c.conditions->'min_subtotal_jpy'),
                            'remaining', case when c.usage_limit is null then null else (select count(*) from coupon_slots s where s.campaign_id = c.id and s.status = 'free') end)
    from coupon_campaigns c join shops s on s.id = c.shop_id
   where c.id = p_campaign_id and c.shop_id = p_shop_id and c.claimable and s.published;
$$;

-- 獲得する（service_role、会員の世代を確かめる）。戻り値: { ok, reason?, code? }
create or replace function member_claim_coupon(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_c coupon_campaigns%rowtype; v_slot bigint; v_code text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_claim_coupon: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from customers where shop_id = p_shop_id and id = p_customer_id and session_epoch = p_epoch) then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  select * into v_c from coupon_campaigns where id = p_campaign_id and shop_id = p_shop_id and claimable;
  if not found or not banto_campaign_live(v_c) then return jsonb_build_object('ok', false, 'reason', 'unavailable'); end if;
  -- 1 人 1 枚（使ったものも数える。取り消されたものは数えない）。同じ人の同時の申込みだけ直列にする
  perform pg_advisory_xact_lock(hashtextextended('claim|' || v_c.id::text || '|' || p_customer_id::text, 0));
  if exists (select 1 from coupon_grants where campaign_id = v_c.id and customer_id = p_customer_id and status <> 'revoked') then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if v_c.usage_limit is not null then
    update coupon_slots set status = 'used'
     where id = (select id from coupon_slots where campaign_id = v_c.id and status = 'free' limit 1 for update skip locked)
    returning id into v_slot;
    if v_slot is null then return jsonb_build_object('ok', false, 'reason', 'exhausted'); end if;
  end if;
  perform banto_grant_to_customer(v_c, p_customer_id);
  select code into v_code from coupon_grants where campaign_id = v_c.id and customer_id = p_customer_id and status = 'available' order by created_at desc limit 1;
  return jsonb_build_object('ok', true, 'code', v_code);
end;
$$;

revoke execute on function coupon_claim_info(uuid, uuid) from public;
grant execute on function coupon_claim_info(uuid, uuid) to anon, authenticated, service_role;
revoke execute on function member_claim_coupon(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function member_claim_coupon(uuid, uuid, integer, uuid) to service_role;

insert into banto_migrations (version) values ('0020_coupon_auto');
