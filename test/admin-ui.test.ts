import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";

/** 管理画面の共通の見た目（パンくず・ショップのタブ・一覧の絞り込み）。docs は src/routes/admin/layout.tsx */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addProduct(shop.id, { slug: "mug", name: "マグカップ", published: false });
  return { sb, shop, app: appWith(sb) };
}

describe("管理画面の共通の見た目", () => {
  it("パンくずは上の帯に出し、ショップの中の画面には今いるタブに印を付ける", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/products`)).text();
    expect(html).toContain(`<nav class="crumbs" aria-label="breadcrumb">`);
    expect(html).toContain(`<a href="/admin/shops/${shop.id}">マイショップ</a>`);
    expect(html).toContain(`<span class="here">商品</span>`);
    expect(html).toMatch(new RegExp(`<a href="/admin/shops/${shop.id}/products" aria-current="page">商品</a>`));
    expect(html).toContain(`<a href="/admin/shops/${shop.id}/tokens">AI 連携</a>`);
    // 本文の上の「ダッシュボード › …」の行はもう無い
    expect(html).not.toContain("›");
    // ダッシュボードにはタブを出さない
    expect(await (await admin.get("/admin")).text()).not.toContain('class="tabs"');
  });

  it("商品の一覧: 名前・スラッグの部分一致と公開の状態で DB で絞る", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products`;
    let html = await (await admin.get(`${base}?q=MUG`)).text();
    expect(html).toContain("マグカップ");
    expect(html).not.toContain("Tシャツ</a>");
    expect(html).not.toContain('rel="next"');
    html = await (await admin.get(`${base}?state=published`)).text();
    expect(html).toContain("Tシャツ</a>");
    expect(html).not.toContain("マグカップ</a>");
    expect(html).toContain('<span class="status on">公開中</span>');
    expect(await (await admin.get(`${base}?q=nothing`)).text()).toContain("条件に合う商品がありません。");
  });

  it("商品の一覧: 50 件ずつ新しい順。次のページは検索条件を残す", async () => {
    const { sb, shop, app } = setup();
    for (let i = 0; i < 70; i++) sb.addProduct(shop.id, { slug: `bulk-${i}`, name: `まとめ${i}`, published: true });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products`;
    const first = await (await admin.get(`${base}?q=${encodeURIComponent("まとめ")}`)).text();
    expect(first.match(/<code>bulk-/g)).toHaveLength(50);
    expect(first).toContain("まとめ69</a>");
    const next = /<a href="([^"]+)" rel="next">/.exec(first)![1]!.replace(/&amp;/g, "&");
    expect(next).toContain("q=");
    const second = await (await admin.get(next)).text();
    expect(second.match(/<code>bulk-/g)).toHaveLength(20);
    expect(second).toContain("まとめ0</a>");
    expect(second).not.toContain('rel="next"');
    expect((await admin.get(`${base}?after=broken`)).status).toBe(400);
  });

  it("注文の一覧: 50 件ずつ。古い注文も番号・メールで DB から探せる。CSV は検索の条件の分だけ明細つき", async () => {
    const { sb, shop, app } = setup();
    const uuid = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
    for (let i = 0; i < 1200; i++) {
      sb.tables.orders.push({ id: uuid(i), shop_id: shop.id, number: 1001 + i, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: `buyer${i}@example.com`, customer_name: `購入者${i}`, shipping_address: {}, payment_provider: "stripe", payment_ref: `pi_${i}`, shipped_at: null, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
      sb.tables.order_items.push({ id: `oi-${i}`, order_id: uuid(i), shop_id: shop.id, sku_id: null, item_name: `品${i}`, item_variant: null, unit_price_jpy: 1000, qty: 1 });
    }
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/orders`;
    const first = await (await admin.get(base)).text();
    expect(first.match(/>#\d+<\/a>/g)).toHaveLength(50);
    expect(first).toContain(">#2200</a>");
    const next = /<a href="([^"]+)" rel="next">/.exec(first)![1]!.replace(/&amp;/g, "&");
    expect(await (await admin.get(next)).text()).toContain(">#2150</a>");
    // いちばん古い注文（全件を読まない作りでも見つかる）
    const byNumber = await (await admin.get(`${base}?q=1001`)).text();
    // 番号の完全一致と、メールに 1001 を含む注文（buyer1001@ = #2002）
    expect(byNumber.match(/>#\d+<\/a>/g)).toEqual([">#2002</a>", ">#1001</a>"]);
    expect(await (await admin.get(`${base}?q=BUYER3@`)).text()).toContain(">#1004</a>");
    const csv = await (await admin.get(`${base}.csv?q=${encodeURIComponent("buyer0@")}`)).text();
    expect(csv.trim().split("\r\n")).toHaveLength(2);
    expect(csv).toContain("品0 x1");
  });

  it("会員の一覧: メール・氏名の部分一致で DB で絞る", async () => {
    const { sb, shop, app } = setup();
    sb.tables.customers.push({ id: "cu1", shop_id: shop.id, email: "yamada@example.com", name: "山田", default_address: null, created_at: "2026-10-01T00:00:00Z" });
    sb.tables.customers.push({ id: "cu2", shop_id: shop.id, email: "sato@example.com", name: "佐藤", default_address: null, created_at: "2026-10-02T00:00:00Z" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/customers?q=YAMA`)).text();
    expect(html).toContain("yamada@example.com");
    expect(html).not.toContain("sato@example.com");
  });

  it("注文の詳細: 明細と合計は本体、購入者・配送先・決済は右の列。キャンセルは赤いボタン", async () => {
    const { sb, shop, app } = setup();
    sb.tables.orders.push({ id: "order-1", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 3960, shipping_jpy: 660, customer_email: "a@example.com", customer_name: "A", shipping_address: { state: "東京都" }, payment_provider: "stripe", payment_ref: "pi_1", shipped_at: null, created_at: "2026-10-20T00:00:00Z" });
    sb.tables.order_items.push({ id: "oi1", order_id: "order-1", shop_id: shop.id, sku_id: null, item_name: "Tシャツ", item_variant: null, unit_price_jpy: 3300, qty: 1 });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/orders/order-1`)).text();
    expect(html).toContain('<div class="split">');
    expect(html).toContain('<span class="status info">支払い済み</span>');
    expect(html).toMatch(/<dt class="total">[^<]+<\/dt><dd class="total">¥3,960<\/dd>/);
    expect(html).toContain('<button type="submit" class="danger">');
  });
});
