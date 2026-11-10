#!/usr/bin/env node
// DB の守りを機械的に検査する（CLAUDE.md §1-4、2026-10-18 のコード監査のI-9）。
//
// 使い方:
//   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres node scripts/check-rls.mjs
//   （BANTO_TEST_DB_URL でも可。どちらも無ければ Supabase CLI の既定 URL を使う）
//
// 検査するもの:
//   1. public スキーマの全テーブルに RLS が有効で、ポリシーが 1 つ以上ある
//   2. anon / authenticated が EXECUTE できる関数が、下の allowlist と一致する
//      （新しい関数は Supabase の既定で anon にも EXECUTE が付く。allowlist に無ければ revoke を忘れている。
//        意図して公開するなら、このファイルの allowlist に足す。その PR で理由を書く）
//   3. 秘密の列の権限（0028）: anon が shops の settings 等を読めない、運営者が customers のパスワードのハッシュを読めない、
//      orders を authenticated が status / shipped_at 以外に更新できない
// どれか 1 つでも違えば一覧を出して exit 1。

import pg from "pg";

const url =
  process.env.SUPABASE_DB_URL ??
  process.env.BANTO_TEST_DB_URL ??
  "postgres://postgres:postgres@127.0.0.1:54322/postgres";

/** pgcrypto 等の拡張の関数は数えない（Supabase では extensions スキーマに入り、素の Postgres では public に入る） */
const EXTENSION_FUNCTIONS = new Set([
  "armor", "crypt", "dearmor", "decrypt", "decrypt_iv", "digest", "encrypt", "encrypt_iv", "gen_random_bytes", "gen_random_uuid", "gen_salt", "hmac",
  "pgp_armor_headers", "pgp_key_id", "pgp_pub_decrypt", "pgp_pub_decrypt_bytea", "pgp_pub_encrypt", "pgp_pub_encrypt_bytea",
  "pgp_sym_decrypt", "pgp_sym_decrypt_bytea", "pgp_sym_encrypt", "pgp_sym_encrypt_bytea",
]);

/** anon（お客様の画面・ヘッドレスの公開 API）が呼べる関数 */
const ANON_FUNCTIONS = new Set([
  "banto_org_admin", "banto_org_role", "banto_owner_signup_allowed", "banto_owns_shop", "banto_setup_state", "banto_shop_perm",
  "banto_shop_perms_all", "banto_store_perm", "banto_store_perms_all", "banto_store_visible", "banto_valid_tags",
  "coupon_claim_info", "heartbeat_age_seconds", "shop_payment_options", "shop_public_get", "shop_public_list", "shop_store_list",
  // 0054: PostgREST がすべてのリクエストの前に、リクエストの役割のまま呼ぶ（中身は JWT を読むだけ。anon には何もしない）
  "banto_mfa_state", "banto_pre_request",
  // 0055: 商品詳細（公開中の商品だけ。attributes は公開の項目だけ）
  "product_public_get",
  // 0058: 商品の一覧（公開中のショップの公開中の商品だけ。attributes・説明は返さない）とタグ・カテゴリーの件数。検索の式インデックスの関数
  "product_public_list", "product_public_facets", "banto_product_search_text",
  // 0060: サイトマップ（公開中の商品の数と slug）・商品フィードの 1 ページ・Workers のプラン（free / paid、裏の処理の量）
  "product_public_count", "product_public_slugs", "product_feed_page", "banto_site_plan",
  // 0074: お店の画面が Liquid のテーマを描いてよいか（Workers のプランと plan_limits.theme_versions が 0 でないか。秘密ではない）
  "banto_site_liquid",
  // 0089: SKU の在庫の段階値（公開中のショップ・商品の SKU だけ。0〜99 に丸める。inventory の行は anon に読ませない）
  "product_public_stock",
  // 0089: pages / blogs / articles の公開の RLS が使う「そのモジュールが ON の公開中のショップか」（ON / OFF しか返さない）
  "banto_shop_module_public",
  // 0098: 会員限定の商品にゲストが URL で来たとき「会員の方だけ」と出してよいか（'members' か null だけ。商品の中身は返さない）
  "product_public_gate",
  // 0099: ゲストに見せる「会員価格」（公開中で見える商品の SKU の、当てはまる決まりのうちいちばん安い単価だけ。条件・決まりの中身は返さない）
  "product_public_member_prices",
  // 0100: 会員限定のページ・記事にゲストが URL で来たとき「会員の方だけ」と出してよいか（'members' か null だけ。中身は返さない）
  "content_public_gate",
  // 0112: 本文の「商品を並べる」で選んだ商品（公開中で見える商品だけ。一覧と同じ列）
  "product_public_pick",
]);

