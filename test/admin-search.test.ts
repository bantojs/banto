import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 管理画面の一覧の検索（メンテナの決定 2026-11-08「検索は同じ形」、src/routes/admin/search.tsx）:
 * キーワード 1 つ ＋ 条件 ＋ 並び ＋ 条件のチップ。絞り込みは DB（admin_search_ids、0132。本物の判定は test/db/admin-search.test.ts）
 */
function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const order = (n: number, f: Record<string, unknown>) =>
    sb.tables.orders.push({ id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: `c${n}@example.com`, customer_name: `客${n}`, shipping_address: {}, payment_provider: "stripe", payment_ref: `pi_${n}`, tags: [], tracking_number: null, created_at: `2026-11-0${n - 1000}T03:00:00Z`, ...f });
  order(1001, { shipping_address: { phone: "090-1234-5678" }, tags: ["ギフト"] });
  order(1002, { payment_provider: "komoju", total_jpy: 8000, tracking_number: "123456789012", status: "shipped" });
  order(1003, { total_jpy: 12000, tags: ["ギフト"] });
  return { sb, shop, app: appWith(sb) };
}
const numbers = (html: string) => [...html.matchAll(/>#(\d+)<\/a>/g)].map((m) => Number(m[1]));

describe("注文の一覧の検索", () => {
  it("キーワードで #番号・電話・送り状番号を読み取る", async () => {
    const { shop, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/orders`;
    expect(numbers(await (await b.get(`${base}?q=${encodeURIComponent("#1002")}`)).text())).toEqual([1002]);
    expect(numbers(await (await b.get(`${base}?q=09012345678`)).text())).toEqual([1001]);
    expect(numbers(await (await b.get(`${base}?q=${encodeURIComponent("+81 90 1234 5678")}`)).text())).toEqual([1001]);
    expect(numbers(await (await b.get(`${base}?q=1234-5678-9012`)).text())).toEqual([1002]);
  });

  it("条件は URL の GET で、チップはその条件だけを外した URL。CSV も同じ条件。形の違う値は捨てる", async () => {
    const { shop, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/orders`;
    const html = await (await b.get(`${base}?tag=${encodeURIComponent("ギフト")}&min=5000&from=nope`)).text();
    expect(numbers(html)).toEqual([1003]);
    // チップ: 印を外すと金額だけ、金額を外すと印だけ。形の違う from はチップにも URL にも残さない
    expect(html).toContain(`<a class="chip" href="${base}?min=5000" title="この条件を外す">印（タグ）: ギフト`);
    expect(html).toContain(`<a class="chip" href="${base}?tag=%E3%82%AE%E3%83%95%E3%83%88" title="この条件を外す">¥5,000 以上`);
    expect(html).not.toContain("from=nope");
    expect(html).toContain(`<a href="${base}">条件をすべて外す</a>`);
    // 条件の欄は開いて出す
    expect(html).toContain('<details class="search-more" open="">');
    expect(html).toContain(`href="/admin/shops/${shop.id}/orders.csv?tag=%E3%82%AE%E3%83%95%E3%83%88&amp;min=5000">この条件で CSV</a>`);
    const csv = await (await b.get(`/admin/shops/${shop.id}/orders.csv?tag=${encodeURIComponent("ギフト")}&min=5000`)).text();
    expect(csv.trim().split("\r\n").map((l) => l.split(",")[0])).toEqual(["注文番号", "1003"]);
    expect(numbers(await (await b.get(`${base}?payment=komoju`)).text())).toEqual([1002]);
    expect(numbers(await (await b.get(`${base}?from=2026-11-02&to=2026-11-02`)).text())).toEqual([1002]);
  });

  it("古い順に並べ、次のページも古い順で続く", async () => {
    const { sb, shop, app } = setup();
    for (let i = 0; i < 55; i++) sb.tables.orders.push({ id: `00000000-0000-4000-c000-${String(i).padStart(12, "0")}`, shop_id: shop.id, number: 2000 + i, status: "paid", total_jpy: 100, shipping_jpy: 0, customer_email: "x@example.com", customer_name: "x", shipping_address: {}, tags: [], created_at: new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString() });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const first = await (await b.get(`/admin/shops/${shop.id}/orders?sort=old`)).text();
    expect(numbers(first).slice(0, 4)).toEqual([1001, 1002, 1003, 2000]);
    expect(first).toContain('<option value="old" selected="">古い順</option>');
    const next = /<a href="([^"]+)" rel="next">/.exec(first)![1]!.replace(/&amp;/g, "&");
    expect(next).toContain("sort=old");
    expect(numbers(await (await b.get(next)).text())).toEqual([2047, 2048, 2049, 2050, 2051, 2052, 2053, 2054]);
  });

  it("0132 を当てる前の DB: 並び・支払い方法・日付・金額の欄を出さず、URL で送られても使わない", async () => {
    const { shop, app } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0132_admin_search") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/orders?payment=komoju&sort=old`)).text();
    expect(html).not.toContain('name="sort"');
    expect(html).not.toContain('name="payment"');
    expect(numbers(html)).toEqual([1003, 1002, 1001]);
    expect(html).toContain('placeholder="注文番号・メール・氏名"');
  });
});

describe("商品の一覧の検索", () => {
  it("品番・JAN の完全一致、カテゴリー（主か追加）、在庫の有無", async () => {
    const { sb, shop, app } = setup();
    const cat = { id: "11111111-1111-4111-8111-111111111111", shop_id: shop.id, slug: "shirts", name: "シャツ", parent_id: null, sort_order: 0 };
    sb.tables.categories.push(cat);
    const linen = sb.addProduct(shop.id, { slug: "linen", name: "リネンシャツ", category_id: cat.id, created_at: "2026-11-01T00:00:00Z" });
    const wool = sb.addProduct(shop.id, { slug: "wool", name: "ウールのマフラー", extra_category_ids: [cat.id], created_at: "2026-11-02T00:00:00Z" });
    sb.addProduct(shop.id, { slug: "mug", name: "マグカップ", created_at: "2026-11-03T00:00:00Z" });
    sb.addSku(shop.id, linen.id, { code: "LS-NV-M", gtin: "4901234567894", available: 0 });
    sb.addSku(shop.id, wool.id, { code: "WM-GR", available: 3 });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products`;
    const names = (html: string) => [...html.matchAll(/<code>([a-z-]+)<\/code>/g)].map((m) => m[1]);
    expect(names(await (await b.get(`${base}?q=LS-NV-M`)).text())).toEqual(["linen"]);
    expect(names(await (await b.get(`${base}?q=4901234567894`)).text())).toEqual(["linen"]);
    const byCat = await (await b.get(`${base}?category=${cat.id}`)).text();
    expect(names(byCat)).toEqual(["wool", "linen"]);
    expect(byCat).toContain(`<a class="chip" href="${base}" title="この条件を外す">カテゴリー: シャツ`);
    expect(names(await (await b.get(`${base}?stock=out`)).text())).toEqual(["mug", "linen"]);
    expect(names(await (await b.get(`${base}?stock=in&sort=old`)).text())).toEqual(["wool"]);
    expect(names(await (await b.get(`${base}?sort=old`)).text())).toEqual(["linen", "wool", "mug"]);
  });
});
