-- Banto 0067_order_lookup_limits: ゲストの注文照会に回数の上限（人間の決定 2026-10-28）。前方専用。
--   - lookup_order は anon キー（公開の値）で直接呼べたので、Worker で数えても PostgREST を直接叩けば上限が無かった。
--     anon・authenticated から実行の権限を外し、Worker が service_role で order_lookup を呼ぶ形にする
--   - 数えるのは外れた照会だけ（合った照会は数えない）。同じ IP から 1 時間に settings.order_lookup.per_ip_per_hour 回（既定 20）、
--     同じ注文番号へ 1 時間に 50 回（IP を変えて 1 つの注文のアドレスを当てに行くのを止める。数えるのは外れだけなので、
--     第三者が外し続けてもその注文の照会が止まるのは 1 時間だけ）
--   - IP は Worker の HMAC だけ（素の IP は置かない）。1 日より古い行は外れを数えるついでに消す

create table if not exists order_lookup_failures (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  number integer not null,
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists order_lookup_failures_ip on order_lookup_failures (shop_id, ip_hash, created_at) where ip_hash is not null;
create index if not exists order_lookup_failures_number on order_lookup_failures (shop_id, number, created_at);
create index if not exists order_lookup_failures_created on order_lookup_failures (created_at);
alter table order_lookup_failures enable row level security;
create policy order_lookup_failures_none on order_lookup_failures for select using (false);
revoke all on order_lookup_failures from anon, authenticated;

-- 注文照会（ゲスト）: 番号とメールアドレスが合えば lookup_order と同じ形。合わなければ null（どちらが違うかは返さない）。
-- 上限を超えていれば too_many_requests（detail = ip / order）。合ったかどうかを確かめる前に判定する
create or replace function order_lookup(p_shop_id uuid, p_number integer, p_email text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
  v_r jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_lookup: service_role only' using errcode = '42501';
  end if;
  if v_ip is not null and (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.ip_hash = v_ip and f.created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'order_lookup', 'per_ip_per_hour', 20) then
    raise exception 'too_many_requests' using detail = 'ip';
  end if;
  if (select count(*) from order_lookup_failures f where f.shop_id = p_shop_id and f.number = p_number and f.created_at > now() - interval '1 hour') >= 50 then
    raise exception 'too_many_requests' using detail = 'order';
  end if;
  v_r := lookup_order(p_shop_id, p_number, p_email);
  if v_r is null then
    delete from order_lookup_failures where created_at < now() - interval '1 day';
    insert into order_lookup_failures (shop_id, number, ip_hash) values (p_shop_id, p_number, v_ip);
  end if;
  return v_r;
end;
$$;
revoke execute on function order_lookup(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function order_lookup(uuid, integer, text, text) to service_role;

-- lookup_order は service_role だけ（order_lookup と、注文トークンで引き直す領収書の経路）
revoke execute on function lookup_order(uuid, integer, text) from public, anon, authenticated;
grant execute on function lookup_order(uuid, integer, text) to service_role;

insert into banto_migrations (version) values ('0067_order_lookup_limits');
