-- Banto 0064_inquiry_api_attachments: AI 用 API（/api/v1）でお問い合わせの添付を扱う（人間の決定 2026-10-27）。前方専用。
--   - 返事に添付する: api_inquiry_reply に p_attachments（管理画面の inquiry_reply と同じ形・同じ上限。banto_inquiry_attach が確かめる）
--   - お客様の添付を受け取る: api_inquiry_attachment_get。inquiries:read に加えて orders:pii が要る
--     （添付は写真・書類で、連絡先と同じく個人情報を含みうる。0061 でファイル名を orders:pii のときだけ返すのと同じ線）
--   - 実体は Worker が公開しない置き場（privateStorage）に置き・配る。ここは行と権限だけ

drop function if exists api_inquiry_reply(text, integer, text, text);
create or replace function api_inquiry_reply(p_token_hash text, p_number integer, p_body text, p_link_hash text, p_attachments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_i inquiries%rowtype; v_body text := left(btrim(coalesce(p_body, '')), 5000); v_send boolean := false; v_s shops%rowtype; v_msg uuid;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:write');
  select * into v_i from inquiries where shop_id = v_tok.shop_id and number = p_number for update;
  if not found then raise exception 'not_found'; end if;
  if v_i.masked_at is not null then raise exception 'inquiry_masked'; end if;
  if length(v_body) = 0 then raise exception 'invalid_body'; end if;
  if coalesce(p_link_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_link'; end if;
  insert into inquiry_messages (shop_id, inquiry_id, author, body) values (v_i.shop_id, v_i.id, 'shop', v_body) returning id into v_msg;
  perform banto_inquiry_attach(v_i.shop_id, v_i.id, v_msg, p_attachments);
  update inquiries set status = 'waiting_customer', last_message_at = now(), updated_at = now(), closed_at = null where id = v_i.id;
  insert into inquiry_links (shop_id, inquiry_id, token_hash, expires_at) values (v_i.shop_id, v_i.id, p_link_hash, now() + interval '30 days');
  if v_i.contact_email is not null then v_send := banto_inquiry_issue_mail(v_i.shop_id, v_i.id, 'reply', v_i.contact_email); end if;
  perform banto_enqueue_inquiry_hook(v_i.shop_id, 'inquiry.updated',
    jsonb_build_object('inquiry_id', v_i.id, 'number', v_i.number, 'shop_id', v_i.shop_id, 'status', 'waiting_customer', 'change', 'message', 'author', 'shop'));
  select * into v_i from inquiries where id = v_i.id;
  select * into v_s from shops where id = v_i.shop_id;
  return jsonb_build_object(
    'inquiry', api_inquiry_json(v_i, 'orders:pii' = any(v_tok.scopes), true),
    'mail', jsonb_build_object('send', v_send, 'to', case when v_send then v_i.contact_email end, 'mail_from', banto_inquiry_mail_from(v_i.shop_id),
                               'return_to', v_i.return_to,
                               'shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                                                          'settings', jsonb_build_object('theme_settings', v_s.settings->'theme_settings', 'headless', v_s.settings->'headless'))));
end;
$$;
revoke execute on function api_inquiry_reply(text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function api_inquiry_reply(text, integer, text, text, jsonb) to service_role;

-- 添付を受け取る（そのショップの、その受付番号のチケットの添付だけ）。戻り値: { storage_key, content_type, filename, size }
create or replace function api_inquiry_attachment_get(p_token_hash text, p_number integer, p_attachment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_r jsonb;
begin
  v_tok := banto_api_inquiries_require(p_token_hash, 'inquiries:read');
  if not ('orders:pii' = any(v_tok.scopes)) then raise exception 'pii_scope_required'; end if;
  select jsonb_build_object('storage_key', a.storage_key, 'content_type', a.content_type, 'filename', a.filename, 'size', a.size) into v_r
    from inquiry_attachments a join inquiries i on i.id = a.inquiry_id
   where a.id = p_attachment_id and i.shop_id = v_tok.shop_id and i.number = p_number;
  if v_r is null then raise exception 'not_found'; end if;
  return v_r;
end;
$$;
revoke execute on function api_inquiry_attachment_get(text, integer, uuid) from public, anon, authenticated;
grant execute on function api_inquiry_attachment_get(text, integer, uuid) to service_role;

insert into banto_migrations (version) values ('0064_inquiry_api_attachments');
