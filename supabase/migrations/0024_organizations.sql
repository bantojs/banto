-- 0024_organizations: 組織・メンバー・役割・権限の項目（docs/knowledge/11-organizations.md、人間の決定 2026-10-17）
--
-- organizations       … 事業者（会社）。ショップと実店舗（0025）の持ち主
-- org_members         … 運営側の人（Supabase Auth のユーザー）と組織の役割（owner / admin / member）
-- org_member_shops    … member にショップごとの権限の項目を割り当てる（catalog / orders / orders_cancel / customers /
--                        marketing / reports / stores / settings / integrations）
-- org_invitations     … 招待（トークンは SHA-256 にして置く。7 日・1 回限り）
-- shops.org_id        … ショップの持ち主の組織。owner_id は 1 マイナー残して後で消す（2 段階の規約）。新しいショップはトリガーで入れる
--
-- 判定は security definer の関数に集める:
--   banto_org_admin(org_id)          … 組織の owner / admin か
--   banto_owns_shop(shop_id)         … そのショップの全権（組織の owner / admin）。作り替え。既存のポリシーと関数はこれで owner / admin に今までどおり効く
--   banto_shop_perm(shop_id, perm)   … 全権か、member でそのショップにその項目を持つか
-- 項目ごとの権限は、既存のポリシーに「足す」形で入れる（permissive なポリシーは OR）。既存のポリシーは書き換えない。
-- 権限を確かめている関数は、対応する項目で確かめるように差し替える（下の一覧）。差し替えていない関数は owner / admin だけが通る（安全側）。

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create table org_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on org_members(user_id);

-- ショップの権限の項目（§3-1）
create or replace function banto_shop_perms_all()
returns text[]
language sql
immutable
as $$ select array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations'] $$;

create table org_member_shops (
  org_id uuid not null,
  user_id uuid not null,
  shop_id uuid not null references shops(id) on delete cascade,
  perms text[] not null default '{}' check (perms <@ array['catalog', 'orders', 'orders_cancel', 'customers', 'marketing', 'reports', 'stores', 'settings', 'integrations']),
  primary key (user_id, shop_id),
  foreign key (org_id, user_id) references org_members(org_id, user_id) on delete cascade
);
create index on org_member_shops(shop_id);

create table org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null check (position('@' in email) > 1 and length(email) <= 254),
  role text not null check (role in ('owner', 'admin', 'member')),
  -- [{ shop_id, perms: [...] }]
  shops jsonb not null default '[]'::jsonb check (jsonb_typeof(shops) = 'array'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  invited_by uuid,
  created_at timestamptz not null default now()
);
create index on org_invitations(org_id);

alter table shops add column if not exists org_id uuid references organizations(id);
create index if not exists shops_org_id on shops(org_id);
-- 招待で入った管理者は owners の行を持たない（owners は「最初の 1 人」の入口）。新しいショップの owner_id は空でよい
alter table shops alter column owner_id drop not null;
-- AI 用トークンを発行した人も同じ（発行した人の記録として残す。権限の判定はショップ単位）
alter table api_tokens drop constraint if exists api_tokens_owner_id_fkey;
alter table api_tokens add constraint api_tokens_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete cascade;

-- ---------- 判定の関数 ----------
create or replace function banto_org_role(p_org_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from org_members where org_id = p_org_id and user_id = auth.uid();
$$;

create or replace function banto_org_admin(p_org_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = p_org_id and user_id = auth.uid() and role in ('owner', 'admin'));
$$;

-- そのショップの全権（組織の owner / admin）。組織に入る前のショップ（org_id が空）は今までどおり owner 本人
create or replace function banto_owns_shop(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shops s
     where s.id = p_shop_id
       and ((s.org_id is not null and exists (select 1 from org_members m where m.org_id = s.org_id and m.user_id = auth.uid() and m.role in ('owner', 'admin')))
            or (s.org_id is null and s.owner_id = auth.uid())));
$$;

create or replace function banto_shop_perm(p_shop_id uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select banto_owns_shop(p_shop_id) or exists (
    select 1 from org_member_shops ms join shops s on s.id = ms.shop_id
     where ms.shop_id = p_shop_id and ms.user_id = auth.uid() and ms.org_id = s.org_id and p_perm = any(ms.perms));
$$;

-- 管理画面がショップを開くときの 1 回の往復: ショップの行と自分の役割・項目（触れないショップなら null）
create or replace function banto_admin_shop(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when banto_owns_shop(s.id) then jsonb_build_object('shop', to_jsonb(s), 'role', coalesce(banto_org_role(s.org_id), 'owner'), 'perms', to_jsonb(banto_shop_perms_all()))
    when ms.perms is not null and cardinality(ms.perms) > 0 then jsonb_build_object('shop', to_jsonb(s), 'role', 'member', 'perms', to_jsonb(ms.perms))
    end
    from shops s
    left join org_member_shops ms on ms.shop_id = s.id and ms.user_id = auth.uid() and ms.org_id = s.org_id
   where s.id = p_shop_id;
$$;

-- 自分が触れるショップ（ダッシュボード）
create or replace function banto_my_shops()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published, 'org_id', s.org_id,
                                               'perms', case when banto_owns_shop(s.id) then to_jsonb(banto_shop_perms_all()) else to_jsonb(ms.perms) end)
                            order by s.created_at), '[]'::jsonb)
    from shops s
    left join org_member_shops ms on ms.shop_id = s.id and ms.user_id = auth.uid() and ms.org_id = s.org_id
   where banto_owns_shop(s.id) or (ms.perms is not null and cardinality(ms.perms) > 0);
