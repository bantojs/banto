-- 0167: 会員の結びつけの一覧（AI 用 API の GET /api/v1/customers/links、スコープ customers:links）。
-- メンテナの決定 2026-11-23（docs/ai-access.md「会員の結びつけの一覧」、docs/knowledge/02-decisions.md）。
--
-- 外部の顧客マスタ（店舗の会員など）が、LINE でログインした Banto の会員と自分の会員を同じ人として結ぶための口。
-- 返すのは会員 ID・外部の ID（external_ref）・独自項目（attributes）・更新日時と、LINE の利用者 ID の鍵付きハッシュだけ。
-- メール・氏名・住所・注文・同意は返さない（customers:read を付けずに済むように、スコープを分ける）。
--
-- LINE の利用者 ID は外へ出さない（0105 の決定のまま）: 返すのは HMAC-SHA256(鍵 = 呼び出し側が X-Banto-Link-Key で渡した値,
-- 本文 = UID) の 16 進（小文字）だけ。呼び出し側は自分が持っている UID から同じ値を作って照らす。鍵は保存しない
-- （呼ぶたびに渡す。鍵を変えれば前の値とは照らせなくなる）。UID を Banto に送らせる「UID で 1 人を引く」口は作らない。

-- スコープ（0155 の定義に customers:links を足す）
alter table api_tokens drop constraint if exists api_tokens_scopes_valid;
alter table api_tokens add constraint api_tokens_scopes_valid check (scopes <@ array[
  'products:read','products:write','orders:read','orders:pii','orders:write','shop:read','shop:write','stats:read',
  'coupons:read','coupons:write','customers:read','customers:write','customers:links','inquiries:read','inquiries:write',
  'theme:write','theme:publish','content:read','content:write','app_data:write','line:send','dialogs:write','stores:write',
  'member_news:write'
]::text[]);

-- 発行者の項目: customers:links → customers（会員を読める人だけが付けられる）
create or replace function banto_scope_perm(p_scope text)
returns text
language sql
immutable
as $$
  select case p_scope
    when 'products:read' then 'catalog'
    when 'products:write' then 'catalog'
    when 'orders:read' then 'orders'
    when 'orders:write' then 'orders'
    when 'orders:pii' then 'customers'
    when 'shop:read' then 'integrations'
    when 'shop:write' then 'settings'
    when 'stats:read' then 'reports'
    when 'coupons:read' then 'marketing'
    when 'coupons:write' then 'marketing'
    when 'customers:read' then 'customers'
    when 'customers:write' then 'customers'
    when 'customers:links' then 'customers'
    when 'inquiries:read' then 'support'
    when 'inquiries:write' then 'support'
    when 'theme:write' then 'design'
    when 'theme:publish' then 'design'
    when 'content:read' then 'content'
    when 'content:write' then 'content'
    when 'app_data:write' then 'apps'
    when 'line:send' then 'marketing'
    when 'dialogs:write' then 'marketing'
    when 'stores:write' then 'stores'
    when 'member_news:write' then 'marketing'
  end;
$$;
revoke execute on function banto_scope_perm(text) from public, anon, authenticated;

-- 一覧: そのショップの会員すべて（LINE でログインしていない会員も）。並びは作った順・id（ページをまたいで変わらない）
create or replace function api_customers_links(p_token_hash text, p_link_key text, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_tok api_tokens; v_limit integer; v_offset integer; v_total integer; v_items jsonb;
begin
  v_tok := api_require(p_token_hash, 'customers:links');
  -- 鍵は ASCII の見える文字（! 〜 ~）の 32〜256 文字（見出しで渡すので、空白・ASCII の外は黙って違うバイトになりうる）
  if p_link_key is null or p_link_key !~ '^[!-~]+$' or length(p_link_key) not between 32 and 256 then raise exception 'invalid_link_key'; end if;
  v_limit := greatest(1, least(coalesce(p_limit, 100), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));
  select count(*) into v_total from customers c where c.shop_id = v_tok.shop_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id,
           'line_link', case when x.subject is null then null else encode(hmac(convert_to(x.subject, 'UTF8'), convert_to(p_link_key, 'UTF8'), 'sha256'), 'hex') end,
           'external_ref', x.external_ref,
           'attributes', coalesce(x.attributes, '{}'::jsonb),
           'updated_at', x.updated_at
         ) order by x.created_at, x.id), '[]'::jsonb)
    into v_items
    from (select c.id, c.external_ref, c.attributes, c.updated_at, c.created_at, mi.subject
            from customers c
            left join member_identities mi on mi.shop_id = c.shop_id and mi.customer_id = c.id and mi.provider = 'line'
           where c.shop_id = v_tok.shop_id
           order by c.created_at, c.id
           limit v_limit offset v_offset) x;
  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;
revoke execute on function api_customers_links(text, text, integer, integer) from public, anon, authenticated;
grant execute on function api_customers_links(text, text, integer, integer) to service_role;

insert into banto_migrations (version) values ('0167_customer_links');
