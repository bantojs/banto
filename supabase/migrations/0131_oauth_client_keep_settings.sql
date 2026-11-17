-- 0131_oauth_client_keep_settings: ショップごとのログインの提供元を保存し直しても、ほかの設定を消さない
--
-- shop_oauth_client_save（0024）は settings.oauth.<provider> を { client_id } だけで置き換えていたため、
-- LINE の友だち追加の設定（settings.oauth.line.bot_prompt、0021）が消えていた。管理画面は保存のあとに書き戻していたが、
-- shops の行の更新は RLS（0024 の shops_member_update）が settings の項目を求めるので、integrations の項目だけの member が
-- チャネルを保存し直すと、黙って既定に戻っていた。client_id だけを書き換え、ほかの鍵は残す。権限の確かめは 0024 のまま
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
                              coalesce(settings->'oauth', '{}'::jsonb)
                                || jsonb_build_object(p_provider,
                                     (case when jsonb_typeof(settings->'oauth'->p_provider) = 'object' then settings->'oauth'->p_provider else '{}'::jsonb end)
                                       || jsonb_build_object('client_id', btrim(p_client_id))), true)
   where id = p_shop_id;
end;
$$;

revoke execute on function shop_oauth_client_save(uuid, text, text, text) from public, anon;
grant execute on function shop_oauth_client_save(uuid, text, text, text) to authenticated;

insert into banto_migrations (version) values ('0131_oauth_client_keep_settings');
