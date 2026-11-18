-- 0154_notice_texts: お知らせの文面をショップが直す（差し込み付きの文面、メンテナの決定 2026-11-18、docs/notices.md）
--   - 注文のメール・LINE（同梱プラグイン）とお店で試着のお知らせ（お客様あて）の件名・本文を、知らせの種類 × 送り方（mail / line）ごとに 1 行
--   - 本文は丸ごと直せる。差し込みは {{名前}}（知らせごとに使える名前が決まっている）。知らせごとに必ず入れる差し込みがあり、無ければ保存できない
--     （明細・合計・お届け先・店舗の案内などを消した知らせを送らないため）。明細のような「かたまり」は 1 回だけ
--   - 送るときは同じ決まりを Worker が確かめ直し、合わなければ（版が上がって必須が増えたなど）その知らせだけ既定の文面で送る（止めない）
--   - 行が無い = 既定の文面（今までと同じ）。shops.settings に置かない（ショップ行と一緒にキャッシュされ、お店の画面に毎回載るため）
--   - 読み書きは項目 settings。書くのは notice_text_set だけ。決まりは banto_notice_spec（Worker の src/notices/spec.ts と同じ。test/db/notice-texts.test.ts で縛る）

create table if not exists shop_notice_texts (
  shop_id uuid not null references shops (id) on delete cascade,
  kind text not null check (kind in ('order_paid', 'order_shipped', 'tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled')),
  channel text not null check (channel in ('mail', 'line')),
  subject text check (subject is null or char_length(subject) between 1 and 150),
  body text not null check (char_length(body) between 1 and 4000),
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind, channel),
  check ((channel = 'mail') = (subject is not null))
);

alter table shop_notice_texts enable row level security;
drop policy if exists shop_notice_texts_settings on shop_notice_texts;
create policy shop_notice_texts_settings on shop_notice_texts for select using (banto_shop_perm(shop_id, 'settings'));
revoke all on shop_notice_texts from anon, authenticated;
grant select on shop_notice_texts to authenticated;

-- 知らせ × 送り方の決まり。body / subject ごとに使える名前（allowed）・必ず入れる名前（required）、本文で 1 回だけの名前（once）。
-- 送り方として無い組み合わせは null
create or replace function banto_notice_spec(p_kind text, p_channel text)
returns jsonb
language sql
immutable
as $$
  select case
    when p_channel = 'mail' and p_kind in ('order_paid', 'order_shipped') then jsonb_build_object(
      'subject_allowed', '["shop_name","customer_name","number","total"]'::jsonb,
      'subject_required', '["number"]'::jsonb,
      'body_allowed', case when p_kind = 'order_shipped'
                           then '["shop_name","customer_name","number","total","order_details","tracking","return_policy","order_link","contact"]'::jsonb
                           else '["shop_name","customer_name","number","total","order_details","return_policy","order_link","contact"]'::jsonb end,
      'body_required', case when p_kind = 'order_shipped' then '["order_details","tracking"]'::jsonb else '["order_details"]'::jsonb end,
      'once', '["order_details","tracking"]'::jsonb)
    when p_channel = 'line' and p_kind in ('order_paid', 'order_shipped') then jsonb_build_object(
      'body_allowed', '["shop_name","number","total"]'::jsonb,
      'body_required', '["number"]'::jsonb,
      'once', '[]'::jsonb)
    when p_channel = 'mail' and p_kind in ('tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled') then jsonb_build_object(
      'subject_allowed', case when p_kind in ('tryon_requested', 'tryon_cancelled')
                              then '["shop_name","customer_name","number","store_name"]'::jsonb
                              else '["shop_name","customer_name","number","store_name","hold_until"]'::jsonb end,
      'subject_required', '["number"]'::jsonb,
      'body_allowed', case p_kind
                        when 'tryon_requested' then '["shop_name","customer_name","number","store_name","visit","items","store_info","contact","shop_link"]'::jsonb
                        when 'tryon_cancelled' then '["shop_name","customer_name","number","store_name","contact","shop_link"]'::jsonb
                        else '["shop_name","customer_name","number","store_name","hold_until","items","store_info","contact","shop_link"]'::jsonb end,
      'body_required', case p_kind
                         when 'tryon_requested' then '["items","store_info"]'::jsonb
                         when 'tryon_cancelled' then '["number"]'::jsonb
                         else '["hold_until","items","store_info"]'::jsonb end,
      'once', '["items","store_info"]'::jsonb)
    when p_channel = 'line' and p_kind in ('tryon_requested', 'tryon_ready', 'tryon_reminder', 'tryon_extended', 'tryon_cancelled') then jsonb_build_object(
      'body_allowed', case when p_kind in ('tryon_requested', 'tryon_cancelled')
                           then '["shop_name","number","store_name"]'::jsonb
                           else '["shop_name","number","store_name","hold_until"]'::jsonb end,
      'body_required', case when p_kind in ('tryon_requested', 'tryon_cancelled') then '["number"]'::jsonb else '["number","hold_until"]'::jsonb end,
      'once', '[]'::jsonb)
  end;