/** authenticated（運営者・スタッフの JWT）が呼べる関数。anon の分を含む */
const AUTHENTICATED_FUNCTIONS = new Set([
  ...ANON_FUNCTIONS,
  "banto_admin_shop", "banto_my_shops", "banto_my_stores", "banto_admin_me", "admin_session_bump",
  "coupon_grant_revoke", "coupon_grants_for_emails", "coupon_grants_issue", "coupon_stats", "coupon_stats_for", "coupon_grant_counts", "admin_search_ids",
  "enqueue_hook", "import_catalog", "import_coupon_usage", "import_coupons", "import_orders", "import_tax_classes", "mask_customer", "member_set_email", "member_passkeys_reset", "customer_set_attributes", "customer_set_note", "views_add", "views_remove", "stock_adjust", "stock_count", "inventory_list", "catalog_bulk_update", "product_images_order", "customer_marketing_consent_withdraw",
  "org_invitation_accept", "org_invitation_revoke", "org_invite", "org_member_remove", "org_member_set", "org_members_list",
  "image_import_cancel", "image_import_enqueue", "image_import_resolve", "image_import_retry", "image_import_summary", "site_settings_set",
  "org_set_require_mfa", "org_members_mfa", "org_member_mfa_reset_authorize", // 0054: 中で組織の owner / admin を確かめる
  "org_member_mfa_self", // 0057: 自分の二段階認証の登録・解除を監査ログに（auth.uid() の分だけ）
  "banto_plan_usage", // 0052: プランの上限と使用量（中で組織の owner / admin を確かめる）
  "sales_summary", "set_stock", "ship_orders", "shop_oauth_client_delete", "shop_oauth_client_save", "shop_secret_save",
  "store_set_hours", "stores_set_special_days", "tryon_request_detail", "tryon_restock", "tryon_store_shops", "tryon_update",
  // 0061: お問い合わせ（同梱モジュール inquiries）。中で support の項目を確かめる
  "inquiry_admin_get", "inquiry_assign", "inquiry_assignees", "inquiry_attachment_admin_get", "inquiry_delete", "inquiry_reply", "inquiry_set_status",
  "legal_links_record", // 0062: 法務のページの外の URL の確認結果（中で integrations の項目を確かめる）
  "banto_image_options_ok", // 0063: product_images.options の CHECK（値の形を見るだけ）
  "banto_option_axes_ok", // 0065: shops / categories / products の option_axes の CHECK（値の形を見るだけ）
  "option_axes_apply", // 0065: 上の段の SKU の軸を商品に当てる（中で catalog の項目を確かめる）
  "banto_option_names_ok", // 0094: shops.option_names の CHECK（値の形を見るだけ）
  "option_names_set", // 0094: SKU の選択肢の表示名を変える（中で catalog の項目を確かめる）
  "banto_care_codes", // 0127: 洗濯表示の記号番号の表（定数を返すだけ）
  "banto_care_ok", // 0127: products.care / categories.care の CHECK（値の形を見るだけ）
  "banto_care_symbols_ok", // 0127: shops.care_symbols の CHECK（値の形を見るだけ）
  "care_symbols_set", // 0127: 洗濯表示の記号の絵の表を変える（中で catalog の項目を確かめる）
  "banto_option_swatches_ok", // 0115: shops.option_swatches の CHECK（値の形を見るだけ）
  "option_swatches_set", // 0115: 選択肢の値ごとの見本を変える（中で catalog の項目を確かめる）
  "article_positions_set", // 0116: ブログの記事を手で並べる順（中で content の項目を確かめる）
  "size_chart_set", // 0095: 採寸表の 1 つの段を置き換える（中で catalog の項目を確かめる）
  "page_layouts_set", // 0101: 固定ページをトップ・記事のひな形に割り当てる（中で content の項目とショップのページ・ブログかを確かめる）
  "hook_storefront_events_set", // 0107: 連携ごとにお店の行動を渡す許し（中で integrations の項目・マニフェストの範囲を確かめ、監査ログに残す）
  "store_fields_set", // 0126: 実店舗の独自項目の定義（中で組織の owner / admin かを確かめる）
  "product_favorite_counts", // 0123: 商品ごとのお気に入りの人数だけ（中で catalog か customers の項目を確かめる。だれかは返さない）
  "order_annotate", // 0106: 注文の印と社内のメモを書く（中で orders の項目とショップの注文かを確かめる）
  "line_marketing_usage", // 0105: LINE の宣伝のメッセージの今月の数と上限（中で marketing の項目を確かめる）
  "size_chart_get", // 0095: 採寸表の段と表示される結果（中で catalog の項目を確かめる）
  // 0071: テーマの版（中で design の項目を確かめる）
  "theme_preview_audit", "theme_publish", "theme_version_complete", "theme_version_create", "theme_version_delete", "theme_version_set_settings",
  "banto_page_handle_ok", // 0079: pages.handle の CHECK（値の形を見るだけ）
  "app_connect_begin", // 0088: 外部プラグインに「つなぐ」券を作る（中で integrations の項目と、許すスコープが自分の項目までかを確かめる）
  "shop_app_blocks", // 0086: 編集の画面に出すプラグインのブロックの一覧（中で content の項目を確かめる。連携の URL・設定は返さない）
  "product_image_hints_set", // 0063: WooCommerce の取り込みで画像の URL の目印に SKU の options を結ぶ（中で catalog の項目を確かめる）
  "banto_content_image_url_ok", // 0089: pages / articles の image_url の CHECK（値の形を見るだけ）
  "blog_delete", // 0089: ブログを記事ごと消す（中で content の項目を確かめる。blogs / articles の DELETE は運営者の JWT から外した）
]);

