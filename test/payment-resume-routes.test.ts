import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, memberLogin, memberMail, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";

/** お支払いに戻る（0180）: 完了画面・会員ページ・ヘッドレスから KOMOJU の決済ページへ戻る・取りやめる */
afterEach(() => externalHosts.clear());

type Sess = { id: string; status: string; expired?: boolean; payment?: { id: string; status: string } | null; metadata?: Record<string, string> };

function setup(opts: { members?: boolean } = {}) {
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
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, ...(opts.members ? { members_enabled: true } : {}) },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.tables.hook_endpoints.push({ id: "ep-komoju", shop_id: shop.id, name: "KOMOJU 決済", url: bundledPluginUrl("komoju"), events: [], enabled: true, manifest: null, settings: { payment_types: "bank_transfer" }, created_at: "" });
  const komoju = { sessions: new Map<string, Sess>(), created: [] as Record<string, unknown>[], calls: [] as string[] };
  externalHosts.set("https://komoju.com/", async (req) => {
    const u = new URL(req.url);
    komoju.calls.push(`${req.method} ${u.pathname}`);
    if (req.method === "POST" && u.pathname === "/api/v1/sessions") {
      const body = (await req.json()) as Record<string, unknown>;
      komoju.created.push(body);
      const id = `ses_${komoju.created.length}`;
      komoju.sessions.set(id, { id, status: "pending", metadata: body["metadata"] as Record<string, string> });
      return Response.json({ id, session_url: `https://komoju.com/sessions/${id}`, status: "pending" });
    }
    const m = /^\/api\/v1\/sessions\/([^/]+)(\/cancel)?$/.exec(u.pathname);
    if (m) {
      const sess = komoju.sessions.get(m[1]!);
      if (!sess) return new Response("{}", { status: 404 });
      if (m[2]) {
        if (sess.payment) return new Response("{}", { status: 422 });
        sess.status = "cancelled";
      }
      return Response.json({ ...sess, session_url: `https://komoju.com/sessions/${sess.id}` });
    }
    const p = /^\/api\/v1\/payments\/([^/]+)\/(cancel|refund)$/.exec(u.pathname);
    if (p) return Response.json({ id: p[1], status: p[2] === "cancel" ? "cancelled" : "refunded" });
    return new Response("{}", { status: 404 });
  });
  const mail = opts.members ? memberMail(sb, shop.id) : null;
  const app = appWith(sb, { KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju", ...(mail ? { RESEND_API_KEY: "re_test" } : {}) }, undefined, stripe);
  return { sb, shop, sku, app, komoju, mail, b: new Browser(app) };
}

async function placeKomoju(b: Browser, skuId: string) {
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty: "1" });
  await b.post("/my-shop/checkout", { provider: "komoju" });
  const review = await b.post("/my-shop/checkout/komoju", ADDRESS);
  return b.post("/my-shop/checkout/komoju", { quote: quoteFrom(await review.text()) });
}

describe("完了画面からお支払いに戻る（0180）", () => {
  it("決済ページの ID を予約に残し、完了画面に「お支払いに進む」。押すと同じ決済ページへ", async () => {
    const { sb, sku, komoju, b } = setup();
    expect((await placeKomoju(b, sku.id)).headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    expect(sb.tables.reservations[0]).toMatchObject({ payment_session: { provider: "komoju", id: "ses_1", types: ["bank_transfer"] } });
    // KOMOJU から手続きをせずに戻る（戻り先は完了画面と照会トークン）
    const ret = new URL(String(komoju.created[0]!["return_url"]));
    const s = ret.searchParams.get("s")!;
    const done = await (await b.get(`/my-shop/checkout/done?s=${encodeURIComponent(s)}&session_id=ses_1`)).text();
    expect(done).toContain("お支払いに進む");
    expect(done).toContain("このお申し込みを取りやめる");
    const pay = await b.post("/my-shop/checkout/payment", { s, action: "pay" });
    expect(pay.status).toBe(303);
    expect(pay.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    expect(komoju.created).toHaveLength(1);
  });

  it("決済ページの期限が切れていれば、同じ金額・種類で作り直して入れ替える。手続き済みは案内のメールへ", async () => {
    const { sb, sku, komoju, b } = setup();
    await placeKomoju(b, sku.id);
    const s = new URL(String(komoju.created[0]!["return_url"])).searchParams.get("s")!;
    komoju.sessions.get("ses_1")!.expired = true;
    const pay = await b.post("/my-shop/checkout/payment", { s, action: "pay" });
    expect(pay.headers.get("location")).toBe("https://komoju.com/sessions/ses_2");
    expect(komoju.created[1]).toMatchObject({ amount: 3500, payment_types: ["bank_transfer"], external_order_num: sb.tables.reservations[0]!["id"] });
    expect(String(komoju.created[1]!["return_url"])).toMatch(/\/my-shop\/checkout\/done\?s=/);
    expect(sb.tables.reservations[0]).toMatchObject({ payment_session: { id: "ses_2" } });
    // 振込先が出た（手続き済み）→ 完了画面に「メールの案内で」
    komoju.sessions.get("ses_2")!.status = "completed";
    komoju.sessions.get("ses_2")!.payment = { id: "pay_1", status: "authorized" };
    const awaiting = await b.post("/my-shop/checkout/payment", { s, action: "pay" });
    expect(awaiting.headers.get("location")).toMatch(/\/my-shop\/checkout\/done\?s=.*&pay=awaiting$/);
    expect(await (await b.get(awaiting.headers.get("location")!)).text()).toContain("KOMOJU から届いたメールの案内でお支払いください");
  });

  it("取りやめる: KOMOJU の決済ページを取り消してから在庫を戻す。照会トークンが無ければ何もしない", async () => {
    const { sb, sku, komoju, b } = setup();
    await placeKomoju(b, sku.id);
    const s = new URL(String(komoju.created[0]!["return_url"])).searchParams.get("s")!;
    expect((await b.post("/my-shop/checkout/payment", { s: "forged", action: "cancel" })).status).toBe(404);
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
    const cancel = await b.post("/my-shop/checkout/payment", { s, action: "cancel" });
    expect(cancel.headers.get("location")).toMatch(/pay=cancelled$/);
    expect(komoju.calls).toContain("POST /api/v1/sessions/ses_1/cancel");
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(5);
    // 取りやめた後は戻れない
    expect((await b.post("/my-shop/checkout/payment", { s, action: "pay" })).headers.get("location")).toMatch(/pay=released$/);
  });
});

describe("作り直した後の支払い（0180）", () => {
  it("同じ予約に 2 回目の支払いが届いたら返金する（作り直す前の決済ページでも払われた場合）", async () => {
    const { sb, shop, sku, app, komoju, b } = setup();
    await placeKomoju(b, sku.id);
    expect(komoju.created[0]).toMatchObject({ expires_in_seconds: 86_400 });
    const rid = String(sb.tables.reservations[0]!["id"]);
    const { signKomojuPayload } = await import("../src/plugins/komoju");
    const send = async (evt: string, pay: string) => {
      const payload = JSON.stringify({ id: evt, type: "payment.captured", data: { id: pay, status: "captured", amount: 3500, currency: "JPY", payment_details: { type: "bank_transfer" }, metadata: { reservation_id: rid, shop_id: shop.id } } });
      return (await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload })).json();
    };
    expect(await send("evt_1", "pay_1")).toMatchObject({ order_id: expect.any(String) });
    expect(await send("evt_2", "pay_2")).toMatchObject({ refunded: true, ignored: "paid_elsewhere" });
    expect(komoju.calls).toContain("POST /api/v1/payments/pay_2/refund");
    expect(komoju.calls).not.toContain("POST /api/v1/payments/pay_1/refund");
    expect(sb.tables.orders).toHaveLength(1);
  });
});

