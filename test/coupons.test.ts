import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, memberLogin, memberMail, quoteFrom } from "./helpers";

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function setup(opts: { modules?: boolean; settings?: Record<string, unknown> } = {}) {
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
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500, free_over_jpy: 100000, by_prefecture: {} }, ...(opts.modules === false ? {} : { modules: { coupons: true } }), ...opts.settings },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 50 });
  const jam = sb.addProduct(shop.id, { slug: "jam", name: "ジャム", published: true });
  const jamS = sb.addSku(shop.id, jam.id, { code: "JAM", name: null, price_jpy: 800, available: 50 });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  const campaign = (fields: Record<string, unknown>) => {
    const row = { id: `camp-${sb.tables.coupon_campaigns.length + 1}`, shop_id: shop.id, value: 0, starts_at: null, ends_at: null, usage_limit: null, per_customer_limit: null, combinable: false, audience: "public", conditions: {}, active: true, created_at: new Date().toISOString(), ...fields };
    sb.tables.coupon_campaigns.push(row);
    return row;
  };
  return { sb, stripe, shop, tee, teeM, jam, jamS, app, campaign, mail };
}

type App = ReturnType<typeof appWith>;

async function api(app: App, path: string, body?: unknown): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://wp.example.com", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function cartOp(app: App, body: Record<string, unknown>): Promise<Record<string, unknown> & { cart: string }> {
  const res = await api(app, "/api/shops/my-shop/cart", body);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & { cart: string };
}

