import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, checkout, externalHosts, quoteFrom } from "./helpers";
import { COD_FEE_CASES } from "./fixtures/cod-fee-cases";
import { codFee, codQuote } from "../src/modules/cod";
import { parseTiers } from "../src/modules/cod/admin";
import { orderMailValues, emailResend } from "../src/plugins/email_resend";
import { buyerMessage } from "../src/plugins/line_buyer";
import { lineMessageFor } from "../src/plugins/line_notify";
import { orderTaxBreakdown } from "../src/commerce/tax";

/** 代金引換（同梱モジュール cod、0157）。DB の判定（手数料の引き直し・上限・会員だけ・hooks）は test/db/cod.test.ts */
afterEach(() => externalHosts.clear());

function setup(cod: Record<string, unknown> = { fee_type: "flat", fee_jpy: 330 }, on = true) {
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
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, contact_email: "shop@example.com", modules: { cod: on }, cod },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 10 });
  const app = appWith(sb, {}, undefined, stripe);
  return { sb, stripe, shop, sku, app };
}

describe("手数料の決まり（src/modules/cod）", () => {
  it("答え合わせの表（DB の banto_cod_fee と同じ）", () => {
    for (const k of COD_FEE_CASES) expect([k.name, codFee(k.settings, k.amount)]).toEqual([k.name, k.fee]);
  });

  it("使えるか: モジュール・段・上限（手数料込み）・会員だけ。0 円は手数料なし", () => {
    const on = (cod: Record<string, unknown>) => ({ modules: { cod: true }, cod });
    expect(codQuote({ cod: { fee_jpy: 330 } }, 1000, false)).toEqual({ ok: false, reason: "module" });
    expect(codQuote(on({ fee_jpy: 330 }), 1000, false)).toEqual({ ok: true, fee: 330 });
    expect(codQuote(on({ fee_jpy: 330 }), 0, false)).toEqual({ ok: true, fee: 0 });
    expect(codQuote(on({ fee_type: "tiers", fee_tiers: [{ upto: 999, fee: 1 }] }), 1000, false)).toEqual({ ok: false, reason: "fee" });
    expect(codQuote(on({ fee_jpy: 330, max_total_jpy: 1329 }), 1000, false)).toEqual({ ok: false, reason: "max_total" });
    expect(codQuote(on({ fee_jpy: 330, max_total_jpy: 1330 }), 1000, false)).toEqual({ ok: true, fee: 330 });
    expect(codQuote(on({ fee_jpy: 330, members_only: true }), 1000, false)).toEqual({ ok: false, reason: "members_only" });
    expect(codQuote(on({ fee_jpy: 330, members_only: true }), 1000, true)).toEqual({ ok: true, fee: 330 });
    // 既定の上限は 30 万円
    expect(codQuote(on({ fee_jpy: 0 }), 300001, false)).toEqual({ ok: false, reason: "max_total" });
  });

  it("税: 手数料は標準税率（値引きの対象にしない）", () => {
    const g = orderTaxBreakdown({ shipping_jpy: 500, fee_jpy: 330, discount_jpy: 0, shipping_tax_rate: 10, items: [{ qty: 1, unit_price_jpy: 1080, tax_rate: 8 }] }, {});
    expect(g).toEqual(expect.arrayContaining([expect.objectContaining({ rate: 10, amount_jpy: 830 }), expect.objectContaining({ rate: 8, amount_jpy: 1080 })]));
  });

  it("管理画面の段の欄", () => {
    expect(parseTiers("30000,440\n10000, 330\n\n")).toEqual([{ upto: 10000, fee: 330 }, { upto: 30000, fee: 440 }]);
    expect(parseTiers("10,000円,330")).toEqual([{ upto: 10000, fee: 330 }]);
    expect(parseTiers("abc")).toBeNull();
    expect(parseTiers("10000,100001")).toBeNull();
    expect(parseTiers(Array.from({ length: 11 }, (_, i) => `${i + 1},1`).join("\n"))).toBeNull();
  });
});