/** 列の権限。must: その役割がその列にその権限を持ってはいけない */
const COLUMN_DENIES = [
  { role: "anon", table: "shops", privilege: "SELECT", columns: ["settings", "stripe_account_id", "order_seq", "tryon_seq", "owner_id", "org_id", "legal_links_state"] },
  { role: "anon", table: "customers", privilege: "SELECT", columns: ["id", "email", "password_hash"] },
  { role: "anon", table: "orders", privilege: "SELECT", columns: ["id", "customer_email"] },
  { role: "authenticated", table: "customers", privilege: "SELECT", columns: ["password_hash", "legacy_password_hash", "session_epoch", "password_updated_at", "legacy_password_expires_at"] },
  // 0090: payment_account（返金に使う決済の口座）は confirm_reservation だけが書く
  { role: "authenticated", table: "orders", privilege: "UPDATE", columns: ["total_jpy", "customer_email", "customer_name", "shipping_address", "number", "shop_id", "payment_ref", "amount_paid_jpy", "discount_jpy", "tax_rate", "reservation_id", "customer_id", "payment_account"] },
  { role: "authenticated", table: "shop_oauth_clients", privilege: "SELECT", columns: ["secret_box"] },
  // 0088: 接続の券と署名シークレットの暗号文は運営者にも読ませない
  { role: "authenticated", table: "app_connections", privilege: "SELECT", columns: ["ticket_hash", "secret_box"] },
  { role: "anon", table: "app_connections", privilege: "SELECT", columns: ["ticket_hash", "secret_box"] },
  { role: "authenticated", table: "shop_secret_boxes", privilege: "SELECT", columns: ["secret_box"] },
  // 0055: 非公開の独自項目は anon に見せない。require_mfa は org_set_require_mfa（owner + aal2 + 監査）だけ。AI 用トークンは失効（revoked_at）と name だけ変えられる
  { role: "anon", table: "products", privilege: "SELECT", columns: ["attributes"] },
  { role: "authenticated", table: "organizations", privilege: "UPDATE", columns: ["require_mfa", "id", "created_at"] },
  // 0089: 在庫の正確な数は anon に読ませない（product_public_stock の段階値だけ）。shops の採番・判定だけが書く列は運営者の JWT から UPDATE できない
  { role: "anon", table: "inventory", privilege: "SELECT", columns: ["available"] },
  { role: "authenticated", table: "shops", privilege: "UPDATE", columns: ["inquiry_seq", "order_seq", "tryon_seq", "legal_links_state", "theme_version_id"] },
  // 0094 / 0115 / 0127: 選択肢の名前・見本・洗濯表示の絵は option_names_set / option_swatches_set / care_symbols_set だけが書く
  { role: "authenticated", table: "shops", privilege: "UPDATE", columns: ["option_names", "option_swatches", "care_symbols"] },
  // 0106: 注文の印とメモは order_annotate だけ。0126: 実店舗の独自項目の定義は store_fields_set だけ
  { role: "authenticated", table: "orders", privilege: "UPDATE", columns: ["tags", "note"] },
  { role: "authenticated", table: "organizations", privilege: "UPDATE", columns: ["store_fields"] },
];

