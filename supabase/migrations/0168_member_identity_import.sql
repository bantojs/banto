-- 0168: 会員の LINE・Google のログインの ID の取り込み（管理画面だけ）。
-- メンテナの決定 2026-11-23（docs/members.md「LINE・Google のログインを移す」、docs/knowledge/02-decisions.md）。
--
-- ほかのカートから移るとき・店舗の会員（会員カードの番号を独自項目に持つ）と結ぶときに、運営者が持っている
-- 「会員を引く値 → LINE の利用者 ID / Google の ID」の表を取り込み、既にいる会員に member_identities を作る。
-- 作っておけば、その人が初めて LINE / Google でログインしたときに、新しい会員を作らずにその会員に入る。
--
-- - 向きは入れるだけ（LINE の利用者 ID を外へ出さない 0105 の決定のまま）。応答に ID を返さない（行の番号と理由だけ）。
-- - 使えるのは組織の owner / admin だけ（member_set_email と同じ線: どの会員として入れるかを決める力なので、
--   customers の項目だけでは足りない）。AI 用 API・MCP には出さない。
-- - 上書きしない: その ID が別の会員に結ばれている（subject_taken）・その会員に別の ID が結ばれている（member_has_other）は飛ばす。
-- - 会員の引き方: email / external_ref（p_match_key = provider）/ attribute（p_match_key = customer_fields の鍵）。
--   ちょうど 1 人に当たるときだけ結ぶ（0 人 = not_found、2 人以上 = ambiguous）。
-- - 監査ログは member_identities のトリガーが書く（この関数が置いた印のあるトランザクションだけ。ID は入れない）。
-- - 会員には知らせず、端末もログアウトさせない（member_set_email とは違う。移行の一括の取り込みで、知らせると一斉のメールになるため）。
--   跡は監査ログと、管理画面の会員の詳細の「ログインの方法」（LINE / Google の別だけ）。
-- - 会員は引き方ごとに別の文で、1 回の問い合わせでまとめて引く（メールと外部の ID は索引、独自項目はショップの会員を 1 回読む）。
--   独自項目は保存してある文字で比べる（数は JSON の文字。先頭の 0 も区別する）。文字と数の項目だけ。
-- - Google の ID は sub（数字）。