describe("クーポン: モジュールが OFF のショップ", () => {
  it("クーポン欄も API の操作も出さず、判定のための DB の往復もしない", async () => {
    const { sb, app, teeM, campaign } = setup({ modules: false });
    campaign({ name: "10%", code: "OFF10", kind: "percent", value: 10 });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await b.get("/my-shop/cart?coupon=OFF10");
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).not.toContain("クーポンコード");
    expect((await b.post("/my-shop/cart/coupon", { code: "OFF10" })).status).toBe(302);
    const review = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(review).not.toContain("OFF10");
    expect(sb.calls.some((c) => c.includes("coupon_"))).toBe(false);
    const res = await api(app, "/api/shops/my-shop/cart", { op: "coupon_add", code: "OFF10" });
    expect(res.status).toBe(409);
    expect(((await cartOp(app, { op: "add", sku_id: teeM.id })) as Record<string, unknown>)["coupons"]).toBeNull();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${sb.tables.shops[0]!["id"]}/modules/coupons`)).status).toBe(404);
  });
});

describe("クーポン: 同梱テーマのレジ", () => {
  it("コードを入れる → カートで値引き → 確認画面 → Stripe に Banto の額のクーポンを付ける → Webhook で注文に値引きと決済額が残る", async () => {
    const { sb, stripe, app, teeM, jamS, campaign } = setup();
    const c = campaign({ name: "Tシャツ 20% オフ", code: "TEE20", kind: "percent", value: 20, conditions: { product_ids: [sb.tables.products[0]!["id"]] }, usage_limit: 10, per_customer_limit: 1 });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await b.post("/my-shop/cart/add", { sku_id: jamS.id, qty: "1" });
    // 小文字・前後の空白でも受け付ける
    expect((await b.post("/my-shop/cart/coupon", { code: " tee20 " })).headers.get("location")).toBe("/my-shop/cart");
    let html = await (await b.get("/my-shop/cart")).text();
    // 対象は Tシャツだけ: 6000 * 20% = 1200
    expect(html).toContain("TEE20");
    expect(html).toContain("−¥1,200");
    expect(html).toContain("¥5,600"); // 6800 - 1200

    html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("値引き（TEE20 Tシャツ 20% オフ）");
    expect(html).toContain("¥6,100"); // 6800 + 500 - 1200
    const res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    const [sessionId, session] = [...stripe.sessions][0]!;
    const couponId = session.params.get("discounts[0][coupon]")!;
    expect(stripe.coupons.get(couponId)).toEqual({ account: "acct_connected", amount_off: 1200, name: "クーポン TEE20" });
    // 明細は値引き前の単価のまま（値引きは「割引」の行で出る）
    expect(session.params.get("line_items[0][price_data][unit_amount]")).toBe("3000");
    expect(sb.tables.coupon_redemptions).toEqual([expect.objectContaining({ campaign_id: c.id, status: "held", amount_jpy: 1200 })]);

    const hook = await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(hook.status).toBe(200);
    const order = sb.tables.orders[0]!;
    expect(order).toMatchObject({ total_jpy: 6100, shipping_jpy: 500, discount_jpy: 1200, amount_paid_jpy: 6100 });
    expect(sb.tables.order_items.find((i) => i["sku_id"] === teeM.id)).toMatchObject({ discount_jpy: 1200 });
    expect(sb.tables.order_items.find((i) => i["sku_id"] === jamS.id)).toMatchObject({ discount_jpy: 0 });
    expect(sb.tables.coupon_redemptions[0]).toMatchObject({ status: "used", order_id: order["id"] });

    // 同じ人（同じメールアドレス）の 2 回目は、確認画面で「使えませんでした」と出て値引きされない
    const b2 = new Browser(app);
    await b2.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await b2.get("/my-shop/cart?coupon=TEE20");
    html = await (await b2.post("/my-shop/checkout/stripe", { ...ADDRESS, customer_email: "BUYER@example.com" })).text();
    expect(html).toContain("ご利用回数の上限に達しています");
    expect(html).toContain("¥3,500");
    // 別の人なら使える
    html = await (await b2.post("/my-shop/checkout/stripe", { ...ADDRESS, customer_email: "other@example.com" })).text();
    expect(html).toContain("¥2,900");
  });

  it("確認画面のあとに上限に達したら、確定せずに確認画面を出し直す（値引きなしの内容で）", async () => {
    const { app, teeM, campaign, sb } = setup();
    campaign({ name: "先着 1 名", code: "FIRST", kind: "fixed", value: 1000, usage_limit: 1 });
    const a = new Browser(app);
    const b = new Browser(app);
    for (const x of [a, b]) {
      await x.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
      await x.get("/my-shop/cart?coupon=FIRST");
    }
    const qa = quoteFrom(await (await a.post("/my-shop/checkout/stripe", ADDRESS)).text());
    const qb = quoteFrom(await (await b.post("/my-shop/checkout/stripe", { ...ADDRESS, customer_email: "b@example.com" })).text());
    expect((await a.post("/my-shop/checkout/stripe", { quote: qa })).status).toBe(303);
    const res = await b.post("/my-shop/checkout/stripe", { quote: qb });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("配布数の上限に達したため終了しました");
    expect(html).toContain("¥3,500");
    expect(sb.tables.coupon_redemptions.filter((r) => r["status"] !== "released")).toHaveLength(1);
  });

  it("送料無料のクーポンは確認画面で送料の額を値引きし、他のクーポンと併用できる（併用不可のものは外す）", async () => {
    const { app, teeM, campaign } = setup();
    campaign({ name: "送料無料", code: "SHIP", kind: "free_shipping", value: 0, combinable: true });
    campaign({ name: "300 円引き", code: "OFF300", kind: "fixed", value: 300, combinable: true });
    campaign({ name: "単独", code: "SOLO", kind: "fixed", value: 2000 });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    for (const code of ["SHIP", "OFF300", "SOLO"]) await b.post("/my-shop/cart/coupon", { code });
    let html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("他のクーポンと併用できません");
    expect(html).toContain("送料無料のクーポンは、配送先を入れた後の確認画面で反映されます");
    html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("値引き（SHIP 送料無料）");
    expect(html).toContain("−¥500");
    expect(html).toContain("¥2,700"); // 3000 + 500 - 300 - 500
    // 外すと元に戻る
    await b.post("/my-shop/cart/coupon", { remove: "SHIP" });
    html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("¥3,200");
  });

  it("値引き後の支払い額が 1〜49 円の注文は確定できない。形の違うコードは受け付けない", async () => {
    const { app, jamS, campaign } = setup();
    campaign({ name: "760 円引き", code: "OFF760", kind: "fixed", value: 760, combinable: true });
    campaign({ name: "送料無料", code: "SHIP", kind: "free_shipping", value: 0, combinable: true });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: jamS.id, qty: "1" });
    await b.post("/my-shop/cart/coupon", { code: "OFF760" });
    await b.post("/my-shop/cart/coupon", { code: "SHIP" });
    // 800 + 500 - 760 - 500 = 40 円
    const res = await b.post("/my-shop/checkout/stripe", ADDRESS);
    expect(res.headers.get("location")).toBe("/my-shop/cart?error=minimum");
    expect(await (await b.get("/my-shop/cart?error=minimum")).text()).toContain("1〜49 円");
    expect((await b.post("/my-shop/cart/coupon", { code: "だめ" })).headers.get("location")).toBe("/my-shop/cart?error=coupon_invalid");
  });

  it("0 円の注文は決済ページへ行かずに確定する。キャンセルは返金なしで回数を戻す", async () => {
    const { sb, stripe, app, jamS, campaign } = setup();
    campaign({ name: "全額", code: "ALL", kind: "fixed", value: 100000, combinable: true, per_customer_limit: 1 });
    campaign({ name: "送料無料", code: "SHIP", kind: "free_shipping", value: 0, combinable: true });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: jamS.id, qty: "2" });
    await b.post("/my-shop/cart/coupon", { code: "ALL" });
    await b.post("/my-shop/cart/coupon", { code: "SHIP" });
    const html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("お支払いはありません（0 円）");
    expect(html).toContain("¥0");
    expect(html).not.toContain("決済ページへ");
    const before = sb.tables.inventory.find((i) => i["sku_id"] === jamS.id)!["available"];
    const res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    const doneUrl = res.headers.get("location")!;
    expect(doneUrl).toMatch(new RegExp(`^${BASE}/my-shop/checkout/done\\?s=[A-Za-z0-9_.-]+&free=1$`));
    expect(stripe.sessions.size).toBe(0);
    const order = sb.tables.orders[0]!;
    expect(order).toMatchObject({ status: "paid", total_jpy: 0, discount_jpy: 2100, payment_provider: "free", amount_paid_jpy: 0 });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === jamS.id)!["available"]).toBe(Number(before) - 2);
    expect(sb.tables.coupon_redemptions.map((r) => r["status"])).toEqual(["used", "used"]);
    expect(await (await b.get("/my-shop/checkout/done?free=1")).text()).toContain("ご注文が確定しました");
    // 照会トークン付きなら注文番号も出る（0 円の注文はこの時点で確定している）
    expect(await (await b.get(doneUrl.slice(BASE.length))).text()).toContain(`ご注文番号は ${order["number"]} です`);

    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${order["shop_id"]}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(sb.tables.orders[0]!["status"]).toBe("cancelled");
    expect(stripe.refunds).toEqual([]);
    expect(sb.tables.coupon_redemptions.map((r) => r["status"])).toEqual(["released", "released"]);
  });

  it("会員限定のクーポンはログイン中の会員だけ。キャンセルすると回数が戻る", async () => {
    const { sb, stripe, app, teeM, campaign, mail } = setup({ settings: { members_enabled: true } });
    campaign({ name: "会員 500 円", code: "MEMBER", kind: "fixed", value: 500, audience: "members", per_customer_limit: 1 });
    const guest = new Browser(app);
    await guest.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await guest.get("/my-shop/cart?coupon=MEMBER");
    expect(await (await guest.get("/my-shop/cart")).text()).toContain("会員の方だけ");

    const m = new Browser(app);
    await memberLogin(m, mail, "/my-shop", "member@example.com");
    await m.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await m.get("/my-shop/cart?coupon=MEMBER");
    const html = await (await m.post("/my-shop/checkout/stripe", { ...ADDRESS, customer_email: "member@example.com" })).text();
    expect(html).toContain("値引き（MEMBER");
    await m.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    const memberId = sb.tables.customers.find((c) => c["email"] === "member@example.com")!["id"];
    expect(sb.tables.coupon_redemptions[0]!["subject"]).toBe(`c:${memberId}`);
    const [sessionId] = [...stripe.sessions][0]!;
    await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    const order = sb.tables.orders[0]!;

    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const detail = await (await admin.get(`/admin/shops/${order["shop_id"]}/orders/${order["id"]}`)).text();
    expect(detail).toContain("−¥500");
    await admin.post(`/admin/shops/${order["shop_id"]}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(sb.tables.orders[0]!["status"]).toBe("refunded");
    expect(sb.tables.coupon_redemptions[0]!["status"]).toBe("released");
  });
});