/** 表の権限。must: その役割がその表にその権限を持ってはいけない（0055: AI 用トークンの削除は無し。失効は revoked_at） */
const TABLE_DENIES = [
  { role: "authenticated", table: "api_tokens", privilege: "DELETE" },
  // 0089: ページ・記事はゴミ箱と Cron の purge、ブログは blog_delete だけ
  { role: "authenticated", table: "pages", privilege: "DELETE" },
  { role: "authenticated", table: "blogs", privilege: "DELETE" },
  { role: "authenticated", table: "articles", privilege: "DELETE" },
  // 0123: お気に入りは本人だけ（member_favorite_*）。0084: 拡張データは連携のトークンだけ。0105: LINE の記録は Worker だけ。0071: テーマの版は関数だけ
  { role: "authenticated", table: "customer_favorites", privilege: "INSERT" },
  { role: "authenticated", table: "customer_favorites", privilege: "UPDATE" },
  { role: "authenticated", table: "customer_favorites", privilege: "DELETE" },
  { role: "authenticated", table: "app_data", privilege: "INSERT" },
  { role: "authenticated", table: "app_data", privilege: "UPDATE" },
  { role: "authenticated", table: "line_messages", privilege: "INSERT" },
  { role: "authenticated", table: "line_messages", privilege: "UPDATE" },
  { role: "authenticated", table: "theme_versions", privilege: "INSERT" },
  { role: "authenticated", table: "theme_versions", privilege: "UPDATE" },
  { role: "authenticated", table: "theme_versions", privilege: "DELETE" },
];

/**
 * 守りを担うトリガー（0028 / 0031 / 0051 / 0052 / 0055）。後のマイグレーションが drop trigger して戻し忘れると、列の権限だけでは
 * 止まらない経路（orders の遷移・shops の列・AI 用トークンの書き換え・プランの上限・監査ログ）が開く。有効（tgenabled <> 'D'）であること
 */
