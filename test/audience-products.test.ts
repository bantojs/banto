import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, checkout, memberLogin, memberMail } from "./helpers";
import { FakeStripe } from "./fake-stripe";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { issueTokens } from "../src/members/auth";

/** 会員限定の商品（0098、docs/audiences.md「会員限定の商品」）: お店の画面・カート・ヘッドレス・管理画面 */

const GOLD = "11111111-1111-4111-8111-111111111111";
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup(opts: { applied?: string[]; modules?: Record<string, boolean>; stripe?: FakeStripe } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", ...(opts.stripe ? { stripe_account_id: "acct_connected" } : {}), settings: { members_enabled: true, modules: opts.modules ?? { audiences: true }, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }], headless: { return_origins: ["https://wp.example.com"] } } });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  const add = (slug: string, fields: Record<string, unknown>) => {
    const p = sb.addProduct(shop.id, { slug, name: slug.toUpperCase(), published: true, ...fields });
    const k = sb.addSku(shop.id, p.id, { code: `${slug}-1`, price_jpy: 5000, available: 3 });
    return { p, k };
  };
  const tee = add("tee", {});
  const vip = add("vip", { audience_id: GOLD, audience_mode: "hide" });
  const early = add("early", { audience_id: GOLD, audience_mode: "buy" });
  const secret = add("secret", { audience_id: GOLD, audience_mode: "hide", audience_hide: true });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "silver@example.com", session_epoch: 0, attributes: { rank: "silver" } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, opts.stripe);
  return { sb, shop, app, mail, tee, vip, early, secret };
}

describe("会員限定の商品の予約（reserve_stock の会員 id）", () => {
  it("合う会員は予約でも会員 id を渡して確かめる。0129 が当たるまでの DB には渡さない（会員の注文が止まらない）", async () => {
    for (const applied of [undefined, BUNDLED_MIGRATIONS.filter((m) => m !== "0129_security_hardening_5")]) {
      const stripe = new FakeStripe();
      const { app, mail, sb, vip } = setup({ stripe, ...(applied ? { applied } : {}) });
      const gold = new Browser(app, BASE);
      await memberLogin(gold, mail, "/my-shop", "gold@example.com");
      await gold.post("/my-shop/cart/add", { sku_id: vip.k.id, qty: "1" });
      const res = await checkout(gold, "/my-shop");
      expect(res.status, applied ? "0129 の前" : "0129 の後").toBe(303);
      expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect(sb.tables.reservations).toHaveLength(1);
      expect(sb.tables.reservations[0]!["customer_id"]).toBeTruthy();
    }
  });
});

describe("お店の画面", () => {
  it("ゲスト: 見せない商品は一覧に出ず、URL では「会員の方だけ」（存在も隠す商品は 404）。buy の商品は見えるが買えない", async () => {
    const { app, early } = setup();
    const b = new Browser(app, BASE);
    const top = await (await b.get("/my-shop")).text();
    expect(top).toContain("/my-shop/products/tee");
    expect(top).toContain("/my-shop/products/early");
    expect(top).not.toContain("/my-shop/products/vip");
    const gate = await b.get("/my-shop/products/vip");
    expect(gate.status).toBe(200);
    const gh = await gate.text();
    expect(gh).toContain("会員の方だけ購入できます");
    expect(gh).not.toContain("VIP");
    expect(gh).toContain('content="noindex');
    expect((await b.get("/my-shop/products/secret")).status).toBe(404);
    const eh = await (await b.get("/my-shop/products/early")).text();
    expect(eh).toContain("data-members-only");
    expect(eh).toContain('href="/my-shop/account/login"');
    // カートに入れようとしても入らない
    const r = await b.post("/my-shop/cart/add", { sku_id: early.k.id, qty: "1" });
    expect(r.headers.get("location")).toBe("/my-shop/products/early");
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("EARLY");
  });

  it("合う会員: 一覧・詳細に出て買える。合わない会員: 見せない商品は 404、buy の商品は「対象の会員の方だけ」", async () => {
    const { app, mail, vip, early } = setup();
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    expect(await (await gold.get("/my-shop")).text()).toContain("/my-shop/products/vip");
    expect(await (await gold.get("/my-shop/products/vip")).text()).toContain("カートに入れる");
    await gold.post("/my-shop/cart/add", { sku_id: vip.k.id, qty: "1" });
    await gold.post("/my-shop/cart/add", { sku_id: early.k.id, qty: "1" });
    const cart = await (await gold.get("/my-shop/cart")).text();
    expect(cart).toContain("VIP");
    expect(cart).toContain("EARLY");
    const silver = new Browser(app, BASE);
    await memberLogin(silver, mail, "/my-shop", "silver@example.com");
    expect((await silver.get("/my-shop/products/vip")).status).toBe(404);
    expect(await (await silver.get("/my-shop")).text()).not.toContain("/my-shop/products/vip");
    expect(await (await silver.get("/my-shop/products/early")).text()).toContain("対象の会員の方だけ購入できます");
    expect((await silver.post("/my-shop/cart/add", { sku_id: early.k.id, qty: "1" })).headers.get("location")).toBe("/my-shop/products/early");
  });

  it("モジュールが OFF なら会員の読み取りの経路を使わない（見せない商品はだれにも出ない）", async () => {
    for (const o of [{ modules: {} }]) {
      const { app, mail } = setup(o);
      const gold = new Browser(app, BASE);
      await memberLogin(gold, mail, "/my-shop", "gold@example.com");
      expect(await (await gold.get("/my-shop")).text()).not.toContain("/my-shop/products/vip");
    }
  });
});

