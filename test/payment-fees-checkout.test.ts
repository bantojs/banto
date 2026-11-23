import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { signKomojuPayload } from "../src/plugins/komoju";

/**
 * 支払い方法の手数料（0170）: 手数料の決まりのあるショップは KOMOJU を種類ごとに並べ、確認画面の合計に手数料を入れ、
 * 決済ページは選んだ種類だけ・手数料込みの金額で作る。DB の確かめ（reservation_payment_fee_check・confirm_reservation）は test/db/payment-fees.test.ts
 */
afterEach(() => externalHosts.clear());

const KOMOJU = { KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju" };

function setup(fees: Record<string, unknown> | null = { konbini: { fee_type: "flat", fee_jpy: 220 } }, types = "konbini,paypay") {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_connected",
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, ...(fees ? { payment_fees: fees } : {}) },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.tables.hook_endpoints.push({ id: "ep-komoju", shop_id: shop.id, name: "KOMOJU 決済", url: bundledPluginUrl("komoju"), events: [], enabled: true, manifest: null, settings: { payment_types: types }, created_at: "" });
  const sessions: Record<string, unknown>[] = [];
  externalHosts.set("https://komoju.com/", async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/api/v1/sessions") {
      sessions.push((await req.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "ses_1", session_url: "https://komoju.com/sessions/ses_1", status: "pending" }), { status: 200 });
    }
    if (/\/refund$/.test(u.pathname)) return new Response(JSON.stringify({ id: "ref_1", status: "refunded" }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  const app = appWith(sb, KOMOJU, undefined, stripe);
  return { sb, shop, sku, app, sessions, b: new Browser(app) };
}

describe("お店の画面: KOMOJU を種類ごとに（0170）", () => {
  it("カートに種類ごとのボタン（手数料つき）。決まりが無ければ今までどおり 1 つ", async () => {
    const { sku, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain('value="komoju:konbini"');
    expect(html).toContain('value="komoju:paypay"');
    expect(html).toContain("コンビニ払い（KOMOJU・手数料 220 円）");
    expect(html).not.toContain('name="provider" value="komoju"');

    const plain = setup(null);
    await plain.b.post("/my-shop/cart/add", { sku_id: plain.sku.id, qty: "1" });
    const html2 = await (await plain.b.get("/my-shop/cart")).text();
    expect(html2).toContain('name="provider" value="komoju"');
    expect(html2).not.toContain("komoju:konbini");
  });

  it("種類を選ぶ → 配送先（隠しの method）→ 確認画面の合計に手数料 → 決済ページは選んだ種類だけ・手数料込み → 確定", async () => {
    const { sb, shop, sku, app, sessions, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const address = await b.post("/my-shop/checkout", { provider: "komoju:konbini" });
    expect(address.status).toBe(200);
    const addressHtml = await address.text();
    expect(addressHtml).toContain('action="/my-shop/checkout/komoju"');
    expect(addressHtml).toContain('name="method" value="konbini"');
    const review = await b.post("/my-shop/checkout/komoju", { ...ADDRESS, method: "konbini" });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain("お支払い手数料");
    expect(html).toContain("コンビニ払い（KOMOJU）");
    // 3,000 + 送料 500 + 手数料 220
    expect(html).toContain("¥3,720");
    // 「修正する」は種類つきで戻る
    expect(html).toContain('name="provider" value="komoju:konbini"');
    const placed = await b.post("/my-shop/checkout/komoju", { quote: quoteFrom(html) });
    expect(placed.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    expect(sessions[0]).toMatchObject({ amount: 3720, payment_types: ["konbini"] });
    const res = sb.tables.reservations[0]!;
    expect(res).toMatchObject({ fee_jpy: 220, payment_method: "komoju:konbini", fee_checked: true });
    // KOMOJU が知らせた種類が同じなら確定（手数料つき）
    const payload = JSON.stringify({ id: "evt_1", type: "payment.captured", data: { id: "pay_1", status: "captured", amount: 3720, currency: "JPY", payment_details: { type: "konbini" }, metadata: { reservation_id: res["id"], shop_id: shop.id } } });
    const wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(await wh.json()).toMatchObject({ order_id: expect.any(String) });
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "komoju" });
  });

  it("KOMOJU が知らせた種類が違えば確定しないで返金する", async () => {
    const { sb, shop, sku, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "komoju:konbini" });
    const review = await b.post("/my-shop/checkout/komoju", { ...ADDRESS, method: "konbini" });
    await b.post("/my-shop/checkout/komoju", { quote: quoteFrom(await review.text()) });
    const res = sb.tables.reservations[0]!;
    const payload = JSON.stringify({ id: "evt_2", type: "payment.captured", data: { id: "pay_2", status: "captured", amount: 3720, currency: "JPY", payment_details: { type: "paypay" }, metadata: { reservation_id: res["id"], shop_id: shop.id } } });
    const wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(await wh.json()).toMatchObject({ refunded: true, ignored: "amount_mismatch" });
    expect(sb.tables.orders).toHaveLength(0);
  });

  it("種類を選ばない・並べていない種類はカートへ戻す", async () => {
    const { sku, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const none = await b.post("/my-shop/checkout", { provider: "komoju" });
    expect(none.headers.get("location")).toBe("/my-shop/cart?error=payment_method");
    const other = await b.post("/my-shop/checkout", { provider: "komoju:bank_transfer" });
    expect(other.headers.get("location")).toBe("/my-shop/cart?error=payment_method");
    // 確認の段で method を外しても手数料を外せない
    const review = await b.post("/my-shop/checkout/komoju", { ...ADDRESS });
    expect(review.headers.get("location")).toBe("/my-shop/cart?error=payment_method");
  });

  it("確認のあとで手数料の決まりが変わったら、決済ページを作る前に DB が断る（お店の画面がショップの行を覚えていても）", async () => {
    const { sb, shop, sku, sessions, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "komoju:konbini" });
    const review = await b.post("/my-shop/checkout/komoju", { ...ADDRESS, method: "konbini" });
    const quote = quoteFrom(await review.text());
    const row = sb.tables.shops.find((s) => s["id"] === shop.id)!;
    row["settings"] = { ...(row["settings"] as Record<string, unknown>), payment_fees: { konbini: { fee_jpy: 330 } } };
    const again = await b.post("/my-shop/checkout/komoju", { quote });
    expect(again.headers.get("location")).toBe("/my-shop/cart?error=price");
    expect(sessions).toHaveLength(0);
    // 予約は戻す
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
  });

  it("手数料なしの種類に、確認のあとで手数料を足しても（お店の画面が古い決まりで 0 と計算しても）DB が断る", async () => {
    const { sb, shop, sku, sessions, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "komoju:paypay" });
    const review = await b.post("/my-shop/checkout/komoju", { ...ADDRESS, method: "paypay" });
    const quote = quoteFrom(await review.text());
    const row = sb.tables.shops.find((s) => s["id"] === shop.id)!;
    row["settings"] = { ...(row["settings"] as Record<string, unknown>), payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 }, paypay: { fee_type: "flat", fee_jpy: 220 } } };
    const again = await b.post("/my-shop/checkout/komoju", { quote });
    expect(again.headers.get("location")).toBe("/my-shop/cart?error=price");
    expect(sessions).toHaveLength(0);
  });
});

