-- 0178: LINE のテスト送信の宛先を、会員の id で選ぶ（メンテナの決定 2026-11-25、docs/line.md §2）
-- LINE でログインした会員には、LINE がメールアドレスを渡さずアドレスの無い会員がいる。0177（メールアドレスで選ぶ）では選べないので、
-- 管理画面の会員の詳細から「この会員に LINE のテスト送信」で会員の id で選べるようにする。
--   - 中身は 0177 と同じ: service_role だけ・LINE と結びついた会員だけ・UID は Worker の中だけ・監査ログ line.test_recipient（会員の id だけ）
--   - Worker が管理画面の項目（integrations・settings・customers）を確かめてから呼ぶ

create or replace function line_test_recipient_member(p_shop_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_uid text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'line_test_recipient_member: service_role only' using errcode = '42501';
  end if;
  select i.subject into v_uid
    from member_identities i
   where i.shop_id = p_shop_id and i.customer_id = p_customer_id and i.provider = 'line'
   limit 1;
  if v_uid is null then return null; end if;
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'line.test_recipient', 'customer', p_customer_id::text, '{}'::jsonb);
  return jsonb_build_object('line_user_id', v_uid, 'customer_id', p_customer_id);
end;
$$;
revoke execute on function line_test_recipient_member(uuid, uuid) from public, anon, authenticated;
grant execute on function line_test_recipient_member(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0178_line_test_member_id');
