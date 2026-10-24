import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, externalHosts, memoryAdapters } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { bundledPluginUrl } from "../src/plugins";

afterEach(() => externalHosts.clear());

async function setup(opts: { connect?: boolean } = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "返品は7日以内", stripe_account_id: (opts.connect ?? true) ? "acct_connected" : null, settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, contact_email: "shop@example.com" } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 10 });
  if (!(opts.connect ?? true)) sb.tables.hook_endpoints.push({ id: "ep-stripe", shop_id: shop.id, name: "Stripe", url: bundledPluginUrl("stripe"), events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
  const app = appWith(sb, {}, undefined, stripe);
  const b = new Browser(app);
  await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
  await checkout(b, "/my-shop");
  const [sessionId] = [...stripe.sessions.keys()];
  await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
  const order = sb.tables.orders[0]!;
  const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
  return { sb, stripe, shop, sku, order, app, admin };
}

describe("注文のキャンセル（返金 → 在庫戻し）", () => {
  it("管理画面: Stripe（Connect）で返金し、在庫が戻り、状態は refunded", async () => {
    const { sb, stripe, shop, sku, order, admin } = await setup();
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(8);
    const res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/orders/${order["id"]}?flash=refunded`);
    expect(stripe.refunds).toEqual([{ account: "acct_connected", payment_intent: order["payment_ref"], idempotencyKey: `cancel-${order["id"]}` }]);
    expect(order["status"]).toBe("refunded");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(10);
    expect(sb.tables.hook_deliveries.some((d) => d["event"] === "order.cancelled")).toBe(false); // 送信先が無いので積まれない
    const html = await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}?flash=refunded`)).text();
    expect(html).toContain("返金し、注文をキャンセルして在庫を戻しました");
    expect(html).not.toContain("キャンセル済みにする");
    // 2 回目は何もしない
    const again = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(again.headers.get("location")).toContain("flash=refunded");
    expect(stripe.refunds).toHaveLength(1);
  });

  it("API キー方式の注文は自分のアカウントで返金する。返金に失敗したら注文は変わらない", async () => {
    const { sb, stripe, shop, sku, order, admin } = await setup({ connect: false });
    stripe.failRefund = true;
    let res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toContain("flash=refund_failed");
    expect(order["status"]).toBe("paid");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(8);
    stripe.failRefund = false;
    res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toContain("flash=refunded");
    expect(stripe.refunds.at(-1)).toMatchObject({ account: null });
  });

  it("発送済みの注文はキャンセルできない", async () => {
    const { shop, order, admin } = await setup();
    await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "shipped" });
    const res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toContain("flash=not_cancellable");
  });

  it("AI 用 API からのキャンセルも返金してから在庫を戻す", async () => {
    const { sb, stripe, shop, sku, order, app } = await setup();
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: sb.shops[0]!.owner_id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["orders:read", "orders:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const res = await app.request(`${BASE}/api/v1/orders/${order["id"]}/status`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("refunded");
    expect(stripe.refunds).toHaveLength(1);
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(10);
    // 注文番号で検索
    const q = await app.request(`${BASE}/api/v1/orders?q=${order["number"]}`, { headers: { authorization: `Bearer ${raw}` } });
    expect(((await q.json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("注文の検索と CSV", () => {
  it("一覧の検索（番号・メール）と状態の絞り込み、CSV の中身", async () => {
    const { shop, order, admin } = await setup();
    let html = await (await admin.get(`/admin/shops/${shop.id}/orders?q=${order["number"]}`)).text();
    expect(html).toContain(`#${order["number"]}`);
    html = await (await admin.get(`/admin/shops/${shop.id}/orders?q=nobody@example.com`)).text();
    expect(html).toContain("注文はまだありません");
    html = await (await admin.get(`/admin/shops/${shop.id}/orders?q=buyer@example.com&status=paid`)).text();
    expect(html).toContain(`#${order["number"]}`);
    html = await (await admin.get(`/admin/shops/${shop.id}/orders?status=shipped`)).text();
    expect(html).toContain("注文はまだありません");

    const csv = await admin.get(`/admin/shops/${shop.id}/orders.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("orders-my-shop.csv");
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM（Response.text() は BOM を落とすのでバイトで見る）
    const text = new TextDecoder().decode(bytes);
    const rows = text.trim().split("\r\n");
    expect(rows[0]).toContain("注文番号,日時,状態,合計,送料,氏名,メール");
    expect(rows[1]).toContain(`${order["number"]},`);
    expect(rows[1]).toContain("山田 太郎,buyer@example.com,0312345678,100-0001,東京都,千代田区,千代田1-1,,TEE-M x2,stripe");
    expect(rows[1]).toContain(",6500,500,");
  });
});

describe("メール通知（既定の送り手 Resend）", () => {
  it("order.paid で購入者に注文確認、運営者に控え。order.shipped で発送通知", async () => {
    const { sb, shop, order, app, admin } = await setup();
    sb.tables.hook_endpoints.push({ id: "ep-mail", shop_id: shop.id, name: "メール", url: bundledPluginUrl("email_resend"), events: ["order.paid", "order.shipped"], enabled: true, manifest: null, settings: { from: "マイショップ <order@example.com>", bcc_owner: true }, created_at: "" });
    // 注文は setup で確定済み（その時点では送信先が無かった）ので、改めて積む
    sb.enqueue(shop.id, "order.paid", { order_id: order["id"], order_number: order["number"] });
    // お問い合わせ番号つきで発送済みにする（0022 の ship_orders）。番号として読めなければ保存しない
    let res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "shipped", tracking_carrier: "yamato", tracking_number: "abc" });
    expect(res.headers.get("location")).toContain("flash=tracking_invalid");
    res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "shipped", tracking_carrier: "yamato", tracking_number: "1234-5678-9012" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const detail = await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}`)).text();
    expect(detail).toContain("123456789012");
    expect(detail).toContain("toi.kuronekoyamato.co.jp");

    const sent: { auth: string | null; idem: string | null; body: Record<string, unknown> }[] = [];
    externalHosts.set("https://api.resend.com/", async (req) => {
      sent.push({ auth: req.headers.get("authorization"), idem: req.headers.get("idempotency-key"), body: (await req.json()) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(h(new Request(input, init)));
      return sb.fetch(input, init);
    };
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const config = memoryAdapters({ RESEND_API_KEY: "re_test", PUBLIC_BASE_URL: BASE }).config;
    const r = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl, config });
    expect(r).toEqual({ claimed: 2, delivered: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    const paid = sent.find((s) => String(s.body["subject"]).includes("ご注文ありがとうございます"))!;
    expect(paid.auth).toBe("Bearer re_test");
    expect(paid.idem).toMatch(/^banto-/);
    expect(paid.body).toMatchObject({ from: "マイショップ <order@example.com>", to: ["buyer@example.com"], bcc: ["shop@example.com"], reply_to: "shop@example.com" });
    const text = String(paid.body["text"]);
    expect(text).toContain(`注文番号: ${order["number"]}`);
    expect(text).toContain("Tシャツ / M × 2  ¥6,000");
    expect(text).toContain("送料: ¥500");
    expect(text).toContain("合計（税込）: ¥6,500");
    // 税率ごとの内訳（0017 の前の注文は標準税率として扱う）
    expect(text).toContain("（10%対象 ¥6,500　内消費税 ¥590）");
    expect(text).toContain("東京都");
    expect(text).toContain("返品は7日以内");
    expect(text).toContain(`${BASE}/my-shop/orders/lookup`);
    const shipped = sent.find((s) => String(s.body["subject"]).includes("発送しました"))!;
    expect(String(shipped.body["text"])).toContain("発送しました");
    expect(String(shipped.body["text"])).toContain("お問い合わせ番号: ヤマト運輸 123456789012");
    expect(String(shipped.body["text"])).toContain("https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=123456789012");

    // 送信元が未設定なら失敗として記録（再送対象）
    sb.tables.hook_endpoints[0]!["settings"] = {};
    sb.enqueue(shop.id, "order.paid", { order_id: order["id"] });
    const r2 = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl, config });
    expect(r2.failed).toBe(1);
    expect(String(sb.tables.hook_deliveries.at(-1)!["last_error"])).toContain("送信元が未設定");
  });

  it("プラグイン一覧に出て、有効化できる", async () => {
    const { shop, admin } = await setup();
    const html = await (await admin.get(`/admin/shops/${shop.id}/plugins`)).text();
    expect(html).toContain("メール通知");
    expect(html).toContain("メールの送り手: resend");
    expect(html).toContain("npx wrangler secret put RESEND_API_KEY");
  });
});
