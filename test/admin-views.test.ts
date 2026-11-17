import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 一覧のビュー（メンテナの決定 2026-11-08、src/routes/admin/views.tsx）と、お問い合わせの一覧の検索の形。
 * 書き込みの権限と形の決まりの本物は test/db/admin-views.test.ts（0135）
 */
const hosts: string[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) externalHosts.delete(h);
});

function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  // お問い合わせの担当者の一覧（0068）は偽の Supabase に無い。中身は test/inquiries.test.ts と test/db/ で確かめている
  const assignees = `${sb.url}/rest/v1/rpc/inquiry_assignees`;
  externalHosts.set(assignees, () => new Response("[]", { headers: { "content-type": "application/json" } }));
  hosts.push(assignees);
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { modules: { inquiries: true } } });
  const order = (n: number, f: Record<string, unknown>) =>
    sb.tables.orders.push({ id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: `c${n}@example.com`, customer_name: `客${n}`, shipping_address: {}, tags: [], created_at: `2026-11-0${n - 1000}T03:00:00Z`, ...f });
  order(1001, { tags: ["ギフト"] });
  order(1002, { status: "shipped" });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  const app = appWith(sb);
  return { sb, shop, app, member };
}

describe("一覧のビュー", () => {
  it("今の条件を名前を付けて保存し、タブから開く。開いているビューには印が付き、消せる。注文の項目だけの人も保存できる", async () => {
    const { sb, shop, member } = setup();
    const b = await member("ship@example.com", ["orders"]);
    const base = `/admin/shops/${shop.id}/orders`;
    const html = await (await b.get(`${base}?status=paid&tag=${encodeURIComponent("ギフト")}`)).text();
    expect(html).toContain(`<a href="${base}">すべて</a>`);
    expect(html).toContain("＋ この条件をビューに保存");
    const save = await b.post(`/admin/shops/${shop.id}/views/orders`, { name: "ギフトの発送待ち", query: JSON.stringify({ status: "paid", tag: "ギフト" }) });
    expect(save.headers.get("location")).toBe(`${base}?status=paid&tag=%E3%82%AE%E3%83%95%E3%83%88`);
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["views_orders"]).toEqual([{ name: "ギフトの発送待ち", query: { status: "paid", tag: "ギフト" } }]);
    const opened = await (await b.get(save.headers.get("location")!)).text();
    expect(opened).toContain(`<a href="${base}?status=paid&amp;tag=%E3%82%AE%E3%83%95%E3%83%88" aria-current="page">ギフトの発送待ち</a>`);
    // 保存済みの条件には保存の欄を出さず、消すボタンを出す
    expect(opened).not.toContain("＋ この条件をビューに保存");
    expect(opened).toContain("このビューを消す");
    // 条件なしは「すべて」に印
    expect(await (await b.get(base)).text()).toContain(`<a href="${base}" aria-current="page">すべて</a>`);
    expect(opened).toContain('<input type="hidden" name="name" value="ギフトの発送待ち"/>');
    expect((await b.post(`/admin/shops/${shop.id}/views/orders/delete`, { name: "ギフトの発送待ち" })).headers.get("location")).toBe(base);
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["views_orders"]).toEqual([]);
  });

  it("ほかの画面のビューは、その画面の項目が無ければ保存できない。名前が無い・長すぎれば保存しない", async () => {
    const { shop, member } = setup();
    const b = await member("ship@example.com", ["orders"]);
    expect((await b.post(`/admin/shops/${shop.id}/views/customers`, { name: "x", query: "{}" })).status).toBe(404);
    expect((await b.post(`/admin/shops/${shop.id}/views/shops`, { name: "x", query: "{}" })).status).toBe(404);
    expect((await b.post(`/admin/shops/${shop.id}/views/orders`, { name: "あ".repeat(41), query: JSON.stringify({ status: "paid" }) })).headers.get("location")).toBe(`/admin/shops/${shop.id}/orders?status=paid&view_error=invalid`);
    expect(await (await b.get(`/admin/shops/${shop.id}/orders?status=paid&view_error=invalid`)).text()).toContain("ビューを保存できませんでした");
  });

  it("0135 を当てる前の DB: ビューのタブと保存の欄を出さない", async () => {
    const { shop, app } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0135_admin_views") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/orders?status=paid`)).text();
    expect(html).not.toContain('class="viewtabs"');
    expect(html).not.toContain("ビューに保存");
  });
});

describe("お問い合わせの一覧の検索", () => {
  it("#番号・名乗った注文番号・連絡先の部分一致で探し、条件はチップ。ビューも同じ形", async () => {
    const { sb, shop, app } = setup();
    const inq = (n: number, f: Record<string, unknown>) =>
      sb.tables.inquiries.push({ id: `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "waiting_shop", category: "other", contact_email: `u${n}@example.com`, contact_name: `問${n}`, email_verified_at: "2026-11-01T00:00:00Z", order_id: null, claimed_order_number: null, last_message_at: `2026-11-0${n}T00:00:00Z`, created_at: `2026-11-0${n}T00:00:00Z`, ...f });
    inq(1, { contact_name: "山田" });
    inq(2, { claimed_order_number: 1002 });
    inq(3, { status: "closed" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/inquiries`;
    const nums = (html: string) => [...html.matchAll(/>#(\d+)<\/a>/g)].map((m) => Number(m[1]));
    expect(nums(await (await b.get(`${base}?q=${encodeURIComponent("#1")}`)).text())).toEqual([1]);
    expect(nums(await (await b.get(`${base}?q=1002`)).text())).toEqual([2]);
    expect(nums(await (await b.get(`${base}?q=${encodeURIComponent("山田")}`)).text())).toEqual([1]);
    const closed = await (await b.get(`${base}?status=closed`)).text();
    expect(nums(closed)).toEqual([3]);
    expect(closed).toContain(`<a class="chip" href="${base}" title="この条件を外す">`);
    expect(closed).toContain("＋ この条件をビューに保存");
  });
});