describe("会員ページとヘッドレスからお支払いに戻る（0180）", () => {
  it("会員ページに「お支払いが済んでいないお申し込み」。本人の予約だけ、押すと決済ページへ", async () => {
    const { sb, sku, komoju, mail, b, app } = setup({ members: true });
    await memberLogin(b, mail!, "/my-shop", "buyer@example.com");
    await placeKomoju(b, sku.id);
    const rid = String(sb.tables.reservations[0]!["id"]);
    expect(sb.tables.reservations[0]!["customer_id"]).toBeTruthy();
    const page = await (await b.get("/my-shop/account")).text();
    expect(page).toContain("お支払いが済んでいないお申し込み");
    expect(page).toContain(`name="r" value="${rid}"`);
    const pay = await b.post("/my-shop/checkout/payment", { r: rid, action: "pay" });
    expect(pay.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    // ログインしていない人・ほかの会員は会員の予約 id では引けない
    const guest = new Browser(app);
    expect((await guest.post("/my-shop/checkout/payment", { r: rid, action: "pay" })).status).toBe(404);
    const other = new Browser(app);
    await memberLogin(other, mail!, "/my-shop", "other@example.com");
    expect((await other.post("/my-shop/checkout/payment", { r: rid, action: "cancel" })).headers.get("location")).toBe("/my-shop/account?pay=unavailable#pending-payments");
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
    // 取りやめると一覧から消える
    expect((await b.post("/my-shop/checkout/payment", { r: rid, action: "cancel" })).headers.get("location")).toBe("/my-shop/account?pay=cancelled#pending-payments");
    const after = await (await b.get("/my-shop/account?pay=cancelled")).text();
    expect(after).toContain("お申し込みを取りやめました");
    expect(after).not.toContain(`name="r" value="${rid}"`);
    expect(komoju.calls).toContain("POST /api/v1/sessions/ses_1/cancel");
    mail!.dispose();
  });

  it("ヘッドレス: 照会トークンで pay / cancel、status に resumable", async () => {
    const { sku, komoju, app, b } = setup();
    await placeKomoju(b, sku.id);
    const s = new URL(String(komoju.created[0]!["return_url"])).searchParams.get("s")!;
    const st = await (await app.request(`${BASE}/api/shops/my-shop/checkout/status?token=${encodeURIComponent(s)}`)).json();
    expect(st).toMatchObject({ status: "pending", resumable: true });
    const post = (body: Record<string, unknown>) => app.request(`${BASE}/api/shops/my-shop/checkout/payment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await post({ token: s, action: "pay" })).json()).toEqual({ result: "redirect", url: "https://komoju.com/sessions/ses_1" });
    expect((await post({ token: s, action: "nope" })).status).toBe(400);
    expect((await post({ token: "forged", action: "pay" })).status).toBe(400);
    expect(await (await post({ token: s, action: "cancel" })).json()).toEqual({ result: "cancelled" });
    expect(await (await post({ token: s, action: "pay" })).json()).toEqual({ result: "released" });
  });
});
