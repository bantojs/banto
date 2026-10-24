import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, quoteFrom } from "./helpers";

function setup() {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected",
    settings: { shipping: { mode: "by_prefecture", flat_fee_jpy: 800, by_prefecture: { 北海道: 1500, 沖縄県: 1800 }, free_over_jpy: 10000 }, tax_rate: 10 },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 10 });
  const app = appWith(sb, {}, undefined, stripe);
  return { sb, stripe, shop, tee, sku, app, b: new Browser(app) };
}

describe("送料・税（ストアフロント）", () => {
  it("カートに送料案内と税込表示、送料ページに都道府県表", async () => {
    const { b, sku } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    let html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("商品合計（税込）");
    expect(html).toContain("送料は都道府県により ¥800〜¥1,800（税込）");
    expect(html).toContain("¥10,000以上で送料無料");
    html = await (await b.get("/my-shop/shipping")).text();
    expect(html).toContain("北海道");
    expect(html).toContain("¥1,500");
    expect(html).toContain("消費税 10%");
    expect(await (await b.get("/my-shop")).text()).toContain("税込");
  });

  it("配送先の都道府県で送料が決まり、Stripe の明細と注文に載る。無料ライン以上なら 0", async () => {
    const { b, sku, stripe, sb, app } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const page = await b.post("/my-shop/checkout", { provider: "stripe" });
    expect(await page.text()).toContain('<option value="北海道">北海道（送料 ¥1,500）');
    const bad = await b.post("/my-shop/checkout/stripe", { ...ADDRESS, state: "火星" });
    expect(bad.status).toBe(400);
    expect(sb.tables.reservations).toHaveLength(0);

    // 最終確認画面に送料と支払総額が出る
    const review = await b.post("/my-shop/checkout/stripe", { ...ADDRESS, state: "北海道" });
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("¥1,500");
    expect(reviewHtml).toContain("¥4,500");
    const res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(reviewHtml) });
    expect(res.status).toBe(303);
    const [sessionId, session] = [...stripe.sessions.entries()][0]!;
    expect(session.params.get("line_items[1][price_data][product_data][name]")).toBe("送料");
    expect(session.params.get("line_items[1][price_data][unit_amount]")).toBe("1500");
    expect(sb.tables.reservations[0]!["shipping_jpy"]).toBe(1500);
    await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(sb.tables.orders[0]).toMatchObject({ number: 1001, shipping_jpy: 1500, total_jpy: 4500, customer_name: "山田 太郎" });
    expect(sb.tables.orders[0]!["shipping_address"]).toMatchObject({ state: "北海道", phone: "0312345678" });

    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "4" });
    const res2 = await checkout(b, "/my-shop", "stripe", { ...ADDRESS, state: "沖縄県" });
    expect(res2.status).toBe(303);
    const s2 = [...stripe.sessions.values()][1]!;
    expect(s2.params.get("line_items[1][price_data][product_data][name]")).toBeNull();
    expect(sb.tables.reservations[1]!["shipping_jpy"]).toBe(0);
  });

  it("管理画面で送料・税・連絡先を保存できる", async () => {
    const { app, shop, sb } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("送料・税・連絡先");
    expect(html).toContain('name="pref_北海道"');
    const res = await admin.post(`/admin/shops/${shop.id}/shipping`, { mode: "flat", flat_fee_jpy: "600", free_over_jpy: "", pref_北海道: "1200", tax_rate: "8", contact_email: "shop@example.com" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=shipping_saved`);
    const settings = sb.shops[0]!["settings"] as Record<string, unknown>;
    expect(settings).toMatchObject({ shipping: { mode: "flat", flat_fee_jpy: 600, free_over_jpy: null, by_prefecture: { 北海道: 1200 } }, tax_rate: 8, contact_email: "shop@example.com" });
    html = await (await admin.get(`/admin/shops/${shop.id}?flash=shipping_saved`)).text();
    expect(html).toContain("送料・税・連絡先を保存しました");
  });
});

describe("注文照会", () => {
  it("番号 + メールで状態を表示。違えば見つからない", async () => {
    const { b, sku, stripe, sb, app } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    const number = String(sb.tables.orders[0]!["number"]);
    const anon = new Browser(app);
    expect((await anon.get("/my-shop/orders/lookup")).status).toBe(200);
    let res = await anon.post("/my-shop/orders/lookup", { number, email: "BUYER@example.com" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`注文番号 ${number}`);
    expect(html).toContain("支払い済み");
    expect(html).toContain("¥6,800"); // 6,000 + 送料 800（東京都）
    expect(html).not.toContain("千代田1-1");
    // 発送済みでお問い合わせ番号があれば、運送会社の照会ページへのリンクを出す（0022）
    Object.assign(sb.tables.orders[0]!, { status: "shipped", tracking_carrier: "sagawa", tracking_number: "400011112222" });
    const shipped = await (await anon.post("/my-shop/orders/lookup", { number, email: "buyer@example.com" })).text();
    expect(shipped).toContain("お問い合わせ番号: 佐川急便 400011112222");
    expect(shipped).toContain("okurijoNo=400011112222");
    res = await anon.post("/my-shop/orders/lookup", { number, email: "other@example.com" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("見つかりません");
    expect((await anon.post("/my-shop/orders/lookup", { number: "abc", email: "x@example.com" })).status).toBe(400);
  });
});