describe("お店の画面", () => {
  it("カートに代金引換。最終確認に手数料と支払い時期、確定で受付（未入金）の注文（決済ページへ行かない）", async () => {
    const { sb, stripe, app, sku } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    expect(await (await b.get("/my-shop/cart")).text()).toContain("代金引換で支払う");
    expect((await b.post("/my-shop/checkout", { provider: "cod" })).status).toBe(200);
    const review = await b.post("/my-shop/checkout/cod", ADDRESS);
    const html = await review.text();
    expect(html).toContain("代引き手数料");
    expect(html).toContain("¥330");
    expect(html).toContain("¥6,830");
    expect(html).toContain("商品のお届けのときに、配達員に合計の金額をお支払いください。");
    expect(html).toContain("注文を確定する（代金引換）");
    const res = await b.post("/my-shop/checkout/cod", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/my-shop/checkout/done");
    expect(stripe.sessions.size).toBe(0);
    expect(sb.tables.orders).toHaveLength(1);
    expect(sb.tables.orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid", payment_provider: "cod", fee_jpy: 330, total_jpy: 6830, amount_paid_jpy: null });
  });

  it("モジュールが OFF なら出さない・進めない", async () => {
    const { app, sku, sb } = setup(undefined, false);
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("代金引換で支払う");
    const res = await b.post("/my-shop/checkout/cod", ADDRESS);
    expect(res.headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.orders).toHaveLength(0);
  });

  it("上限を超える・会員だけ（ゲスト）はカートに戻して知らせる", async () => {
    const over = setup({ fee_jpy: 330, max_total_jpy: 5000 });
    const b = new Browser(over.app);
    await b.post("/my-shop/cart/add", { sku_id: over.sku.id, qty: "2" });
    const res = await checkout(b, "/my-shop", "cod");
    expect(res.headers.get("location")).toBe("/my-shop/cart?error=cod_max_total");
    expect(await (await b.get("/my-shop/cart?error=cod_max_total")).text()).toContain("代金引換の上限を超えている");
    const members = setup({ fee_jpy: 330, members_only: true });
    const g = new Browser(members.app);
    await g.post("/my-shop/cart/add", { sku_id: members.sku.id, qty: "1" });
    expect((await checkout(g, "/my-shop", "cod")).headers.get("location")).toBe("/my-shop/cart?error=cod_members_only");
    expect(members.sb.tables.orders).toHaveLength(0);
  });

  it("確認のあとで手数料が変わったら出し直す", async () => {
    const { app, sku, shop, sb } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "cod" });
    const quote = quoteFrom(await (await b.post("/my-shop/checkout/cod", ADDRESS)).text());
    shop["settings"] = { ...(shop["settings"] as Record<string, unknown>), cod: { fee_jpy: 440 } };
    const app2 = appWith(sb);
    const b2 = new Browser(app2);
    b2.cookies = b.cookies;
    const res = await b2.post("/my-shop/checkout/cod", { quote });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("¥440");
    expect(sb.tables.orders).toHaveLength(0);
  });
});

