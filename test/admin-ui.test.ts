import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, fieldForm } from "./helpers";

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
  it("管理画面と既定のテーマのお店の画面は <!doctype html> で始まる（無いとブラウザが互換モードで描く）", async () => {
    const { app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get("/admin")).text()).toMatch(/^<!doctype html><html lang="ja">/);
    expect(await (await new Browser(app).get("/my-shop")).text()).toMatch(/^<!doctype html><html lang="ja">/);
  });

  it("パンくずは上の帯に出し、ショップの中の画面には左の目次を出して今いる項目に印を付ける", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/products`)).text();
    expect(html).toContain(`<nav class="crumbs" aria-label="breadcrumb">`);
    expect(html).toContain(`<a href="/admin/shops/${shop.id}">マイショップ</a>`);
    expect(html).toContain(`<span class="here">商品</span>`);
    expect(html).toContain(`<nav class="sidenav" aria-label="マイショップ">`);
    expect(html).toMatch(new RegExp(`<a href="/admin/shops/${shop.id}/products" aria-current="page">商品</a>`));
    // 目次は仕事ごとのまとまり。連携の 3 つ（Webhook・プラグイン・AI 連携）は 1 つの項目
    for (const g of ["毎日の運営", "集客", "お店づくり", "広げる", "ショップ"]) expect(html).toContain(`<div class="navlabel">${g}</div>`);
    expect(html).toContain(`<a href="/admin/shops/${shop.id}/hooks">外部サービスと連携</a>`);
    // 本文の上の「ダッシュボード › …」の行はもう無い
    expect(html).not.toContain("›");
    // ダッシュボードには目次を出さない
    expect(await (await admin.get("/admin")).text()).not.toContain('class="sidenav"');
  });

  it("目次の 1 項目に画面が 2 つ以上あれば、画面の中のタブでつなぐ（カテゴリーは商品の中）", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/categories`)).text();
    expect(html).toContain(`<nav class="subtabs" aria-label="商品">`);
    expect(html).toContain(`<a href="/admin/shops/${shop.id}/categories" aria-current="page">カテゴリー</a>`);
    // 左の目次では「商品」に印
    expect(html).toMatch(new RegExp(`<a href="/admin/shops/${shop.id}/products" aria-current="page">商品</a>`));
    // 連携の画面: Webhook・プラグイン・AI 連携をタブで行き来する
    const hooks = await (await admin.get(`/admin/shops/${shop.id}/tokens`)).text();
    expect(hooks).toContain(`<a href="/admin/shops/${shop.id}/tokens" aria-current="page">AI 連携</a>`);
    expect(hooks).toContain(`<a href="/admin/shops/${shop.id}/plugins">プラグイン</a>`);
  });

  it("ページのひな形の画面では、タブの「ひな形」に印を付ける（ページの一覧ではない）", async () => {
    const { sb, shop, app } = setup();
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { modules: { pages: true } };
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/modules/pages/layouts`)).text();
    const tabs = html.slice(html.indexOf('<nav class="subtabs"'), html.indexOf("</nav>", html.indexOf('<nav class="subtabs"')));
    expect(tabs).toMatch(/<a href="[^"]+\/modules\/pages\/layouts" aria-current="page">/);
    expect(tabs).not.toMatch(/<a href="[^"]+\/modules\/pages" aria-current="page">/);
  });

  it("目次は権限の項目と同梱モジュールの ON / OFF で出し分ける", async () => {
    const { sb, shop, app } = setup();
    // OFF のモジュール（クーポン）は出さない。ON にすると「集客」に出る（集客には LINE 公式アカウントもある）
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`/admin/shops/${shop.id}/products`)).text()).not.toContain(`/modules/coupons"`);
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { modules: { coupons: true } };
    const on = await (await owner.get(`/admin/shops/${shop.id}/products`)).text();
    expect(on).toContain(`<a href="/admin/shops/${shop.id}/modules/coupons">クーポン</a>`);
    // 注文の項目だけの人: 注文とショップ設定だけ
    const u = sb.addUser("ship@example.com", "password-123");
    const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms: ["orders"] });
    const ship = await Browser.loggedIn(app, "ship@example.com", "password-123");
    const html = await (await ship.get(`/admin/shops/${shop.id}/orders`)).text();
    const nav = html.slice(html.indexOf('<nav class="sidenav"'), html.indexOf("</nav>", html.indexOf('<nav class="sidenav"')));
    expect([...nav.matchAll(/<a href="[^"]+"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(["ホーム", "注文", "ショップ設定"]);
  });

  it("ショップ設定は画面ごとに分け、1 画面に保存は 1 つ（基本と法定表記 / 配送と税 / 決済 / 会員とログイン / 上級者向け）", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}`;
    const main = (html: string) => html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    const general = await (await admin.get(base)).text();
    expect(general).toContain(`<nav class="subtabs" aria-label="ショップ設定">`);
    for (const [path, label] of [["", "基本と法定表記"], ["/settings/shipping", "配送と税"], ["/settings/payments", "決済"], ["/settings/members", "会員とログイン"], ["/settings/advanced", "上級者向け"]]) {
      expect(general).toContain(`<a href="${base}${path}"`);
      const html = await (await admin.get(`${base}${path}`)).text();
      expect(html).toContain(`<h1>${label}</h1>`);
      expect(main(html).match(/<button type="submit"/g)?.length ?? 0, label).toBeLessThanOrEqual(1);
    }
    // 上級者向けは一覧から 1 つずつの画面へ
    const adv = await (await admin.get(`${base}/settings/advanced`)).text();
    for (const s of ["domain", "storefront", "headless", "legal-links", "terms", "images", "backup"]) {
      expect(adv).toContain(`href="${base}/settings/${s}"`);
      const html = await (await admin.get(`${base}/settings/${s}`)).text();
      // 目次とタブは「上級者向け」に印
      expect(html, s).toContain(`<a href="${base}/settings/advanced" aria-current="page">上級者向け</a>`);
    }
    expect((await admin.get(`${base}/settings/nothing`)).status).toBe(404);
    // 見た目はデザイン、独自項目は商品・会員の中
    expect(general).not.toContain('name="accent_color"');
    expect(await (await admin.get(`${base}/design`)).text()).toContain('name="accent_color"');
    const fields = await (await admin.get(`${base}/fields`)).text();
    expect(fields).toContain(`<a href="${base}/fields" aria-current="page">カスタム項目（商品）</a>`);
    expect(fields).toMatch(new RegExp(`<a href="${base}/products" aria-current="page">商品</a>`));
  });

  it("設定の画面は保存する鍵の項目で出し分ける（会員とログインは owner / admin、ログインの方法だけなら integrations）", async () => {
    const { sb, shop, app } = setup();
    const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
    const member = async (email: string, perms: string[]) => {
      const u = sb.addUser(email, "password-123");
      sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
      sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
      return Browser.loggedIn(app, email, "password-123");
    };
    const base = `/admin/shops/${shop.id}`;
    const settings = await member("settings@example.com", ["settings"]);
    expect((await settings.get(`${base}/settings/shipping`)).status).toBe(200);
    expect((await settings.get(`${base}/settings/members`)).status).toBe(404);
    expect((await settings.get(`${base}/settings/images`)).status).toBe(404);
    const adv = await (await settings.get(`${base}/settings/advanced`)).text();
    expect(adv).toContain(`href="${base}/settings/domain"`);
    expect(adv).not.toContain(`href="${base}/settings/backup"`);
    expect(adv).not.toContain(`href="${base}/settings/headless"`);
    // 配送と税の保存は会員機能の鍵に触らない（owner / admin の鍵、0129）
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { members_enabled: true };
    await settings.post(`${base}/shipping`, { mode: "flat", flat_fee_jpy: "500", tax_rate: "10" });
    expect(sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"]).toMatchObject({ members_enabled: true, shipping: { flat_fee_jpy: 500 } });
    // integrations だけの人: ログインの方法は見えるが、会員機能の欄は出さない
    const integ = await member("integ@example.com", ["integrations"]);
    const m = await (await integ.get(`${base}/settings/members`)).text();
    expect(m).toContain("ログインの方法");
    expect(m).not.toContain('name="members_enabled"');
    expect((await integ.post(`${base}/members`, { members_enabled: "on" })).status).toBe(404);
    // ヘッドレス・法務のページは shops の行の更新なので settings も要る（RLS の shops_member_update、0024）。開けない
    expect((await integ.get(`${base}/settings/headless`)).status).toBe(404);
    expect((await integ.get(`${base}/settings/legal-links`)).status).toBe(404);
    // 直接送っても、RLS で 0 行になったら「保存しました」と言わない
    const res = await integ.post(`${base}/headless`, { return_origins: "https://wp.example.com" });
    expect(res.headers.get("location")).toBe(`${base}/settings/headless?flash=not_saved`);
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["headless"]).toBeUndefined();
    expect(await (await settings.get(`${base}?flash=not_saved`)).text()).toContain("保存できませんでした");
    // 独自項目の定義も同じ: catalog だけの人には画面とタブを出さず、送っても保存しない
    const catalog = await member("catalog@example.com", ["catalog"]);
    expect((await catalog.get(`${base}/fields`)).status).toBe(404);
    expect(await (await catalog.get(`${base}/products`)).text()).not.toContain(`href="${base}/fields"`);
    expect((await catalog.post(`${base}/fields`, fieldForm([{ key: "material", label: "素材" }]))).headers.get("location")).toBe(`${base}/fields?flash=not_saved`);
    const both = await member("both@example.com", ["catalog", "settings"]);
    expect(await (await both.get(`${base}/products`)).text()).toContain(`href="${base}/fields"`);
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
