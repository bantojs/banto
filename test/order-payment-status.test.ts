import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, WEBHOOK_SECRET, appWith, checkout, externalHosts } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { cancellable, payable, paidAndActive, shippable, unpaid, PAYMENT_STATUS_MIGRATION } from "../src/orders/payment";
import { receiptAvailable } from "../src/modules/receipt/data";

/** お支払いの状態（0156）。DB の判定（制約・取り消し・集計・hooks）は test/db/order-payment-status.test.ts */
afterEach(() => externalHosts.clear());

/** 注文を 1 件作り、未入金の受付にする（作る口は次の版の同梱モジュール） */
async function setup() {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, contact_email: "shop@example.com", modules: { receipt: true } } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 10 });
  const app = appWith(sb, {}, undefined, stripe);
  const b = new Browser(app);
  await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
  await checkout(b, "/my-shop");
  const [sessionId] = [...stripe.sessions.keys()];
  await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
  const order = sb.tables.orders[0]!;
  Object.assign(order, { status: "pending", payment_status: "unpaid", paid_at: null, payment_provider: "cod", payment_ref: null });
  const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
  return { sb, stripe, shop, sku, order, app, admin };
}

const stockOf = (sb: FakeSupabase, skuId: string) => Number(sb.tables.inventory.find((i) => i["sku_id"] === skuId)!["available"]);

describe("判定（src/orders/payment.ts）", () => {
  it("受付・発送・取り消し・入金の記録・領収書", () => {
    const pending = { status: "pending", payment_status: "unpaid" };
    const shippedUnpaid = { status: "shipped", payment_status: "unpaid" };
    const shippedPaid = { status: "shipped", payment_status: "paid" };
    const legacy = { status: "shipped" };
    expect([shippable(pending), cancellable(pending), payable(pending), paidAndActive(pending)]).toEqual([true, true, true, false]);
    expect([shippable(shippedUnpaid), cancellable(shippedUnpaid), payable(shippedUnpaid)]).toEqual([false, true, true]);
    expect([cancellable(shippedPaid), payable(shippedPaid), paidAndActive(shippedPaid)]).toEqual([false, false, true]);
    // 0156 より前の行（列が無い）は入金済み
    expect([unpaid(legacy), paidAndActive(legacy), receiptAvailable(legacy)]).toEqual([false, true, true]);
    expect(receiptAvailable(shippedUnpaid)).toBe(false);
    expect(PAYMENT_STATUS_MIGRATION).toBe("0156_order_payment_status");
  });
});

describe("管理画面", () => {
  it("未入金の印・入金を記録・領収書は入金の後。受付から発送にできる", async () => {
    const { shop, order, admin } = await setup();
    const base = `/admin/shops/${shop.id}/orders/${order["id"]}`;
    const html = await (await admin.get(base)).text();
    expect(html).toContain("受付（未入金）");
    expect(html).toContain("入金を記録する");
    expect(html).not.toContain("領収書");
    expect((await admin.get(`${base}/receipt`)).status).toBe(404);
    expect((await admin.post(`${base}/payment`, {})).headers.get("location")).toBe(`${base}?flash=payment_recorded`);
    expect(order).toMatchObject({ status: "paid", payment_status: "paid" });
    expect((await admin.get(`${base}/receipt`)).status).toBe(200);
    const after = await (await admin.get(base)).text();
    expect(after).not.toContain("入金を記録する");
    expect(after).toContain("入金済み");
  });

  it("受付のまま発送にでき、発送の後は受け取り拒否で取り消せる（返金なし・在庫を戻す）", async () => {
    const { sb, stripe, shop, sku, order, admin } = await setup();
    const base = `/admin/shops/${shop.id}/orders/${order["id"]}`;
    await admin.post(`${base}/status`, { status: "shipped" });
    expect(order).toMatchObject({ status: "shipped", payment_status: "unpaid" });
    const html = await (await admin.get(base)).text();
    expect(html).toContain("受け取り拒否で取り消す");
    expect(html).not.toContain('value="cancelled"/><button type="submit" class="danger">キャンセル');
    const before = stockOf(sb, sku.id);
    const res = await admin.post(`${base}/status`, { status: "cancelled", reason: "refused" });
    expect(res.headers.get("location")).toBe(`${base}?flash=cancelled`);
    expect(order).toMatchObject({ status: "cancelled", cancel_reason: "refused" });
    expect(stripe.refunds).toEqual([]);
    expect(stockOf(sb, sku.id)).toBe(before + 2);
    expect(await (await admin.get(base)).text()).toContain("受け取り拒否");
  });

  it("一覧: 未入金の印と絞り込み", async () => {
    const { shop, admin } = await setup();
    const html = await (await admin.get(`/admin/shops/${shop.id}/orders`)).text();
    expect(html).toContain('<span class="status warn">未入金</span>');
    expect(html).toContain('name="paid"');
  });
});

describe("AI 用 API", () => {
  async function token(sb: FakeSupabase, shopId: string) {
    const raw = generateApiToken();
    const owner = sb.tables.shops.find((s) => s["id"] === shopId)!["owner_id"];
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shopId, owner_id: owner, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["orders:read", "orders:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  }

  it("入金を記録・未入金の取り消しは返金しない。0156 を当てる前は 409", async () => {
    const { sb, stripe, shop, order, app } = await setup();
    const raw = await token(sb, shop.id);
    const call = (path: string, body?: unknown) => app.request(`${BASE}/api/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await call(`/orders/${String(order["id"])}/payment`)).status).toBe(200);
    expect(order).toMatchObject({ status: "paid", payment_status: "paid" });

    const two = await setup();
    const raw2 = await token(two.sb, two.shop.id);
    const res = await two.app.request(`${BASE}/api/v1/orders/${String(two.order["id"])}/status`, { method: "POST", headers: { authorization: `Bearer ${raw2}`, "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
    expect(res.status).toBe(200);
    expect(two.order["status"]).toBe("cancelled");
    expect(two.stripe.refunds).toEqual([]);
    expect(stripe.refunds).toEqual([]);

    const old = await setup();
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((m) => m !== PAYMENT_STATUS_MIGRATION);
    const raw3 = await token(old.sb, old.shop.id);
    // 当てた版の一覧は 60 秒覚えるので、新しいアプリ（キャッシュが空）で確かめる
    const fresh = appWith(old.sb, {}, undefined, old.stripe);
    expect((await fresh.request(`${BASE}/api/v1/orders/${String(old.order["id"])}/payment`, { method: "POST", headers: { authorization: `Bearer ${raw3}` } })).status).toBe(409);
  });
});

describe("同梱のメール・LINE", () => {
  it("入金の記録で出た order.paid には受付の知らせを重ねない", async () => {
    const { emailResend } = await import("../src/plugins/email_resend");
    const sent: string[] = [];
    const ctx = {
      envelope: { id: "e1", event: "order.paid", created_at: "", shop_id: "s1", attempt: 1, data: { order_id: "o1", recorded_payment: true } },
      settings: { from: "shop@example.com" },
      config: { get: (n: string) => (n === "RESEND_API_KEY" ? "re_test" : undefined), secret: () => "" },
      fetch: (async (u: string) => (sent.push(u), new Response("{}"))) as unknown as typeof fetch,
      privileged: { orderContact: async () => { throw new Error("should not read"); } },
    };
    await emailResend.handle!(ctx as never);
    expect(sent).toEqual([]);
  });
});
