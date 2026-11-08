import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0129_security_hardening_5: 守りの締め直し 5。
 * - shops.settings の鍵ごとに要る項目（モジュールの ON/OFF・ひな形・独自項目の定義・上限と公開は owner / admin）、上限は 1 未満を受けない
 * - 二段階認証の解除は、相手がどこかで owner なら自分がその組織の owner のときだけ。相手の全組織に監査
 * - 大きさと数の上限（説明・settings・マニフェスト・メディアライブラリ）
 * - 監査ログ（送信先の変更と削除・ブログの削除・ひな形・実店舗の独自項目の定義）
 * - hooks の URL の検査（末尾のドット・8 進の IPv4・CGNAT）、つないだ連携の URL は変えられない、page_media の url は鍵を指すものだけ
 * - 会員限定の商品の予約、検索語のエスケープ、パスキーの 15 分、セッションの id の必須、enqueue_hook の id、PUBLIC の EXECUTE
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し 5（0129_security_hardening_5）", () => {
  let f: Fixture;
  let orgId: string;
  let settingsOnly: string;
  let marketingOnly: string;
  let contentOnly: string;
  let intOnly: string;
  let catalogOnly: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const invite = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
    await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    return uid;
  };
  const patch = (uid: string, settings: J) => asUser(uid, (c) => c.query("update shops set settings = settings || $2::jsonb where id = $1", [f.shopId, JSON.stringify(settings)]));
  const auditCount = async (action: string) => (await getPool().query<{ n: number }>("select count(*)::int as n from audit_log where action = $1", [action])).rows[0]!.n;
  const issue = async (uid: string, scopes: string[]) => {
    const raw = `banto_${randomUUID()}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, uid, hash(raw), raw.slice(0, 12), scopes]));
    return hash(raw);
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "h5-owner@example.com", slug: "h5-shop", publish: true, stock: 50 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    settingsOnly = await invite("h5-settings@example.com", ["settings"]);
    marketingOnly = await invite("h5-marketing@example.com", ["marketing", "settings"]);
    contentOnly = await invite("h5-content@example.com", ["content", "settings"]);
    intOnly = await invite("h5-int@example.com", ["integrations", "settings"]);
    catalogOnly = await invite("h5-catalog@example.com", ["catalog"]);
  });
  afterAll(closePool);

  // ---------- 1. settings の鍵ごとの項目 ----------
  it("settings だけの member は、公開・モジュールの ON/OFF・ひな形・独自項目の定義・回数の上限・お店の画面の使い方を変えられない", async () => {
    expect(await expectDbError(() => asUser(settingsOnly, (c) => c.query("update shops set published = false where id = $1", [f.shopId])))).toMatch(/admin_required/);
    expect(await expectDbError(() => patch(settingsOnly, { modules: { coupons: true } }))).toMatch(/marketing_required/);
    expect(await expectDbError(() => patch(settingsOnly, { modules: { inquiries: true } }))).toMatch(/support_required/);
    expect(await expectDbError(() => patch(settingsOnly, { modules: { event_relay: true } }))).toMatch(/integrations_required/);
    expect(await expectDbError(() => patch(settingsOnly, { page_layouts: { home: "x" } }))).toMatch(/content_required/);
    expect(await expectDbError(() => patch(settingsOnly, { product_fields: [{ key: "secret", label: "s", type: "text", public: true }] }))).toMatch(/catalog_required/);
    expect(await expectDbError(() => patch(settingsOnly, { customer_fields: [{ key: "rank", label: "r", type: "text" }] }))).toMatch(/customers_required/);
    for (const bad of [{ members_login_limits: { per_ip_per_hour: 9999 } }, { order_lookup: { per_hour: 0 } }, { checkout: { max_pending_per_ip: 9999 } }, { storefront: { mode: "off", external_url: "https://evil.example/" } }, { members_password: true }, { line_marketing_limit: 999999 }]) {
      expect(await expectDbError(() => patch(settingsOnly, bad)), JSON.stringify(bad)).toMatch(/admin_required/);
    }
    // 自分の領分（settings の項目で足りる鍵）は変えられる
    await patch(settingsOnly, { low_stock_threshold: 5, shipping: { mode: "flat", flat_fee_jpy: 500 } });
    const s = (await getPool().query<{ settings: J }>("select settings from shops where id = $1", [f.shopId])).rows[0]!.settings;
    expect(s["low_stock_threshold"]).toBe(5);
  });

  it("モジュールの ON/OFF はそのモジュールの項目、ひな形は content、連携は integrations。owner は何でも", async () => {
    // jsonb の || は浅いので、modules は今の値に重ねて送る（変えていない鍵は見ない）
    const modules = async (uid: string, changes: J) => {
      const cur = ((await getPool().query<{ m: J | null }>("select settings->'modules' as m from shops where id = $1", [f.shopId])).rows[0]!.m ?? {}) as J;
      return patch(uid, { modules: { ...cur, ...changes } });
    };
    await modules(marketingOnly, { coupons: true, dialogs: true });
    expect(await expectDbError(() => modules(marketingOnly, { pages: true }))).toMatch(/content_required/);
    await modules(contentOnly, { pages: true, blog: true });
    expect(await expectDbError(() => modules(contentOnly, { coupons: false }))).toMatch(/marketing_required/);
    // 変えていない鍵（coupons・dialogs は true のまま）は見ない
    await modules(contentOnly, { blog: false });
    await modules(intOnly, { event_relay: true });
    await patch(intOnly, { headless: { return_origins: ["https://wp.example.com"] } });
    await asUser(f.ownerId, (c) => c.query("update shops set published = false, settings = settings || jsonb_build_object('members_login_limits', '{\"per_ip_per_hour\": 50}'::jsonb, 'modules', (settings->'modules') || '{\"inquiries\": true}'::jsonb) where id = $1", [f.shopId]));
    await asUser(f.ownerId, (c) => c.query("update shops set published = true where id = $1", [f.shopId]));
  });

  it("回数の上限は 1〜9999 だけ。0 や負の値は既定に戻る", async () => {
    await getPool().query("update shops set settings = settings || '{\"order_lookup\": {\"per_hour\": 0}, \"checkout\": {\"max_pending_per_ip\": -5}}' where id = $1", [f.shopId]);
    expect(await rpc<number>("banto_shop_limit", [f.shopId, "order_lookup", "per_hour", 30])).toBe(30);
    expect(await rpc<number>("banto_shop_limit", [f.shopId, "checkout", "max_pending_per_ip", 20])).toBe(20);
    await getPool().query("update shops set settings = settings || '{\"order_lookup\": {\"per_hour\": 7}}' where id = $1", [f.shopId]);
    expect(await rpc<number>("banto_shop_limit", [f.shopId, "order_lookup", "per_hour", 30])).toBe(7);
  });

  it("AI 用 API（shop:write）の公開の切り替えと上限は、発行者が owner / admin のときだけ", async () => {
    // トークンを出せるのは integrations の項目を持つ人。intOnly は settings も持つが owner / admin ではない
    const tok = await issue(intOnly, ["shop:read", "shop:write"]);
    expect(await expectDbError(() => rpc("api_shop_update", [tok, JSON.stringify({ published: false })]))).toMatch(/admin_required/);
    expect(await expectDbError(() => rpc("api_shop_update", [tok, JSON.stringify({ login_per_ip_per_hour: 9999 })]))).toMatch(/admin_required/);
    expect(await expectDbError(() => rpc("api_shop_update", [tok, JSON.stringify({ max_pending_per_ip: 9999 })]))).toMatch(/admin_required/);
    await rpc("api_shop_update", [tok, JSON.stringify({ low_stock_threshold: 9 })]);
    const owner = await issue(f.ownerId, ["shop:read", "shop:write"]);
    await rpc("api_shop_update", [owner, JSON.stringify({ login_per_ip_per_hour: 40 })]);
    expect(await rpc<number>("banto_shop_limit", [f.shopId, "members_login_limits", "per_ip_per_hour", 10])).toBe(40);
  });

  // ---------- 2. 二段階認証の解除 ----------
  it("別の組織で owner の人の二段階認証は、その組織の owner でなければ外せない。外したら相手の全組織に監査", async () => {
    const as = (uid: string, sql: string, params: unknown[] = []) => withRole("authenticated", { sub: uid, aal: "aal2" }, async (c) => (await c.query(sql, params)).rows);
    const admin = await createAuthUser("h5-admin@example.com");
    const victim = await createAuthUser("h5-victim@example.com");
    const other = await createShopFixture({ email: "h5-other@example.com", slug: "h5-other" });
    const otherOrg = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [other.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member'), ($4, $3, 'owner')", [orgId, admin, victim, otherOrg]);
    expect(await expectDbError(() => as(admin, "select org_member_mfa_reset_authorize($1)", [victim]))).toMatch(/forbidden/);
    expect(await expectDbError(() => as(f.ownerId, "select org_member_mfa_reset_authorize($1)", [victim]))).toMatch(/forbidden/);
    // 相手が owner でない組織のメンバーなら外せ、相手の全組織に残る
    const plain = await createAuthUser("h5-plain@example.com");
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member'), ($3, $2, 'member')", [orgId, plain, otherOrg]);
    expect(await as(admin, "select org_member_mfa_reset_authorize($1) as ok", [plain])).toEqual([{ ok: true }]);
    const rows = await getPool().query<{ org_id: string }>("select org_id from audit_log where action = 'org_member.mfa_reset' and target_id = $1 order by org_id", [plain]);
    expect(rows.rows.map((r) => r.org_id).sort()).toEqual([orgId, otherOrg].sort());
  });

  // ---------- 3. 大きさの上限 ----------
  it("商品の説明は 50,000 字、settings とマニフェストは 64 KiB まで", async () => {
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set description = repeat('あ', 50001) where id = $1", [f.productId])))).toMatch(/products_description_len/);
    await asUser(f.ownerId, (c) => c.query("update products set description = repeat('あ', 50000) where id = $1", [f.productId]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update shops set settings = settings || jsonb_build_object('note', repeat('x', 70000)) where id = $1", [f.shopId])))).toMatch(/shops_settings_size/);
    const ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'ext', 'https://vendor.example/hooks', '{order.shipped}') returning id", [f.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update hook_endpoints set manifest = jsonb_build_object('name', repeat('x', 70000)) where id = $1", [ep])))).toMatch(/hook_endpoints_manifest_size/);
  });

  // ---------- 4. 数の上限 ----------
  it("メディアライブラリは 1 ショップあたりの数に上限", async () => {
    const max = (await getPool().query<{ n: number }>("select banto_page_media_max() as n")).rows[0]!.n;
    expect(max).toBe(2000);
    await getPool().query("update shops set settings = settings || '{\"modules\": {\"pages\": true}}' where id = $1", [f.shopId]);
    await getPool().query(
      "insert into page_media (shop_id, storage_key, url) select $1::uuid, 'pages/' || $1::text || '/' || i || '.webp', '/media/pages/' || $1::text || '/' || i || '.webp' from generate_series(1, $2::int) i",
      [f.shopId, max],
    );
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into page_media (shop_id, storage_key, url) values ($1::uuid, 'pages/' || $1::text || '/last.webp', '/media/pages/' || $1::text || '/last.webp')", [f.shopId])))).toMatch(/page_media_full/);
    await getPool().query("delete from page_media where shop_id = $1", [f.shopId]);
  });

  // ---------- 5. 監査ログ ----------
  it("送信先の変更と削除・ブログの削除・ひな形の割り当て・実店舗の独自項目の定義が監査ログに残る（個人情報は入らない）", async () => {
    const ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'crm', 'https://crm.example/hooks', '{order.shipped}') returning id", [f.shopId]))).rows[0]!.id;
    const before = await auditCount("hook_endpoint.changed");
    await asUser(intOnly, (c) => c.query("update hook_endpoints set url = 'https://other.example/hooks', enabled = false where id = $1", [ep]));
    expect(await auditCount("hook_endpoint.changed")).toBe(before + 1);
    const row = (await getPool().query<{ detail: J; shop_id: string }>("select detail, shop_id from audit_log where action = 'hook_endpoint.changed' order by id desc limit 1")).rows[0]!;
    expect(row.shop_id).toBe(f.shopId);
    expect(row.detail).toMatchObject({ host_from: "crm.example", host_to: "other.example", enabled: false, name: "crm" });
    // マニフェストの取り直し（service_role）は残さない
    await asService((c) => c.query("update hook_endpoints set manifest = '{\"name\": \"x\"}' where id = $1", [ep]));
    expect(await auditCount("hook_endpoint.changed")).toBe(before + 1);
    await asUser(intOnly, (c) => c.query("delete from hook_endpoints where id = $1", [ep]));
    expect(await auditCount("hook_endpoint.deleted")).toBe(1);

    await getPool().query("update shops set settings = settings || '{\"modules\": {\"pages\": true, \"blog\": true}}' where id = $1", [f.shopId]);
    const blog = (await asUser(contentOnly, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'news', 'News') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(contentOnly, (c) => c.query("select blog_delete($1, $2)", [f.shopId, blog]));
    expect(await auditCount("blog.deleted")).toBe(1);
    const page = (await asUser(contentOnly, (c) => c.query<{ id: string }>("insert into pages (shop_id, handle, title, body) values ($1, 'home', 'Home', 'x') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(contentOnly, (c) => c.query("select page_layouts_set($1, $2::jsonb)", [f.shopId, JSON.stringify({ home: page })]));
    expect(await auditCount("shop.page_layouts_changed")).toBe(1);
    await asUser(f.ownerId, (c) => c.query("select store_fields_set($1, $2::jsonb)", [orgId, JSON.stringify([{ key: "floor", label: "階", type: "text" }])]));
    expect(await auditCount("org.store_fields_changed")).toBe(1);
    const detail = (await getPool().query<{ detail: J }>("select detail from audit_log where action = 'org.store_fields_changed' order by id desc limit 1")).rows[0]!.detail;
    expect(detail).toEqual({ keys: ["floor"] });
  });

  // ---------- 6. hooks の URL ----------
  it("hooks の送信先: 末尾のドットの localhost・先頭 0 の IPv4・CGNAT は受けない", async () => {
    const ins = (url: string) => asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', $2, '{}')", [f.shopId, url]));
    for (const bad of ["http://localhost./hook", "http://0177.0.0.1/hook", "http://010.1.1.1/hook", "http://100.64.1.1/hook", "http://198.18.0.1/hook", "http://192.0.0.9/hook", "http://a.internal./hook"]) {
      expect(await expectDbError(() => ins(bad)), bad).toMatch(/invalid_url/);
    }
    await ins("https://plugin.example./hook");
    await ins("http://93.184.216.34/hook");
  });

  // ---------- 7. つないだ連携の URL ----------
  it("つないだ連携の送信先は、ホストが変わる更新を受けない（パスは変えられる）", async () => {
    const ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'reviews', 'https://vendor.example/hooks/a', '{order.shipped}', 'reviews') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("select app_connect_begin($1, $2, $3, $4)", [f.shopId, ep, ["app_data:write"], hash("ticket-1")]));
    await asService((c) => c.query("select app_connect_exchange($1, $2, $3, $4)", [hash("ticket-1"), hash("tok-1"), "banto_tok1", "v1.aaaa.bbbb"]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update hook_endpoints set url = 'https://other-vendor.example/hooks/a' where id = $1", [ep])))).toMatch(/app_connected_url_locked/);
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set url = 'https://vendor.example/hooks/b' where id = $1", [ep]));
    expect((await getPool().query("select 1 from app_connections where endpoint_id = $1", [ep])).rowCount).toBe(1);
  });

  // ---------- 8. page_media の url ----------
  it("page_media の url は置き場の鍵を指すものだけ", async () => {
    const tok = await issue(f.ownerId, ["content:write"]);
    const key = `pages/${f.shopId}/abc.webp`;
    expect(await expectDbError(() => rpc("api_page_media_add", [tok, key, "https://evil.example/pages/other/x.png"]))).toMatch(/invalid_url/);
    expect(await expectDbError(() => rpc("api_page_media_add", [tok, key, "javascript:alert(1)"]))).toMatch(/invalid_url/);
    const r = await rpc<J>("api_page_media_add", [tok, key, `https://media.example/${key}`]);
    expect(r["url"]).toBe(`https://media.example/${key}`);
    await rpc<J>("api_page_media_add", [tok, `pages/${f.shopId}/def.webp`, `/media/pages/${f.shopId}/def.webp`]);
  });

  // ---------- 9. 会員限定の商品の予約 ----------
  it("会員限定の商品は、条件に合う会員だけが予約できる（ゲスト・合わない会員は sku_not_available）", async () => {
    const pool = getPool();
    await pool.query("update shops set settings = settings || jsonb_build_object('modules', (settings->'modules') || '{\"audiences\": true}'::jsonb, 'customer_fields', $2::jsonb, 'members_enabled', true) where id = $1", [f.shopId, JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }])]);
    const gold = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', $2) returning id", [f.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })])).rows[0]!.id;
    const p = (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, audience_id, audience_mode) values ($1, 'vip', 'VIP', true, $2, 'buy') returning id", [f.shopId, gold])).rows[0]!.id;
    const k = (await pool.query<{ id: string }>("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'VIP-1', 5000) returning id", [f.shopId, p])).rows[0]!.id;
    await pool.query("update inventory set available = 3 where sku_id = $1", [k]);
    const goldCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'g@example.com', '{\"rank\":\"gold\"}') returning id", [f.shopId])).rows[0]!.id;
    const silverCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 's@example.com', '{\"rank\":\"silver\"}') returning id", [f.shopId])).rows[0]!.id;
    const items = JSON.stringify([{ sku_id: k, qty: 1 }]);
    const reserve = (cid: string | null) => rpc<string>("reserve_stock", [f.shopId, items, 900, null, null, null, cid]);
    expect(await expectDbError(() => reserve(null))).toMatch(/sku_not_available/);
    expect(await expectDbError(() => reserve(silverCid))).toMatch(/sku_not_available/);
    expect(await reserve(goldCid)).toBeTruthy();
    // 条件の無い商品は今までどおり（会員 id が無くても）
    expect(await rpc<string>("reserve_stock", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), 900, null, null, null, null])).toBeTruthy();
    // お店で試着も同じ
    const store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '本店') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id, tryon) values ($1, $2, true)", [f.shopId, store]));
    const tryon = (cid: string | null) => rpc<J>("tryon_request", [f.shopId, store, items, JSON.stringify({ customer_email: "t@example.com", customer_id: cid }), null]);
    expect(await expectDbError(() => tryon(null))).toMatch(/sku_not_available/);
    expect(await expectDbError(() => tryon(silverCid))).toMatch(/sku_not_available/);
    expect((await tryon(goldCid))["number"]).toBeTruthy();
  });

  // ---------- 10. 検索語 ----------
  it("api_orders_list の検索語の % と _ はそのままの文字として探す", async () => {
    const tok = await issue(f.ownerId, ["orders:read", "orders:pii"]);
    const r = await rpc<J>("api_orders_list", [tok, null, null, null, 10, 0, "%"]);
    expect(r["total"]).toBe(0);
    const r2 = await rpc<J>("api_orders_list", [tok, null, null, null, 10, 0, "_"]);
    expect(r2["total"]).toBe(0);
  });

  // ---------- 11. パスキーの 15 分 ----------
  it("パスキーの登録と追加の券は authenticated_at で 15 分を数える（作り直した行の created_at では若返らない）", async () => {
    const pool = getPool();
    await pool.query("update shops set domain = 'h5.example' where id = $1", [f.shopId]);
    await pool.query("update shops set settings = settings || jsonb_build_object('modules', (settings->'modules') || '{\"passkey\": true}'::jsonb) where id = $1", [f.shopId]);
    const cid = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'pk@example.com') returning id", [f.shopId])).rows[0]!.id;
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    const web = await rpc<string>("member_session_start", [f.shopId, cid, 0, "web", "x", 3600, old]);
    const api = await rpc<string>("member_session_start", [f.shopId, cid, 0, "api", "x", 3600, old]);
    expect(await rpc<J>("member_passkey_begin", [f.shopId, "register", hash("c1"), null, cid, 0, web])).toMatchObject({ ok: false, reason: "reauth" });
    expect(await rpc<J>("member_passkey_ticket_create", [f.shopId, cid, 0, api, hash("t1")])).toMatchObject({ ok: false, reason: "reauth" });
    const fresh = await rpc<string>("member_session_start", [f.shopId, cid, 0, "web", "x", 3600, null]);
    expect(await rpc<J>("member_passkey_begin", [f.shopId, "register", hash("c2"), null, cid, 0, fresh])).toMatchObject({ ok: true });
  });

  // ---------- 13. enqueue_hook ----------
  it("運営者の JWT からの enqueue_hook は、ペイロードの id がそのショップの行のときだけ", async () => {
    const other = await createShopFixture({ email: "h5-other2@example.com", slug: "h5-other2", publish: true });
    await asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'ext2', 'https://vendor2.example/hooks', '{product.updated,order.shipped}')", [f.shopId]));
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("select enqueue_hook($1, 'product.updated', $2::jsonb)", [f.shopId, JSON.stringify({ product_id: other.productId })])))).toMatch(/invalid_payload/);
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("select enqueue_hook($1, 'product.updated', $2::jsonb)", [f.shopId, JSON.stringify({ product_id: randomUUID() })])))).toMatch(/invalid_payload/);
    const n = (await asUser(catalogOnly, (c) => c.query<{ n: number }>("select enqueue_hook($1, 'product.updated', $2::jsonb) as n", [f.shopId, JSON.stringify({ product_id: f.productId })]))).rows[0]!.n;
    expect(n).toBe(1);
  });

  // ---------- 14. PUBLIC の EXECUTE ----------
  it("PUBLIC に EXECUTE が残る関数が無い（anon は今までどおり shop_public_get を呼べる）", async () => {
    const pub = await getPool().query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'banto_%' or p.proname like 'shop_public_%')
          and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`,
    );
    expect(pub.rows.filter((r) => r.name.startsWith("banto_") || r.name.startsWith("shop_public_")).map((r) => r.name)).toEqual([]);
    const r = await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get($1, null) as r", ["h5-shop"])).rows[0]!.r);
    expect(r?.["slug"]).toBe("h5-shop");
  });
});
