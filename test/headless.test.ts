import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, quoteFrom } from "./helpers";
import { cartCookieName } from "../src/cart/cart";

function setup(settings: Record<string, unknown> = {}) {
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
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500, free_over_jpy: 10000, by_prefecture: {} }, ...settings },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const cap = sb.addProduct(shop.id, { slug: "cap", name: "キャップ", published: true });
  const capF = sb.addSku(shop.id, cap.id, { code: "CAP", name: null, price_jpy: 2000, available: 1 });
  const hidden = sb.addProduct(shop.id, { slug: "hidden", name: "非公開", published: false });
  const hiddenSku = sb.addSku(shop.id, hidden.id, { code: "HID", price_jpy: 100, available: 9 });
  const app = appWith(sb, {}, undefined, stripe);
  return { sb, stripe, shop, teeM, capF, cap, hiddenSku, app };
}

type App = ReturnType<typeof appWith>;
type Json = Record<string, unknown> & { cart: string };

const WP = "https://wp.example.com";

async function api(app: App, path: string, body?: unknown): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    // 別ドメインのブラウザからの呼び出しを再現（Cookie なし）
    headers: { origin: WP, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function cartOp(app: App, body: Record<string, unknown>): Promise<Json> {
  const res = await api(app, "/api/shops/my-shop/cart", body);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

const stock = (sb: FakeSupabase, skuId: string) => sb.tables.inventory.find((i) => i["sku_id"] === skuId)!["available"];

describe("CORS（公開 API だけ）", () => {
  it("/api/shops は別ドメインから呼べる。/api/v1 には付けない", async () => {
    const { app } = setup();
    let res = await api(app, "/api/shops");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    res = await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "OPTIONS", headers: { origin: WP, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    res = await app.request(`${BASE}/api/v1/shop`, { headers: { origin: WP } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("カート API", () => {
  it("入れる・数量変更・出す・リセット。価格と合計は Banto が計算する", async () => {
    const { app, teeM, capF } = setup();
    let v = await cartOp(app, { op: "add", sku_id: teeM.id, qty: 2 });
    expect(v).toMatchObject({ count: 2, subtotal_jpy: 6000, tax_included: true, can_checkout: true, payments: { stripe: true, komoju: false } });
    expect(v["items"]).toEqual([expect.objectContaining({ sku_id: teeM.id, product_name: "Tシャツ", sku_name: "M", unit_price_jpy: 3000, qty: 2, line_total_jpy: 6000, short: false })]);
    expect(v["shipping"]).toMatchObject({ free_over_jpy: 10000, remaining_for_free_jpy: 4000 });

    v = await cartOp(app, { cart: v.cart, op: "add", sku_id: capF.id });
    expect(v).toMatchObject({ count: 3, subtotal_jpy: 8000 });
    v = await cartOp(app, { cart: v.cart, op: "set", sku_id: teeM.id, qty: 1 });
    expect(v).toMatchObject({ count: 2, subtotal_jpy: 5000 });
    v = await cartOp(app, { cart: v.cart, op: "remove", sku_id: capF.id });
    expect(v).toMatchObject({ count: 1, subtotal_jpy: 3000 });

    // GET でも同じ内容（最新の価格で再計算）
    const got = (await (await api(app, `/api/shops/my-shop/cart?cart=${encodeURIComponent(v.cart)}`)).json()) as Json;
    expect(got).toMatchObject({ count: 1, subtotal_jpy: 3000 });

    v = await cartOp(app, { cart: v.cart, op: "clear" });
    expect(v).toMatchObject({ count: 0, subtotal_jpy: 0, items: [], can_checkout: false });
  });

  it("在庫不足・非公開・価格変更・改ざんを Banto 側で判定する", async () => {
    const { sb, app, teeM, capF, hiddenSku } = setup();
    // 非公開の SKU は入らない
    let res = await api(app, "/api/shops/my-shop/cart", { op: "add", sku_id: hiddenSku.id });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "sku_not_available" });
    // 不正な操作
    expect((await api(app, "/api/shops/my-shop/cart", { op: "explode" })).status).toBe(400);
    expect((await api(app, "/api/shops/my-shop/cart", { op: "add", sku_id: teeM.id, qty: -1 })).status).toBe(400);
    // 改ざんしたトークン
    res = await api(app, "/api/shops/my-shop/cart", { cart: "eyJpdGVtcyI6W119.forged", op: "clear" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cart" });

    // 在庫 1 のキャップを 2 個 → short、購入不可
    let v = await cartOp(app, { op: "add", sku_id: capF.id, qty: 2 });
    expect(v).toMatchObject({ can_checkout: false });
    expect((v["items"] as Record<string, unknown>[])[0]).toMatchObject({ short: true, in_stock: true });

    // 価格を変えると次の取得で反映される（カートには数量しか持たない）
    v = await cartOp(app, { cart: v.cart, op: "set", sku_id: capF.id, qty: 1 });
    v = await cartOp(app, { cart: v.cart, op: "add", sku_id: teeM.id });
    sb.tables.skus.find((s) => s["id"] === teeM.id)!["price_jpy"] = 3500;
    v = (await (await api(app, `/api/shops/my-shop/cart?cart=${encodeURIComponent(v.cart)}`)).json()) as Json;
    expect(v).toMatchObject({ subtotal_jpy: 5500 });

    // 商品が非公開になったらカートから外れ、removed で知らせる
    sb.tables.products.find((p) => p["slug"] === "cap")!["published"] = false;
    v = (await (await api(app, `/api/shops/my-shop/cart?cart=${encodeURIComponent(v.cart)}`)).json()) as Json;
    expect(v).toMatchObject({ count: 1, removed: [capF.id] });
  });

  it("checkout_url で同梱テーマのレジに引き継げる。不正なトークンでは今のカートを消さない", async () => {
    const { app, teeM, shop } = setup();
    const v = await cartOp(app, { op: "add", sku_id: teeM.id, qty: 2 });
    const url = new URL(v["checkout_url"] as string);
    expect(url.origin).toBe(BASE);
    const b = new Browser(app);
    const res = await b.get(url.pathname + url.search);
    expect(res.headers.get("location")).toBe("/my-shop/cart");
    expect(b.cookies.get(cartCookieName(shop.id))).toBeDefined();
    let html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("Tシャツ");
    expect(html).toContain("¥6,000");
    await b.get("/my-shop/cart/load?cart=bogus.token");
    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("¥6,000");
  });
});

describe("購入リンク", () => {
  it("/:shop/buy で SKU をカートに入れてカート画面へ", async () => {
    const { app, teeM, capF, hiddenSku } = setup();
    const b = new Browser(app);
    let res = await b.get(`/my-shop/buy?sku=${teeM.id}&qty=2`);
    expect(res.headers.get("location")).toBe("/my-shop/cart");
    res = await b.get(`/my-shop/buy?items=${capF.id}:1,${teeM.id}:1`);
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain('value="3"');
    expect(html).toContain("キャップ");
    expect(html).toContain("¥11,000");
    expect((await b.get(`/my-shop/buy?sku=${hiddenSku.id}`)).status).toBe(404);
  });
});

describe("最終確認画面（同梱テーマ）", () => {
  it("設定した引渡時期・キャンセル条件を出し、未設定なら法務ページへ案内する", async () => {
    const terms = { delivery: "ご入金確認後 3 営業日以内に発送します。", cancellation: "決済後のキャンセルはできません。", payment_note: "領収書は発行しません。" };
    const { app, teeM } = setup({ checkout_terms: terms });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    let html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    for (const text of Object.values(terms)) expect(html).toContain(text);
    expect(html).toContain("¥3,500"); // 3,000 + 送料 500
    expect(html).toContain(`href="${BASE}/my-shop/legal"`);

    const plain = setup();
    const b2 = new Browser(plain.app);
    await b2.post("/my-shop/cart/add", { sku_id: plain.teeM.id, qty: "1" });
    html = await (await b2.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("お届け時期は「特定商取引法に基づく表記」をご確認ください");
    expect(html).toContain("返品ポリシー」をご確認ください");
  });

  it("確認後に価格が変わったら確定せず、新しい内容で確認し直させる", async () => {
    const { sb, app, teeM, stripe } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const quote = quoteFrom(await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text());
    sb.tables.skus.find((s) => s["id"] === teeM.id)!["price_jpy"] = 3200;
    let res = await b.post("/my-shop/checkout/stripe", { quote });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("価格・送料・在庫のいずれかが変わりました");
    expect(html).toContain("¥3,700");
    expect(sb.tables.reservations).toHaveLength(0);
    // 新しい quote で確定できる。Stripe の明細は確認画面の金額
    res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    expect([...stripe.sessions.values()][0]!.params.get("line_items[0][price_data][unit_amount]")).toBe("3200");
  });

  it("改ざん・別ショップ・別決済手段の quote は受け付けない。「修正する」で入力に戻れる", async () => {
    const { sb, app, teeM } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const review = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    const quote = quoteFrom(review);
    const [payload, sig] = quote.split(".");
    const forged = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/"))) as { total: number };
    forged.total = 1;
    const forgedToken = `${btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${sig}`;
    expect((await b.post("/my-shop/checkout/stripe", { quote: forgedToken })).headers.get("location")).toBe("/my-shop/cart?error=expired");
    expect((await b.post("/my-shop/checkout/komoju", { quote })).headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.reservations).toHaveLength(0);
    expect(await (await b.get("/my-shop/cart?error=expired")).text()).toContain("確認画面の有効期限が切れました");

    // 「修正する」: 住所の hidden 項目を /checkout に POST → 入力済みの配送先画面
    const edit = await b.post("/my-shop/checkout", { provider: "stripe", ...ADDRESS, city: "港区" });
    const html = await edit.text();
    expect(html).toContain('value="港区"');
    expect(html).toContain('value="山田 太郎"');
  });
});

describe("チェックアウト API（ヘッドレス）", () => {
  it("quote → confirmation を表示 → checkout で決済ページ。Webhook で確定する", async () => {
    const { sb, stripe, app, teeM, shop } = setup({
      checkout_terms: { delivery: "3 営業日以内に発送" },
      headless: { return_origins: [WP] },
    });
    const v = await cartOp(app, { op: "add", sku_id: teeM.id, qty: 2 });

    // 住所の不備は項目名で返す
    let res = await api(app, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: { ...ADDRESS, state: "火星", customer_email: "x" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_address", fields: expect.arrayContaining(["state", "customer_email"]) });

    res = await api(app, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: ADDRESS });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { quote: string; expires_at: string; confirmation: Record<string, unknown> };
    expect(q.confirmation).toMatchObject({
      shop: { slug: "my-shop" },
      lines: [{ sku_id: teeM.id, product_name: "Tシャツ", sku_name: "M", unit_price_jpy: 3000, qty: 2, line_total_jpy: 6000 }],
      subtotal_jpy: 6000,
      shipping_jpy: 500,
      total_jpy: 6500,
      tax_included: true,
      payment: { provider: "stripe" },
      delivery: "3 営業日以内に発送",
      cancellation: null,
      ship_to: { name: "山田 太郎", state: "東京都" },
      links: { legal: `${BASE}/my-shop/legal`, returns: `${BASE}/my-shop/returns` },
      submit_label: "注文を確定する（決済ページへ）",
    });
    expect(Date.parse(q.expires_at)).toBeGreaterThan(Date.now());
    expect(sb.tables.reservations).toHaveLength(0);

    // 許可したオリジンへの戻り先はそのまま、それ以外は Banto の画面
    res = await api(app, "/api/shops/my-shop/checkout", { quote: q.quote, success_url: `${WP}/thanks?order=1`, cancel_url: "https://evil.example/phish" });
    expect(res.status).toBe(200);
    const { payment_url, status_token, status_url } = (await res.json()) as { payment_url: string; status_token: string; status_url: string };
    expect(payment_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    // 照会トークン（0035）: 応答に入り、success_url にも banto_status として付く（個人情報は入っていない）
    expect(status_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(status_url).toBe(`${BASE}/api/shops/my-shop/checkout/status?token=${encodeURIComponent(status_token)}`);
    expect(atob(status_token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("buyer@example.com");
    const [sessionId, session] = [...stripe.sessions.entries()][0]!;
    expect(session.params.get("success_url")).toBe(`${WP}/thanks?order=1&banto_status=${encodeURIComponent(status_token)}`);
    expect(session.params.get("cancel_url")).toBe(`${BASE}/my-shop/cart`);
    expect(session.params.get("line_items[1][price_data][unit_amount]")).toBe("500");
    expect(stock(sb, teeM.id)).toBe(3);
    expect(sb.tables.reservations[0]!["shipping_jpy"]).toBe(500);

    // 戻り先の画面: Webhook の前は「確認中」、後は注文番号つきで確定
    let st = await api(app, `/api/shops/my-shop/checkout/status?token=${encodeURIComponent(status_token)}`);
    expect(st.status).toBe(200);
    expect(st.headers.get("cache-control")).toBe("no-store");
    expect(await st.json()).toMatchObject({ status: "pending", order: null });
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(sb.tables.orders[0]).toMatchObject({ shop_id: shop.id, total_jpy: 6500, shipping_jpy: 500, customer_email: "buyer@example.com" });
    st = await api(app, status_url.slice(BASE.length));
    const body = (await st.json()) as { status: string; order: Record<string, unknown> };
    expect(body).toMatchObject({ status: "confirmed", order: { number: 1001, status: "paid", total_jpy: 6500, payment_provider: "stripe" } });
    expect(JSON.stringify(body)).not.toContain("buyer@example.com");
    // 署名の合わないトークン・無いトークンは 400
    expect((await api(app, `/api/shops/my-shop/checkout/status?token=${encodeURIComponent(status_token)}x`)).status).toBe(400);
    expect((await api(app, "/api/shops/my-shop/checkout/status")).status).toBe(400);
  });

  it("確認後の変更は 409 で新しい confirmation を返す。改ざん・在庫切れも弾く", async () => {
    const { sb, app, teeM } = setup();
    const v = await cartOp(app, { op: "add", sku_id: teeM.id, qty: 1 });
    const q = (await (await api(app, "/api/shops/my-shop/checkout/quote", { cart: v.cart, provider: "stripe", address: ADDRESS })).json()) as { quote: string };

    expect((await api(app, "/api/shops/my-shop/checkout", { quote: `${q.quote}x` })).status).toBe(400);
    expect((await api(app, "/api/shops/my-shop/checkout", {})).status).toBe(400);

    sb.tables.skus.find((s) => s["id"] === teeM.id)!["price_jpy"] = 2800;
    let res = await api(app, "/api/shops/my-shop/checkout", { quote: q.quote });
    expect(res.status).toBe(409);
    const changed = (await res.json()) as { error: string; quote: string; confirmation: { total_jpy: number } };
    expect(changed).toMatchObject({ error: "changed", confirmation: { total_jpy: 3300 } });
    expect(sb.tables.reservations).toHaveLength(0);

    sb.tables.inventory.find((i) => i["sku_id"] === teeM.id)!["available"] = 0;
    res = await api(app, "/api/shops/my-shop/checkout", { quote: changed.quote });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "stock" });
    expect(sb.tables.reservations).toHaveLength(0);
  });

  it("使えない決済手段・空のカートは quote を出さない", async () => {
    const { app } = setup();
    const empty = await cartOp(app, { op: "clear" });
    let res = await api(app, "/api/shops/my-shop/checkout/quote", { cart: empty.cart, provider: "stripe", address: ADDRESS });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "empty_cart" });
    res = await api(app, "/api/shops/my-shop/checkout/quote", { cart: empty.cart, provider: "komoju", address: ADDRESS });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "payment_unavailable", payments: { stripe: true, komoju: false } });
  });
});

describe("管理画面: 確認画面の文言とヘッドレス設定", () => {
  it("未設定なら警告し、保存すると確認画面に出る。戻り先は https のオリジンだけ残す", async () => {
    const { sb, app, shop } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("購入前の確認画面に出す「お届け時期（引渡時期）・ご注文の取消し・返品（申込みの撤回・解除）」が未設定です");

    let res = await admin.post(`/admin/shops/${shop.id}/terms`, { delivery: "翌営業日に発送", cancellation: "キャンセル不可", payment_note: "" });
    expect(res.headers.get("location")).toContain("flash=terms_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ checkout_terms: { delivery: "翌営業日に発送", cancellation: "キャンセル不可", payment_note: "" }, shipping: { flat_fee_jpy: 500 } });
    html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).not.toContain("が未設定です");

    res = await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://wp.example.com/shop\nhttp://insecure.example\nhttp://localhost:3000, nonsense\nhttps://wp.example.com" });
    expect(res.headers.get("location")).toContain("flash=headless_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ headless: { return_origins: ["https://wp.example.com", "http://localhost:3000"] } });
  });
});

describe("商品一覧の絞り込み・並べ替え・ページング（公開 API）とタグ別一覧", () => {
  function catalog() {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const mk = (slug: string, name: string, price: number, tags: string[], created: string, updated: string, description: string | null = null) => {
      const p = sb.addProduct(shop.id, { slug, name, published: true, tags, description, created_at: created, updated_at: updated });
      sb.addSku(shop.id, p.id, { code: slug.toUpperCase(), price_jpy: price, available: 1 });
      return p;
    };
    mk("tee", "Tシャツ", 3000, ["夏物", "トップス"], "2026-01-01T00:00:00Z", "2026-10-10T00:00:00Z", "綿100%");
    mk("cap", "キャップ", 2000, ["夏物", "小物"], "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
    mk("coat", "コート", 20000, ["冬物"], "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    sb.addProduct(shop.id, { slug: "hidden", name: "非公開", published: false, tags: ["夏物"] });
    return { sb, app: appWith(sb) };
  }
  type List = { products: { slug: string; tags: string[]; updated_at: string }[]; total: number; limit: number; offset: number; next_offset: number | null; tags: { tag: string; count: number }[] };
  const list = async (app: App, qs = "") => (await (await api(app, `/api/shops/my-shop/products${qs}`)).json()) as List;

  it("tag / q / updated_since / sort / limit / offset", async () => {
    const { app } = catalog();
    let r = await list(app);
    expect(r.products.map((p) => p.slug)).toEqual(["coat", "cap", "tee"]);
    expect(r).toMatchObject({ total: 3, limit: 100, offset: 0, next_offset: null });
    // tags はショップ全体（公開中だけ）の件数
    expect(r.tags).toEqual([
      { tag: "夏物", count: 2 },
      { tag: "トップス", count: 1 },
      { tag: "冬物", count: 1 },
      { tag: "小物", count: 1 },
    ]);
    expect(r.products[2]).toMatchObject({ tags: ["夏物", "トップス"], updated_at: "2026-10-10T00:00:00Z" });

    expect((await list(app, `?tag=${encodeURIComponent("夏物")}`)).products.map((p) => p.slug)).toEqual(["cap", "tee"]);
    // 2 文字以下の語は、タグ・カテゴリー・ブランドで絞っているときだけ（docs/headless.md）
    expect((await list(app, `?q=${encodeURIComponent("綿")}&tag=${encodeURIComponent("夏物")}`)).products.map((p) => p.slug)).toEqual(["tee"]);
    expect((await list(app, `?q=${encodeURIComponent("冬")}&tag=${encodeURIComponent("冬物")}`)).products.map((p) => p.slug)).toEqual(["coat"]);
    expect((await api(app, `/api/shops/my-shop/products?q=${encodeURIComponent("綿")}`)).status).toBe(400);
    expect((await list(app, `?q=${encodeURIComponent("キャップ")}`)).products.map((p) => p.slug)).toEqual(["cap"]);
    expect((await list(app, "?updated_since=2026-03-01T12:00:00Z")).products.map((p) => p.slug)).toEqual(["coat", "tee"]);
    expect((await list(app, "?updated_since=2026-03-05T00:00:00Z")).products.map((p) => p.slug)).toEqual(["tee"]);
    expect((await list(app, "?sort=price_asc")).products.map((p) => p.slug)).toEqual(["cap", "tee", "coat"]);
    expect((await list(app, "?sort=updated")).products.map((p) => p.slug)).toEqual(["tee", "coat", "cap"]);

    r = await list(app, "?sort=price_asc&limit=2");
    expect(r).toMatchObject({ total: 3, limit: 2, offset: 0, next_offset: 2 });
    expect(r.products.map((p) => p.slug)).toEqual(["cap", "tee"]);
    r = await list(app, "?sort=price_asc&limit=2&offset=2");
    expect(r).toMatchObject({ next_offset: null });
    expect(r.products.map((p) => p.slug)).toEqual(["coat"]);

    for (const bad of ["?sort=random", "?limit=0", "?limit=abc", "?offset=-1", "?updated_since=yesterday"]) {
      const res = await api(app, `/api/shops/my-shop/products${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    }
    const detail = (await (await api(app, "/api/shops/my-shop/products/tee")).json()) as { product: Record<string, unknown> };
    expect(detail.product).toMatchObject({ tags: ["夏物", "トップス"], updated_at: "2026-10-10T00:00:00Z" });
  });

  it("ストアフロント: /:shop?tag= でタグ別一覧、商品ページにタグのリンク", async () => {
    const { app } = catalog();
    const b = new Browser(app);
    let html = await (await b.get(`/my-shop?tag=${encodeURIComponent("夏物")}`)).text();
    expect(html).toContain("キャップ");
    expect(html).toContain("Tシャツ");
    expect(html).not.toContain("コート</div>");
    expect(html).toContain('class="active"');
    expect(html).toContain(`href="/my-shop?tag=${encodeURIComponent("冬物")}"`);
    expect(html).toContain(`rel="canonical" href="${BASE}/my-shop?tag=${encodeURIComponent("夏物")}"`);
    html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain(`href="/my-shop?tag=${encodeURIComponent("トップス")}"`);
  });
});
