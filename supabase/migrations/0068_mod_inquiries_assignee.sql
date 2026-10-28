-- Banto 0068_mod_inquiries_assignee: お問い合わせの担当者（同梱モジュール inquiries、人間の決定 2026-10-28）。前方専用。
--   - 担当者にできるのは、そのショップの support の項目を持つ人（組織の owner / admin、組織の無いショップは owner）。判定は banto_user_shop_perm
--   - 割り当ては運営者（support の項目）と AI 用トークン（inquiries:write）。担当になった本人に、チケットへのリンクだけのメールで知らせる
--     （本文は載せない。自分で自分に割り当てたときは送らない）。メールの回数は banto_inquiry_issue_mail の上限に入る（kind = 'assign'）
--   - 未割り当てのチケットに運営者が最初に返事をしたら、その人を担当にする（inquiry_messages のトリガー。AI 用トークンの返事は人ではないので当てない）
--   - 担当者が support の項目を失っても、割り当ては残す（画面で付け替える）。運営者のアカウントが消えたら外れる（on delete set null）
--   - お客様には担当者を見せない。hooks の inquiry.updated は change = 'assignee'（担当者の id もアドレスも載せない）
--   - バックアップの復元では担当者を戻さない（運営者のアカウントはデプロイごとに違うため）

alter table inquiries add column if not exists assignee_id uuid references auth.users(id) on delete set null;
create index if not exists inquiries_assignee on inquiries(shop_id, assignee_id, last_message_at desc) where assignee_id is not null;

alter table inquiry_mails drop constraint if exists inquiry_mails_kind_check;
alter table inquiry_mails add constraint inquiry_mails_kind_check check (kind in ('verify', 'created', 'reply', 'link', 'shop', 'assign'));

-- 担当者にできる人（そのショップの support の項目を持つ人）。運営者の画面と AI 用 API の選択肢
create or replace function banto_inquiry_assignees(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'email', u.email) order by lower(u.email)), '[]'::jsonb)
    from auth.users u
   where u.id in (
           select s.owner_id from shops s where s.id = p_shop_id and s.org_id is null
           union
           select m.user_id from shops s join org_members m on m.org_id = s.org_id where s.id = p_shop_id and m.role in ('owner', 'admin')
           union
           select ms.user_id from shops s join org_member_shops ms on ms.org_id = s.org_id and ms.shop_id = s.id where s.id = p_shop_id and 'support' = any(ms.perms))
     and banto_user_shop_perm(u.id, p_shop_id, 'support');
$$;
revoke execute on function banto_inquiry_assignees(uuid) from public, anon, authenticated, service_role;

