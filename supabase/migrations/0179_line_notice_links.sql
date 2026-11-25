-- 0179: LINE の注文の知らせにリンクを差し込めるようにする（docs/notices.md、docs/line.md §2）。
--   - 文面の決まり（banto_notice_spec）: LINE の受付・発送で {{order_link}}（ご注文の状況のリンク）、発送で {{tracking}}（お問い合わせ番号と
--     運送会社の配送状況のリンク、1 回だけ）を使えるようにする。必ず入れる名前は変えない（今までに直した文面はそのまま使える）
--   - order_line_recipient: リンクを組むのに要る値（お問い合わせ番号、ショップのスラッグ・ドメイン・注文照会のページ）も返す。
--     氏名・住所・メールアドレスは今までどおり返さない（LINE には載せない）
--   - 既定の文面（Worker の src/notices/templates.ts）にも入れる。値が無い（番号が無い・リンクを組めない）ときは行ごと消える
--   - LINE の見た目（shops.settings.line_notice_style = text / card）も返す。card なら Worker がボタン付きのカード（Flex Message）で送る
--     （型は Banto の 1 つだけ、src/notices/line-card.ts）。設定の鍵は項目 settings（banto_shop_settings_perm の既定）

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
      'body_allowed', case when p_kind = 'order_shipped'
                           then '["shop_name","number","total","tracking","order_link"]'::jsonb
                           else '["shop_name","number","total","order_link"]'::jsonb end,
      'body_required', '["number"]'::jsonb,
      'once', case when p_kind = 'order_shipped' then '["tracking"]'::jsonb else '[]'::jsonb end)
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
    select jsonb_build_object('line_user_id', i.subject, 'number', o.number, 'total_jpy', o.total_jpy, 'shop_name', s.name, 'status', o.status,
             -- 0179: リンクの材料（鍵ではない）。LINE の知らせは会員の注文だけなので、注文照会のリンクはいつも会員の印つき
             'tracking', case when o.tracking_number is not null then jsonb_build_object('carrier', o.tracking_carrier, 'number', o.tracking_number) end,
             'shop', jsonb_build_object('name', s.name, 'slug', s.slug, 'domain', s.domain,
                                        'order_page_url', s.settings->'headless'->>'order_page_url',
                                        'return_origins', coalesce(s.settings->'headless'->'return_origins', '[]'::jsonb)),
             -- LINE の見た目（文字だけ / カード）。ショップの設定 line_notice_style（項目 settings、無ければ文字だけ）
             'line_style', s.settings->>'line_notice_style')
      from orders o join shops s on s.id = o.shop_id
      join member_identities i on i.shop_id = o.shop_id and i.customer_id = o.customer_id and i.provider = 'line'
     where o.id = p_order_id and o.shop_id = p_shop_id and o.customer_id is not null
     limit 1);
end;
$$;
revoke execute on function order_line_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function order_line_recipient(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0179_line_notice_links');
