import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, appWith, checkout, memberLogin, memberMail } from "./helpers";
import { normalizeDomain, shopHome, shopOrigin } from "../src/storefront/urls";

const DOMAIN = "shop.example.jp";
const SHOP_URL = `https://${DOMAIN}`;

function setup(opts: { domain?: string | null; members?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_x",
    domain: opts.domain === undefined ? DOMAIN : opts.domain,
    settings: opts.members ? { members_enabled: true } : {},
  });
  const other = sb.addShop(owner.id, { slug: "other", name: "ほかの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
  const stripe = new FakeStripe();
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, shop, other, sku, app, stripe, b: new Browser(app, SHOP_URL), base: new Browser(app) };
}

describe("URL の組み立て（src/storefront/urls.ts）", () => {
  it("独自ドメインがあればそのドメイン、無ければ Banto の URL + スラッグ", () => {
    expect(shopHome("https://banto.example.com/", { slug: "s", domain: null })).toBe("https://banto.example.com/s");
    expect(shopHome("https://banto.example.com", { slug: "s", domain: DOMAIN })).toBe(SHOP_URL);
    expect(shopOrigin("https://banto.example.com", { slug: "s" })).toBe("https://banto.example.com");
    expect(shopOrigin("https://banto.example.com", { slug: "s", domain: DOMAIN })).toBe(SHOP_URL);
  });

  it("入力をホスト名にそろえ、形の違うものは通さない", () => {
    expect(normalizeDomain("  https://Shop.Example.JP/ ")).toBe(DOMAIN);
    expect(normalizeDomain("")).toBeNull();
    for (const bad of ["localhost", "shop", "-a.example.jp", "a..jp", "shop.example.jp/path", "shop.example.jp:8443", "ショップ.jp", "a.123"]) expect(normalizeDomain(bad), bad).toBe("invalid");
  });
});