describe("ヘッドレス: provider に komoju:<種類>（0170）", () => {
  it("quote に手数料、種類なし・知らない種類は 409 payment_method", async () => {
    const { sku, app } = setup();
    const cartRes = await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: sku.id, qty: 1 }) });
    const view = (await cartRes.json()) as { cart: string; payments: { komoju_methods?: { type: string; fee: number | null }[] } };
    const cart = view.cart;
    // カートの応答の決済手段にも種類ごとの並び（手数料つき）
    expect(view.payments.komoju_methods).toEqual([
      { type: "konbini", name: "コンビニ払い", fee: 220 },
      { type: "paypay", name: "PayPay", fee: 0 },
    ]);
    const quote = async (provider: string) => {
      const r = await app.request(`${BASE}/api/shops/my-shop/checkout/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cart, provider, address: ADDRESS }) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const ok = await quote("komoju:konbini");
    expect(ok.status).toBe(200);
    expect(ok.json["confirmation"]).toMatchObject({ fee_jpy: 220, total_jpy: 3720, fee_label: "お支払い手数料", payment: { provider: "komoju", type: "konbini", choice: "komoju:konbini" } });
    expect((await quote("komoju")).json).toMatchObject({ error: "payment_method" });
    expect((await quote("komoju:bank_transfer")).json).toMatchObject({ error: "payment_method" });
    const free = await quote("komoju:paypay");
    expect(free.json["confirmation"]).toMatchObject({ fee_jpy: 0, total_jpy: 3500 });
  });
});

describe("管理画面: KOMOJU の支払い方法ごとの手数料（0170）", () => {
  it("支払いの設定の画面から入れ、保存・誤り・外す。0170 の前は出さない", async () => {
    const { sb, shop, app } = setup(null);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/payment-fees`;
    expect(await (await admin.get(`/admin/shops/${shop.id}/settings/payments`)).text()).toContain(`href="${base}"`);
    expect(await (await admin.get(base)).text()).toContain('name="type_0"');
    // 受け付ける支払い方法に無い種類・知らない名前は警告（保存はできる）
    await admin.post(base, { rows: "1", type_0: "bank_transfer", fee_type_0: "flat", fee_jpy_0: "110" });
    expect(await (await admin.get(base)).text()).toContain("data-payfees-warnings");
    let res = await admin.post(base, { rows: "1", type_0: "konbini", fee_type_0: "flat", fee_jpy_0: "220" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect((shop["settings"] as Record<string, unknown>)["payment_fees"]).toEqual({ konbini: { fee_type: "flat", fee_jpy: 220, fee_tiers: [] } });
    res = await admin.post(base, { rows: "1", type_0: "Konbini", fee_jpy_0: "220" });
    expect(res.headers.get("location")).toBe(`${base}?flash=invalid`);
    res = await admin.post(base, { rows: "1", type_0: "konbini", fee_jpy_0: "220", remove_0: "on" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect(shop["settings"] as Record<string, unknown>).not.toHaveProperty("payment_fees");
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== "0170_payment_fees");
    const fresh = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect((await fresh.get(base)).status).toBe(404);
    expect(await (await fresh.get(`/admin/shops/${shop.id}/settings/payments`)).text()).not.toContain(`href="${base}"`);
  });
});
