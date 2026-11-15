-- Banto 0143_shop_columns: ショップを扱う人（member）に見える shops の列を絞る
-- 前方専用。
--
-- 項目を 1 つでも持つ member には、shops の行がまるごと見えていた（0024 の shops_member_select + authenticated の全列の SELECT、
-- と、管理画面がショップを引く banto_admin_shop が member にも行をまるごと返す）。
-- 商品だけを任された人が、決済の接続先（stripe_account_id）・注文や申し込みの連番（件数が分かる）・法務のリンクの確認の結果を読めた。
--
-- 行そのものは隠せない: 商品・SKU・画像・カテゴリーの公開のポリシーが、呼び手の権限で shops（id・published）を読むので、
-- 行を見えなくすると member の画面で商品が読めなくなる。絞るのは列。
--   1. authenticated から stripe_account_id・order_seq・tryon_seq・inquiry_seq・legal_links_state の SELECT を外す
--      （owner / admin も PostgREST から直接は読めなくなる。管理画面は banto_admin_shop で読む）。
--   2. banto_admin_shop: owner / admin には今までどおり行の全部。member には上の列を除き、
--      stripe_account_id は項目 settings（決済の設定の画面）・integrations（Stripe の接続）・orders_cancel（返金）のどれかを持つ人にだけ、
--      legal_links_state は integrations を持つ人にだけ足す。連番は member には返さない。
-- settings の鍵ごとの絞り込みは別のマイグレーションで（保存が「読んだ全体を書き戻す」形なので、書き込みを鍵ごとの差分にしてから）。
--
-- これから shops に列を足すマイグレーションは、authenticated に見せる列なら grant select (<列>) on shops to authenticated を書く
-- （表の全体の SELECT を外したので、足した列は自動では見えない）。

-- ---------- 1. 列の権限 ----------
revoke select on shops from authenticated;
grant select (id, owner_id, org_id, slug, name, published, domain, legal_notice, privacy_policy, return_policy, settings,
              option_axes, option_names, option_swatches, care_symbols, theme_version_id, created_at, updated_at)
  on shops to authenticated;

-- ---------- 2. 管理画面がショップを引く関数 ----------
create or replace function banto_admin_shop(p_shop_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when banto_owns_shop(s.id) then jsonb_build_object('shop', to_jsonb(s), 'role', coalesce(banto_org_role(s.org_id), 'owner'), 'perms', to_jsonb(banto_shop_perms_all()))
    when ms.perms is not null and cardinality(ms.perms) > 0 then jsonb_build_object(
      'shop',
        (to_jsonb(s) - 'stripe_account_id' - 'order_seq' - 'tryon_seq' - 'inquiry_seq' - 'legal_links_state')
        || case when ms.perms && array['settings', 'integrations', 'orders_cancel'] then jsonb_build_object('stripe_account_id', s.stripe_account_id) else '{}'::jsonb end
        || case when 'integrations' = any(ms.perms) then jsonb_build_object('legal_links_state', s.legal_links_state) else '{}'::jsonb end,
      'role', 'member', 'perms', to_jsonb(ms.perms))
    end
    from shops s
    left join org_member_shops ms on ms.shop_id = s.id and ms.user_id = auth.uid() and ms.org_id = s.org_id
   where s.id = p_shop_id;
$$;
revoke execute on function banto_admin_shop(uuid) from public, anon;
grant execute on function banto_admin_shop(uuid) to authenticated;

insert into banto_migrations (version) values ('0143_shop_columns');
