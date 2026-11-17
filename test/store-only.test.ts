import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, quoteFrom } from "./helpers";
import { cartableOf, purchaseBlockOf } from "../src/products/sale";

/** 店頭のみ（ネットでは買えない）商品（0149、メンテナの決定 2026-11-17）。DB の判定は test/db/product-sale-dates.test.ts・test/db/tryon.test.ts */

function setup(opts: { tryon?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_connected",
    settings: { modules: { store_tryon: opts.tryon ?? true } },
  });
  const one = sb.addProduct(shop.id, { slug: "one-off", name: "一点もの", published: true, store_only: true });
  const oneSku = sb.addSku(shop.id, one.id, { code: "ONE-1", price_jpy: 9000, available: 1 });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeSku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  const app = appWith(sb, {}, undefined, new FakeStripe());
  return { sb, shop, oneSku, teeSku, app, b: new Browser(app) };
}

describe("判定（src/products/sale.ts）", () => {
  it("store_only は発売前・会員の条件より後。カートには、お店で試着が ON のときだけ入る", () => {
    expect(purchaseBlockOf({ store_only: true }, true)).toBe("store_only");
    expect(purchaseBlockOf({ store_only: true }, false)).toBe("members_only");
    expect(purchaseBlockOf({ store_only: true, released_at: new Date(Date.now() + 86_400_000).toISOString() }, true)).toBe("coming_soon");
    expect(cartableOf("store_only", true)).toBe(true);
    expect(cartableOf("store_only", false)).toBe(false);
    expect(cartableOf("members_only", true)).toBe(false);
    expect(cartableOf(null, false)).toBe(true);
  });
});

describe("お店の画面", () => {
  it("お店で試着が ON: カートに入り、店頭のみの印。小計に入れない。購入手続きは店頭のみの商品だけなら進めない", async () => {
    const s = setup();
    const page = await (await s.b.get("/my-shop/products/one-off")).text();
    expect(page).toContain("data-store-only");
    expect(page).toContain("お店で試着");
    await s.b.post("/my-shop/cart/add", { sku_id: s.oneSku.id, qty: "1" });
    const cart = await (await s.b.get("/my-shop/cart")).text();
    expect(cart).toContain("一点もの");
    expect(cart).toContain("店頭のみ");
    expect(cart).not.toContain("¥9,000</th>");
    const go = await s.b.post("/my-shop/checkout", { provider: "stripe" });
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toContain("error=store_only");
  });

  it("ほかの商品と一緒なら、購入手続きから外して知らせ、注文のあともカートに残す", async () => {
    const s = setup();
    await s.b.post("/my-shop/cart/add", { sku_id: s.oneSku.id, qty: "1" });
    await s.b.post("/my-shop/cart/add", { sku_id: s.teeSku.id, qty: "1" });
    expect((await s.b.post("/my-shop/checkout", { provider: "stripe" })).status).toBe(200);
    const review = await (await s.b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(review).toContain("一点もの");
    expect(review).toContain("ご購入の手続きに含めていません");
    expect(review).toContain("¥3,000");
    expect(review).not.toContain("¥12,000");
    // 確定すると、予約には店頭のみの商品が入らない
    await s.b.post("/my-shop/checkout/stripe", { quote: quoteFrom(review) });
    const items = s.sb.tables.reservations[0]!["items"] as { sku_id: string }[];
    expect(items.map((i) => i.sku_id)).toEqual([s.teeSku.id]);
    // 決済から戻った完了画面のあとも、店頭のみの商品はカートに残る
    await s.b.get("/my-shop/checkout/done");
    const cart = await (await s.b.get("/my-shop/cart")).text();
    expect(cart).toContain("一点もの");
    expect(cart).not.toContain("Tシャツ");
  });

  it("お店で試着が OFF: カートに入らず、商品のページは「店頭でのお取り扱いのみ」だけ", async () => {
    const s = setup({ tryon: false });
    const page = await (await s.b.get("/my-shop/products/one-off")).text();
    expect(page).toContain("data-store-only");
    expect(page).toContain("ネットではご購入いただけません");
    await s.b.post("/my-shop/cart/add", { sku_id: s.oneSku.id, qty: "1" });
    expect(await (await s.b.get("/my-shop/cart")).text()).not.toContain("一点もの");
    const js = await s.b.post("/my-shop/cart/add.js", { id: s.oneSku.id, quantity: "1" });
    expect(js.status).toBe(422);
  });
});

describe("ヘッドレス", () => {
  it("詳細に store_only と cartable。お店で試着が OFF ならカートは 403 store_only", async () => {
    const on = setup();
    const d = (await (await on.app.request(`${BASE}/api/shops/my-shop/products/one-off`)).json()) as { product: Record<string, unknown> };
    expect(d.product).toMatchObject({ store_only: true, cartable: true, purchasable: false });
    const cart = (await (await on.app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: on.oneSku.id, qty: 1 }) })).json()) as { items: Record<string, unknown>[]; subtotal_jpy: number };
    expect(cart.items[0]).toMatchObject({ store_only: true });
    expect(cart.subtotal_jpy).toBe(0);
    const off = setup({ tryon: false });
    const r = await off.app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: off.oneSku.id, qty: 1 }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "store_only" });
  });
});