const REQUIRED_TRIGGERS = [
  ["orders", "orders_guard"], ["shops", "shops_guard"], ["api_tokens", "api_tokens_guard"],
  ["shops", "shops_plan_limit"], ["products", "products_plan_limit"], ["customers", "customers_plan_limit"], ["org_members", "org_members_plan_limit"],
  ["shops", "shops_theme_guard"], // 0071: 公開中のテーマは theme_publish だけが変える
  ["theme_versions", "theme_versions_plan_limit"], // 0073: テーマの版の数のプランの上限
  ["customer_favorites", "customer_favorites_guard"], // 0123: お気に入りは 1 人 200 個まで
  ["organizations", "organizations_store_fields"], // 0126: 実店舗の独自項目の定義の形
  ["stores", "stores_fields_norm"], // 0126: 実店舗の独自項目の値は定義にある鍵だけ・形を整える
  ["pages", "pages_plan_limit"], ["pages", "pages_shop_limit"], ["articles", "articles_plan_limit"], ["articles", "articles_shop_limit"], ["articles", "articles_shape"], ["blogs", "blogs_shop_limit"], // 0081: ブログと記事
  // 0079: ページの数のプランの上限と 1 ショップの上限
  // 0075: SKU・商品の画像・在庫を変えたときの product.updated（連携サイトのキャッシュの入れ替え）
  ["skus", "skus_product_updated"], ["product_images", "product_images_product_updated"], ["inventory", "inventory_product_updated"],
  // 0089: hooks の送信先の URL（私設のアドレス・同梱の内部 URL への書き換え）、テーマの版と AI 用トークンの削除の監査ログ
  ["hook_endpoints", "hook_endpoints_guard"], ["theme_versions", "theme_versions_audit"], ["api_tokens", "api_tokens_audit_delete"],
  // 0051: 監査ログ
  ["shops", "shops_audit"], ["orders", "orders_audit_status"], ["org_members", "org_members_audit_insert"], ["org_members", "org_members_audit_role"], ["org_members", "org_members_audit_delete"],
  ["org_member_shops", "org_member_shops_audit"], ["api_tokens", "api_tokens_audit_insert"], ["api_tokens", "api_tokens_audit_revoke"], ["shops", "shops_audit_theme"],
  ["app_connections", "app_connections_audit_delete"], ["hook_endpoints", "hook_endpoints_audit"],
  // 0106: 社内のメモはマスキングで一緒に消す。0107: お店の行動を渡す許しは hook_storefront_events_set だけ。0110 / 0111: ダイアログの形と連携の結び付け
  ["orders", "orders_mask_note"], ["hook_endpoints", "hook_endpoints_storefront_events_guard"], ["dialogs", "dialogs_guard"], ["dialogs", "dialogs_endpoint_guard"],
  // 0097〜0100: 会員の条件と会員価格の形。表示用の条件は商品に使わせない
  ["products", "products_audience_guard"], ["pages", "pages_audience_guard"], ["articles", "articles_audience_guard"], ["audiences", "audiences_guard"], ["price_rules", "price_rules_guard"],
  // 0053: 1 日のメールの数。0094: 選択肢の鍵。0129: メディアライブラリの数
  ["member_login_challenges", "member_login_challenges_plan_mail"], ["org_invitations", "org_invitations_plan_mail"], ["shops", "shops_option_keys"], ["skus", "skus_00_option_keys"],
  ["page_media", "page_media_shop_limit"],
];

/** 名前に守りの印（_guard / _audit / _plan_ / _norm / _shape / _mask）を含むトリガーは、列挙していなくても全部有効であること */
const GUARD_TRIGGER_RE = /_guard|_audit|_plan_|_norm|_shape|_mask|_shop_limit/;

const client = new pg.Client({ connectionString: url });
await client.connect();
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`NG  ${msg}`);
};