describe("クーポン: 会員の独自項目の条件（0049）", () => {
  const FIELDS = [{ key: "rank", label: "会員ランク", type: "select", options: ["regular", "silver", "gold"] }, { key: "owner", label: "担当者", type: "text" }];

  it("ゲストと項目の合わない会員には使えず、合う会員にはカートと確認画面で値引きが付く", async () => {
    const { sb, app, teeM, campaign, mail } = setup({ settings: { members_enabled: true, customer_fields: FIELDS } });
    campaign({ name: "ゴールド 500 円", code: "GOLD", kind: "fixed", value: 500, conditions: { attributes: { rank: ["gold"] } } });
    const guest = new Browser(app);
    await guest.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await guest.get("/my-shop/cart?coupon=GOLD");
    expect(await (await guest.get("/my-shop/cart")).text()).toContain("対象の会員の方だけ");

    const m = new Browser(app);
    await memberLogin(m, mail, "/my-shop", "member@example.com");
    const row = sb.tables.customers.find((c) => c["email"] === "member@example.com")!;
    await m.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await m.get("/my-shop/cart?coupon=GOLD");
    expect(await (await m.get("/my-shop/cart")).text()).toContain("対象の会員の方だけ"); // 値が無い会員
    row["attributes"] = { rank: "gold" };
    expect(await (await m.get("/my-shop/cart")).text()).not.toContain("対象の会員の方だけ");
    const html = await (await m.post("/my-shop/checkout/stripe", { ...ADDRESS, customer_email: "member@example.com" })).text();
    expect(html).toContain("値引き（GOLD");
    // 0049 より前の DB では会員 id を渡さない（条件のあるクーポンは使えない）
    const old = setup({ settings: { members_enabled: true, customer_fields: FIELDS } });
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((v) => v !== "0049_coupon_attributes");
    old.campaign({ name: "ゴールド", code: "GOLD", kind: "fixed", value: 500, conditions: { attributes: { rank: ["gold"] } } });
    const m2 = new Browser(old.app);
    await memberLogin(m2, old.mail, "/my-shop", "member@example.com");
    old.sb.tables.customers.find((c) => c["email"] === "member@example.com")!["attributes"] = { rank: "gold" };
    await m2.post("/my-shop/cart/add", { sku_id: old.teeM.id, qty: "1" });
    await m2.get("/my-shop/cart?coupon=GOLD");
    expect(await (await m2.get("/my-shop/cart")).text()).toContain("対象の会員の方だけ");
  });

  it("管理画面: 会員の項目の条件を印とカンマ区切りで登録する。定義が無ければ案内だけ", async () => {
    const { sb, app, shop } = setup({ settings: { members_enabled: true, customer_fields: FIELDS } });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/coupons`;
    const page = await (await admin.get(`${base}/new`)).text();
    expect(page).toContain('name="attr_rank__2"');
    expect(page).toContain('name="attr_owner"');
    const form = { name: "ゴールド", code: "GOLD", kind: "fixed", value: "500", active: "on", audience: "public", attr_rank__1: "on", attr_rank__2: "on", attr_owner: "田中, 佐藤, 田中" };
    const res = await admin.post(base, form);
    expect(res.headers.get("location")).toMatch(/flash=saved$/);
    const row = sb.tables.coupon_campaigns[0]!;
    expect(row["conditions"]).toEqual({ attributes: { rank: ["silver", "gold"], owner: ["田中", "佐藤"] } });
    const edit = await (await admin.get(`${base}/${row["id"]}`)).text();
    expect(edit).toContain('name="attr_rank__2" checked');
    expect(edit).toContain('value="田中, 佐藤"');
    // 印を外せば条件なし
    await admin.post(`${base}/${row["id"]}`, { ...form, attr_rank__1: "", attr_rank__2: "", attr_owner: "" });
    expect(sb.tables.coupon_campaigns[0]!["conditions"]).toEqual({});

    const plain = setup();
    const admin2 = await Browser.loggedIn(plain.app, "owner@example.com", "password-123");
    expect(await (await admin2.get(`/admin/shops/${plain.shop.id}/modules/coupons/new`)).text()).toContain("会員の項目はまだ定義されていません");
  });
});

describe("クーポン: ヘッドレス API", () => {
  it("coupon_add / coupon_remove でカートに入れ、カート・quote・確定で Banto が判定する", async () => {
    const { app, stripe, teeM, campaign } = setup();
    campaign({ name: "1000 円以上で 10%", code: "TEN", kind: "percent", value: 10, conditions: { min_subtotal_jpy: 5000 } });
    let v = await cartOp(app, { op: "add", sku_id: teeM.id });
    v = await cartOp(app, { cart: v.cart, op: "coupon_add", code: "ten" });
    expect(v["coupons"]).toEqual({ applied: [], rejected: [expect.objectContaining({ code: "TEN", reason: "min_subtotal", message: expect.stringContaining("2000") })], discount_jpy: 0, subtotal_after_discount_jpy: 3000 });
    v = await cartOp(app, { cart: v.cart, op: "set", sku_id: teeM.id, qty: 2 });
    expect(v["coupons"]).toMatchObject({ applied: [{ code: "TEN", amount_jpy: 600 }], discount_jpy: 600, subtotal_after_discount_jpy: 5400 });
    // 形の違うコード
    expect((await api(app, "/api/shops/my-shop/cart", { cart: v.cart, op: "coupon_add", code: "!!" })).status).toBe(400);

    const q = (await (await api(app, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: ADDRESS })).json()) as Record<string, unknown> & { quote: string; confirmation: Record<string, unknown> };
    expect(q.confirmation).toMatchObject({ subtotal_jpy: 6000, shipping_jpy: 500, discount_jpy: 600, total_jpy: 5900, discounts: [{ code: "TEN", amount_jpy: 600 }], coupon_notices: [] });
    const placed = (await (await api(app, "/api/shops/my-shop/checkout", { quote: q.quote })).json()) as Record<string, unknown>;
    expect(placed["payment_url"]).toMatch(/^https:\/\/checkout\.stripe\.com/);
    expect([...stripe.coupons.values()]).toEqual([{ account: "acct_connected", amount_off: 600, name: "クーポン TEN" }]);

    const removed = await cartOp(app, { cart: v.cart, op: "coupon_remove", code: "TEN" });
    expect(removed["coupons"]).toMatchObject({ applied: [], rejected: [] });
  });
});

describe("クーポン: 管理画面（同梱モジュール）", () => {
  it("モジュールの画面で ON にできる（ON/OFF の URL がクーポンの作成と衝突しない）", async () => {
    const { sb, app, shop } = setup({ modules: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/modules`)).text();
    const action = /action="([^"]*\/modules\/coupons[^"]*)"/.exec(html)![1]!;
    let res = await admin.post(action, { enabled: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/modules?flash=saved`);
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ modules: { coupons: true } });
    expect((await admin.get(`/admin/shops/${shop.id}/modules/coupons`)).status).toBe(200);
    // ON のあいだもクーポンの作成は作成のまま
    res = await admin.post(`/admin/shops/${shop.id}/modules/coupons`, { name: "x", code: "X1", kind: "fixed", value: "100", active: "on", audience: "public" });
    expect(sb.tables.coupon_campaigns).toHaveLength(1);
    res = await admin.post(action, { enabled: "off" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ modules: { coupons: false } });
    expect((await admin.get(`/admin/shops/${shop.id}/modules/coupons`)).status).toBe(404);
  });

  it("作成・一覧・編集・クーポン付きリンク・コードの重複・条件の商品のスラッグ", async () => {
    const { sb, app, shop } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/coupons`;
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).toContain(base);
    expect(await (await admin.get(base)).text()).toContain("クーポンはまだありません");
    const form = { name: "秋のセール", code: "aut-10", kind: "percent", value: "10", usage_limit: "100", per_customer_limit: "1", min_subtotal_jpy: "3000", product_slugs: "tee\njam", exclude_sale: "on", active: "on", starts_at: "2026-10-01T00:00", ends_at: "2026-10-31T23:59", audience: "public" };
    let res = await admin.post(base, form);
    expect(res.headers.get("location")).toMatch(new RegExp(`^${base}/.+\\?flash=saved$`));
    const row = sb.tables.coupon_campaigns[0]!;
    expect(row).toMatchObject({ name: "秋のセール", code: "AUT-10", kind: "percent", value: 10, usage_limit: 100, per_customer_limit: 1, active: true, combinable: false, audience: "public" });
    // 時刻は日本時間として受け取り、UTC で持つ
    expect(row["starts_at"]).toBe("2026-09-30T15:00:00.000Z");
    expect(row["conditions"]).toEqual({ min_subtotal_jpy: 3000, exclude_sale: true, product_ids: sb.tables.products.map((p) => p["id"]) });
    const edit = await (await admin.get(`${base}/${row["id"]}`)).text();
    expect(edit).toContain(`${BASE}/my-shop/cart?coupon=AUT-10`);
    expect(edit).toContain('value="2026-10-01T00:00"');
    expect(edit).toContain("tee\njam");
    expect(await (await admin.get(base)).text()).toContain("秋のセール");

    // 同じコードは作れない・存在しない商品・値の範囲
    expect((await admin.post(base, { ...form, name: "別" })).headers.get("location")).toBe(`${base}/new?flash=code_taken`);
    expect((await admin.post(base, { ...form, code: "OTHER", product_slugs: "nope" })).headers.get("location")).toBe(`${base}/new?flash=unknown_products`);
    expect((await admin.post(base, { ...form, code: "OTHER", value: "150" })).headers.get("location")).toBe(`${base}/new?flash=invalid`);
    expect((await admin.post(base, { ...form, code: "OTHER", starts_at: "2026-11-01T00:00", ends_at: "2026-10-01T00:00" })).headers.get("location")).toBe(`${base}/new?flash=invalid`);

    // 停止・削除
    res = await admin.post(`${base}/${row["id"]}`, { ...form, active: "" });
    expect(sb.tables.coupon_campaigns[0]!["active"]).toBe(false);
    res = await admin.post(`${base}/${row["id"]}/delete`, {});
    expect(sb.tables.coupon_campaigns).toHaveLength(0);
  });
});

