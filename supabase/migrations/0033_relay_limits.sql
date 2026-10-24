-- Banto 0033_relay_limits: 中継元の IP と、IP ごとの上限の設定（外部レビューの指摘 2026-10-18、docs/headless.md「サーバー側で中継するとき」）
-- 前方専用。
--
-- WordPress などの連携側がサーバーで Banto を中継すると、Banto から見た購入者の IP は全員その 1 台になり、
-- 0029 の「同じ IP の未確定の予約は 20 まで」「同じ IP から会員のコード発行は 1 時間 30 回」がサイト全体の上限に化ける。
--  - settings.headless.relay_ips: 信頼する中継元の IP。公開の settings に含め、Worker はそこから来た通信だけ X-Banto-Client-IP を購入者の IP として使う
--  - member_login_start: 同じ IP からの 1 時間の回数を settings.members_login_limits.per_ip_per_hour（既定 30）で変えられるようにする
--  - api_shop_get / api_shop_update: max_pending_per_ip と login_per_ip_per_hour を AI 用トークン（shop:read / shop:write）からも読み書きできる
--    （0032_api_checkout_terms の checkout_terms の扱いはそのまま引き継ぐ。この 2 本は同じ関数を差し替えるので、後の版がすべてを含む）

-- ---------- 公開の settings に headless.relay_ips（0028 を差し替え） ----------
create or replace function banto_shop_public_settings(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e(k, v)
                    where k in ('theme', 'theme_settings', 'notice', 'shipping', 'modules', 'members_enabled', 'members_password',
                                'checkout_terms', 'delivery_time', 'store_tryon', 'receipt', 'product_fields',
                                'tax_rate', 'tax_rate_reduced', 'tax_rounding')), '{}'::jsonb)
      || case when jsonb_typeof(p->'headless') = 'object'
              then jsonb_build_object('headless', jsonb_build_object('return_origins', coalesce(p->'headless'->'return_origins', '[]'::jsonb),
                                                                      'relay_ips', coalesce(p->'headless'->'relay_ips', '[]'::jsonb)))
              else '{}'::jsonb end
      || case when jsonb_typeof(p->'oauth') = 'object'
              then jsonb_build_object('oauth', coalesce((
                     select jsonb_object_agg(k, coalesce((select jsonb_object_agg(k2, v2) from jsonb_each(v) f(k2, v2) where k2 in ('client_id', 'bot_prompt')), '{}'::jsonb))
                       from jsonb_each(p->'oauth') e(k, v) where jsonb_typeof(v) = 'object'), '{}'::jsonb))
              else '{}'::jsonb end;
$$;
revoke execute on function banto_shop_public_settings(jsonb) from public, anon, authenticated;

-- ---------- member_login_start（0029 を差し替え: 同じ IP からの 1 時間の回数をショップの設定で） ----------
create or replace function member_login_start(p_shop_id uuid, p_email text, p_code_hash text, p_link_hash text, p_ip_hash text, p_return_to text, p_ttl_seconds integer default 900)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_from text;
  v_id uuid;
  v_limited boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'member_login_start: service_role only' using errcode = '42501';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if not exists (select 1 from shops where id = p_shop_id and coalesce(settings->>'members_enabled', 'false') = 'true') then
    raise exception 'members_disabled';
  end if;
  select nullif(btrim(e.settings->>'from'), '') into v_from
    from hook_endpoints e
   where e.shop_id = p_shop_id and e.enabled and e.url = 'https://banto.invalid/plugins/email_resend'
   limit 1;
  if v_from is null then raise exception 'mail_not_configured'; end if;

  perform pg_advisory_xact_lock(hashtextextended('member_login|' || p_shop_id::text || '|' || v_email, 0));
  if p_ip_hash is not null then
    -- 同じ IP から同じアドレスへ: 15 分に 3 回・1 日 10 回（他人が被害者の枠を使い切れないように、IP ごとに分ける）
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 3
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and ip_hash = p_ip_hash and created_at > now() - interval '1 day') >= 10
              -- 同じ IP から誰へでも: 1 時間に 30 回（0033: settings.members_login_limits.per_ip_per_hour。中継する構成では中継元の宣言のほうを使う）
              or (select count(*) from member_login_challenges where shop_id = p_shop_id and ip_hash = p_ip_hash and created_at > now() - interval '1 hour')
                 >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_ip_per_hour', 30);
  else
    -- IP が分からない（Node でヘッダー未設定、中継元が申告しない）: アドレスだけで数える
    v_limited := (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '15 minutes') >= 5;
  end if;
  -- アドレス全体: 1 日 30 通（メール爆撃の上限）。ショップ全体: 1 時間・1 日の上限（送信元の評判と Resend の枠を守る）
  v_limited := v_limited
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and email = v_email and created_at > now() - interval '1 day') >= 30
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and created_at > now() - interval '1 hour')
       >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_hour', 100)
    or (select count(*) from member_login_challenges where shop_id = p_shop_id and created_at > now() - interval '1 day')
       >= banto_shop_limit(p_shop_id, 'members_login_limits', 'per_day', 500);
  if v_limited then
    return jsonb_build_object('send', false, 'challenge_id', gen_random_uuid(), 'mail_from', v_from);
  end if;

  -- 直近 3 つまで有効（新しいコードを出しても、届いたばかりの前のコードが無効にならない）。それより古いものは無効にする
  update member_login_challenges set consumed_at = now()
   where shop_id = p_shop_id and email = v_email and consumed_at is null
     and id not in (select id from member_login_challenges where shop_id = p_shop_id and email = v_email and consumed_at is null order by created_at desc limit 2);
  insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, return_to, expires_at)
  values (p_shop_id, v_email, p_code_hash, p_link_hash, p_ip_hash, nullif(left(p_return_to, 500), ''),
          now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 900), 3600))))
  returning id into v_id;
  return jsonb_build_object('send', true, 'challenge_id', v_id, 'mail_from', v_from);