-- 担当者を決める・外す（共通）。戻り値: { inquiry_id, number, send, to, mail_from }。to は担当になった人のアドレス（知らせるときだけ）
create or replace function banto_inquiry_assign(p_inquiry inquiries, p_user uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_send boolean := false; v_to text;
begin
  if p_user is not null and not banto_user_shop_perm(p_user, p_inquiry.shop_id, 'support') then raise exception 'invalid_assignee'; end if;
  if p_inquiry.assignee_id is not distinct from p_user then
    return jsonb_build_object('inquiry_id', p_inquiry.id, 'number', p_inquiry.number, 'send', false, 'to', null, 'mail_from', null);
  end if;
  update inquiries set assignee_id = p_user, updated_at = now() where id = p_inquiry.id;
  perform banto_enqueue_inquiry_hook(p_inquiry.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', p_inquiry.id, 'number', p_inquiry.number, 'shop_id', p_inquiry.shop_id, 'status', p_inquiry.status, 'change', 'assignee'));
  if p_user is not null and p_user is distinct from p_actor then
    select email into v_to from auth.users where id = p_user;
    if v_to is not null then v_send := banto_inquiry_issue_mail(p_inquiry.shop_id, p_inquiry.id, 'assign', v_to); end if;
  end if;
  return jsonb_build_object('inquiry_id', p_inquiry.id, 'number', p_inquiry.number, 'send', v_send, 'to', case when v_send then v_to end, 'mail_from', banto_inquiry_mail_from(p_inquiry.shop_id));
end;
$$;
revoke execute on function banto_inquiry_assign(inquiries, uuid, uuid) from public, anon, authenticated, service_role;

-- ---------- 運営者（authenticated、support の項目） ----------
create or replace function inquiry_assignees(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not banto_shop_perm(p_shop_id, 'support') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return banto_inquiry_assignees(p_shop_id);
end;
$$;
revoke execute on function inquiry_assignees(uuid) from public, anon;
grant execute on function inquiry_assignees(uuid) to authenticated;

create or replace function inquiry_assign(p_inquiry_id uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i inquiries%rowtype;
begin
  select * into v_i from inquiries where id = p_inquiry_id for update;
  if not found or not banto_shop_perm(v_i.shop_id, 'support') then raise exception 'inquiry_not_found' using errcode = '42501'; end if;
  return banto_inquiry_assign(v_i, p_user, auth.uid());
end;
$$;
revoke execute on function inquiry_assign(uuid, uuid) from public, anon;
grant execute on function inquiry_assign(uuid, uuid) to authenticated;

-- 1 件（0061 を差し替え: assignee_id を足す）
create or replace function inquiry_admin_get(p_inquiry_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_i inquiries%rowtype;
begin
  select * into v_i from inquiries where id = p_inquiry_id;
  if not found or not banto_shop_perm(v_i.shop_id, 'support') then return null; end if;
  return jsonb_build_object(
    'id', v_i.id, 'shop_id', v_i.shop_id, 'number', v_i.number, 'status', v_i.status, 'category', v_i.category, 'origin', v_i.origin,
    'contact_email', v_i.contact_email, 'contact_name', v_i.contact_name, 'verified', v_i.email_verified_at is not null,
    'customer_id', v_i.customer_id, 'claimed_order_number', v_i.claimed_order_number, 'created_at', v_i.created_at, 'closed_at', v_i.closed_at,
    'masked', v_i.masked_at is not null, 'assignee_id', v_i.assignee_id,
    'member_match', v_i.customer_id is null and v_i.contact_email is not null
                    and exists (select 1 from customers c where c.shop_id = v_i.shop_id and lower(c.email) = lower(v_i.contact_email)),
    'order', case when v_i.order_id is not null then banto_inquiry_order_summary(v_i.order_id) || jsonb_build_object('order_id', v_i.order_id) end,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at,
                                                               'attachments', banto_inquiry_message_attachments(m.id, true)) order by m.created_at, m.id)
                            from inquiry_messages m where m.inquiry_id = v_i.id), '[]'::jsonb));
end;
$$;

-- 未割り当てのチケットに運営者が最初に返事をしたら、その人を担当にする（知らせない。自分の返事なので）
create or replace function banto_inquiry_assign_on_reply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.author = 'shop' and new.author_user is not null then
    update inquiries i set assignee_id = new.author_user
     where i.id = new.inquiry_id and i.assignee_id is null and banto_user_shop_perm(new.author_user, i.shop_id, 'support');
  end if;
  return new;
end;
$$;
revoke execute on function banto_inquiry_assign_on_reply() from public, anon, authenticated, service_role;
drop trigger if exists inquiry_messages_assign_on_reply on inquiry_messages;
create trigger inquiry_messages_assign_on_reply after insert on inquiry_messages for each row execute function banto_inquiry_assign_on_reply();

-- ---------- AI 用トークン（inquiries:read / inquiries:write） ----------
-- 0061 を差し替え: assignee（{ user_id, email }、未割り当ては null）を足す
create or replace function api_inquiry_json(p_i inquiries, p_pii boolean, p_messages boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'number', p_i.number, 'status', p_i.status, 'category', p_i.category, 'origin', p_i.origin, 'verified', p_i.email_verified_at is not null,
    'customer_id', p_i.customer_id, 'claimed_order_number', p_i.claimed_order_number, 'masked', p_i.masked_at is not null,
    'order', (select jsonb_build_object('number', o.number, 'status', o.status, 'total_jpy', o.total_jpy, 'created_at', o.created_at) from orders o where o.id = p_i.order_id),
    'assignee', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_i.assignee_id),
    'created_at', p_i.created_at, 'last_message_at', p_i.last_message_at, 'closed_at', p_i.closed_at)
  || case when p_messages then jsonb_build_object('messages', coalesce((
          select jsonb_agg(jsonb_build_object('author', m.author, 'body', m.body, 'created_at', m.created_at,
                                              'attachments', banto_inquiry_message_attachments(m.id, p_pii)) order by m.created_at, m.id)
            from inquiry_messages m where m.inquiry_id = p_i.id), '[]'::jsonb)) else '{}'::jsonb end
  || case when p_pii then jsonb_build_object('contact', jsonb_build_object('email', p_i.contact_email, 'name', p_i.contact_name)) else '{}'::jsonb end;
