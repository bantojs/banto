-- 0168: 会員の LINE・Google のログインの ID の取り込み（管理画面だけ）。
-- メンテナの決定 2026-11-23（docs/members.md「LINE・Google のログインを移す」、docs/knowledge/02-decisions.md）。
--
-- ほかのカートから移るとき・店舗の会員（会員カードの番号を独自項目に持つ）と結ぶときに、運営者が持っている
-- 「会員を引く値 → LINE の利用者 ID / Google の ID」の表を取り込み、既にいる会員に member_identities を作る。
-- 作っておけば、その人が初めて LINE / Google でログインしたときに、新しい会員を作らずにその会員に入る。
--
-- - 向きは入れるだけ（LINE の利用者 ID を外へ出さない 0105 の決定のまま）。応答にも ID を返さない（行の番号だけ）。
-- - 使えるのは組織の owner / admin だけ（member_set_email と同じ線: どの会員として入れるかを決める力なので、
--   customers の項目だけでは足りない）。AI 用 API・MCP には出さない。
-- - 上書きしない: その ID が別の会員に結ばれている（subject_taken）・その会員に別の ID が結ばれている（member_has_other）は飛ばす。
-- - 会員の引き方: email / external_ref（p_match_key = provider）/ attribute（p_match_key = customer_fields の鍵）。
--   ちょうど 1 人に当たるときだけ結ぶ（0 人 = not_found、2 人以上 = ambiguous）。
-- - 監査ログは member_identities のトリガーが書く（この関数が置いた印のあるトランザクションだけ。ID は入れない）。
-- - 会員には知らせない（会員の取り込み import_members と同じ）。

create or replace function member_identities_import(p_shop_id uuid, p_match text, p_match_key text, p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
  v_row record;
  v_key text;
  v_ids uuid[];
  v_cid uuid;
  v_prov text;
  v_subject text;
  v_other text;
  v_owner uuid;
  v_counts jsonb := jsonb_build_object('linked', 0, 'unchanged', 0, 'not_found', 0, 'ambiguous', 0, 'invalid', 0, 'subject_taken', 0, 'member_has_other', 0);
  v_issues jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- 会員としてログインさせる先を決める力なので、組織の owner / admin だけ（member_set_email と同じ）
  if not banto_owns_shop(p_shop_id) then raise exception 'shop_not_found' using errcode = '42501'; end if;
  if p_match not in ('email', 'external_ref', 'attribute') then raise exception 'invalid_match'; end if;
  if p_match in ('external_ref', 'attribute') and (p_match_key is null or btrim(p_match_key) = '' or length(p_match_key) > 100) then
    raise exception 'invalid_match_key';
  end if;
  if p_match = 'attribute' then
    select settings into v_settings from shops where id = p_shop_id;
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_settings->'customer_fields') = 'array' then v_settings->'customer_fields' else '[]'::jsonb end) f
                    where jsonb_typeof(f) = 'object' and f->>'key' = p_match_key) then
      raise exception 'invalid_match_key';
    end if;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too_many_rows'; end if;

  -- 監査ログのトリガーへの印（このトランザクションだけ）
  perform set_config('banto.identity_import', '1', true);

  begin
    for v_row in
      with r as (
        select (o - 1)::integer as idx,
               nullif(btrim(case when jsonb_typeof(e) = 'object' then e->>'key' end), '') as k,
               case when jsonb_typeof(e) = 'object' then e end as e
          from jsonb_array_elements(p_rows) with ordinality as x(e, o)
      )
      select r.idx, r.k, r.e,
             -- 会員は集合で引く（行ごとにショップの会員を読み直さない）。3 人目以降は要らないので 2 人まで
             (select array_agg(m.id) from (
                select c.id from customers c
                 where c.shop_id = p_shop_id and r.k is not null
                   and case p_match
                         when 'email' then lower(c.email) = lower(r.k)
                         when 'external_ref' then c.external_ref->>'provider' = p_match_key and c.external_ref->>'id' = r.k
                         else c.attributes->>p_match_key = r.k
                       end
                 limit 2) m) as ids
        from r
       order by r.idx
    loop
      v_ids := coalesce(v_row.ids, '{}'::uuid[]);
      -- 形: 鍵があり、line / google のどちらかがあり、あるものはどれも正しい形
      if v_row.e is null or v_row.k is null or length(v_row.k) > 254
         or (nullif(v_row.e->>'line', '') is null and nullif(v_row.e->>'google', '') is null)
         or (nullif(v_row.e->>'line', '') is not null and (v_row.e->>'line') !~ '^U[0-9a-f]{32}$')
         or (nullif(v_row.e->>'google', '') is not null and ((v_row.e->>'google') !~ '^[!-~]+$' or length(v_row.e->>'google') > 200)) then
        v_counts := jsonb_set(v_counts, '{invalid}', to_jsonb((v_counts->>'invalid')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'invalid');
        continue;
      end if;
      if cardinality(v_ids) = 0 then
        v_counts := jsonb_set(v_counts, '{not_found}', to_jsonb((v_counts->>'not_found')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'not_found');
        continue;
      end if;
      if cardinality(v_ids) > 1 then
        v_counts := jsonb_set(v_counts, '{ambiguous}', to_jsonb((v_counts->>'ambiguous')::integer + 1));
        v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'reason', 'ambiguous');
        continue;
      end if;
      v_cid := v_ids[1];
      foreach v_prov in array array['line', 'google'] loop
        v_subject := nullif(v_row.e->>v_prov, '');
        continue when v_subject is null;
        select customer_id into v_owner from member_identities where shop_id = p_shop_id and provider = v_prov and subject = v_subject;
        select subject into v_other from member_identities where shop_id = p_shop_id and provider = v_prov and customer_id = v_cid;
        if v_owner = v_cid then
          v_counts := jsonb_set(v_counts, '{unchanged}', to_jsonb((v_counts->>'unchanged')::integer + 1));
        elsif v_owner is not null then
          v_counts := jsonb_set(v_counts, '{subject_taken}', to_jsonb((v_counts->>'subject_taken')::integer + 1));
          v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'provider', v_prov, 'reason', 'subject_taken');
        elsif v_other is not null then
          v_counts := jsonb_set(v_counts, '{member_has_other}', to_jsonb((v_counts->>'member_has_other')::integer + 1));
          v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'provider', v_prov, 'reason', 'member_has_other');
        else
          begin
            insert into member_identities (shop_id, provider, subject, customer_id) values (p_shop_id, v_prov, v_subject, v_cid);
            v_counts := jsonb_set(v_counts, '{linked}', to_jsonb((v_counts->>'linked')::integer + 1));
          exception when unique_violation then
            -- 同じ時にその人が LINE でログインした・別の会員に結ばれた（上書きしない）
            v_counts := jsonb_set(v_counts, '{subject_taken}', to_jsonb((v_counts->>'subject_taken')::integer + 1));
            v_issues := v_issues || jsonb_build_object('row', v_row.idx, 'provider', v_prov, 'reason', 'subject_taken');
          end;
        end if;
        v_owner := null;
        v_other := null;
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
