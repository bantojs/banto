import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, memberLogin, memberMail, quoteFrom } from "./helpers";

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function setup() {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "S",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_x",
    settings: { members_enabled: true, modules: { coupons: true }, shipping: { mode: "flat", flat_fee_jpy: 500, free_over_jpy: null, by_prefecture: {} } },
  });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 3000, available: 50 });
  const campaign = { id: "camp-1", shop_id: shop.id, name: "おかえり 500 円", code: null, kind: "fixed", value: 500, starts_at: null, ends_at: null, usage_limit: null, per_customer_limit: null, combinable: false, audience: "public", conditions: {}, active: true, grant_valid_days: 30, created_at: new Date().toISOString() };
  sb.tables.coupon_campaigns.push(campaign);
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, stripe, shop, sku, campaign, mail, app };
}

async function buyWith(b: Browser, sku: string, code: string, path = "/my-shop"): Promise<string> {
  await b.post(`${path}/cart/add`, { sku_id: sku, qty: "1" });
  await b.post(`${path}/cart/coupon`, { code });
  await b.post(`${path}/checkout`, { provider: "stripe" });
  return (await b.post(`${path}/checkout/stripe`, ADDRESS)).text();
}

describe("配布型のクーポン（0019）", () => {
  it("使い捨てコード: 1 回だけ使える。決済ページの期限切れで戻り、確定で使用済み", async () => {
    const { sb, stripe, sku, campaign, app } = setup();
    const g = sb.addGrant(campaign.shop_id, campaign.id);
    const b = new Browser(app);
    const confirm = await buyWith(b, sku.id, g.code);
    expect(confirm).toContain("おかえり 500 円");
    expect(confirm).toContain("¥3,000"); // 3000 + 500 - 500
    await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(confirm) });
    expect(g["status"]).toBe("held");
    // 同じコードはほかの人が使えない（手続き中）
    const other = await buyWith(new Browser(app), sku.id, g.code);
    expect(other).toContain("ほかのご注文の手続き中");
    // 期限切れで戻る
    const [first] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(first!, "checkout.session.expired"), WEBHOOK_SECRET);
    expect(g["status"]).toBe("available");
    // 使い直して確定
    const b2 = new Browser(app);
    const c2 = await buyWith(b2, sku.id, g.code);
    await b2.post("/my-shop/checkout/stripe", { quote: quoteFrom(c2) });
    const second = [...stripe.sessions.keys()].at(-1)!;
    await stripe.deliver(app, BASE, stripe.event(second, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(g["status"]).toBe("used");
    expect(sb.tables.orders.at(-1)!["discount_jpy"]).toBe(500);
    expect(await buyWith(new Browser(app), sku.id, g.code)).toContain("ほかのご注文の手続き中");
  });

  it("会員に発行したクーポン: その会員だけ・ログイン中だけ。マイクーポンに出て、期限切れは使えない", async () => {
    const { sb, shop, sku, campaign, mail, app } = setup();
    const b = new Browser(app);
    await memberLogin(b, mail, "/my-shop", "m@example.com");
    const member = sb.tables.customers.find((x) => x["email"] === "m@example.com")!;
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}`)).text();
    expect(page).toContain("発行して配る");
    const res = await admin.post(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants/members`, { emails: "M@example.com\nnobody@example.com" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}?grants=issued#grants`);
    // 同じ会員に重ねて発行しない
    expect((await admin.post(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants/members`, { all: "on" })).headers.get("location")).toContain("grants=none");
    const g = sb.tables.coupon_grants.find((x) => x["customer_id"] === member["id"])!;
    expect(Date.parse(String(g["expires_at"])) - Date.now()).toBeGreaterThan(29 * 86400_000);
    const account = await (await b.get("/my-shop/account")).text();
    expect(account).toContain("マイクーポン");
    expect(account).toContain(String(g["code"]));
    // ログインしていない人は使えない
    expect(await buyWith(new Browser(app), sku.id, String(g["code"]))).toContain("受け取った会員がログインしているときだけ");
    // 本人は使える
    expect(await buyWith(b, sku.id, String(g["code"]))).toContain("おかえり 500 円");
    // 期限切れ
    g["expires_at"] = new Date(Date.now() - 1000).toISOString();
    const b3 = new Browser(app);
    await memberLogin(b3, mail, "/my-shop", "m@example.com");
    expect(await buyWith(b3, sku.id, String(g["code"]))).toContain("有効期限が過ぎています");
  });

  it("使い捨てコードの一括発行・CSV・取り消し", async () => {
    const { sb, shop, campaign, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants/codes`, { count: "3" });
    expect(sb.tables.coupon_grants).toHaveLength(3);
    const csv = await (await admin.get(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants.csv`)).text();
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
    const g = sb.tables.coupon_grants[0]!;
    await admin.post(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants/${g["id"]}/revoke`, {});
    expect(g["status"]).toBe("revoked");
    expect((await admin.post(`/admin/shops/${shop.id}/modules/coupons/${campaign.id}/grants/codes`, { count: "0" })).headers.get("location")).toContain("grants=invalid");
  });

  it("コードの無いキャンペーンを作れる", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/shops/${shop.id}/modules/coupons`, { name: "誕生日", code: "", kind: "percent", value: "10", grant_valid_days: "14", active: "on" });
    expect(res.headers.get("location")).toMatch(/flash=saved/);
    expect(sb.tables.coupon_campaigns.at(-1)).toMatchObject({ name: "誕生日", code: null, grant_valid_days: 14 });
  });
});

describe("先着の「クーポンを獲得する」ページ（0020）", () => {
  it("ログイン中の会員が 1 人 1 枚。先着の枚数に達したら終わり。ログインしていなければ案内だけ", async () => {
    const { sb, shop, campaign, mail, app } = setup();
    Object.assign(campaign, { claimable: true, usage_limit: 1 });
    const anon = new Browser(app);
    const page = await (await anon.get(`/my-shop/coupons/${"0".repeat(8)}-0000-0000-0000-000000000000`)).text();
    expect(page).toContain("見つかりません");
    campaign.id = "11111111-1111-1111-1111-111111111111";
    const url = `/my-shop/coupons/${campaign.id}`;
    expect(await (await anon.get(url)).text()).toContain("ログインしてから");
    const b = new Browser(app);
    await memberLogin(b, mail, "/my-shop", "m@example.com");
    expect(await (await b.get(url)).text()).toContain("クーポンを獲得する");
    expect((await b.post(`${url}/claim`, {})).headers.get("location")).toBe("/my-shop/account?flash=coupon_claimed");
    expect(await (await b.get("/my-shop/account?flash=coupon_claimed")).text()).toContain("クーポンを獲得しました");
    expect((await b.post(`${url}/claim`, {})).headers.get("location")).toBe(`${url}?error=already`);
    const b2 = new Browser(app);
    await memberLogin(b2, mail, "/my-shop", "n@example.com");
    expect((await b2.post(`${url}/claim`, {})).headers.get("location")).toBe(`${url}?error=exhausted`);
    expect(sb.tables.coupon_grants).toHaveLength(1);
    void shop;
  });
});