$$;
revoke execute on function api_inquiry_json(inquiries, boolean, boolean) from public, anon, authenticated, service_role;

-- 一覧（0061 を差し替え: p_assignee = 'none'（未割り当て）か担当者の user_id で絞る）
drop function if exists api_inquiries_list(text, text, integer, integer);
create or replace function api_inquiries_list(p_token_hash text, p_status text default null, p_limit integer default 50, p_offset integer default 0, p_assignee text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_pii boolean; v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_offset integer := greatest(0, coalesce(p_offset, 0));
        v_total integer; v_items jsonb; v_none boolean := p_assignee = 'none'; v_user uuid;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  v_pii := 'orders:pii' = any(v_tok.scopes);
  if p_status is not null and p_status not in ('waiting_shop', 'waiting_customer', 'closed') then raise exception 'invalid_status'; end if;
  if p_assignee is not null and not v_none then
    if p_assignee !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_assignee'; end if;
    v_user := p_assignee::uuid;
  end if;
  select count(*) into v_total from inquiries i
   where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status)
     and (not v_none or i.assignee_id is null) and (v_user is null or i.assignee_id = v_user);
  select coalesce(jsonb_agg(api_inquiry_json(i, v_pii, false) order by i.last_message_at desc), '[]'::jsonb) into v_items
    from (select * from inquiries i
           where i.shop_id = v_tok.shop_id and (p_status is null or i.status = p_status)
             and (not v_none or i.assignee_id is null) and (v_user is null or i.assignee_id = v_user)
           order by i.last_message_at desc limit v_limit offset v_offset) i;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'pii', v_pii);
end;
$$;
revoke execute on function api_inquiries_list(text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function api_inquiries_list(text, text, integer, integer, text) to service_role;

-- 担当者にできる人（user_id と運営者のメールアドレス。お客様の連絡先ではない）
create or replace function api_inquiry_assignees(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  return banto_inquiry_assignees(v_tok.shop_id);
end;
$$;
revoke execute on function api_inquiry_assignees(text) from public, anon, authenticated;
grant execute on function api_inquiry_assignees(text) to service_role;

-- 担当者を決める・外す（p_user = null で外す）。戻り値: { inquiry, mail: { send, to, mail_from, shop } }（mail は Worker の中だけで使い、AI には返さない）
create or replace function api_inquiry_assign(p_token_hash text, p_number integer, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype; v_r jsonb; v_s shops%rowtype;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  v_r := banto_inquiry_assign(v_i, p_user, null);
  select * into v_i from inquiries where id = v_i.id;
  select * into v_s from shops where id = v_i.shop_id;
  return jsonb_build_object(
    'inquiry', api_inquiry_json(v_i, 'orders:pii' = any(v_tok.scopes), false),
    'mail', v_r || jsonb_build_object('shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                                                                 'settings', jsonb_build_object('theme_settings', v_s.settings->'theme_settings'))));
end;
$$;
revoke execute on function api_inquiry_assign(text, integer, uuid) from public, anon, authenticated;
grant execute on function api_inquiry_assign(text, integer, uuid) to service_role;

insert into banto_migrations (version) values ('0068_mod_inquiries_assignee');
