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
  "coupon_claim_info", "heartbeat_age_seconds", "lookup_order", "shop_payment_options", "shop_public_get", "shop_public_list", "shop_store_list",
  // 0054: PostgREST がすべてのリクエストの前に、リクエストの役割のまま呼ぶ（中身は JWT を読むだけ。anon には何もしない）
  "banto_mfa_state", "banto_pre_request",
  // 0055: 商品詳細（公開中の商品だけ。attributes は公開の項目だけ）
  "product_public_get",
  // 0058: 商品の一覧（公開中のショップの公開中の商品だけ。attributes・説明は返さない）とタグ・カテゴリーの件数。検索の式インデックスの関数
  "product_public_list", "product_public_facets", "banto_product_search_text",
]);

/** authenticated（運営者・スタッフの JWT）が呼べる関数。anon の分を含む */
const AUTHENTICATED_FUNCTIONS = new Set([
  ...ANON_FUNCTIONS,
  "banto_admin_shop", "banto_my_shops", "banto_my_stores", "banto_admin_me", "admin_session_bump",
  "coupon_grant_revoke", "coupon_grants_for_emails", "coupon_grants_issue", "coupon_stats", "coupon_stats_for",
  "enqueue_hook", "import_catalog", "import_coupon_usage", "import_coupons", "import_orders", "import_tax_classes", "mask_customer", "member_set_email", "member_passkeys_reset", "customer_set_attributes", "customer_marketing_consent_withdraw",
  "org_invitation_accept", "org_invitation_revoke", "org_invite", "org_member_remove", "org_member_set", "org_members_list",
  "image_import_cancel", "image_import_enqueue", "image_import_resolve", "image_import_retry", "image_import_summary", "site_settings_set",
  "org_set_require_mfa", "org_members_mfa", "org_member_mfa_reset_authorize", // 0054: 中で組織の owner / admin を確かめる
  "org_member_mfa_self", // 0057: 自分の二段階認証の登録・解除を監査ログに（auth.uid() の分だけ）
  "banto_plan_usage", // 0052: プランの上限と使用量（中で組織の owner / admin を確かめる）
  "sales_summary", "set_stock", "ship_orders", "shop_oauth_client_delete", "shop_oauth_client_save", "shop_secret_save",
  "store_set_hours", "stores_set_special_days", "tryon_request_detail", "tryon_restock", "tryon_store_shops", "tryon_update",
]);

/** 列の権限。must: その役割がその列にその権限を持ってはいけない */
const COLUMN_DENIES = [
  { role: "anon", table: "shops", privilege: "SELECT", columns: ["settings", "stripe_account_id", "order_seq", "tryon_seq", "owner_id", "org_id"] },
  { role: "anon", table: "customers", privilege: "SELECT", columns: ["id", "email", "password_hash"] },
  { role: "anon", table: "orders", privilege: "SELECT", columns: ["id", "customer_email"] },
  { role: "authenticated", table: "customers", privilege: "SELECT", columns: ["password_hash", "legacy_password_hash", "session_epoch", "password_updated_at", "legacy_password_expires_at"] },
  { role: "authenticated", table: "orders", privilege: "UPDATE", columns: ["total_jpy", "customer_email", "customer_name", "shipping_address", "number", "shop_id", "payment_ref", "amount_paid_jpy", "discount_jpy", "tax_rate", "reservation_id", "customer_id"] },
  { role: "authenticated", table: "shop_oauth_clients", privilege: "SELECT", columns: ["secret_box"] },
  { role: "authenticated", table: "shop_secret_boxes", privilege: "SELECT", columns: ["secret_box"] },
  // 0055: 非公開の独自項目は anon に見せない。require_mfa は org_set_require_mfa（owner + aal2 + 監査）だけ。AI 用トークンは失効（revoked_at）と name だけ変えられる
  { role: "anon", table: "products", privilege: "SELECT", columns: ["attributes"] },
  { role: "authenticated", table: "organizations", privilege: "UPDATE", columns: ["require_mfa", "id", "created_at"] },
];

/** 表の権限。must: その役割がその表にその権限を持ってはいけない（0055: AI 用トークンの削除は無し。失効は revoked_at） */
const TABLE_DENIES = [{ role: "authenticated", table: "api_tokens", privilege: "DELETE" }];

/**
 * 守りを担うトリガー（0028 / 0031 / 0051 / 0052 / 0055）。後のマイグレーションが drop trigger して戻し忘れると、列の権限だけでは
 * 止まらない経路（orders の遷移・shops の列・AI 用トークンの書き換え・プランの上限・監査ログ）が開く。有効（tgenabled <> 'D'）であること
 */
const REQUIRED_TRIGGERS = [
  ["orders", "orders_guard"], ["shops", "shops_guard"], ["api_tokens", "api_tokens_guard"],
  ["shops", "shops_plan_limit"], ["products", "products_plan_limit"], ["customers", "customers_plan_limit"], ["org_members", "org_members_plan_limit"],
];

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
  console.log(`check-rls: required triggers checked (${REQUIRED_TRIGGERS.length})`);

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