end;
$$;

-- ---------- AI 用: IP ごとの上限を読み書き（0032_api_checkout_terms を差し替え。checkout_terms の扱いは同じ） ----------
create or replace function api_shop_get(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_shop shops%rowtype;
begin
  v_tok := api_require(p_token_hash, 'shop:read');
  select * into v_shop from shops where id = v_tok.shop_id;
  return jsonb_build_object(
    'id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'published', v_shop.published,
    'legal_notice', v_shop.legal_notice, 'privacy_policy', v_shop.privacy_policy, 'return_policy', v_shop.return_policy,
    'checkout_terms', jsonb_build_object(
      'delivery', nullif(btrim(v_shop.settings->'checkout_terms'->>'delivery'), ''),
      'cancellation', nullif(btrim(v_shop.settings->'checkout_terms'->>'cancellation'), ''),
      'payment_note', nullif(btrim(v_shop.settings->'checkout_terms'->>'payment_note'), '')),
    'low_stock_threshold', coalesce((v_shop.settings->>'low_stock_threshold')::integer, 3),
    'max_pending_per_ip', banto_shop_limit(v_shop.id, 'checkout', 'max_pending_per_ip', 20),
    'login_per_ip_per_hour', banto_shop_limit(v_shop.id, 'members_login_limits', 'per_ip_per_hour', 30),
    'stripe_connected', v_shop.stripe_account_id is not null,
    'created_at', v_shop.created_at, 'updated_at', v_shop.updated_at);
end;
$$;

-- 更新できる項目だけを受け付ける（settings 全体や stripe_account_id は触らせない）
create or replace function api_shop_update(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok api_tokens;
  v_threshold integer;
  v_per_ip integer;
  v_login_ip integer;
  v_patch jsonb := '{}'::jsonb;
  v_in jsonb;
  v_terms jsonb;
  v_key text;
  v_val text;
  v_settings jsonb;
begin
  v_tok := api_require(p_token_hash, 'shop:write');
  select settings into v_settings from shops where id = v_tok.shop_id for update;
  if p_values ? 'low_stock_threshold' then
    v_threshold := (p_values->>'low_stock_threshold')::integer;
    if v_threshold is null or v_threshold < 0 or v_threshold > 100000 then raise exception 'invalid_low_stock_threshold'; end if;
    v_patch := v_patch || jsonb_build_object('low_stock_threshold', v_threshold);
  end if;
  -- 購入前の確認画面の文言（0032）: 渡した鍵だけ変え、null か空文字で消す。1 項目 2000 文字まで
  if p_values ? 'checkout_terms' then
    v_in := p_values->'checkout_terms';
    if jsonb_typeof(v_in) is distinct from 'object' then raise exception 'invalid_checkout_terms'; end if;
    v_terms := case when jsonb_typeof(v_settings->'checkout_terms') = 'object' then v_settings->'checkout_terms' else '{}'::jsonb end;
    foreach v_key in array array['delivery', 'cancellation', 'payment_note'] loop
      continue when not v_in ? v_key;
      case jsonb_typeof(v_in->v_key)
        when 'null' then v_val := '';
        when 'string' then v_val := btrim(replace(v_in->>v_key, E'\r\n', E'\n'));
        else raise exception 'invalid_checkout_terms';
      end case;
      if length(v_val) > 2000 then raise exception 'invalid_checkout_terms'; end if;
      v_terms := v_terms || jsonb_build_object(v_key, v_val);
    end loop;
    v_patch := v_patch || jsonb_build_object('checkout_terms', v_terms);
  end if;
  -- IP ごとの上限（0033。banto_shop_limit が読むのは 1〜4 桁）。同じ節のほかの値は残す
  if p_values ? 'max_pending_per_ip' then
    v_per_ip := (p_values->>'max_pending_per_ip')::integer;
    if v_per_ip is null or v_per_ip < 1 or v_per_ip > 9999 then raise exception 'invalid_max_pending_per_ip'; end if;
    v_patch := v_patch || jsonb_build_object('checkout',
      coalesce(case when jsonb_typeof(v_settings->'checkout') = 'object' then v_settings->'checkout' end, '{}'::jsonb) || jsonb_build_object('max_pending_per_ip', v_per_ip));
  end if;
  if p_values ? 'login_per_ip_per_hour' then
    v_login_ip := (p_values->>'login_per_ip_per_hour')::integer;
    if v_login_ip is null or v_login_ip < 1 or v_login_ip > 9999 then raise exception 'invalid_login_per_ip_per_hour'; end if;
    v_patch := v_patch || jsonb_build_object('members_login_limits',
      coalesce(case when jsonb_typeof(v_settings->'members_login_limits') = 'object' then v_settings->'members_login_limits' end, '{}'::jsonb) || jsonb_build_object('per_ip_per_hour', v_login_ip));
  end if;
  update shops set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    legal_notice = case when p_values ? 'legal_notice' then nullif(btrim(p_values->>'legal_notice'), '') else legal_notice end,
    privacy_policy = case when p_values ? 'privacy_policy' then nullif(btrim(p_values->>'privacy_policy'), '') else privacy_policy end,
    return_policy = case when p_values ? 'return_policy' then nullif(btrim(p_values->>'return_policy'), '') else return_policy end,
    published = coalesce((p_values->>'published')::boolean, published),
    settings = settings || v_patch
  where id = v_tok.shop_id;
  return api_shop_get(p_token_hash);
end;
$$;

insert into banto_migrations (version) values ('0033_relay_limits');
