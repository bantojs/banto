-- 0177: LINE のテスト送信の宛先を、会員のメールアドレスで指定する（メンテナの決定 2026-11-25、docs/line.md §2）
-- テスト用の LINE アカウントで一度ショップに LINE でログインして会員になっておけば、その会員のメールアドレスで宛先を選べる。
--   - LINE の利用者 ID（UID）は Worker の中だけで使い、画面・API には出さない（「LINE の利用者 ID は外へ出さない」）
--   - service_role だけ。Worker が管理画面の項目（integrations・settings・customers）を確かめてから呼ぶ
--   - 宛先に会員を選んだことを監査ログ line.test_recipient に残す（送れたかどうかは問わない）（会員の id だけ、メール・UID は入れない）。誰がは X-Banto-Actor（banto_audit_actor）
--   - 本物のお客様にも送れてしまうので、画面に注意を書く

create or replace function line_test_recipient(p_shop_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_customer uuid; v_uid text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'line_test_recipient: service_role only' using errcode = '42501';
  end if;
  if p_email is null or length(btrim(p_email)) not between 3 and 320 then return null; end if;
  select c.id, i.subject into v_customer, v_uid
    from customers c join member_identities i on i.shop_id = c.shop_id and i.customer_id = c.id and i.provider = 'line'
   where c.shop_id = p_shop_id and c.email is not null and lower(c.email) = lower(btrim(p_email))
   limit 1;
  if v_uid is null then return null; end if;
  perform banto_audit(banto_shop_org(p_shop_id), p_shop_id, 'line.test_recipient', 'customer', v_customer::text, '{}'::jsonb);
  return jsonb_build_object('line_user_id', v_uid, 'customer_id', v_customer);
end;
$$;
revoke execute on function line_test_recipient(uuid, text) from public, anon, authenticated;
grant execute on function line_test_recipient(uuid, text) to service_role;

insert into banto_migrations (version) values ('0177_line_test_member');
