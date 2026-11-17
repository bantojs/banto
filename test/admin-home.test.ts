import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * ショップのホーム（src/routes/admin/home.tsx、0139）・注文の詳細・権限の無いページ（src/routes/admin/denied.tsx）。
 * 「見えないものは出さない、押せないものは理由を出す」（メンテナの決定 2026-11-08）。数え方の本物は test/db/shop-home.test.ts
 */
function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE-M", available: 0 });
  const now = new Date().toISOString();
  const order = (n: number, f: Record<string, unknown>) =>
    sb.tables.orders.push({ id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: `c${n}@example.com`, customer_name: `客${n}`, shipping_address: {}, tags: [], created_at: now, ...f });
  order(1001, { customer_id: "00000000-0000-4000-c000-000000000001" });
  order(1002, { status: "shipped", shipped_at: now, total_jpy: 2000 });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const app = appWith(sb);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: now });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  return { sb, shop, app, member, base: `/admin/shops/${shop.id}` };
}

describe("ショップのホーム", () => {
  it("今やることは 1 件以上のものだけを、その条件の一覧へのリンクで。owner には 30 日の売上と開店の準備も", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`${base}/home`)).text();
    expect(html).toContain(`<a href="${base}/orders?status=paid"><strong>1</strong> 件の注文が発送を待っています</a>`);
    expect(html).toContain(`<a href="${base}/inventory?stock=out"><strong>1</strong> 件の SKU が在庫切れです（公開中の商品）</a>`);
    expect(html).not.toContain("件の商品が非公開のまま");
    expect(html).toContain("¥3,000");
    expect(html).toContain("開店の準備");
    expect(html).toContain(`<a href="${base}/home" aria-current="page">ホーム</a>`);
    // 組織のダッシュボードのショップ名はホームへ
    expect(await (await b.get("/admin")).text()).toContain(`<a href="${base}/home">マイショップ</a>`);
  });

  it("出荷の担当には注文の分だけ（売上・在庫・開店の準備は出さない）", async () => {
    const { member, base } = setup();
    const ship = await member("ship@example.com", ["orders"]);
    const html = await (await ship.get(`${base}/home`)).text();
    expect(html).toContain("件の注文が発送を待っています");
    expect(html).not.toContain("¥3,000");
    expect(html).not.toContain("在庫切れ");
    expect(html).not.toContain("開店の準備");
  });

  it("0139 の前はアップデートを案内する", async () => {
    const { app, base } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0139_shop_home") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(`${base}/home`)).text()).toContain("「今やること」は、データベースのアップデートを適用すると出ます");
  });
});

describe("注文の詳細・権限の無いページ", () => {
  it("押せないものは理由を出す: キャンセルは orders_cancel、個人情報の削除と会員を開くのは customers", async () => {
    const { member, base } = setup();
    const ship = await member("ship@example.com", ["orders"]);
    const html = await (await ship.get(`${base}/orders/00000000-0000-4000-b000-000000001001`)).text();
    expect(html).toContain("この操作には「キャンセル・返金」の項目が要ります。");
    expect(html).toContain("この操作には「会員」の項目が要ります。");
    expect(html).not.toContain('value="cancelled"');
    expect(html).not.toContain(`action="${base}/orders/00000000-0000-4000-b000-000000001001/mask"`);
    expect(html).toContain('<span class="status off">未発送</span>');
    expect(html).toContain("注文を受けました");
  });

  it("全部の項目の人には、キャンセル・個人情報の削除・会員の詳細へのリンクと発送の経過", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const paid = await (await b.get(`${base}/orders/00000000-0000-4000-b000-000000001001`)).text();
    expect(paid).toContain('value="cancelled"');
    expect(paid).toContain(`href="${base}/customers/00000000-0000-4000-c000-000000000001"`);
    const shipped = await (await b.get(`${base}/orders/00000000-0000-4000-b000-000000001002`)).text();
    expect(shipped).toContain("発送しました");
    expect(shipped).toContain("ゲストの購入です。");
  });

  it("リンクをもらって項目の無いページに来たら、どの項目が要るかを出してホームへ戻れる。触れないショップは今までどおり 404", async () => {
    const { sb, member, base } = setup();
    const ship = await member("ship@example.com", ["orders"]);
    const res = await ship.get(`${base}/products`);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("このページには「商品・在庫」の項目が要ります。");
    expect(html).toContain(`<a href="${base}/home">ショップのホームに戻る</a>`);
    const other = sb.addShop(sb.addUser("o@example.com", "password-123", { owner: true }).id, { slug: "other", name: "ほか" });
    expect((await ship.get(`/admin/shops/${other.id}/products`)).status).toBe(404);
  });
});