$$;

-- ---------- 最初の 1 人 = 最初の組織の owner ----------
-- owners の行（自己登録の入口、0001）ができたら、その人の組織を作る（まだどの組織にも入っていなければ）
create or replace function banto_owner_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if exists (select 1 from org_members where user_id = new.id) then return new; end if;
  insert into organizations (name) values ('マイ組織') returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, new.id, 'owner');
  return new;
end;
$$;
drop trigger if exists owners_org on owners;
create trigger owners_org after insert on owners for each row execute function banto_owner_org();

-- 新しいショップ: 組織は「自分が owner / admin の組織」（いちばん古いもの）。持ち主を後から変えさせない。
-- Stripe の接続先（入金先）は integrations の項目を持つ人だけが変えられる
create or replace function banto_shops_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.org_id is null and auth.uid() is not null then
      select m.org_id into new.org_id from org_members m join organizations o on o.id = m.org_id
       where m.user_id = auth.uid() and m.role in ('owner', 'admin') order by o.created_at limit 1;
    end if;
    if new.owner_id is not null and not exists (select 1 from owners where id = new.owner_id) then new.owner_id := null; end if;
    return new;
  end if;
  if auth.role() = 'authenticated' then
    if new.org_id is distinct from old.org_id and old.org_id is not null then raise exception 'org_immutable' using errcode = '42501'; end if;
    if new.owner_id is distinct from old.owner_id then raise exception 'owner_immutable' using errcode = '42501'; end if;
    if new.stripe_account_id is distinct from old.stripe_account_id and not banto_shop_perm(old.id, 'integrations') then
      raise exception 'integrations_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists shops_guard on shops;
create trigger shops_guard before insert or update on shops for each row execute function banto_shops_guard();

-- 既存のデータ: owner ごとに組織を 1 つ作り、その owner を owner にして、ショップに組織を入れる
do $$
declare v_owner record; v_org uuid;
begin
  for v_owner in select o.id, (select name from shops s where s.owner_id = o.id order by created_at limit 1) as shop_name
                   from owners o where not exists (select 1 from org_members m where m.user_id = o.id) loop
    insert into organizations (name) values (left(coalesce(v_owner.shop_name, 'マイ組織'), 100)) returning id into v_org;
    insert into org_members (org_id, user_id, role) values (v_org, v_owner.id, 'owner');
  end loop;
  update shops s set org_id = (select m.org_id from org_members m where m.user_id = s.owner_id and m.role = 'owner' limit 1)
   where s.org_id is null and s.owner_id is not null;
end;
$$;

-- ---------- RLS ----------
alter table organizations enable row level security;
alter table org_members enable row level security;
alter table org_member_shops enable row level security;
alter table org_invitations enable row level security;

create policy organizations_member_select on organizations for select using (banto_org_role(id) is not null);
create policy organizations_admin_update on organizations for update using (banto_org_admin(id)) with check (banto_org_admin(id));
-- メンバーと割り当ては、自分の分と、組織の owner / admin が読める。書くのは下の関数だけ
create policy org_members_select on org_members for select using (user_id = auth.uid() or banto_org_admin(org_id));
create policy org_member_shops_select on org_member_shops for select using (user_id = auth.uid() or banto_org_admin(org_id));
create policy org_invitations_admin_select on org_invitations for select using (banto_org_admin(org_id));

-- shops: 全権は組織の owner / admin（作成・削除も）。member は割り当てたショップを読め、settings の項目があれば更新できる
drop policy if exists shops_owner on shops;
-- 行の列で判定する（banto_owns_shop は表を引き直すので、INSERT ... RETURNING の新しい行が見えない）
create policy shops_admin on shops for all
  using (case when org_id is null then owner_id = auth.uid() else banto_org_admin(org_id) end)
  with check (case when org_id is null then owner_id = auth.uid() else banto_org_admin(org_id) end);
create policy shops_member_select on shops for select
  using (exists (select 1 from org_member_shops ms where ms.shop_id = shops.id and ms.user_id = auth.uid() and ms.org_id = shops.org_id and cardinality(ms.perms) > 0));
create policy shops_member_update on shops for update using (banto_shop_perm(id, 'settings')) with check (banto_shop_perm(id, 'settings'));

-- 項目ごとの権限（既存の owner のポリシーに足す）
create policy products_catalog on products for all using (banto_shop_perm(shop_id, 'catalog')) with check (banto_shop_perm(shop_id, 'catalog'));
create policy skus_catalog on skus for all using (banto_shop_perm(shop_id, 'catalog')) with check (banto_shop_perm(shop_id, 'catalog'));
create policy images_catalog on product_images for all using (banto_shop_perm(shop_id, 'catalog')) with check (banto_shop_perm(shop_id, 'catalog'));
create policy categories_catalog on categories for all using (banto_shop_perm(shop_id, 'catalog')) with check (banto_shop_perm(shop_id, 'catalog'));
create policy inventory_catalog on inventory for select using (banto_shop_perm(shop_id, 'catalog'));
create policy orders_perm_select on orders for select using (banto_shop_perm(shop_id, 'orders'));
create policy orders_perm_update on orders for update using (banto_shop_perm(shop_id, 'orders')) with check (banto_shop_perm(shop_id, 'orders'));
create policy order_items_perm on order_items for select using (banto_shop_perm(shop_id, 'orders'));
create policy reservations_perm on reservations for select using (banto_shop_perm(shop_id, 'orders'));
create policy customers_perm_select on customers for select using (banto_shop_perm(shop_id, 'customers'));
create policy customers_perm_delete on customers for delete using (banto_shop_perm(shop_id, 'customers'));
create policy coupon_campaigns_marketing on coupon_campaigns for all using (banto_shop_perm(shop_id, 'marketing')) with check (banto_shop_perm(shop_id, 'marketing'));
create policy coupon_slots_marketing on coupon_slots for select using (banto_shop_perm(shop_id, 'marketing'));
create policy coupon_redemptions_marketing on coupon_redemptions for select using (banto_shop_perm(shop_id, 'marketing'));
create policy coupon_grants_marketing on coupon_grants for select using (banto_shop_perm(shop_id, 'marketing'));
create policy hook_endpoints_integrations on hook_endpoints for all using (banto_shop_perm(shop_id, 'integrations')) with check (banto_shop_perm(shop_id, 'integrations'));
create policy hook_deliveries_integrations on hook_deliveries for select using (banto_shop_perm(shop_id, 'integrations'));
drop policy if exists api_tokens_owner on api_tokens;
create policy api_tokens_integrations on api_tokens for all
  using (banto_shop_perm(shop_id, 'integrations')) with check (banto_shop_perm(shop_id, 'integrations') and owner_id = auth.uid());
