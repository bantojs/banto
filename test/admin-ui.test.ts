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

  it("商品の一覧: 名前・スラッグの部分一致と公開の状態で絞り、件数を出す", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products`;
    let html = await (await admin.get(`${base}?q=MUG`)).text();
    expect(html).toContain("マグカップ");
    expect(html).not.toContain("Tシャツ</a>");
    expect(html).toContain("1 件 / 全 2 件");
    html = await (await admin.get(`${base}?state=published`)).text();
    expect(html).toContain("Tシャツ</a>");
    expect(html).not.toContain("マグカップ</a>");
    expect(html).toContain('<span class="status on">公開中</span>');
    expect(await (await admin.get(`${base}?q=nothing`)).text()).toContain("条件に合う商品がありません。");
  });

  it("会員の一覧: メール・氏名の部分一致で絞り、件数を出す", async () => {
    const { sb, shop, app } = setup();
    sb.tables.customers.push({ id: "cu1", shop_id: shop.id, email: "yamada@example.com", name: "山田", default_address: null, created_at: "2026-10-01T00:00:00Z" });
    sb.tables.customers.push({ id: "cu2", shop_id: shop.id, email: "sato@example.com", name: "佐藤", default_address: null, created_at: "2026-10-02T00:00:00Z" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/customers?q=YAMA`)).text();
    expect(html).toContain("yamada@example.com");
    expect(html).not.toContain("sato@example.com");
    expect(html).toContain("1 件 / 全 2 件");
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
