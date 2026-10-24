-- 0021_line_messaging: ショップごとの LINE 公式アカウント（Messaging API）で、購入者に注文を知らせる（docs/line.md）
--
-- shop_secret_boxes … ショップごとの外部サービスの秘密の暗号文（今は purpose = 'line_messaging' のチャネルアクセストークンだけ）。
--   CLAUDE.md §1-5 の例外を広げる（人間の決定 2026-10-17）: Worker がサイトの秘密から作った鍵で AES-GCM で暗号化し、
--   暗号文だけを置く（src/members/secret-box.ts、追加認証データはショップと用途）。運営者にも暗号文の列は読ませない。
-- 送り先は LINE でログインした会員の LINE の利用者 ID（member_identities、0014）。LINE ログインのチャネルと
-- Messaging API のチャネルが同じ「プロバイダー」なら、利用者 ID は同じになる。

create table shop_secret_boxes (
  shop_id uuid not null references shops(id) on delete cascade,
  purpose text not null check (purpose in ('line_messaging')),
  secret_box text not null check (secret_box ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  updated_at timestamptz not null default now(),
  primary key (shop_id, purpose)
);
alter table shop_secret_boxes enable row level security;
create policy shop_secret_boxes_owner_select on shop_secret_boxes for select using (banto_owns_shop(shop_id));
-- 運営者は「設定済みか」だけ読める（暗号文の列は読めない）
revoke all on shop_secret_boxes from anon, authenticated;
grant select (shop_id, purpose, updated_at) on shop_secret_boxes to authenticated;

-- 保存・削除（owner）。p_secret_box が null なら消す
create or replace function shop_secret_save(p_shop_id uuid, p_purpose text, p_secret_box text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
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

-- 暗号文を読む（service_role。同梱プラグインが送るときだけ）
create or replace function shop_secret(p_shop_id uuid, p_purpose text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'shop_secret: service_role only' using errcode = '42501';
  end if;
  return (select secret_box from shop_secret_boxes where shop_id = p_shop_id and purpose = p_purpose);
end;
$$;

-- 注文を LINE で知らせる相手（service_role）。会員の注文で、その会員が LINE と結びついているときだけ。
-- 返すのは LINE の利用者 ID と、知らせる文に要る値（注文番号・合計・ショップ名）だけ（住所・氏名は返さない）
create or replace function order_line_recipient(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_line_recipient: service_role only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('line_user_id', i.subject, 'number', o.number, 'total_jpy', o.total_jpy, 'shop_name', s.name, 'status', o.status)
      from orders o join shops s on s.id = o.shop_id
      join member_identities i on i.shop_id = o.shop_id and i.customer_id = o.customer_id and i.provider = 'line'
     where o.id = p_order_id and o.shop_id = p_shop_id and o.customer_id is not null
     limit 1);
end;
$$;

revoke execute on function shop_secret_save(uuid, text, text) from public, anon;
grant execute on function shop_secret_save(uuid, text, text) to authenticated;
revoke execute on function shop_secret(uuid, text) from public, anon, authenticated;
grant execute on function shop_secret(uuid, text) to service_role;
revoke execute on function order_line_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function order_line_recipient(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0021_line_messaging');