describe("ヘッドレス", () => {
  it("会員トークンで見せない商品も読める。ゲストは 403 members_only / 存在も隠す商品は 404。カートは会員だけ", async () => {
    const { app, shop, sb, early } = setup();
    const goldId = String(sb.tables.customers.find((c) => c["email"] === "gold@example.com")!["id"]);
    const sid = crypto.randomUUID();
    sb.memberSessions.push({ id: sid, shop_id: shop.id, customer_id: goldId, session_epoch: 0, kind: "api", label: null, refresh_gen: 0, rotated_at: null, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: Date.now() + 3600_000, revoked_at: null });
    const tok = (await issueTokens("test-session-secret", shop.id, goldId, 0, { sid, gen: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600 })).access_token;
    const get = (path: string, token?: string) => app.request(`${BASE}/api/shops/my-shop${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get("/products/vip")).status).toBe(403);
    expect((await get("/products/secret")).status).toBe(404);
    const g = (await (await get("/products/vip", tok)).json()) as { product: { members_only: boolean; purchasable: boolean } };
    expect(g.product).toMatchObject({ members_only: true, purchasable: true });
    const e = (await (await get("/products/early")).json()) as { product: { purchasable: boolean } };
    expect(e.product.purchasable).toBe(false);
    const list = (await (await get("/products", tok)).json()) as { products: { slug: string }[] };
    expect(list.products.map((i) => i.slug)).toContain("vip");
    expect(((await (await get("/products")).json()) as { products: { slug: string }[] }).products.map((i) => i.slug)).not.toContain("vip");
    const cart = (body: unknown, token?: string) => app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await cart({ op: "add", sku_id: early.k.id, qty: 1 })).status).toBe(403);
    expect((await cart({ op: "add", sku_id: early.k.id, qty: 1 }, tok)).status).toBe(200);
  });
});

describe("管理画面", () => {
  it("商品の「会員限定」の欄: 条件・扱い・存在も隠す。表示用の条件は選択肢に出ない。存在も隠すだけ付ければ「見せない」", async () => {
    const { app, shop, sb, tee } = setup();
    sb.tables.audiences.push({ id: "22222222-2222-4222-8222-222222222222", shop_id: shop.id, name: "LP", condition: { param: "ref", set: true } });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products/${tee.p.id}`;
    const html = await (await b.get(base)).text();
    expect(html).toContain('name="audience_id"');
    expect(html).toContain(`<option value="${GOLD}">ゴールド</option>`);
    expect(html).not.toContain(">LP</option>");
    await b.post(base, { name: "TEE", slug: "tee", published: "on", audience_present: "1", audience_id: GOLD, audience_mode: "buy", audience_hide: "on" });
    const row = sb.tables.products.find((p) => p["id"] === tee.p.id)!;
    expect(row).toMatchObject({ audience_id: GOLD, audience_mode: "hide", audience_hide: true });
    await b.post(base, { name: "TEE", slug: "tee", published: "on", audience_present: "1", audience_id: "", audience_mode: "hide" });
    expect(sb.tables.products.find((p) => p["id"] === tee.p.id)!["audience_id"]).toBeNull();
    // 欄の無い送信（モジュールが OFF の画面など）は列に触れない
    row["audience_id"] = GOLD;
    await b.post(base, { name: "TEE", slug: "tee", published: "on" });
    expect(sb.tables.products.find((p) => p["id"] === tee.p.id)!["audience_id"]).toBe(GOLD);
  });
});
