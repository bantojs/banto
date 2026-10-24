import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, appWith } from "./helpers";
import { cartCookieName } from "../src/cart/cart";

function setup(opts: { secondShop?: boolean; stripe?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "販売業者: テスト商店",
    privacy_policy: "個人情報は…",
    return_policy: "返品は7日以内",
    stripe_account_id: opts.stripe ? "acct_123" : null,
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", description: "綿100%", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const teeL = sb.addSku(shop.id, tee.id, { code: "TEE-L", name: "L", price_jpy: 3200, available: 0 });
  sb.tables.product_images.push({ id: "img-1", shop_id: shop.id, product_id: tee.id, storage_key: "shops/x/tee.png", sort_order: 0, created_at: "" });
  const hidden = sb.addProduct(shop.id, { slug: "hidden", name: "非公開商品", published: false });
  const hiddenSku = sb.addSku(shop.id, hidden.id, { code: "HID", price_jpy: 100, available: 10 });
  const other = sb.addUser("other@example.com", "password-456", { owner: true });
  const otherShop = sb.addShop(other.id, { slug: "other-shop", name: "準備中の店", published: opts.secondShop ?? false, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const app = appWith(sb, {}, undefined, opts.stripe ? new FakeStripe() : undefined);
  return { sb, shop, tee, teeM, teeL, hidden, hiddenSku, otherShop, app, b: new Browser(app) };
}

describe("ストアフロント（Step 5）", () => {
  it("/ は公開ショップが1件なら転送、複数なら一覧", async () => {
    const one = setup();
    const r1 = await one.b.get("/");
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("/my-shop");

    const two = setup({ secondShop: true });
    const r2 = await two.b.get("/");
    expect(r2.status).toBe(200);
    const html = await r2.text();
    expect(html).toContain('href="/my-shop"');
    expect(html).toContain('href="/other-shop"');
  });

  it("商品一覧は公開中の商品だけ。画像と最安価格を出す", async () => {
    const { b } = setup();
    const res = await b.get("/my-shop");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tシャツ");
    expect(html).toContain("¥3,000〜");
    expect(html).toContain(`${BASE}/media/shops/x/tee.png`);
    expect(html).not.toContain("非公開商品");
    expect(html).toContain('href="/my-shop/legal"');
  });

  it("非公開ショップ・非公開商品は 404", async () => {
    const { b } = setup();
    expect((await b.get("/other-shop")).status).toBe(404);
    expect((await b.get("/my-shop/p/hidden")).status).toBe(404);
    expect((await b.get("/my-shop/p/nope")).status).toBe(404);
    expect((await b.get("/nope")).status).toBe(404);
  });

  it("商品詳細: SKU・価格・在庫状況・説明", async () => {
    const { b, teeM, teeL } = setup();
    const html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain("綿100%");
    expect(html).toContain(`value="${teeM.id}"`);
    expect(html).toContain("M — ¥3,000 (残りわずか)");
    expect(html).toMatch(new RegExp(`value="${teeL.id}" disabled`));
    expect(html).toContain("在庫なし");
    expect(html).toContain('action="/my-shop/cart/add"');
  });

  it("法務ページ（特商法表記・プライバシー・返品）", async () => {
    const { b } = setup();
    expect(await (await b.get("/my-shop/legal")).text()).toContain("販売業者: テスト商店");
    expect(await (await b.get("/my-shop/privacy")).text()).toContain("個人情報は…");
    expect(await (await b.get("/my-shop/returns")).text()).toContain("返品は7日以内");
  });

  it("商品一覧は CacheAdapter で短時間キャッシュされる", async () => {
    const { b, sb, shop } = setup();
    await b.get("/my-shop");
    sb.addProduct(shop.id, { slug: "new", name: "新商品", published: true });
    expect(await (await b.get("/my-shop")).text()).not.toContain("新商品");
  });
});

describe("カート", () => {
  it("追加 → 表示 → 数量変更 → 削除", async () => {
    const { b, teeM, shop } = setup();
    let res = await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/my-shop/p/tee?added=1&sku=TEE-M&qty=2");
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie.startsWith(`${cartCookieName(shop.id)}=`)).toBe(true);
    expect(cookie).toContain("Path=/my-shop");
    expect(cookie).toContain("HttpOnly");

    let html = await (await b.get("/my-shop/p/tee?added=1")).text();
    expect(html).toContain("カートに入れました");
    expect(html).toContain("カート (2)");

    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("Tシャツ");
    expect(html).toContain("¥6,000");
    expect(html).toContain("このショップは現在決済を受け付けていません");

    // 同じ SKU を足すと合算
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("¥9,000");

    // 在庫 5 を超えると警告
    await b.post("/my-shop/cart/update", { sku_id: teeM.id, qty: "7" });
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("在庫が足りません");

    // 0 で削除
    await b.post("/my-shop/cart/update", { sku_id: teeM.id, qty: "0" });
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("カートは空です");
  });

  it("非公開商品の SKU・在庫 0 の SKU・他店の SKU は入らない", async () => {
    const { b, hiddenSku, teeL, otherShop, sb } = setup();
    expect((await b.post("/my-shop/cart/add", { sku_id: hiddenSku.id, qty: "1" })).status).toBe(404);
    const otherProduct = sb.addProduct(otherShop.id, { slug: "x", published: true });
    const otherSku = sb.addSku(otherShop.id, otherProduct.id, { available: 10 });
    expect((await b.post("/my-shop/cart/add", { sku_id: otherSku.id, qty: "1" })).status).toBe(404);
    // 在庫 0 でも追加自体はできる（表示時に在庫不足として扱う）
    await b.post("/my-shop/cart/add", { sku_id: teeL.id, qty: "1" });
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("在庫が足りません");
  });

  it("Stripe 接続済みなら購入手続きボタンが出る（在庫不足なら無効）", async () => {
    const { b, teeM } = setup({ stripe: true });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    let html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain('action="/my-shop/checkout"');
    expect(html).not.toContain("現在決済を受け付けていません");
    await b.post("/my-shop/cart/update", { sku_id: teeM.id, qty: "50" });
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toMatch(/<button type="submit" disabled[^>]*>購入手続きへ/);
  });

  it("改ざんした Cookie は空のカートとして扱う", async () => {
    const { b, teeM, shop } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const name = cartCookieName(shop.id);
    b.cookies.set(name, b.cookies.get(name)!.slice(0, -3) + "xyz");
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("カートは空です");
  });

  it("他オリジンからの POST は 403", async () => {
    const { b, teeM } = setup();
    const res = await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("ヘッドレス API", () => {
  it("公開データだけを JSON で返す", async () => {
    const { app, tee, teeM, teeL } = setup();
    const shops = (await (await app.request(`${BASE}/api/shops`)).json()) as { shops: { slug: string }[] };
    expect(shops.shops.map((s) => s.slug)).toEqual(["my-shop"]);

    const shop = (await (await app.request(`${BASE}/api/shops/my-shop`)).json()) as { shop: Record<string, unknown> };
    expect(shop.shop).toMatchObject({ slug: "my-shop", name: "マイショップ", legal_notice: "販売業者: テスト商店" });
    expect(shop.shop).not.toHaveProperty("stripe_account_id");

    const list = (await (await app.request(`${BASE}/api/shops/my-shop/products`)).json()) as { products: Record<string, unknown>[] };
    expect(list.products).toEqual([{ id: tee.id, slug: "tee", name: "Tシャツ", brand: null, category: null, extra_categories: [], tags: [], compare_at_price_jpy: null, image: `${BASE}/media/shops/x/tee.png`, thumb: `${BASE}/media/shops/x/tee.png`, min_price_jpy: 3000, created_at: expect.any(String), updated_at: expect.any(String) }]);

    const detail = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { skus: Record<string, unknown>[] } };
    expect(detail.product.skus).toEqual([
      { id: teeM.id, code: "TEE-M", name: "M", options: {}, gtin: null, price_jpy: 3000, compare_at_price_jpy: null, in_stock: true },
      { id: teeL.id, code: "TEE-L", name: "L", options: {}, gtin: null, price_jpy: 3200, compare_at_price_jpy: null, in_stock: false },
    ]);

    expect((await app.request(`${BASE}/api/shops/other-shop`)).status).toBe(404);
    expect((await app.request(`${BASE}/api/shops/my-shop/products/hidden`)).status).toBe(404);
  });
});
