import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, memberLogin, memberMail, quoteFrom } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

/**
 * 0050_marketing_consent: 「お得な情報やセールの案内を受け取る」。
 * 欄はショップの設定（settings.marketing_consent）が ON で DB が 0050 以降のときだけ。選択はレジ → 注文（ゲスト）/ 会員に写り、
 * 会員ページで本人が変えられる。運営者は外すだけ、API は false だけ。値の検査と写し方の本体は test/db/marketing-consent.test.ts
 */
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

function setup(opts: { consent?: boolean; members?: boolean; migrated?: boolean } = {}) {
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
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500, free_over_jpy: 100000, by_prefecture: {} }, members_enabled: opts.members ?? true, marketing_consent: opts.consent ?? true },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 50 });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  if (opts.migrated === false) sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0050_marketing_consent");
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, stripe, shop, sku, app, mail, issue };
}

/** 配送先を送って最終確認画面の HTML を返す */
async function review(b: Browser, skuId: string, address: Record<string, string>): Promise<string> {
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty: "1" });
  await b.post("/my-shop/checkout", { provider: "stripe" });
  return (await b.post("/my-shop/checkout/stripe", address)).text();
}

describe("案内メールの同意: お店の画面", () => {
  it("欄は設定が ON のときだけ。ゲストの選択は最終確認画面に出て、注文の行に残る（選ばなければ受け取らない）", async () => {
    const { sb, stripe, sku, app } = setup({ members: false });
    const b = new Browser(app);
    const address = await (await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" }).then(() => b.post("/my-shop/checkout", { provider: "stripe" }))).text();
    expect(address).toContain('name="marketing_consent"');
    let html = await review(b, sku.id, { ...ADDRESS, marketing_consent: "1" });
    expect(html).toContain("お得な情報やセールの案内: 受け取る");
    expect(html).toContain('name="marketing_consent" value="1"'); // 「修正する」でも選択を持ち回る
    await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    const [sessionId] = [...stripe.sessions][0]!;
    await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(sb.tables.orders[0]).toMatchObject({ marketing_consent: true, customer_id: null });

    html = await review(new Browser(app), sku.id, ADDRESS);
    expect(html).toContain("お得な情報やセールの案内: 受け取らない");

    // 設定が OFF: 欄も行も出ない。注文は未回答
    const off = setup({ consent: false, members: false });
    const b2 = new Browser(off.app);
    html = await review(b2, off.sku.id, { ...ADDRESS, marketing_consent: "1" });
    expect(html).not.toContain("お得な情報やセールの案内");
    await b2.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    const [s2] = [...off.stripe.sessions][0]!;
    await off.stripe.deliver(off.app, BASE, off.stripe.event(s2, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(off.sb.tables.orders[0]!["marketing_consent"]).toBeNull();

    // 0050 より前の DB: 設定が ON でも欄を出さない
    const old = setup({ members: false, migrated: false });
    const b3 = new Browser(old.app);
    await b3.post("/my-shop/cart/add", { sku_id: old.sku.id, qty: "1" });
    expect(await (await b3.post("/my-shop/checkout", { provider: "stripe" })).text()).not.toContain('name="marketing_consent"');
  });

  it("会員の注文の選択は会員にも写る。会員ページで本人が変えられる（設定が OFF なら欄も経路も無い）", async () => {
    const { sb, stripe, sku, app, mail } = setup();
    const m = new Browser(app);
    await memberLogin(m, mail, "/my-shop", "member@example.com");
    const row = sb.tables.customers.find((c) => c["email"] === "member@example.com")!;
    const html = await review(m, sku.id, { ...ADDRESS, customer_email: "member@example.com", marketing_consent: "1" });
    await m.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    const [sessionId] = [...stripe.sessions][0]!;
    await stripe.deliver(app, BASE, stripe.event(sessionId, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(row).toMatchObject({ marketing_consent: true, marketing_consent_source: "checkout" });

    // 会員ページ: 欄が出て、外す → 付ける
    let account = await (await m.get("/my-shop/account")).text();
    expect(account).toContain('name="marketing_consent" value="1" checked');
    let res = await m.post("/my-shop/account/consent", {});
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=saved");
    expect(row).toMatchObject({ marketing_consent: false, marketing_consent_source: "account" });
    account = await (await m.get("/my-shop/account")).text();
    expect(account).not.toContain('name="marketing_consent" value="1" checked');
    res = await m.post("/my-shop/account/consent", { marketing_consent: "1" });
    expect(row).toMatchObject({ marketing_consent: true });

    const off = setup({ consent: false });
    const m2 = new Browser(off.app);
    await memberLogin(m2, off.mail, "/my-shop", "member@example.com");
    expect(await (await m2.get("/my-shop/account")).text()).not.toContain('name="marketing_consent"');
    expect((await m2.post("/my-shop/account/consent", { marketing_consent: "1" })).status).toBe(404);
    expect(off.sb.tables.customers.find((c) => c["email"] === "member@example.com")!["marketing_consent"]).toBeUndefined();
  });
});

describe("案内メールの同意: ヘッドレス API", () => {
  const api = (app: ReturnType<typeof appWith>, path: string, body: unknown) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { origin: "https://wp.example.com", "content-type": "application/json" }, body: JSON.stringify(body) });

  it("quote の address.marketing_consent（true / \"1\"）が confirmation.marketing_consent に出る。設定が OFF なら null", async () => {
    const { sku, app } = setup({ members: false });
    const cart = ((await (await api(app, "/api/shops/my-shop/cart", { op: "add", sku_id: sku.id })).json()) as { cart: string }).cart;
    const q = async (consent: unknown) => ((await (await api(app, "/api/shops/my-shop/checkout/quote", { cart, provider: "stripe", address: { ...ADDRESS, ...(consent === undefined ? {} : { marketing_consent: consent }) } })).json()) as { confirmation: { marketing_consent: boolean | null } }).confirmation.marketing_consent;
    expect(await q(true)).toBe(true);
    expect(await q("1")).toBe(true);
    expect(await q(false)).toBe(false);
    expect(await q(undefined)).toBe(false);
    const off = setup({ consent: false, members: false });
    const cart2 = ((await (await api(off.app, "/api/shops/my-shop/cart", { op: "add", sku_id: off.sku.id })).json()) as { cart: string }).cart;
    const r = (await (await api(off.app, "/api/shops/my-shop/checkout/quote", { cart: cart2, provider: "stripe", address: { ...ADDRESS, marketing_consent: true } })).json()) as { confirmation: { marketing_consent: boolean | null } };
    expect(r.confirmation.marketing_consent).toBeNull();
  });
});

describe("案内メールの同意: 管理画面と AI 用 API", () => {
  it("設定の保存、一覧の列と絞り込み、CSV、同意を外す", async () => {
    const { sb, shop, app } = setup({ consent: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/members`, { members_enabled: "on", marketing_consent: "on" }).catch(() => undefined);
    const yes = crypto.randomUUID();
    const no = crypto.randomUUID();
    sb.tables.customers.push({ id: yes, shop_id: shop.id, email: "yes@example.com", name: "はい", marketing_consent: true, marketing_consent_at: "2026-10-23T00:00:00Z", marketing_consent_source: "checkout", created_at: "2026-10-23T00:00:00Z" });
    sb.tables.customers.push({ id: no, shop_id: shop.id, email: "no@example.com", name: "いいえ", marketing_consent: null, created_at: "2026-10-22T00:00:00Z" });
    let html = await (await admin.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).toContain("受け取る");
    expect(html).toContain("未回答");
    html = await (await admin.get(`/admin/shops/${shop.id}/customers?consent=yes`)).text();
    expect(html).toContain("yes@example.com");
    expect(html).not.toContain("no@example.com");
    const csv = await (await admin.get(`/admin/shops/${shop.id}/customers.csv?consent=yes`)).text();
    expect(csv.split("\r\n")[0]).toContain("marketing_consent,marketing_consent_at,marketing_consent_source");
    expect(csv).toContain(",yes,");
    expect(csv).toContain(",checkout,");
    expect(csv).not.toContain("no@example.com");
    const res = await admin.post(`/admin/shops/${shop.id}/customers/${yes}/consent/withdraw?consent=yes`, {});
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?consent=yes&flash=consent_withdrawn`);
    expect(sb.tables.customers.find((c) => c["id"] === yes)).toMatchObject({ marketing_consent: false, marketing_consent_source: "admin" });
  });

  it("REST: 同意で絞る、false は書ける、true は 400 consent_requires_person。0050 より前の DB は 409", async () => {
    const { sb, shop, app, issue } = setup();
    const tok = await issue(["customers:read", "customers:write"]);
    const id = crypto.randomUUID();
    sb.tables.customers.push({ id, shop_id: shop.id, email: "m@example.com", marketing_consent: true, created_at: "" });
    const rest = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
    };
    expect((await rest("GET", "/customers?marketing_consent=true")).json["total"]).toBe(1);
    expect((await rest("GET", "/customers?marketing_consent=false")).json["total"]).toBe(0);
    const up = await rest("PATCH", `/customers/${id}`, { marketing_consent: true });
    expect(up.status).toBe(400);
    expect(up.json.error!.message).toMatch(/consent_requires_person/);
    expect((await rest("PATCH", `/customers/${id}`, { marketing_consent: false })).json).toMatchObject({ marketing_consent: false, marketing_consent_source: "api" });
    expect((await rest("POST", "/customers/upsert", { email: "m@example.com", marketing_consent: "no" })).status).toBe(400);

    const old = setup({ migrated: false });
    const tok2 = await old.issue(["customers:read", "customers:write"]);
    const r = await old.app.request(`${BASE}/api/v1/customers?marketing_consent=true`, { headers: { authorization: `Bearer ${tok2}` } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("0050_marketing_consent");
  });
});
