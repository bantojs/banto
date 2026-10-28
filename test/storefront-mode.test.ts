import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BASE, readSitemap } from "./helpers";
import { blockedTarget, pageKind, safeHttpsUrl, storefrontSettings } from "../src/storefront/mode";
import { injectHead, renderHeadTags } from "../src/storefront/head";
import { ga4Tags } from "../src/modules/ga4/ga4";
import { buildFeed } from "../src/modules/product-feed/feed";

/** お店の画面の使い方（storefront.mode）、同梱モジュールの <head> の口と、それを使う同梱モジュール ga4。0041。docs/storefront.md・docs/ga4.md */
function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "販売業者: テスト", privacy_policy: "p", return_policy: "r", settings });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ</script><script>alert(1)</script>", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.addSku(shop.id, tee.id, { code: "TEE-L", name: "L", price_jpy: 3200, available: 5 });
  const app = appWith(sb);
  return { sb, shop, tee, teeM, app, b: new Browser(app) };
}

describe("画面の種類と転送先（src/storefront/mode.ts）", () => {
  it("どのモードでも残す画面は system", () => {
    for (const p of ["/legal", "/privacy", "/returns", "/shipping", "/orders/lookup", "/orders/receipt", "/checkout/done", "/account/verify", "/account/code", "/account/passkey", "/account/passkey.js", "/account/passkey/login/options", "/account/passkey/login", "/account/passkey/add", "/account/passkey/register/options", "/account/passkey/register", "/feed/products.xml"]) expect(pageKind(p)).toBe("system");
    // パスキーの一覧・削除は会員ページの続き（使い方の設定に従う）
    for (const p of ["/account/passkeys", "/account/passkeys/00000000-0000-4000-8000-000000000000/delete"]) expect(pageKind(p)).toBe("shopping");
    for (const p of ["", "/", "/p/tee"]) expect(pageKind(p)).toBe("catalog");
    for (const p of ["/cart", "/buy", "/checkout", "/checkout/stripe", "/account", "/account/login", "/stores", "/tryon", "/coupons/x"]) expect(pageKind(p)).toBe("shopping");
  });

  it("転送先は https だけ。商品ページは {slug} を置き換える", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://example.com")).toBeNull();
    expect(safeHttpsUrl("https://user:pass@example.com")).toBeNull();
    expect(safeHttpsUrl("https://wp.example/product/", { template: true })).toBeNull();
    const s = storefrontSettings({ storefront: { mode: "checkout", site_url: "https://wp.example/", product_url: "https://wp.example/product/{slug}/" } });
    expect(blockedTarget(s, "/p/%E3%83%9E%E3%82%B0")).toBe("https://wp.example/product/%E3%83%9E%E3%82%B0/");
    expect(blockedTarget(s, "")).toBe("https://wp.example/");
    expect(blockedTarget(s, "/cart")).toBeNull();
    expect(blockedTarget({ ...s, mode: "off" }, "/cart")).toBe("https://wp.example/");
    expect(blockedTarget({ ...s, mode: "off", siteUrl: null }, "/cart")).toBe("not_found");
    expect(blockedTarget({ ...s, mode: "off" }, "/legal")).toBeNull();
    // 値が壊れていれば既定（full）
    expect(storefrontSettings({ storefront: { mode: "weird", site_url: "javascript:x" } })).toEqual({ mode: "full", siteUrl: null, productUrl: null });
  });

  it("<head> の口は決まった形だけ: https 以外の src・</script や <!-- を含むインラインは捨てる。</head> が無ければ差し込まない", () => {
    expect(renderHeadTags([{ kind: "script", src: "javascript:alert(1)" }, { kind: "script", src: "http://x.example/a.js" }, { kind: "inline-script", code: "a()</script><script>b()" }, { kind: "inline-script", code: "<!-- x" }])).toBe("");
    expect(renderHeadTags([{ kind: "script", src: 'https://x.example/a.js?q="><img>' }])).toBe('<script async src="https://x.example/a.js?q=&quot;>&lt;img>"></script>');
    expect(injectHead("<p>no head</p>", "<script></script>")).toBe("<p>no head</p>");
  });

  it("GA4 のタグ（モジュール）: コアの出来事を GA4 のイベントにする。商品名から </script> で抜けられない", () => {
    const html = injectHead("<html><head><title>x</title></head><body></body></html>", renderHeadTags(ga4Tags("G-ABC1234", [{ type: "product_view", value_jpy: 1, items: [{ sku: "A", name: "</script><script>alert(1)</script>", price: 1 }] }, { type: "purchase", value_jpy: 3000, items: [], order_number: 1023 }])));
    expect(html).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"');
    expect(html).toContain('gtag("event","view_item",{"currency":"JPY","value":1,"items":[{"item_id":"A"');
    expect(html).toContain('gtag("event","purchase",{"currency":"JPY","value":3000,"items":[],"transaction_id":"1023"})');
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("商品フィードの商品のリンクは、外のサイトの商品ページがあればそちら", () => {
    const cat = { products: [{ id: "p1", slug: "tee", name: "T", description: null, brand: null, published: true, category_id: null }], skus: [{ id: "s1", product_id: "p1", code: "A", name: null, price_jpy: 1000, compare_at_price_jpy: null, gtin: null }], images: [{ product_id: "p1", storage_key: "a.png", sort_order: 0 }], inventory: [{ sku_id: "s1", shop_id: "x", available: 1 }], categories: [] };
    const target = { shopName: "S", home: "https://banto.example/s", mediaBaseUrl: "https://media.example", productLink: (slug: string) => `https://wp.example/product/${slug}/` };
    const r = buildFeed(cat as unknown as Parameters<typeof buildFeed>[0], target);
    expect(JSON.stringify(r)).toContain("https://wp.example/product/tee/");
  });
});

describe("お店の画面の使い方", () => {
  it("既定（full）は今までどおり。GA4 のタグも入らない", async () => {
    const { b } = setup();
    expect((await b.get("/my-shop")).status).toBe(200);
    expect(await (await b.get("/my-shop/p/tee")).text()).not.toContain("googletagmanager");
  });

  it("checkout: 商品の一覧と詳細は外のサイトへ。カート・法務・注文照会は残す。サイトマップは法務だけ", async () => {
    const { b } = setup({ storefront: { mode: "checkout", site_url: "https://wp.example/shop/", product_url: "https://wp.example/product/{slug}/" } });
    let res = await b.get("/my-shop");
    expect([res.status, res.headers.get("location")]).toEqual([302, "https://wp.example/shop/"]);
    res = await b.get("/my-shop/p/tee?added=1");
    expect(res.headers.get("location")).toBe("https://wp.example/product/tee/");
    for (const p of ["/my-shop/cart", "/my-shop/legal", "/my-shop/shipping", "/my-shop/orders/lookup"]) expect(`${p} ${(await b.get(p)).status}`).toBe(`${p} 200`);
    const sitemap = await readSitemap(async (u) => (await b.get(new URL(u).pathname)).text(), `${BASE}/sitemap.xml`);
    expect(sitemap).toContain("/my-shop/legal");
    expect(sitemap).not.toContain("/my-shop/p/tee");
  });

  it("off: カートも外のサイトへ。POST は 404。法務・注文照会は残す。転送先が無ければ 404。サイトマップに載せない", async () => {
    const { b, teeM } = setup({ storefront: { mode: "off", site_url: "https://wp.example/" } });
    expect((await b.get("/my-shop/cart")).headers.get("location")).toBe("https://wp.example/");
    expect((await b.get("/my-shop/p/tee")).headers.get("location")).toBe("https://wp.example/");
    expect((await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" })).status).toBe(404);
    expect((await b.get("/my-shop/legal")).status).toBe(200);
    expect((await b.get("/my-shop/orders/lookup")).status).toBe(200);
    expect(await (await b.get("/sitemap.xml")).text()).not.toContain("/my-shop");
    const none = setup({ storefront: { mode: "off" } });
    expect((await none.b.get("/my-shop/cart")).status).toBe(404);
  });

  it("ヘッドレスの API はどのモードでも使える", async () => {
    const { b } = setup({ storefront: { mode: "off", site_url: "https://wp.example/" } });
    const res = await b.get("/api/shops/my-shop/products");
    expect(res.status).toBe(200);
  });
});

describe("同梱モジュール ga4", () => {
  it("モジュールが OFF なら、測定 ID があってもタグは入らない（コアは何も足さない）", async () => {
    const { b } = setup({ analytics: { ga4_id: "G-TEST1234" } });
    const html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).not.toContain("googletagmanager");
    expect(html).not.toContain("gtag(");
  });

  it("ON: お店の画面にタグと EC のイベント（view_item・add_to_cart・view_cart）。商品名は抜けられない。管理画面には入れない", async () => {
    const { b, teeM } = setup({ modules: { ga4: true }, analytics: { ga4_id: "G-TEST1234" } });
    let html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain("gtag/js?id=G-TEST1234");
    expect(html).toContain('gtag("event","view_item"');
    expect(html).toContain('"item_id":"TEE-M"');
    expect(html).not.toContain("</script><script>alert(1)</script>\",");
    const add = await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    html = await (await b.get(add.headers.get("location")!)).text();
    expect(html).toContain('gtag("event","add_to_cart",{"currency":"JPY","value":6000');
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain('gtag("event","view_cart"');
    expect(html).not.toMatch(/owner@example\.com|customer_email/);
    const admin = await Browser.loggedIn(b["app"], "owner@example.com", "password-123");
    expect(await (await admin.get("/admin")).text()).not.toContain("googletagmanager");
  });
});

describe("管理画面: お店の画面の使い方", () => {
  it("保存できる。https 以外の URL・{slug} の無い商品ページは断る。GA4 の欄はコアの設定には無い", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).not.toContain('name="ga4_id"');
    let res = await admin.post(`/admin/shops/${shop.id}/storefront`, { mode: "checkout", site_url: "https://wp.example/", product_url: "https://wp.example/product/{slug}/" });
    expect(res.headers.get("location")).toContain("storefront_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ storefront: { mode: "checkout", site_url: "https://wp.example/", product_url: "https://wp.example/product/{slug}/" } });
    expect(sb.tables.shops[0]!["settings"]).not.toHaveProperty("analytics");
    const bads: Record<string, string>[] = [{ site_url: "javascript:alert(1)" }, { site_url: "http://wp.example/" }, { product_url: "https://wp.example/product/" }];
    for (const bad of bads) {
      res = await admin.post(`/admin/shops/${shop.id}/storefront`, { mode: "off", ...bad });
      expect(res.headers.get("location")).toContain("storefront_invalid");
    }
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ storefront: { mode: "checkout" } });
    // 空にすると外す
    await admin.post(`/admin/shops/${shop.id}/storefront`, { mode: "full", site_url: "", product_url: "" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ storefront: { mode: "full", site_url: null, product_url: null } });
  });
});

describe("管理画面: 同梱モジュール ga4", () => {
  it("OFF なら画面は無い。ON にすると測定 ID を入れられ、形の違う ID は断る。空にすると外す", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/ga4`;
    expect((await admin.get(base)).status).toBe(404);
    expect(await (await admin.get(`/admin/shops/${shop.id}/modules`)).text()).toContain("Google アナリティクス（GA4）");
    await admin.post(`/admin/shops/${shop.id}/modules/ga4/enabled`, { enabled: "on" });
    expect(await (await admin.get(base)).text()).toContain('name="ga4_id"');
    expect((await admin.post(base, { ga4_id: "g-abc1234" })).headers.get("location")).toContain("flash=saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ modules: { ga4: true }, analytics: { ga4_id: "G-ABC1234" } });
    for (const bad of ["UA-12345-1", "G-<script>"]) expect((await admin.post(base, { ga4_id: bad })).headers.get("location")).toContain("flash=invalid");
    await admin.post(base, { ga4_id: "" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ analytics: { ga4_id: null } });
  });
});
