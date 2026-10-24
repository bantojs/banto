import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, memberLogin, memberMail, quoteFrom } from "./helpers";
import { includedTaxOf, orderTaxBreakdown, shopTaxRates, taxBreakdown } from "../src/commerce/tax";
import { receiptSettings } from "../src/modules/receipt/render";

describe("消費税の計算（src/commerce/tax.ts）", () => {
  it("税率ごとの税込の合計から 1 回だけ端数を処理する（切り捨て・四捨五入・切り上げ）", () => {
    expect(includedTaxOf(1080, 8, "floor")).toBe(80);
    expect(includedTaxOf(1100, 10, "floor")).toBe(100);
    expect(includedTaxOf(1000, 10, "floor")).toBe(90); // 90.9
    expect(includedTaxOf(1000, 10, "round")).toBe(91);
    expect(includedTaxOf(1000, 10, "ceil")).toBe(91);
    expect(includedTaxOf(1000, 0, "ceil")).toBe(0);
    // 明細ごとに端数を出すと 3 × 9 = 27、合計からなら 300 × 10/110 = 27.27 → 27（同じ税率はまとめて 1 回）
    expect(taxBreakdown([{ amount_jpy: 100, rate: 10 }, { amount_jpy: 100, rate: 10 }, { amount_jpy: 100, rate: 10 }], 0, "floor")).toEqual([{ rate: 10, amount_jpy: 300, tax_jpy: 27 }]);
  });

  it("軽減税率と標準税率を分け、値引きは合計の比で按分する（端数は大きい方へ）", () => {
    const g = taxBreakdown([{ amount_jpy: 3240, rate: 8 }, { amount_jpy: 1100, rate: 10 }, { amount_jpy: 660, rate: 10 }], 500, "floor");
    // 8%: 3240、10%: 1760、合計 5000。値引き 500 → 8% から 324、10% から 176
    expect(g).toEqual([
      { rate: 10, amount_jpy: 1584, tax_jpy: 144 },
      { rate: 8, amount_jpy: 2916, tax_jpy: 216 },
    ]);
    expect(g.reduce((n, x) => n + x.amount_jpy, 0)).toBe(4500);
  });

  it("商品ごとの値引きはその明細から、送料の値引きは送料から差し引く（軽減税率の商品だけのクーポン）", () => {
    const order = { shipping_jpy: 660, discount_jpy: 324 + 660, items: [{ qty: 3, unit_price_jpy: 1080, tax_rate: 8, discount_jpy: 324 }, { qty: 1, unit_price_jpy: 1100, tax_rate: 10, discount_jpy: 0 }], shipping_tax_rate: 10, tax_rounding: "floor" };
    expect(orderTaxBreakdown(order, {})).toEqual([
      { rate: 10, amount_jpy: 1100, tax_jpy: 100 },
      { rate: 8, amount_jpy: 2916, tax_jpy: 216 },
    ]);
  });

  it("確定した注文: 税率の無い（0017 の前の）明細は標準税率", () => {
    expect(orderTaxBreakdown({ shipping_jpy: 0, items: [{ qty: 1, unit_price_jpy: 1100 }] }, { tax_rate: 10 })).toEqual([{ rate: 10, amount_jpy: 1100, tax_jpy: 100 }]);
    expect(shopTaxRates({ tax_rate: "abc", tax_rate_reduced: 8 })).toEqual({ standard: 10, reduced: 8 });
  });

  it("領収書の設定: 登録番号は T + 13 桁のときだけ", () => {
    expect(receiptSettings({ name: "S", settings: { receipt: { invoice_number: "T1234567890123" } } }).invoice_number).toBe("T1234567890123");
    expect(receiptSettings({ name: "S", settings: { receipt: { invoice_number: "1234" } } }).invoice_number).toBeNull();
    expect(receiptSettings({ name: "S" }).issuer).toBe("S");
  });
});

function setup(modules: Record<string, boolean> = { receipt: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_x",
    settings: { tax_rate: 10, tax_rate_reduced: 8, shipping: { mode: "flat", flat_fee_jpy: 660, free_over_jpy: null, by_prefecture: {} }, members_enabled: true, modules, receipt: { issuer: "株式会社マイショップ", invoice_number: "T1234567890123" } },
  });
  const food = sb.addProduct(shop.id, { slug: "coffee", name: "コーヒー豆", published: true, tax_class: "reduced" });
  const foodSku = sb.addSku(shop.id, food.id, { code: "COF", price_jpy: 1080, available: 10 });
  const mug = sb.addProduct(shop.id, { slug: "mug", name: "マグ", published: true });
  const mugSku = sb.addSku(shop.id, mug.id, { code: "MUG", price_jpy: 2200, available: 10 });
  const stripe = new FakeStripe();
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, shop, foodSku, mugSku, stripe, app };
}