$$;
revoke execute on function banto_notice_spec(text, text) from public, anon, authenticated;

-- 文の差し込みを決まりと照らす。合わなければ invalid_notice_text:<理由>[:<名前>] を投げる。
-- 差し込みは {{ 名前 }}（前後の空白は可）。{{ と }} の組で名前として読めないもの・使えない名前・必須の欠け・1 回だけの重なりを断る
create or replace function banto_notice_tags_check(p_text text, p_allowed jsonb, p_required jsonb, p_once jsonb, p_where text)
returns void
language plpgsql
immutable
as $$
declare v_tag text; v_names text[] := '{}'; v_n text;
begin
  for v_tag in select (regexp_matches(p_text, '\{\{(.*?)\}\}', 'g'))[1] loop
    v_n := btrim(v_tag, E' \t');
    if v_n !~ '^[a-z_]{1,40}$' or not (p_allowed ? v_n) then
      raise exception 'invalid_notice_text:%_unknown_tag:%', p_where, left(v_n, 40) using errcode = '22023';
    end if;
    v_names := v_names || v_n;
  end loop;
  -- 組になっていない {{ / }} も断る（書き間違いを黙って文字として送らない）
  if regexp_replace(p_text, '\{\{.*?\}\}', '', 'g') ~ '\{\{|\}\}' then
    raise exception 'invalid_notice_text:%_broken_tag', p_where using errcode = '22023';
  end if;
  for v_n in select value from jsonb_array_elements_text(p_required) loop
    if not (v_n = any(v_names)) then raise exception 'invalid_notice_text:%_missing_tag:%', p_where, v_n using errcode = '22023'; end if;
  end loop;
  for v_n in select value from jsonb_array_elements_text(coalesce(p_once, '[]'::jsonb)) loop
    if (select count(*) from unnest(v_names) x where x = v_n) > 1 then
      raise exception 'invalid_notice_text:%_repeated_tag:%', p_where, v_n using errcode = '22023';
    end if;
  end loop;
end;
$$;
revoke execute on function banto_notice_tags_check(text, jsonb, jsonb, jsonb, text) from public, anon, authenticated;

-- 保存（項目 settings）。p_body が null なら行を消す（既定の文面に戻す）。改行は LF にそろえてから確かめる
create or replace function notice_text_set(p_shop_id uuid, p_kind text, p_channel text, p_subject text, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_spec jsonb := banto_notice_spec(p_kind, p_channel); v_body text; v_subject text;
begin
  if not banto_shop_perm(p_shop_id, 'settings') then raise exception 'settings_required' using errcode = '42501'; end if;
  if v_spec is null then raise exception 'invalid_notice_text:kind' using errcode = '22023'; end if;
  if p_body is null then
    delete from shop_notice_texts where shop_id = p_shop_id and kind = p_kind and channel = p_channel;
    return;
  end if;
  v_body := btrim(replace(replace(p_body, E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n');
  if v_body = '' then raise exception 'invalid_notice_text:body_empty' using errcode = '22023'; end if;
  if char_length(v_body) > (case when p_channel = 'line' then 2000 else 4000 end) then raise exception 'invalid_notice_text:body_too_long' using errcode = '22023'; end if;
  perform banto_notice_tags_check(v_body, v_spec->'body_allowed', v_spec->'body_required', v_spec->'once', 'body');
  if p_channel = 'mail' then
    v_subject := btrim(coalesce(p_subject, ''), E' \t');
    if v_subject = '' then raise exception 'invalid_notice_text:subject_empty' using errcode = '22023'; end if;
    if v_subject ~ E'[\r\n]' then raise exception 'invalid_notice_text:subject_newline' using errcode = '22023'; end if;
    if char_length(v_subject) > 150 then raise exception 'invalid_notice_text:subject_too_long' using errcode = '22023'; end if;
    perform banto_notice_tags_check(v_subject, v_spec->'subject_allowed', v_spec->'subject_required', '[]'::jsonb, 'subject');
  else
    v_subject := null;
  end if;
  insert into shop_notice_texts (shop_id, kind, channel, subject, body) values (p_shop_id, p_kind, p_channel, v_subject, v_body)
  on conflict (shop_id, kind, channel) do update set subject = excluded.subject, body = excluded.body, updated_at = now();
end;
$$;
revoke execute on function notice_text_set(uuid, text, text, text, text) from public, anon;
grant execute on function notice_text_set(uuid, text, text, text, text) to authenticated;

insert into banto_migrations (version) values ('0154_notice_texts');