create policy shop_oauth_clients_integrations on shop_oauth_clients for select using (banto_shop_perm(shop_id, 'integrations'));
create policy shop_secret_boxes_integrations on shop_secret_boxes for select using (banto_shop_perm(shop_id, 'integrations'));
-- アップデート・稼働の画面は組織の owner / admin にも
create policy migrations_org_admin_select on banto_migrations for select
  using (exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')));
create policy heartbeats_org_admin_select on banto_heartbeats for select
  using (exists (select 1 from org_members m where m.user_id = auth.uid() and m.role in ('owner', 'admin')));

-- ---------- メンバーの管理（組織の owner / admin） ----------
-- 規則: owner を作る・外す・owner の役割を変えるのは owner だけ。最後の owner は外せない・降格できない
create or replace function banto_org_guard(p_org_id uuid, p_target_role text, p_current_role text)
returns void language plpgsql stable security definer set search_path = public as $$
declare v_me text := banto_org_role(p_org_id);
begin
  if v_me is null or v_me not in ('owner', 'admin') then raise exception 'org_not_found' using errcode = '42501'; end if;
  if v_me <> 'owner' and ('owner' in (coalesce(p_target_role, ''), coalesce(p_current_role, ''))) then raise exception 'owner_only' using errcode = '42501'; end if;
end;
$$;

-- p_shops: [{ shop_id, perms: [...] }]（member のとき）。その組織のショップの、決まった項目だけ入れる
create or replace function banto_set_member_shops(p_org_id uuid, p_user_id uuid, p_shops jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_row jsonb;
begin
  delete from org_member_shops where org_id = p_org_id and user_id = p_user_id;
  for v_row in select e from jsonb_array_elements(coalesce(p_shops, '[]'::jsonb)) e loop
    if exists (select 1 from shops where id = nullif(v_row->>'shop_id', '')::uuid and org_id = p_org_id) then
      insert into org_member_shops (org_id, user_id, shop_id, perms)
      values (p_org_id, p_user_id, (v_row->>'shop_id')::uuid,
              coalesce((select array_agg(distinct p) from jsonb_array_elements_text(coalesce(v_row->'perms', '[]'::jsonb)) p where p = any(banto_shop_perms_all())), '{}'))
      on conflict (user_id, shop_id) do update set perms = excluded.perms;
    end if;
  end loop;
end;
$$;

create or replace function org_member_set(p_org_id uuid, p_user_id uuid, p_role text, p_shops jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  if p_role not in ('owner', 'admin', 'member') then raise exception 'invalid_role'; end if;
  select role into v_current from org_members where org_id = p_org_id and user_id = p_user_id for update;
  if not found then raise exception 'member_not_found'; end if;
  perform banto_org_guard(p_org_id, p_role, v_current);
  if v_current = 'owner' and p_role <> 'owner' and (select count(*) from org_members where org_id = p_org_id and role = 'owner') <= 1 then
    raise exception 'last_owner';
  end if;
  update org_members set role = p_role where org_id = p_org_id and user_id = p_user_id;
  perform banto_set_member_shops(p_org_id, p_user_id, case when p_role = 'member' then p_shops else '[]'::jsonb end);
end;
$$;

create or replace function org_member_remove(p_org_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  select role into v_current from org_members where org_id = p_org_id and user_id = p_user_id for update;
  if not found then raise exception 'member_not_found'; end if;
  perform banto_org_guard(p_org_id, null, v_current);
  if v_current = 'owner' and (select count(*) from org_members where org_id = p_org_id and role = 'owner') <= 1 then raise exception 'last_owner'; end if;
  delete from org_members where org_id = p_org_id and user_id = p_user_id;
end;
$$;

-- メンバーの一覧（メールアドレスは auth.users から。組織の owner / admin だけ）
create or replace function org_members_list(p_org_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not banto_org_admin(p_org_id) then raise exception 'org_not_found' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'created_at', m.created_at,
                                                       'shops', (select coalesce(jsonb_agg(jsonb_build_object('shop_id', ms.shop_id, 'perms', to_jsonb(ms.perms))), '[]'::jsonb)
                                                                   from org_member_shops ms where ms.org_id = m.org_id and ms.user_id = m.user_id))
                                    order by m.created_at), '[]'::jsonb)
            from org_members m join auth.users u on u.id = m.user_id where m.org_id = p_org_id);
end;
$$;

-- ---------- 招待 ----------
-- 同じ組織・同じメールアドレスの受け入れ前の招待は置き換える。
-- 戻り値: { id, mail_from }。mail_from は組織のショップのメール通知プラグインの送信元（無ければ null → 画面にリンクを出す）
create or replace function org_invite(p_org_id uuid, p_email text, p_role text, p_shops jsonb, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_from text;
begin
  if length(btrim(coalesce(p_email, ''))) > 254 or btrim(coalesce(p_email, '')) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if p_role not in ('owner', 'admin', 'member') then raise exception 'invalid_role'; end if;
  perform banto_org_guard(p_org_id, p_role, null);
  if exists (select 1 from org_members m join auth.users u on u.id = m.user_id where m.org_id = p_org_id and lower(u.email) = lower(btrim(p_email))) then
    raise exception 'already_member';
  end if;
  delete from org_invitations where org_id = p_org_id and lower(email) = lower(btrim(p_email)) and accepted_at is null;
  insert into org_invitations (org_id, email, role, shops, token_hash, expires_at, invited_by)
  values (p_org_id, lower(btrim(p_email)), p_role, case when p_role = 'member' then coalesce(p_shops, '[]'::jsonb) else '[]'::jsonb end,
          p_token_hash, now() + interval '7 days', auth.uid())
  returning id into v_id;
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e join shops s on s.id = e.shop_id
   where s.org_id = p_org_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend' and nullif(btrim(e.settings->>'from'), '') is not null
   order by s.created_at limit 1;
  return jsonb_build_object('id', v_id, 'mail_from', v_from);
end;
$$;

create or replace function org_invitation_revoke(p_org_id uuid, p_invitation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform banto_org_guard(p_org_id, (select role from org_invitations where id = p_invitation_id and org_id = p_org_id), null);
  delete from org_invitations where id = p_invitation_id and org_id = p_org_id and accepted_at is null;
end;
$$;

-- 招待のリンクを開いたときの確認（service_role。メールアドレス・組織の名前・有効か）
create or replace function org_invitation_peek(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'org_invitation_peek: service_role only' using errcode = '42501'; end if;
  return (select jsonb_build_object('email', i.email, 'org_name', o.name, 'role', i.role,
                                    'valid', i.accepted_at is null and i.expires_at > now(),
                                    'user_exists', exists (select 1 from auth.users u where lower(u.email) = i.email))
            from org_invitations i join organizations o on o.id = i.org_id where i.token_hash = p_token_hash);
end;
$$;

-- 受け入れ（招待された本人。JWT のメールアドレスが招待と同じであること）
create or replace function org_invitation_accept(p_token_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_i org_invitations%rowtype; v_email text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if auth.uid() is null then raise exception 'login_required' using errcode = '42501'; end if;
  select * into v_i from org_invitations where token_hash = p_token_hash for update;
  if not found or v_i.accepted_at is not null or v_i.expires_at <= now() then raise exception 'invitation_invalid'; end if;
  if v_i.email <> v_email then raise exception 'invitation_email_mismatch'; end if;
  insert into org_members (org_id, user_id, role) values (v_i.org_id, auth.uid(), v_i.role)
  on conflict (org_id, user_id) do nothing;
  if v_i.role = 'member' then perform banto_set_member_shops(v_i.org_id, auth.uid(), v_i.shops); end if;
  update org_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_i.id;
  return v_i.org_id;
end;
$$;

-- ---------- 権限を確かめている関数を項目で確かめる（中身は元のまま、判定だけ差し替え） ----------
-- enqueue_hook（0002 を差し替え）: 管理画面から送るのは order.shipped（orders）と product.updated（catalog）
create or replace function enqueue_hook(p_shop_id uuid, p_event text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' and not (banto_shop_perm(p_shop_id, 'orders') or banto_shop_perm(p_shop_id, 'catalog')) then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  if p_event is null or p_event !~ '^[a-z_]+\.[a-z_]+$' then
    raise exception 'invalid_event';
  end if;
  insert into hook_deliveries (shop_id, endpoint_id, event, payload)
  select e.shop_id, e.id, p_event, coalesce(p_payload, '{}'::jsonb)
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and p_event = any(e.events);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- coupon_grant_revoke（0019_coupon_grants.sql を差し替え: marketing）
create or replace function coupon_grant_revoke(p_shop_id uuid, p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  update coupon_grants set status = 'revoked' where id = p_grant_id and shop_id = p_shop_id and status = 'available';
  return found;
end;
$$;

-- coupon_grants_for_emails（0023_woo_history.sql を差し替え: marketing）
create or replace function coupon_grants_for_emails(p_shop_id uuid, p_campaign_id uuid, p_emails text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c coupon_campaigns%rowtype; v_email text; v_cid uuid; v_code text; v_expires timestamptz;
  v_out jsonb := '[]'::jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if coalesce(array_length(p_emails, 1), 0) > 5000 then raise exception 'too_many'; end if;
  select * into v_c from coupon_campaigns where id = p_campaign_id and shop_id = p_shop_id;
  if not found then raise exception 'campaign_not_found'; end if;
  v_expires := case when v_c.grant_valid_days is not null then now() + make_interval(days => v_c.grant_valid_days) end;
  if v_c.ends_at is not null and (v_expires is null or v_expires > v_c.ends_at) then v_expires := v_c.ends_at; end if;
  for v_email in select distinct lower(btrim(e)) from unnest(coalesce(p_emails, '{}'::text[])) e where position('@' in coalesce(e, '')) > 0 and position('*' in e) = 0 order by 1 loop
    select id into v_cid from customers where shop_id = p_shop_id and lower(email) = v_email limit 1;
    v_code := null;
    if v_cid is not null then
      select code into v_code from coupon_grants where campaign_id = v_c.id and customer_id = v_cid and status in ('available', 'held') limit 1;
    end if;
    if v_code is null then
      loop
        v_code := banto_grant_code();
        begin
          insert into coupon_grants (shop_id, campaign_id, code, customer_id, expires_at) values (p_shop_id, v_c.id, v_code, v_cid, v_expires);
          exit;
        exception when unique_violation then null;
        end;
      end loop;
    end if;
    v_out := v_out || jsonb_build_object('email', v_email, 'code', v_code, 'member', v_cid is not null);
  end loop;
  return v_out;
end;
$$;

-- coupon_grants_issue（0019_coupon_grants.sql を差し替え: marketing）
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
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'shop_not_found' using errcode = '42501'; end if;
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

-- coupon_stats（0010_coupons.sql を差し替え: marketing）
create or replace function coupon_stats(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when banto_shop_perm(p_shop_id, 'marketing') then coalesce((
    select jsonb_object_agg(campaign_id, jsonb_build_object('used', used, 'held', held))
      from (select campaign_id, count(*) filter (where status = 'used') as used, count(*) filter (where status = 'held') as held
              from coupon_redemptions where shop_id = p_shop_id group by campaign_id) x), '{}'::jsonb) end;
$$;

-- import_catalog（0009_catalog_import.sql を差し替え: catalog）
create or replace function import_catalog(p_shop_id uuid, p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_sku jsonb; v_cat_id uuid; v_parent uuid; v_pid uuid; v_kid uuid; v_existing uuid; v_avail integer;
  v_price integer; v_compare integer; v_gtin text; v_created boolean;
  v_n_cat integer := 0; v_p_new integer := 0; v_p_upd integer := 0; v_k_new integer := 0; v_k_upd integer := 0;
  l_p_new integer; l_k_new integer; l_k_upd integer;
  v_errors jsonb := '[]'::jsonb;
  v_overwrite boolean := coalesce((p_batch->>'overwrite_stock')::boolean, true);
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;

  -- カテゴリー（親が先）
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'categories', '[]'::jsonb)) loop
    v_parent := null;
    if coalesce(v_row->>'parent_slug', '') <> '' then
      select id into v_parent from categories where shop_id = p_shop_id and slug = v_row->>'parent_slug';
    end if;
    insert into categories (shop_id, slug, name, parent_id, sort_order)
    values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 100), v_parent, coalesce((v_row->>'sort_order')::integer, 0))
    on conflict (shop_id, slug) do update set name = excluded.name, parent_id = excluded.parent_id;
    v_n_cat := v_n_cat + 1;
  end loop;

  -- 商品と SKU
  for v_row in select * from jsonb_array_elements(coalesce(p_batch->'products', '[]'::jsonb)) loop
    begin
      l_p_new := 0; l_k_new := 0; l_k_upd := 0;
      v_cat_id := null;
      if coalesce(v_row->>'category_slug', '') <> '' then
        select id into v_cat_id from categories where shop_id = p_shop_id and slug = v_row->>'category_slug';
      end if;
      select id into v_pid from products where shop_id = p_shop_id and slug = v_row->>'slug';
      if v_pid is null then
        insert into products (shop_id, slug, name, description, published, tags, brand, attributes, category_id)
        values (p_shop_id, v_row->>'slug', left(btrim(v_row->>'name'), 200), nullif(btrim(coalesce(v_row->>'description', '')), ''),
                coalesce((v_row->>'published')::boolean, false), banto_normalize_tags(v_row->'tags'),
                nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''), banto_clean_object(v_row->'attributes', 200), v_cat_id)
        returning id into v_pid;
        l_p_new := 1;
      else
        -- カスタム項目は既存の値に上書きでマージする（取り込み元に無い項目を消さない）
        update products set
          name = left(btrim(v_row->>'name'), 200),
          description = nullif(btrim(coalesce(v_row->>'description', '')), ''),
          published = coalesce((v_row->>'published')::boolean, published),
          tags = banto_normalize_tags(v_row->'tags'),
          brand = nullif(left(btrim(coalesce(v_row->>'brand', '')), 100), ''),
          attributes = attributes || banto_clean_object(v_row->'attributes', 200),
          category_id = v_cat_id
        where id = v_pid;
      end if;

      for v_sku in select * from jsonb_array_elements(coalesce(v_row->'skus', '[]'::jsonb)) loop
        v_price := (v_sku->>'price_jpy')::integer;
        v_compare := (v_sku->>'compare_at_price_jpy')::integer;
        if v_compare is not null and v_compare <= v_price then v_compare := null; end if;
        v_gtin := nullif(btrim(coalesce(v_sku->>'gtin', '')), '');
        if v_gtin is not null and v_gtin !~ '^([0-9]{8}|[0-9]{12,14})$' then v_gtin := null; end if;
        select id, product_id into v_kid, v_existing from skus where shop_id = p_shop_id and code = v_sku->>'code';
        v_created := v_kid is null;
        if v_created then
          insert into skus (shop_id, product_id, code, name, price_jpy, compare_at_price_jpy, gtin, options)
          values (p_shop_id, v_pid, v_sku->>'code', nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), v_price, v_compare, v_gtin,
                  banto_clean_object(v_sku->'options', 5))
          returning id into v_kid;
          l_k_new := l_k_new + 1;
        else
          if v_existing <> v_pid then raise exception 'sku_belongs_to_other_product: %', v_sku->>'code'; end if;
          update skus set name = nullif(left(btrim(coalesce(v_sku->>'name', '')), 200), ''), price_jpy = v_price, compare_at_price_jpy = v_compare,
                          gtin = v_gtin, options = banto_clean_object(v_sku->'options', 5)
           where id = v_kid;
          l_k_upd := l_k_upd + 1;
        end if;
        -- 在庫（inventory 行は skus の insert でトリガーが作る）
        if v_sku ? 'available' and (v_created or v_overwrite) then
          v_avail := greatest(0, coalesce((v_sku->>'available')::integer, 0));
          update inventory set available = v_avail, updated_at = now() where sku_id = v_kid;
        end if;
      end loop;

      perform enqueue_hook(p_shop_id, 'product.updated', jsonb_build_object('product_id', v_pid, 'shop_id', p_shop_id, 'slug', v_row->>'slug'));
      -- 件数はこの商品が最後まで通ったときだけ数える（例外なら全部取り消されるため）
      v_p_new := v_p_new + l_p_new; v_p_upd := v_p_upd + (1 - l_p_new); v_k_new := v_k_new + l_k_new; v_k_upd := v_k_upd + l_k_upd;
    exception when others then
      -- この商品だけ取り消して続ける（plpgsql の例外ブロックはセーブポイントとして働く）
      v_errors := v_errors || jsonb_build_object('slug', v_row->>'slug', 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('categories', v_n_cat, 'products_created', v_p_new, 'products_updated', v_p_upd,
                            'skus_created', v_k_new, 'skus_updated', v_k_upd, 'errors', v_errors);
end;
$$;

-- import_coupon_usage（0023_woo_history.sql を差し替え: marketing）
create or replace function import_coupon_usage(p_shop_id uuid, p_code text, p_emails text[], p_reset boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_campaign uuid; v_email text; v_cid uuid; v_n integer := 0;
begin
  if not banto_shop_perm(p_shop_id, 'marketing') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if coalesce(array_length(p_emails, 1), 0) > 5000 then raise exception 'too_many'; end if;
  select id into v_campaign from coupon_campaigns where shop_id = p_shop_id and code = upper(btrim(p_code));
  if v_campaign is null then return jsonb_build_object('found', false, 'uses', 0); end if;
  if p_reset then delete from coupon_redemptions where campaign_id = v_campaign and reservation_id is null; end if;
  foreach v_email in array coalesce(p_emails, '{}'::text[]) loop
    if position('@' in coalesce(v_email, '')) = 0 then continue; end if;
    insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status) values (p_shop_id, v_campaign, null, banto_email_subject(v_email), 'used');
    select id into v_cid from customers where shop_id = p_shop_id and lower(email) = lower(btrim(v_email)) limit 1;
    if v_cid is not null then
      insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status) values (p_shop_id, v_campaign, null, 'c:' || v_cid::text, 'used');
    end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('found', true, 'uses', v_n);
end;
$$;

-- import_orders（0023_woo_history.sql を差し替え: orders）
create or replace function import_orders(p_shop_id uuid, p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_it jsonb; v_id uuid; v_num integer; v_ref text; v_status text; v_cid uuid; v_sku uuid; v_rate numeric;
  v_created integer := 0; v_existing integer := 0; v_items integer := 0; v_no_sku integer := 0; v_invalid integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_max integer;
begin
  if not banto_shop_perm(p_shop_id, 'orders') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) > 100 then raise exception 'invalid_orders'; end if;
  for v_row in select e from jsonb_array_elements(p_orders) e loop
    v_ref := left(btrim(coalesce(v_row->>'ref', '')), 100);
    v_status := v_row->>'status';
    if v_ref = '' or coalesce(v_row->>'number', '') !~ '^[0-9]{1,9}$' or v_status is null or v_status not in ('paid', 'shipped', 'cancelled', 'refunded')
       or coalesce(v_row->>'total_jpy', '') !~ '^[0-9]{1,9}$' or jsonb_typeof(v_row->'items') <> 'array' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if exists (select 1 from orders where shop_id = p_shop_id and external_ref = v_ref) then
      v_existing := v_existing + 1;
      continue;
    end if;
    v_num := (v_row->>'number')::integer;
    if exists (select 1 from orders where shop_id = p_shop_id and number = v_num) then
      if jsonb_array_length(v_conflicts) < 50 then v_conflicts := v_conflicts || to_jsonb(v_num); end if;
      continue;
    end if;
    v_cid := null;
    if nullif(btrim(coalesce(v_row->>'customer_email', '')), '') is not null then
      select id into v_cid from customers where shop_id = p_shop_id and lower(email) = lower(btrim(v_row->>'customer_email')) limit 1;
    end if;
    v_rate := case when coalesce(v_row->>'shipping_tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (v_row->>'shipping_tax_rate')::numeric end;
    insert into orders (shop_id, reservation_id, status, total_jpy, shipping_jpy, discount_jpy, amount_paid_jpy, number, customer_id,
                        customer_email, customer_name, shipping_address, payment_provider, payment_ref, shipped_at, shipping_tax_rate,
                        external_ref, created_at, updated_at)
    values (p_shop_id, null, v_status::order_status, (v_row->>'total_jpy')::integer, greatest(0, coalesce((v_row->>'shipping_jpy')::integer, 0)),
            greatest(0, coalesce((v_row->>'discount_jpy')::integer, 0)), (v_row->>'total_jpy')::integer, v_num, v_cid,
            nullif(lower(btrim(coalesce(v_row->>'customer_email', ''))), ''), left(nullif(btrim(coalesce(v_row->>'customer_name', '')), ''), 200),
            case when jsonb_typeof(v_row->'shipping_address') = 'object' then v_row->'shipping_address' end,
            'woocommerce', left(nullif(v_row->>'payment_ref', ''), 200),
            case when v_status = 'shipped' then coalesce((v_row->>'shipped_at')::timestamptz, (v_row->>'created_at')::timestamptz, now()) end,
            v_rate, v_ref, coalesce((v_row->>'created_at')::timestamptz, now()), coalesce((v_row->>'created_at')::timestamptz, now()))
    returning id into v_id;
    v_created := v_created + 1;
    for v_it in select e from jsonb_array_elements(v_row->'items') e loop
      if coalesce(v_it->>'qty', '') !~ '^[0-9]{1,6}$' or (v_it->>'qty')::integer <= 0 or coalesce(v_it->>'unit_price_jpy', '') !~ '^[0-9]{1,9}$' then continue; end if;
      v_sku := null;
      if nullif(btrim(coalesce(v_it->>'sku', '')), '') is not null then
        select id into v_sku from skus where shop_id = p_shop_id and code = btrim(v_it->>'sku');
      end if;
      if v_sku is null then v_no_sku := v_no_sku + 1; end if;
      insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy, discount_jpy, tax_rate, item_name, item_variant)
      values (p_shop_id, v_id, v_sku, (v_it->>'qty')::integer, (v_it->>'unit_price_jpy')::integer, greatest(0, coalesce((v_it->>'discount_jpy')::integer, 0)),
              case when coalesce(v_it->>'tax_rate', '') ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then (v_it->>'tax_rate')::numeric end,
              left(nullif(btrim(coalesce(v_it->>'name', '')), ''), 200), left(nullif(btrim(coalesce(v_it->>'variant', '')), ''), 200));
      v_items := v_items + 1;
    end loop;
  end loop;
  -- 新しい注文の番号は、取り込んだ番号の続きから
  select max(number) into v_max from orders where shop_id = p_shop_id;
  if v_max is not null then update shops set order_seq = greatest(order_seq, v_max) where id = p_shop_id; end if;
  return jsonb_build_object('created', v_created, 'existing', v_existing, 'invalid', v_invalid, 'items', v_items, 'items_without_sku', v_no_sku, 'conflicts', v_conflicts);
end;
$$;

-- import_tax_classes（0022_tracking.sql を差し替え: catalog）
create or replace function import_tax_classes(p_shop_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer; v_total integer := 0;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then raise exception 'invalid_items'; end if;
  for v_row in select e from jsonb_array_elements(p_items) e loop
    if v_row->>'tax_class' in ('standard', 'reduced', 'exempt') then
      update products set tax_class = v_row->>'tax_class', updated_at = now()
       where shop_id = p_shop_id and slug = v_row->>'slug' and tax_class is distinct from v_row->>'tax_class';
      get diagnostics v_n = row_count; v_total := v_total + v_n;
    end if;
  end loop;
  return v_total;
end;
$$;

-- mask_customer（0001_init.sql を差し替え: customers）
create or replace function mask_customer(p_shop_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then
    raise exception 'shop_not_found' using errcode = '42501';
  end if;
  update orders
     set customer_email = null, customer_name = '[masked]', shipping_address = null
   where shop_id = p_shop_id and lower(customer_email) = lower(p_email);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- member_set_email（0012_member_auth.sql を差し替え: customers）
create or replace function member_set_email(p_shop_id uuid, p_customer_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_old text;
begin
  if not banto_shop_perm(p_shop_id, 'customers') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  select email into v_old from customers where shop_id = p_shop_id and id = p_customer_id for update;
  if not found then raise exception 'customer_not_found'; end if;
  if exists (select 1 from customers where shop_id = p_shop_id and lower(email) = v_email and id <> p_customer_id) then
    raise exception 'email_taken';
  end if;
  update customers set email = v_email, session_epoch = session_epoch + 1 where shop_id = p_shop_id and id = p_customer_id;
  -- 未使用のチャレンジは前のアドレスのものも含めて無効にする
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email in (lower(coalesce(v_old, '')), v_email) and consumed_at is null;
  return jsonb_build_object('old_email', v_old, 'new_email', v_email);
end;
$$;

-- sales_summary（0003_api.sql を差し替え: reports）
create or replace function sales_summary(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text default 'day')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'reports') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return sales_summary_for_shop(p_shop_id, p_from, p_to, p_group_by);
end;
$$;

-- set_stock（0001_init.sql を差し替え: catalog）
create or replace function set_stock(p_sku_id uuid, p_available integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
begin
  if p_available is null or p_available < 0 then
    raise exception 'invalid_available';
  end if;
  select shop_id into v_shop_id from skus where id = p_sku_id;
  if not found or not banto_shop_perm(v_shop_id, 'catalog') then
    raise exception 'sku_not_found' using errcode = '42501';
  end if;
  update inventory set available = p_available, updated_at = now() where sku_id = p_sku_id;
  return p_available;
end;
$$;

-- ship_orders（0022_tracking.sql を差し替え: orders）
create or replace function ship_orders(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb; v_o orders%rowtype; v_num text; v_carrier text; v_tracking text;
  v_shipped integer := 0; v_updated integer := 0; v_invalid integer := 0;
  v_missing jsonb := '[]'::jsonb;
begin
  if not banto_shop_perm(p_shop_id, 'orders') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'invalid_items'; end if;
  for v_row in select e from jsonb_array_elements(p_items) e loop
    v_num := btrim(coalesce(v_row->>'number', ''));
    v_carrier := v_row->>'carrier';
    v_tracking := regexp_replace(coalesce(v_row->>'tracking', ''), '[\s-]', '', 'g');
    if v_num !~ '^[0-9]{1,9}$' or v_carrier is null or v_carrier not in ('yamato', 'sagawa', 'japanpost', 'other') or v_tracking !~ '^[0-9A-Za-z]{4,40}$' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    select * into v_o from orders where shop_id = p_shop_id and number = v_num::integer and status in ('paid', 'shipped') for update;
    if not found then
      if jsonb_array_length(v_missing) < 50 then v_missing := v_missing || to_jsonb(v_num::integer); end if;
      continue;
    end if;
    if v_o.status = 'paid' then
      update orders set status = 'shipped', shipped_at = now(), tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now()
       where id = v_o.id returning * into v_o;
      perform enqueue_hook(p_shop_id, 'order.shipped',
        jsonb_build_object('order_id', v_o.id, 'order_number', v_o.number, 'shop_id', p_shop_id, 'total_jpy', v_o.total_jpy, 'status', v_o.status,
                           'shipped_at', v_o.shipped_at, 'customer_id', v_o.customer_id));
      v_shipped := v_shipped + 1;
    else
      update orders set tracking_carrier = v_carrier, tracking_number = v_tracking, updated_at = now() where id = v_o.id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('shipped', v_shipped, 'updated', v_updated, 'invalid', v_invalid, 'missing', v_missing);
end;
$$;

-- shop_oauth_client_delete（0014_member_oauth.sql を差し替え: integrations）
create or replace function shop_oauth_client_delete(p_shop_id uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'integrations') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  delete from shop_oauth_clients where shop_id = p_shop_id and provider = p_provider;
  update shops set settings = settings #- array['oauth', p_provider] where id = p_shop_id;
end;
$$;

-- shop_oauth_client_save（0014_member_oauth.sql を差し替え: integrations）
create or replace function shop_oauth_client_save(p_shop_id uuid, p_provider text, p_client_id text, p_secret_box text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'integrations') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if p_provider not in ('line', 'google') then raise exception 'invalid_provider'; end if;
  if p_client_id is null or length(btrim(p_client_id)) not between 1 and 200 or btrim(p_client_id) ~ '\s' then raise exception 'invalid_client_id'; end if;
  if p_secret_box is null then
    -- client_id だけ変える（シークレットは今のまま）
    update shop_oauth_clients set client_id = btrim(p_client_id), updated_at = now() where shop_id = p_shop_id and provider = p_provider;
    if not found then raise exception 'secret_required'; end if;
  else
    insert into shop_oauth_clients (shop_id, provider, client_id, secret_box) values (p_shop_id, p_provider, btrim(p_client_id), p_secret_box)
    on conflict (shop_id, provider) do update set client_id = excluded.client_id, secret_box = excluded.secret_box, updated_at = now();
  end if;
  update shops
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{oauth}',
                              coalesce(settings->'oauth', '{}'::jsonb) || jsonb_build_object(p_provider, jsonb_build_object('client_id', btrim(p_client_id))), true)
   where id = p_shop_id;
end;
$$;

-- shop_secret_save（0021_line_messaging.sql を差し替え: integrations）
create or replace function shop_secret_save(p_shop_id uuid, p_purpose text, p_secret_box text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'integrations') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if p_purpose not in ('line_messaging') then raise exception 'invalid_purpose'; end if;
  if p_secret_box is null then
    delete from shop_secret_boxes where shop_id = p_shop_id and purpose = p_purpose;
    return true;
  end if;
  insert into shop_secret_boxes (shop_id, purpose, secret_box) values (p_shop_id, p_purpose, p_secret_box)
  on conflict (shop_id, purpose) do update set secret_box = excluded.secret_box, updated_at = now();
  return true;
end;
$$;
-- ---------- 実行権限 ----------
revoke execute on function banto_shop_perms_all() from public;
grant execute on function banto_shop_perms_all() to anon, authenticated, service_role;
grant execute on function banto_org_role(uuid) to anon, authenticated, service_role;
grant execute on function banto_org_admin(uuid) to anon, authenticated, service_role;
grant execute on function banto_shop_perm(uuid, text) to anon, authenticated, service_role;
revoke execute on function banto_admin_shop(uuid) from public, anon;
grant execute on function banto_admin_shop(uuid) to authenticated;
revoke execute on function banto_my_shops() from public, anon;
grant execute on function banto_my_shops() to authenticated;
revoke execute on function banto_owner_org() from public, anon, authenticated;
revoke execute on function banto_shops_guard() from public, anon, authenticated;
revoke execute on function banto_org_guard(uuid, text, text) from public, anon, authenticated;
revoke execute on function banto_set_member_shops(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function org_member_set(uuid, uuid, text, jsonb) from public, anon;
grant execute on function org_member_set(uuid, uuid, text, jsonb) to authenticated;
revoke execute on function org_member_remove(uuid, uuid) from public, anon;
grant execute on function org_member_remove(uuid, uuid) to authenticated;
revoke execute on function org_members_list(uuid) from public, anon;
grant execute on function org_members_list(uuid) to authenticated;
revoke execute on function org_invite(uuid, text, text, jsonb, text) from public, anon;
grant execute on function org_invite(uuid, text, text, jsonb, text) to authenticated;
revoke execute on function org_invitation_revoke(uuid, uuid) from public, anon;
grant execute on function org_invitation_revoke(uuid, uuid) to authenticated;
revoke execute on function org_invitation_peek(text) from public, anon, authenticated;
grant execute on function org_invitation_peek(text) to service_role;
revoke execute on function org_invitation_accept(text) from public, anon;
grant execute on function org_invitation_accept(text) to authenticated;

insert into banto_migrations (version) values ('0024_organizations');
