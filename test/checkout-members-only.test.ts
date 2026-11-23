import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, memberLogin, memberMail, quoteFrom } from "./helpers";
import { CHECKOUT_MEMBERS_ONLY_MIGRATION, checkoutMembersOnly } from "../src/commerce/checkout";

/** 注文は会員だけ（ショップの設定 checkout_members_only、0165）。DB の判定は test/db/checkout-members-only.test.ts */
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  externalHosts.clear();
});

function setup(settings: Record<string, unknown> = { members_enabled: true, checkout_members_only: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "member@example.com", session_epoch: 0, attributes: {} });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, new FakeStripe());
  return { sb, shop, sku, mail, app, b: new Browser(app) };
}
const LOGIN = "/my-shop/account/login?return_to=%2Fmy-shop%2Fcart";

describe("判定", () => {
  it("会員機能が ON で checkout_members_only が true のときだけ", () => {
    expect(checkoutMembersOnly({ members_enabled: true, checkout_members_only: true })).toBe(true);
    expect(checkoutMembersOnly({ members_enabled: false, checkout_members_only: true })).toBe(false);
    expect(checkoutMembersOnly({ members_enabled: true })).toBe(false);
    expect(checkoutMembersOnly({ members_enabled: true, checkout_members_only: "true" })).toBe(false);
    expect(checkoutMembersOnly(null)).toBe(false);
  });
});

describe("お店の画面", () => {
  it("ゲスト: カートに案内とログインのリンク。購入手続き・配送先の送信はログインへ回し、済んだらカートへ戻る", async () => {
    const { sku, mail, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const cart = await (await b.get("/my-shop/cart")).text();
    expect(cart).toContain("ご注文には会員登録（ログイン）が必要です。");
    expect(cart).toContain(`href="${LOGIN.replace(/&/g, "&amp;")}"`);
    expect((await b.post("/my-shop/checkout", { provider: "stripe" })).headers.get("location")).toBe(LOGIN);
    expect((await b.post("/my-shop/checkout/stripe", ADDRESS)).headers.get("location")).toBe(LOGIN);
    // ログイン（その場で会員登録）すると、会員ページがカートへ戻す。そのまま購入手続きに進める
    await b.get(LOGIN);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/cart");
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("ご注文には会員登録（ログイン）が必要です。");
    expect((await b.post("/my-shop/checkout", { provider: "stripe" })).status).toBe(200);
    const review = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    const go = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(review) });
    expect(go.headers.get("location")).toContain("checkout.stripe");
  });

  it("ゲストのうちに作った確認画面の quote でも確定させない（設定を ON にした後）。予約は作らない", async () => {
    const { sb, sku, b } = setup({ members_enabled: true });
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "stripe" });
    const quote = quoteFrom(await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text());
    sb.tables.shops[0]!["settings"] = { members_enabled: true, checkout_members_only: true };
    const fresh = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, new FakeStripe()));
    for (const [k, v] of b.cookies) fresh.cookies.set(k, v);
    expect((await fresh.post("/my-shop/checkout/stripe", { quote })).headers.get("location")).toBe(LOGIN);
    expect(sb.tables.reservations).toHaveLength(0);
  });

  it("会員機能が OFF なら設定があっても効かない（ゲストが買える）", async () => {
    const { sku, b } = setup({ members_enabled: false, checkout_members_only: true });
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("ご注文には会員登録");
    expect((await b.post("/my-shop/checkout", { provider: "stripe" })).status).toBe(200);
  });
});

describe("ヘッドレス", () => {
  it("ショップの checkout_members_only。会員トークンの無い quote は 403 member_required", async () => {
    const { sku, app } = setup();
    expect(((await (await app.request(`${BASE}/api/shops/my-shop`)).json()) as { shop: { checkout_members_only: boolean } }).shop.checkout_members_only).toBe(true);
    const cartRes = await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: sku.id, qty: 1 }) });
    const cart = ((await cartRes.json()) as { cart: string }).cart;
    const r = await app.request(`${BASE}/api/shops/my-shop/checkout/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cart, provider: "stripe", address: {} }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "member_required" });
  });
});

describe("管理画面", () => {
  it("会員とログインの画面に欄。保存すると settings に書き、0165 の前は出さず触れない", async () => {
    const { sb, shop, app } = setup({ members_enabled: true });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = `/admin/shops/${shop.id}/settings/members`;
    expect(await (await admin.get(page)).text()).toContain('name="checkout_members_only"');
    await admin.post(`/admin/shops/${shop.id}/members`, { members_enabled: "on", checkout_members_only_present: "1", checkout_members_only: "on" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ members_enabled: true, checkout_members_only: true });
    await admin.post(`/admin/shops/${shop.id}/members`, { members_enabled: "on", checkout_members_only_present: "1" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ checkout_members_only: false });
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== CHECKOUT_MEMBERS_ONLY_MIGRATION);
    sb.tables.shops[0]!["settings"] = { members_enabled: true, checkout_members_only: true };
    const old = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await old.get(page)).text()).not.toContain('name="checkout_members_only"');
    await old.post(`/admin/shops/${shop.id}/members`, { members_enabled: "on" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ checkout_members_only: true });
  });
});