try {
  // ---------- 1. RLS ----------
  const { rows } = await client.query(`
    select c.relname as table_name,
           c.relrowsecurity as rls_enabled,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by c.relname
  `);
  if (rows.length === 0) {
    console.error("check-rls: public スキーマにテーブルがありません。マイグレーションは適用済みですか？");
    process.exit(1);
  }
  for (const r of rows) {
    const bad = !r.rls_enabled || r.policy_count === 0;
    if (bad) failures++;
    console.log(`${bad ? "NG" : "ok"}  ${r.table_name.padEnd(24)} rls=${r.rls_enabled ? "on " : "OFF"}  policies=${r.policy_count}`);
  }
  console.log(`check-rls: ${rows.length} tables`);

  // ---------- 2. 関数の EXECUTE ----------
  for (const [role, allow] of [["anon", ANON_FUNCTIONS], ["authenticated", AUTHENTICATED_FUNCTIONS]]) {
    const r = await client.query(
      `select distinct p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute')
        order by 1`,
      [role],
    );
    const actual = r.rows.map((x) => x.name).filter((n) => !EXTENSION_FUNCTIONS.has(n));
    const extra = actual.filter((n) => !allow.has(n));
    const missing = [...allow].filter((n) => !actual.includes(n));
    for (const n of extra) fail(`${role} が EXECUTE できる関数が allowlist にありません: ${n}（revoke execute ... from public, anon, authenticated を忘れていませんか）`);
    for (const n of missing) fail(`allowlist にある関数を ${role} が EXECUTE できません: ${n}（消した・改名したなら allowlist から外す）`);
    console.log(`check-rls: ${role} executable functions = ${actual.length}${extra.length + missing.length === 0 ? " (ok)" : ""}`);
  }

  // ---------- 3. 列の権限 ----------
  for (const d of COLUMN_DENIES) {
    for (const col of d.columns) {
      const present = await client.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2", [d.table, col]);
      if (present.rowCount === 0) continue; // まだ無い列（古いマイグレーションのテスト）は飛ばす
      const r = await client.query("select has_column_privilege($1, ('public.' || quote_ident($2))::regclass, $3::text, $4) as allowed", [d.role, d.table, col, d.privilege]);
      if (r.rows[0].allowed) fail(`${d.role} が ${d.table}.${col} を ${d.privilege} できます（0028 の列の権限が外れています）`);
    }
  }
  console.log(`check-rls: column privileges checked (${COLUMN_DENIES.length} rules)`);

  // ---------- 4. 表の権限 ----------
  for (const d of TABLE_DENIES) {
    const r = await client.query("select has_table_privilege($1, ('public.' || quote_ident($2))::regclass, $3) as allowed", [d.role, d.table, d.privilege]);
    if (r.rows[0].allowed) fail(`${d.role} が ${d.table} を ${d.privilege} できます（0055 の表の権限が外れています）`);
  }

  // ---------- 5. 守りのトリガー ----------
  for (const [table, trigger] of REQUIRED_TRIGGERS) {
    const r = await client.query(
      `select t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and t.tgname = $2 and not t.tgisinternal`,
      [table, trigger],
    );
    if (r.rowCount === 0) fail(`トリガー ${table}.${trigger} がありません（守りの判定が外れています）`);
    else if (r.rows[0].tgenabled === "D") fail(`トリガー ${table}.${trigger} が無効です`);
  }
  const guards = await client.query(
    `select c.relname as table_name, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal order by 1, 2`,
  );
  let guardCount = 0;
  for (const r of guards.rows) {
    if (!GUARD_TRIGGER_RE.test(r.tgname)) continue;
    guardCount++;
    if (r.tgenabled === "D") fail(`守りのトリガー ${r.table_name}.${r.tgname} が無効です`);
  }
  console.log(`check-rls: required triggers checked (${REQUIRED_TRIGGERS.length} listed, ${guardCount} guard-like)`);

  // ---------- 5b. PUBLIC の EXECUTE ----------
  // PostgreSQL の既定は PUBLIC に EXECUTE が付く。anon / authenticated から剥奪するだけでは足りない（CLAUDE.md §6）
  const pub = await client.query(
    `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
      order by 1`,
  );
  const pubNames = [...new Set(pub.rows.map((x) => x.name))].filter((n) => !EXTENSION_FUNCTIONS.has(n));
  for (const n of pubNames) fail(`PUBLIC が EXECUTE できる関数があります: ${n}（revoke execute ... from public を忘れていませんか）`);
  console.log(`check-rls: public execute checked${pubNames.length === 0 ? " (ok)" : ""}`);

  // ---------- 6. SECURITY DEFINER の search_path ----------
  // 固定していないと、呼び手が search_path に置いた同名のオブジェクトで判定をすり替えられる
  const sd = await client.query(
    `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
      order by 1`,
  );
  for (const r of sd.rows) if (!EXTENSION_FUNCTIONS.has(r.name)) fail(`SECURITY DEFINER 関数 ${r.name} に set search_path がありません`);
  console.log("check-rls: security definer search_path checked");

  if (failures > 0) {
    console.error(`\ncheck-rls: ${failures} problem(s)`);
    process.exit(1);
  }
  console.log("\ncheck-rls: ok");
} finally {
  await client.end();
}