create or replace function member_identities_import(p_shop_id uuid, p_match text, p_match_key text, p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
  v_keys text[];
  v_map jsonb := '{}'::jsonb;
  v_row record;
  v_ids jsonb;
  v_cid uuid;
  v_prov text;
  v_subject text;
  v_owner uuid;
  v_n integer;
  v_reason text;
  v_counts jsonb := jsonb_build_object('linked', 0, 'unchanged', 0, 'not_found', 0, 'ambiguous', 0, 'invalid', 0, 'subject_taken', 0, 'member_has_other', 0);
  v_issues jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- 会員としてログインさせる先を決める力なので、組織の owner / admin だけ（member_set_email と同じ）
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if p_match is null or p_match not in ('email', 'external_ref', 'attribute') then raise exception 'invalid_match'; end if;
  if p_match in ('external_ref', 'attribute') and (p_match_key is null or btrim(p_match_key) = '' or length(p_match_key) > 100) then
    raise exception 'invalid_match_key';
  end if;
  if p_match = 'attribute' then
    -- 比べるのは保存してある文字（数は JSON の文字）。文字と数の項目だけ（選択肢・URL・長い文などは引く値にしない）
    select settings into v_settings from shops where id = p_shop_id;
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_settings->'customer_fields') = 'array' then v_settings->'customer_fields' else '[]'::jsonb end) f
                    where jsonb_typeof(f) = 'object' and f->>'key' = p_match_key and coalesce(f->>'type', 'text') in ('text', 'number')) then
      raise exception 'invalid_match_key';
    end if;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too_many_rows'; end if;

  -- 引く値（メールは小文字）をまとめ、会員は 1 回の問い合わせで引く（引き方ごとに別の文にして、索引を使う）
  select coalesce(array_agg(distinct k), '{}'::text[]) into v_keys
    from (select case when p_match = 'email' then lower(btrim(e->>'key')) else btrim(e->>'key') end as k
            from jsonb_array_elements(p_rows) e where jsonb_typeof(e) = 'object') x
   where k is not null and k <> '' and length(k) <= 254;
  if p_match = 'email' then
    select coalesce(jsonb_object_agg(k, ids), '{}'::jsonb) into v_map
      from (select lower(c.email) as k, jsonb_agg(c.id) as ids
              from customers c
             where c.shop_id = p_shop_id and c.email is not null and lower(c.email) = any(v_keys)
             group by lower(c.email)) m;
  elsif p_match = 'external_ref' then
    select coalesce(jsonb_object_agg(k, ids), '{}'::jsonb) into v_map
      from (select c.external_ref->>'id' as k, jsonb_agg(c.id) as ids
              from customers c
             where c.shop_id = p_shop_id and c.external_ref is not null
               and c.external_ref->>'provider' = p_match_key and c.external_ref->>'id' = any(v_keys)
             group by c.external_ref->>'id') m;
  else
    select coalesce(jsonb_object_agg(k, ids), '{}'::jsonb) into v_map
      from (select c.attributes->>p_match_key as k, jsonb_agg(c.id) as ids
              from customers c
             where c.shop_id = p_shop_id and c.attributes->>p_match_key = any(v_keys)
             group by c.attributes->>p_match_key) m;
  end if;

  -- 監査ログのトリガーへの印（このトランザクションだけ）
  perform set_config('banto.identity_import', '1', true);

  begin
    for v_row in
      select (o - 1)::integer as idx,
             case when jsonb_typeof(e) = 'object' then nullif(case when p_match = 'email' then lower(btrim(e->>'key')) else btrim(e->>'key') end, '') end as k,
             case when jsonb_typeof(e) = 'object' then e end as e
        from jsonb_array_elements(p_rows) with ordinality as x(e, o)
       order by o
    loop
      -- 形: 鍵があり、line / google のどちらかがあり、あるものはどれも正しい形
      if v_row.e is null or v_row.k is null or length(v_row.k) > 254
         or (nullif(v_row.e->>'line', '') is null and nullif(v_row.e->>'google', '') is null)
         or (nullif(v_row.e->>'line', '') is not null and (v_row.e->>'line') !~ '^U[0-9a-f]{32}$')
         or (nullif(v_row.e->>'google', '') is not null and (v_row.e->>'google') !~ '^[0-9]{1,200}$') then
        v_counts := jsonb_set(v_counts, '{invalid}', to_jsonb((v_counts->>'invalid')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'invalid');
        continue;
      end if;
      v_ids := coalesce(v_map->v_row.k, '[]'::jsonb);
      if jsonb_array_length(v_ids) = 0 then
        v_counts := jsonb_set(v_counts, '{not_found}', to_jsonb((v_counts->>'not_found')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'not_found');
        continue;
      end if;
      if jsonb_array_length(v_ids) > 1 then
        v_counts := jsonb_set(v_counts, '{ambiguous}', to_jsonb((v_counts->>'ambiguous')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'ambiguous');
        continue;
      end if;
      v_cid := (v_ids->>0)::uuid;
      foreach v_prov in array array['line', 'google'] loop
        v_subject := nullif(v_row.e->>v_prov, '');
        continue when v_subject is null;
        -- 上書きしない: どちらの一意の制約にぶつかっても入れない（副トランザクションを作らない）
        insert into member_identities (shop_id, provider, subject, customer_id) values (p_shop_id, v_prov, v_subject, v_cid)
        on conflict do nothing;
        get diagnostics v_n = row_count;
        if v_n = 1 then
          v_reason := 'linked';
        else
          select customer_id into v_owner from member_identities where shop_id = p_shop_id and provider = v_prov and subject = v_subject;
          v_reason := case when v_owner = v_cid then 'unchanged' when v_owner is not null then 'subject_taken' else 'member_has_other' end;
          v_owner := null;
        end if;
        v_counts := jsonb_set(v_counts, array[v_reason], to_jsonb((v_counts->>v_reason)::integer + 1));
        if v_reason not in ('linked', 'unchanged') then
          v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'provider', v_prov, 'reason', v_reason);
        end if;
      end loop;
    end loop;
    v_result := jsonb_build_object('counts', v_counts, 'issues', v_issues, 'dry_run', coalesce(p_dry_run, false));
    -- 確かめるだけのときは、作った行（と監査ログ）をこの塊ごと戻す
    if coalesce(p_dry_run, false) then raise exception 'banto_identity_import_dry_run'; end if;
  exception when raise_exception then
    if sqlerrm <> 'banto_identity_import_dry_run' then raise; end if;
  end;
  return v_result;
end;
$$;
revoke execute on function member_identities_import(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function member_identities_import(uuid, text, text, jsonb, boolean) to authenticated;

-- 管理画面の会員の詳細に出す「ログインの方法」（LINE / Google の別だけ。ID は返さない）。項目 customers
create or replace function customer_login_providers(p_shop_id uuid, p_customer_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'customers') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return coalesce((select array_agg(provider order by provider) from member_identities where shop_id = p_shop_id and customer_id = p_customer_id), '{}'::text[]);
end;
$$;
revoke execute on function customer_login_providers(uuid, uuid) from public, anon;
grant execute on function customer_login_providers(uuid, uuid) to authenticated;

-- 監査ログ: 運営者が取り込みで結んだときだけ（会員自身の LINE・Google のログインと連携は書かない）。ID は入れない
create or replace function banto_audit_member_identities()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('banto.identity_import', true) = '1' then
    perform banto_audit(banto_shop_org(new.shop_id), new.shop_id, 'customer.identity_imported', 'customer', new.customer_id::text,
                        jsonb_build_object('provider', new.provider));
  end if;
  return new;
end;
$$;
revoke execute on function banto_audit_member_identities() from public, anon, authenticated;
drop trigger if exists member_identities_audit_import on member_identities;
create trigger member_identities_audit_import after insert on member_identities for each row execute function banto_audit_member_identities();

insert into banto_migrations (version) values ('0168_member_identity_import');