describe("クーポン: ヘッドレスの会員（Authorization: Bearer）", () => {
  /** 連携側の手順: /members/login でコードを送り、/members/verify でトークンを受け取る */
  async function memberTokens(app: App, mail: ReturnType<typeof memberMail>, email: string): Promise<{ access_token: string; refresh_token: string; member: { id: string } }> {
    const started = (await (await api(app, "/api/shops/my-shop/members/login", { email })).json()) as { challenge_id: string };
    const res = await api(app, "/api/shops/my-shop/members/verify", { challenge_id: started.challenge_id, code: mail.code(email) });
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; refresh_token: string; member: { id: string } };
  }
  const withToken = (app: App, token: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "https://wp.example.com", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("連携側が Banto の会員トークン（メールのコードで発行）で、会員限定のクーポン・会員 ID での回数・注文の紐づけが使える", async () => {
    const { sb, app, teeM, campaign, mail } = setup({ settings: { members_enabled: true } });
    campaign({ name: "会員 10%", code: "VIP", kind: "percent", value: 10, audience: "members", per_customer_limit: 1 });
    const conf = (await (await api(app, "/api/shops/my-shop/members/config")).json()) as Record<string, unknown>;
    expect(conf).toEqual({ enabled: true, login: ["email_code", "email_link"] });
    const tokens = await memberTokens(app, mail, "member@example.com");
    const token = tokens.access_token;
    const memberId = sb.tables.customers.find((c) => c["email"] === "member@example.com")!["id"];
    expect(tokens.member.id).toBe(memberId);
    // CORS の事前確認で Authorization を許す
    const pre = await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "OPTIONS", headers: { origin: "https://wp.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");

    // トークンなし（ゲスト）では会員限定は使えない
    let v = await cartOp(app, { op: "add", sku_id: teeM.id });
    v = await cartOp(app, { cart: v.cart, op: "coupon_add", code: "VIP" });
    expect(v["coupons"]).toMatchObject({ applied: [], rejected: [{ code: "VIP", reason: "members_only" }] });
    expect(v["member"]).toBeNull();
    // トークン付きなら使える
    let res = await withToken(app, token, `/api/shops/my-shop/cart?cart=${encodeURIComponent(v.cart)}`);
    const mv = (await res.json()) as Record<string, unknown>;
    expect(mv["member"]).toEqual({ id: memberId });
    expect(mv["coupons"]).toMatchObject({ applied: [{ code: "VIP", amount_jpy: 300 }] });

    res = await withToken(app, token, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: { ...ADDRESS, customer_email: "anything@example.com" } });
    const q = (await res.json()) as { quote: string; confirmation: Record<string, unknown> };
    expect(q.confirmation).toMatchObject({ discount_jpy: 300, total_jpy: 3200 });
    // 同じ quote をトークンなしで確定しようとしても、会員限定の値引きは付かない（判定し直して出し直す）
    res = await api(app, "/api/shops/my-shop/checkout", { quote: q.quote });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("changed");
    res = await withToken(app, token, "/api/shops/my-shop/checkout", { quote: q.quote });
    expect(res.status).toBe(200);
    expect(sb.tables.coupon_redemptions[0]).toMatchObject({ subject: `c:${memberId}` });
    expect(sb.tables.reservations.at(-1)).toMatchObject({ customer_id: memberId });

    // 会員本人の注文（確定後）
    const res0 = sb.tables.reservations.at(-1)!;
    await sb.fetch(`${sb.url}/rest/v1/rpc/confirm_reservation`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sb.serviceRoleKey}`, apikey: sb.serviceRoleKey }, body: JSON.stringify({ p_reservation_id: res0["id"], p_shop_id: res0["shop_id"], p_order: { payment_provider: "stripe", payment_ref: "pi_x" } }) });
    const me = (await (await withToken(app, token, "/api/shops/my-shop/members/me")).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ id: memberId, email: "member@example.com", orders: [expect.objectContaining({ total_jpy: 3200, discount_jpy: 300 })] });
    expect(JSON.stringify(me)).not.toContain("千代田");

    // 2 回目は 1 人あたりの上限（メールアドレスを変えても同じ会員）
    v = await cartOp(app, { op: "add", sku_id: teeM.id });
    v = await cartOp(app, { cart: v.cart, op: "coupon_add", code: "VIP" });
    res = await withToken(app, token, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: { ...ADDRESS, customer_email: "new@example.com" } });
    expect(((await res.json()) as { confirmation: Record<string, unknown> }).confirmation).toMatchObject({ discount_jpy: 0, coupon_notices: [expect.objectContaining({ reason: "limit_reached" })] });
  });

  it("確かめられないトークンは 401（ゲストとして黙って続けない）。会員機能が OFF ならトークンを無視する。DB に問い合わせずに確かめる", async () => {
    const { sb, app, mail } = setup({ settings: { members_enabled: true } });
    expect((await withToken(app, "not-a-token", "/api/shops/my-shop/cart")).status).toBe(401);
    expect((await withToken(app, "", "/api/shops/my-shop/members/me")).status).toBe(401);
    const { access_token: token, refresh_token: refresh } = await memberTokens(app, mail, "m2@example.com");
    // refresh のトークンは API の呼び出しに使えない
    expect((await withToken(app, refresh, "/api/shops/my-shop/cart")).status).toBe(401);
    sb.calls.length = 0;
    for (let i = 0; i < 3; i++) expect((await withToken(app, token, "/api/shops/my-shop/cart")).status).toBe(200);
    expect(sb.calls.filter((c) => c.includes("member_"))).toHaveLength(0);

    const off = setup();
    const r = await withToken(off.app, token, "/api/shops/my-shop/cart");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, unknown>)["member"]).toBeNull();
    expect((await (await api(off.app, "/api/shops/my-shop/members/config")).json())).toEqual({ enabled: false });
  });

  it("0 円の注文はヘッドレス API でも決済なしで確定し、完了画面の URL を返す", async () => {
    const { sb, app, jamS, campaign } = setup();
    campaign({ name: "全額", code: "ALL", kind: "fixed", value: 100000, combinable: true });
    campaign({ name: "送料無料", code: "SHIP", kind: "free_shipping", value: 0, combinable: true });
    let v = await cartOp(app, { op: "add", sku_id: jamS.id });
    v = await cartOp(app, { cart: v.cart, op: "coupon_add", code: "ALL" });
    v = await cartOp(app, { cart: v.cart, op: "coupon_add", code: "SHIP" });
    const q = (await (await api(app, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: ADDRESS })).json()) as { quote: string; confirmation: Record<string, unknown> };
    expect(q.confirmation).toMatchObject({ total_jpy: 0, payment: { free: true }, submit_label: "注文を確定する" });
    const placed = (await (await api(app, "/api/shops/my-shop/checkout", { quote: q.quote })).json()) as Record<string, unknown>;
    expect(placed).toMatchObject({ payment_url: expect.stringMatching(new RegExp(`^${BASE}/my-shop/checkout/done\\?s=[A-Za-z0-9_.-]+&free=1$`)), free: true, order_id: sb.tables.orders[0]!["id"], status_token: expect.any(String) });
    expect(await (await api(app, (placed["status_url"] as string).slice(BASE.length))).json()).toMatchObject({ status: "confirmed", order: { number: 1001, total_jpy: 0, payment_provider: "free" } });
  });
});