describe("ヘッドレス API", () => {
  it("quote に手数料、確定は cod: true と注文 id。上限を超えると cod_unavailable", async () => {
    const { app, sku, sb } = setup();
    const api = (path: string, body: unknown) => app.request(`${BASE}${path}`, { method: "POST", headers: { origin: "https://wp.example.com", "content-type": "application/json" }, body: JSON.stringify(body) });
    const cart = ((await (await api("/api/shops/my-shop/cart", { op: "add", sku_id: sku.id, qty: 1 })).json()) as { cart: string; payments: Record<string, boolean> });
    expect(cart.payments).toMatchObject({ cod: true });
    const q = (await (await api("/api/shops/my-shop/checkout/quote", { cart: cart.cart, provider: "cod", address: ADDRESS })).json()) as { quote: string; confirmation: Record<string, unknown> };
    expect(q.confirmation).toMatchObject({ fee_jpy: 330, total_jpy: 3830, payment: { provider: "cod", cod: true } });
    const placed = (await (await api("/api/shops/my-shop/checkout", { quote: q.quote })).json()) as Record<string, unknown>;
    expect(placed).toMatchObject({ cod: true, order_id: sb.tables.orders[0]!["id"] });
    expect(sb.tables.orders[0]).toMatchObject({ payment_status: "unpaid", fee_jpy: 330 });

    const big = ((await (await api("/api/shops/my-shop/cart", { op: "add", sku_id: sku.id, qty: 9 })).json()) as { cart: string });
    shopSettings(sb, { cod: { fee_jpy: 330, max_total_jpy: 10000 } });
    const res = await appWith(sb).request(`${BASE}/api/shops/my-shop/checkout/quote`, { method: "POST", headers: { origin: "https://wp.example.com", "content-type": "application/json" }, body: JSON.stringify({ cart: big.cart, provider: "cod", address: ADDRESS }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cod_unavailable", reason: "max_total" });
  });
});

function shopSettings(sb: FakeSupabase, patch: Record<string, unknown>) {
  const shop = sb.tables.shops[0]!;
  shop["settings"] = { ...(shop["settings"] as Record<string, unknown>), ...patch };
}

describe("管理画面", () => {
  it("設定の画面: 保存・段の誤り。支払いの設定の画面から入れる", async () => {
    const { app, shop } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/cod`;
    expect(await (await admin.get(`/admin/shops/${shop.id}/settings/payments`)).text()).toContain(`href="${base}"`);
    expect(await (await admin.get(base)).text()).toContain('name="max_total_jpy"');
    let res = await admin.post(base, { fee_type: "tiers", fee_tiers: "10000,330\n30000,440", max_total_jpy: "200000", members_only: "on", note: "現金のみ" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect((shop["settings"] as Record<string, unknown>)["cod"]).toEqual({ fee_type: "tiers", fee_jpy: 0, fee_tiers: [{ upto: 10000, fee: 330 }, { upto: 30000, fee: 440 }], max_total_jpy: 200000, members_only: true, note: "現金のみ" });
    res = await admin.post(base, { fee_type: "tiers", fee_tiers: "" });
    expect(res.headers.get("location")).toBe(`${base}?flash=invalid_tiers`);
  });

  it("注文の画面に手数料", async () => {
    const { app, sku, shop, sb } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop", "cod");
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/orders/${String(sb.tables.orders[0]!["id"])}`)).text();
    expect(html).toContain("代引き手数料");
    expect(html).toContain("受付（未入金）");
  });
});

describe("同梱のメール・LINE", () => {
  const contact = (over: Record<string, unknown> = {}) => ({
    order_id: "o1", number: 1001, status: "pending", created_at: "", total_jpy: 3830, shipping_jpy: 500, fee_jpy: 330, payment_status: "unpaid", discount_jpy: 0, payment_provider: "cod",
    customer_email: "buyer@example.com", customer_name: "山田", shipping_address: null, shop: { name: "S", slug: "s", contact_email: null, return_policy: null }, items: [{ name: "T", sku: "M", qty: 1, unit_price_jpy: 3000 }], ...over,
  });

  it("受付のメール: 手数料の行・代金引換の案内。商品合計は手数料を除く", () => {
    const v = orderMailValues("paid", contact() as never, BASE);
    expect(v["order_details"]).toContain("商品合計: ¥3,000");
    expect(v["order_details"]).toContain("代引き手数料: ¥330");
    expect(v["order_details"]).toContain("お支払い方法: 代金引換");
  });

  it("order.created は未入金の注文だけ送る（入金済みの注文の受付は order.paid）", async () => {
    const sent: string[] = [];
    const ctx = (data: Record<string, unknown>) => ({
      envelope: { id: "e1", event: "order.created", created_at: "", shop_id: "s1", attempt: 1, data },
      settings: { from: "shop@example.com" },
      config: { get: (n: string) => (n === "RESEND_API_KEY" ? "re_test" : undefined), secret: () => "" },
      fetch: (async (u: string, init: RequestInit) => (sent.push(`${u} ${String(init.body)}`), new Response("{}"))) as unknown as typeof fetch,
      privileged: { orderContact: async () => contact(), shopNoticeTexts: async () => [] },
    });
    await emailResend.handle!(ctx({ order_id: "o1", payment_status: "paid" }) as never);
    expect(sent).toEqual([]);
    await emailResend.handle!(ctx({ order_id: "o1", payment_status: "unpaid" }) as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("代引き手数料");
    expect(emailResend.manifest.events).toContain("order.created");
  });

  it("LINE: 購入者には受付の文、運営者には「新しい注文（未入金）」", () => {
    expect(buyerMessage("order.created", { number: 1001, total_jpy: 3830, shop_name: "S" })).toContain("1001");
    const ctx = (event: string, data: Record<string, unknown>) => ({ envelope: { id: "e", event, created_at: "", shop_id: "s", attempt: 1, data } }) as never;
    expect(lineMessageFor(ctx("order.created", { order_id: "o1", total_jpy: 3830, payment_status: "unpaid", items: [{ qty: 1 }] }))).toContain("新しい注文が入りました（未入金）");
    expect(lineMessageFor(ctx("order.created", { order_id: "o1", total_jpy: 3830, payment_status: "paid" }))).toBeNull();
  });
});