describe("独自ドメインのストアフロント", () => {
  it("ドメインのトップがショップになり、リンク・canonical にスラッグが付かない", async () => {
    const { b } = setup();
    const res = await b.get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tシャツ");
    expect(html).toContain('href="/p/tee"');
    expect(html).not.toContain("/my-shop");
    expect(html).toContain(`<link rel="canonical" href="${SHOP_URL}/"`);
    const detail = await (await b.get("/p/tee")).text();
    expect(detail).toContain(`<link rel="canonical" href="${SHOP_URL}/p/tee"`);
    expect(detail).toContain('action="/cart/add"');
  });

  it("カートの Cookie はドメイン全体（Path=/）に置き、カート・確認画面まで進める", async () => {
    const { b, sb, sku } = setup();
    const add = await b.post("/cart/add", { sku_id: sku.id, qty: "1" });
    expect(add.status).toBe(302);
    expect(add.headers.get("location")).toBe("/p/tee?added=1&sku=A&qty=1");
    expect(add.headers.getSetCookie().some((c) => c.includes("Path=/;"))).toBe(true);
    const cart = await (await b.get("/cart")).text();
    expect(cart).toContain("Tシャツ");
    expect(sb.tables.shops.length).toBe(2);
  });

  it("ほかのショップのパスはドメインの上では開けない", async () => {
    const { b } = setup();
    expect((await b.get("/other")).status).toBe(404);
    expect((await b.get("/my-shop")).status).toBe(404);
  });

  it("API・/health はドメインの上でもそのまま", async () => {
    const { b } = setup();
    expect((await b.get("/api/shops/my-shop/products")).status).toBe(200);
    expect((await b.get("/health")).status).not.toBe(404);
  });

  it("管理画面はショップのドメインでは出さない: GET は Banto の URL へ転送、POST は 404。Banto の URL ではこれまでどおり", async () => {
    const { b, base } = setup();
    const login = await b.get("/admin/login?next=%2Fadmin%2Fshops");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(`${BASE}/admin/login?next=%2Fadmin%2Fshops`);
    expect((await b.get("/admin")).headers.get("location")).toBe(`${BASE}/admin`);
    expect((await b.post("/admin/login", { email: "owner@example.com", password: "password-123" })).status).toBe(404);
    expect((await base.get("/admin/login")).status).toBe(200);
    // PUBLIC_BASE_URL が無ければ転送先が分からないので 404（ドメインの上に運営者のログイン画面を出さない）
    const bare = new Browser(appWith(setup().sb, { PUBLIC_BASE_URL: "" }), SHOP_URL);
    expect((await bare.get("/admin/login")).status).toBe(404);
  });

  it("Host の末尾のドット・大文字でも同じショップのドメイン（/admin は出ない）。運営者と連携の入口（/mcp /api/v1 /webhooks）はショップのドメインでは 404", async () => {
    const { app, b } = setup();
    for (const host of [`https://${DOMAIN}.`, `https://${DOMAIN.toUpperCase()}`]) {
      const dotted = new Browser(app, host);
      expect((await dotted.get("/admin/login")).status, host).toBe(302);
      expect((await dotted.get("/p/tee")).status, host).toBe(200);
    }
    expect((await b.get("/mcp")).status).toBe(404);
    expect((await app.request(`${SHOP_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await b.get("/api/v1/openapi.json")).status).toBe(404);
    expect((await app.request(`${SHOP_URL}/webhooks/stripe`, { method: "POST", body: "{}" })).status).toBe(404);
    // 公開 API と画像はショップのドメインでも使える
    expect((await b.get("/api/shops/my-shop/products")).status).toBe(200);
    // Banto 自身の URL では今までどおり
    expect((await app.request(`${BASE}/api/v1/openapi.json`)).status).toBe(200);
  });

  it("Banto の URL でショップを開くと、同じページのドメインへ転送する（GET だけ）", async () => {
    const { base } = setup();
    const top = await base.get("/my-shop");
    expect(top.status).toBe(302);
    expect(top.headers.get("location")).toBe(`${SHOP_URL}/`);
    const p = await base.get("/my-shop/p/tee?x=1");
    expect(p.headers.get("location")).toBe(`${SHOP_URL}/p/tee?x=1`);
    // 独自ドメインの無いショップはそのまま
    expect((await base.get("/other")).status).toBe(200);
  });

  it("robots.txt と sitemap.xml はドメインごと", async () => {
    const { b, base } = setup();
    const robots = await (await b.get("/robots.txt")).text();
    expect(robots).toContain(`Sitemap: ${SHOP_URL}/sitemap.xml`);
    expect(robots).toContain("Disallow: /cart");
    const own = await (await b.get("/sitemap.xml")).text();
    expect(own).toContain(`<loc>${SHOP_URL}/p/tee</loc>`);
    expect(own).not.toContain("/other");
    // Banto の URL のサイトマップには、独自ドメインのショップを載せない
    const main = await (await base.get("/sitemap.xml")).text();
    expect(main).toContain(`<loc>${BASE}/other</loc>`);
    expect(main).not.toContain("my-shop");
    expect(main).not.toContain(DOMAIN);
  });

  it("決済の戻り先はショップのドメイン", async () => {
    const { b, sku, stripe } = setup();
    await b.post("/cart/add", { sku_id: sku.id, qty: "1" });
    const res = await checkout(b, "", "stripe");
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const params = [...stripe.sessions.values()].at(-1)!.params;
    // 照会トークン（0035）が付く。戻り先はショップのドメイン
    expect(params.get("success_url")).toMatch(new RegExp(`^${SHOP_URL}/checkout/done\\?s=[A-Za-z0-9_.-]+$`));
    expect(params.get("cancel_url")).toBe(`${SHOP_URL}/cart`);
  });

  it("ログインのメールのリンクはショップのドメイン、会員の Cookie は Path=/", async () => {
    const { b, sb, shop } = setup({ members: true });
    const mail = memberMail(sb, shop.id);
    try {
      const res = await b.post("/account/login", { email: "m@example.com" });
      expect(res.headers.get("location")).toBe("/account/code");
      const sent = mail.sent.at(-1)!;
      expect(sent.text).toContain(`${SHOP_URL}/account/verify?c=`);
      await memberLogin(b, mail, "", "m@example.com");
      const account = await b.get("/account");
      expect(account.status).toBe(200);
      expect([...b.cookies.keys()].some((k) => k.startsWith("banto_member_"))).toBe(true);
    } finally {
      mail.dispose();
    }
  });
});

describe("管理画面: 独自ドメインの設定", () => {
  it("保存・形のチェック・重複・Banto 自身のホスト名", async () => {
    const { app, shop, other, sb } = setup({ domain: null });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain(`action="/admin/shops/${shop.id}/domain"`);

    let res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "https://Shop.Example.JP/" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
    expect(sb.tables.shops.find((s) => s["id"] === shop.id)!["domain"]).toBe(DOMAIN);

    res = await admin.post(`/admin/shops/${other.id}/domain`, { domain: DOMAIN });
    expect(res.headers.get("location")).toBe(`/admin/shops/${other.id}?flash=domain_taken#domain`);

    for (const bad of ["not a domain", "localhost", "banto.workers.dev"]) {
      res = await admin.post(`/admin/shops/${other.id}/domain`, { domain: bad });
      expect(res.headers.get("location"), bad).toBe(`/admin/shops/${other.id}?flash=domain_invalid#domain`);
    }

    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
    expect(sb.tables.shops.find((s) => s["id"] === shop.id)!["domain"]).toBeNull();
  });
});

describe("取引メールのリンク", () => {
  it("注文照会のリンクはショップのドメイン", async () => {
    const { buildOrderEmail } = await import("../src/plugins/email_resend");
    const contact = {
      order_id: "o1",
      number: 1001,
      status: "paid",
      created_at: "2026-10-16T00:00:00Z",
      total_jpy: 1000,
      shipping_jpy: 0,
      payment_provider: "stripe",
      customer_email: "buyer@example.com",
      customer_name: "山田",
      shipping_address: {},
      items: [],
      shop: { name: "マイショップ", slug: "my-shop", domain: DOMAIN, contact_email: null, return_policy: null },
    } as unknown as Parameters<typeof buildOrderEmail>[1];
    expect(buildOrderEmail("paid", contact, BASE).text).toContain(`${SHOP_URL}/orders/lookup`);
    expect(buildOrderEmail("paid", { ...contact, shop: { ...contact.shop, domain: null } }, BASE).text).toContain(`${BASE}/my-shop/orders/lookup`);
  });
});

