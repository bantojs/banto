-- 0016_member_notice: パスワードでのログインを会員に知らせる（docs/knowledge/10-members-identity.md §16）
--
-- member_password_login（0013）を差し替え、成功したときに知らせのメールの送信元（メール通知プラグインの「送信元」）も返す。
-- メールを送るのは Worker（src/members/notice.ts）。この端末で前にログインしたことがあれば送らない（署名付きの Cookie で覚える）。
-- 0016 を適用する前は mail_from が返らないので、知らせは送らない（ログインはそのまま動く）。

create or replace function member_password_login(p_shop_id uuid, p_email text, p_password text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_c customers%rowtype;
  v_ok boolean := false;
  v_found boolean;
  v_from text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_password_login: service_role only' using errcode = '42501';
  end if;
  if not exists (select 1 from shops where id = p_shop_id
                  and coalesce(settings->>'members_enabled', 'false') = 'true'
                  and coalesce(settings->>'members_password', 'false') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if p_password is null or length(p_password) = 0 or length(p_password) > 200 or length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member_password|' || p_shop_id::text || '|' || v_email, 0));
  if (select count(*) from member_login_failures where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5
     or (p_ip_hash is not null and (select count(*) from member_login_failures where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30) then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  select * into v_c from customers where shop_id = p_shop_id and lower(email) = v_email for update;
  v_found := found;
  if v_found and v_c.password_hash is not null then
    v_ok := crypt(p_password, v_c.password_hash) = v_c.password_hash;
  elsif v_found and v_c.legacy_password_hash is not null and (v_c.legacy_password_expires_at is null or v_c.legacy_password_expires_at > now()) then
    -- WordPress は保存するときに前後の空白を落としている
    v_ok := banto_wp_password_matches(p_password, v_c.legacy_password_hash)
            or (btrim(p_password) <> p_password and banto_wp_password_matches(btrim(p_password), v_c.legacy_password_hash));
    if v_ok then
      update customers set password_hash = crypt(p_password, gen_salt('bf', 10)), password_updated_at = now(),
                           legacy_password_hash = null, legacy_password_expires_at = null
       where shop_id = p_shop_id and id = v_c.id;
    end if;
  else
    -- 会員がいない・パスワードが無いときも同じくらいの時間をかける（応答の時間で登録の有無が分からないように）
    perform crypt(p_password, '$2a$10$' || repeat('a', 53));
  end if;
  if not v_ok then
    insert into member_login_failures (shop_id, email, ip_hash) values (p_shop_id, v_email, p_ip_hash);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update customers set last_login_at = now() where shop_id = p_shop_id and id = v_c.id;
  -- 知らせのメールの送信元（メール通知プラグインの設定。無ければ null = 送らない）
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  return jsonb_build_object('ok', true, 'customer_id', v_c.id, 'session_epoch', v_c.session_epoch, 'email', v_c.email, 'mail_from', v_from);
end;
$$;

revoke execute on function member_password_login(uuid, text, text, text) from public, anon, authenticated;
grant execute on function member_password_login(uuid, text, text, text) to service_role;

insert into banto_migrations (version) values ('0016_member_notice');
