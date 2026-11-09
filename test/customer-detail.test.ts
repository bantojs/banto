import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 会員の一覧と詳細（メンテナの決定 2026-11-08「会員の行に購入の集計の列」「会員の詳細の画面」、2026-11-09「会員の社内メモ」）。
 * 集計とメモの DB の正しさは test/db/customer-stats-note.test.ts（0133）
 */
function setup(opts: { migrations?: string[]; inquiries?: boolean } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { members_enabled: true, ...(opts.inquiries ? { modules: { inquiries: true } } : {}) } });
  const cid = "00000000-0000-4000-a000-000000000001";
  sb.tables.customers.push({ id: cid, shop_id: shop.id, email: "hanako@example.com", name: "佐藤 花子", default_address: { state: "東京都" }, attributes: {}, marketing_consent: true, orders_count: 3, total_spent_jpy: 18400, last_order_at: "2026-11-05T03:00:00Z", note: "ギフト包装をよく頼む", created_at: "2026-10-01T00:00:00Z", last_login_at: "2026-11-05T02:00:00Z" });
  sb.tables.customers.push({ id: "00000000-0000-4000-a000-000000000002", shop_id: shop.id, email: "taro@example.com", name: "山田 太郎", default_address: null, attributes: {}, marketing_consent: null, orders_count: 0, total_spent_jpy: 0, last_order_at: null, created_at: "2026-10-02T00:00:00Z" });
  sb.tables.orders.push({ id: "00000000-0000-4000-b000-000000000001", shop_id: shop.id, number: 1001, status: "shipped", total_jpy: 6800, shipping_jpy: 0, customer_id: cid, customer_email: "hanako@example.com", customer_name: "佐藤 花子", shipping_address: {}, tags: [], created_at: "2026-11-05T03:00:00Z" });
  sb.tables.orders.push({ id: "00000000-0000-4000-b000-000000000002", shop_id: shop.id, number: 1002, status: "paid", total_jpy: 500, shipping_jpy: 0, customer_id: null, customer_email: "guest@example.com", customer_name: "ゲスト", shipping_address: {}, tags: [], created_at: "2026-11-06T03:00:00Z" });
  return { sb, shop, cid, app: appWith(sb) };
}

describe("会員の一覧", () => {
  it("購入回数・累計の購入額・最後に買った日の列を出し、名前から詳細の画面へ。検索は注文・商品と同じ形", async () => {
    const { shop, cid, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).toContain(`<a href="/admin/shops/${shop.id}/customers/${cid}">佐藤 花子</a>`);
    expect(html).toContain('<td class="num">3</td><td class="num">¥18,400</td>');
    expect(html).toContain('<form method="get" action="/admin/shops/' + shop.id + '/customers" class="search">');
    // 一覧の行に操作のフォームはもう無い（詳細の画面へ）
    expect(html).not.toContain("/email");
    const filtered = await (await b.get(`/admin/shops/${shop.id}/customers?consent=yes`)).text();
    expect(filtered).toContain("佐藤 花子");
    expect(filtered).not.toContain("山田 太郎");
    expect(filtered).toContain(`<a class="chip" href="/admin/shops/${shop.id}/customers" title="この条件を外す">案内メール: 受け取る`);
  });

  it("0133 を当てる前の DB: 集計の列とメモを出さない（列を選ばない）", async () => {
    const { shop, cid, app } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0133_customer_stats_note") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).not.toContain("購入回数");
    const detail = await (await b.get(`/admin/shops/${shop.id}/customers/${cid}`)).text();
    expect(detail).not.toContain("社内メモ");
    expect(detail).not.toContain("ギフト包装");
  });
});

describe("会員の詳細", () => {
  it("集計・この会員の注文だけ・社内メモ・案内メールの同意・アカウントの操作を 1 画面に", async () => {
    const { shop, cid, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/customers/${cid}`)).text();
    expect(html).toContain("<h1>佐藤 花子</h1>");
    expect(html).toContain("<dd>¥18,400</dd>");
    expect(html).toContain(">#1001</a>");
    expect(html).not.toContain(">#1002</a>");
    expect(html).toContain("ギフト包装をよく頼む</textarea>");
    expect(html).toContain(`action="/admin/shops/${shop.id}/customers/${cid}/consent/withdraw"`);
    expect(html).toContain(`action="/admin/shops/${shop.id}/customers/${cid}/email"`);
    expect(html).toContain(`action="/admin/shops/${shop.id}/customers/${cid}/delete"`);
    expect((await b.get(`/admin/shops/${shop.id}/customers/00000000-0000-4000-a000-0000000000ff`)).status).toBe(404);
    expect((await b.get(`/admin/shops/${shop.id}/customers/not-a-uuid`)).status).toBe(404);
  });

  it("社内メモを保存する（2,000 字まで、空で消す）", async () => {
    const { sb, shop, cid, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/${cid}`;
    expect((await b.post(`${base}/note`, { note: "サイズ交換あり" })).headers.get("location")).toBe(`${base}?flash=note_saved`);
    expect(sb.tables.customers.find((x) => x["id"] === cid)!["note"]).toBe("サイズ交換あり");
    expect((await b.post(`${base}/note`, { note: "あ".repeat(2001) })).headers.get("location")).toBe(`${base}?error=note_too_long`);
    expect(await (await b.get(`${base}?error=note_too_long`)).text()).toContain("社内メモは 2,000 字までです。");
    await b.post(`${base}/note`, { note: "  " });
    expect(sb.tables.customers.find((x) => x["id"] === cid)!["note"]).toBeNull();
  });

  it("注文・お問い合わせは、その項目のある人にだけ出す", async () => {
    const { sb, shop, cid, app } = setup({ inquiries: true });
    const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
    const u = sb.addUser("cs@example.com", "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms: ["customers"] });
    const b = await Browser.loggedIn(app, "cs@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/customers/${cid}`)).text();
    expect(html).not.toContain(">#1001</a>");
    expect(html).not.toContain("この会員のお問い合わせ");
    expect(html).toContain("社内メモ");
  });
});