describe("軽減税率と領収書（0017・同梱モジュール receipt）", () => {
  it("最終確認画面に税率ごとの内訳と ※ が出る", async () => {
    const { foodSku, mugSku, app } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: foodSku.id, qty: "2" });
    await b.post("/my-shop/cart/add", { sku_id: mugSku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "stripe" });
    const html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).toContain("コーヒー豆");
    expect(html).toContain("※ は軽減税率の対象です。");
    // 8%: 2160（うち 160）、10%: 2200 + 送料 660 = 2860（うち 260）
    expect(html).toContain("8% 対象 ¥2,160（うち消費税 ¥160）");
    expect(html).toContain("10% 対象 ¥2,860（うち消費税 ¥260）");
    expect(quoteFrom(html)).toBeTruthy();
  });

  it("購入者は注文照会から、運営者は注文の画面から、会員は注文履歴から領収書を出せる", async () => {
    const { sb, shop, foodSku, mugSku, stripe, app } = setup();
    const mail = memberMail(sb, shop.id);
    try {
      const b = new Browser(app);
      await memberLogin(b, mail, "/my-shop", "buyer@example.com");
      await b.post("/my-shop/cart/add", { sku_id: foodSku.id, qty: "2" });
      await b.post("/my-shop/cart/add", { sku_id: mugSku.id, qty: "1" });
      await checkout(b, "/my-shop");
      const [sessionId] = [...stripe.sessions.keys()];
      await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
      const order = sb.tables.orders[0]!;
      const number = String(order["number"]);

      // 注文照会 → 領収書（POST、宛名つき）
      const anon = new Browser(app);
      const lookup = await (await anon.post("/my-shop/orders/lookup", { number, email: "buyer@example.com" })).text();
      expect(lookup).toContain('action="/my-shop/orders/receipt"');
      const r = await anon.post("/my-shop/orders/receipt", { number, email: "buyer@example.com", name: "山田商店" });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const html = await r.text();
      expect(html).toContain("適格簡易請求書");
      expect(html).toContain("山田商店 様");
      expect(html).toContain("登録番号 T1234567890123");
      expect(html).toContain("株式会社マイショップ");
      expect(html).toContain("コーヒー豆 / COF ※");
      expect(html).toContain("8% 対象");
      expect(html).toContain("¥160");
      expect(html).toContain("¥260");
      expect(html).not.toContain("千代田1-1");
      expect((await anon.post("/my-shop/orders/receipt", { number, email: "other@example.com", name: "" })).status).toBe(404);

      // 会員の注文履歴
      const account = await (await b.get("/my-shop/account")).text();
      expect(account).toContain(`/my-shop/account/orders/${number}/receipt`);
      const mr = await b.get(`/my-shop/account/orders/${number}/receipt?name=${encodeURIComponent("会員さん")}`);
      expect(mr.status).toBe(200);
      expect(await mr.text()).toContain("会員さん 様");
      expect((await new Browser(app).get(`/my-shop/account/orders/${number}/receipt`)).headers.get("location")).toBe("/my-shop/account/login");

      // 運営者
      const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
      const detail = await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}`)).text();
      expect(detail).toContain(`/admin/shops/${shop.id}/orders/${order["id"]}/receipt`);
      expect(detail).toContain("8% 対象 ¥2,160（うち消費税 ¥160）");
      const ar = await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}/receipt`)).text();
      expect(ar).toContain("山田 太郎 様");

      // キャンセルした注文には出さない
      order["status"] = "cancelled";
      expect((await anon.post("/my-shop/orders/receipt", { number, email: "buyer@example.com", name: "" })).status).toBe(404);
    } finally {
      mail.dispose();
    }
  });

  it("モジュールが OFF なら領収書の経路も画面の案内も無い", async () => {
    const { foodSku, stripe, app, sb } = setup({});
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: foodSku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    const number = String(sb.tables.orders[0]!["number"]);
    const lookup = await (await b.post("/my-shop/orders/lookup", { number, email: "buyer@example.com" })).text();
    expect(lookup).not.toContain("orders/receipt");
    expect((await b.post("/my-shop/orders/receipt", { number, email: "buyer@example.com", name: "" })).status).toBe(404);
  });

  it("管理画面: 商品の税の区分、ショップの軽減税率・端数、領収書の登録番号の形", async () => {
    const { shop, sb, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const p = sb.tables.products.find((x) => x["slug"] === "mug")!;
    const form = await (await admin.get(`/admin/shops/${shop.id}/products/${p["id"]}`)).text();
    expect(form).toContain('name="tax_class"');
    await admin.post(`/admin/shops/${shop.id}/shipping`, { mode: "flat", flat_fee_jpy: "660", tax_rate: "10", tax_rate_reduced: "8", tax_rounding: "round" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ tax_rate: 10, tax_rate_reduced: 8, tax_rounding: "round" });
    expect((await admin.post(`/admin/shops/${shop.id}/modules/receipt`, { issuer: "", invoice_number: "T123", proviso: "" })).headers.get("location")).toBe(`/admin/shops/${shop.id}/modules/receipt?flash=invalid`);
    expect((await admin.post(`/admin/shops/${shop.id}/modules/receipt`, { issuer: "X", invoice_number: "t9999999999999", proviso: "" })).headers.get("location")).toBe(`/admin/shops/${shop.id}/modules/receipt?flash=saved`);
    expect((sb.tables.shops[0]!["settings"] as Record<string, unknown>)["receipt"]).toMatchObject({ issuer: "X", invoice_number: "T9999999999999" });
  });
});
