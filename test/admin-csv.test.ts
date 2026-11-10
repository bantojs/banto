import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";

/**
 * CSV の書き出しの列と範囲（src/routes/admin/csv-export.tsx、メンテナの決定 2026-11-09）。
 * 列を選ばない今までのリンクは今までの列のまま（test/orders-admin.test.ts ほか）
 */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, tags: ["夏"] });
  const cap = sb.addProduct(shop.id, { slug: "cap", name: "キャップ", published: false });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 4, options: { size: "M" } });
  const teeL = sb.addSku(shop.id, tee.id, { code: "TEE-L", price_jpy: 3200, available: 1, options: { size: "L" } });
  sb.addSku(shop.id, cap.id, { code: "CAP-1", price_jpy: 2000, available: 0 });
  const now = new Date().toISOString();
  const order = (n: number, f: Record<string, unknown>) =>
    sb.tables.orders.push({ id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "paid", total_jpy: 9200, shipping_jpy: 0, customer_email: `c${n}@example.com`, customer_name: `客${n}`, shipping_address: { postal_code: "1000001", state: "東京都" }, payment_provider: "stripe", payment_ref: `pi_${n}`, tags: [], created_at: now, ...f });
  order(1001, {});
  order(1002, { status: "shipped" });
  sb.tables.order_items.push(
    { id: "oi-1", order_id: "00000000-0000-4000-b000-000000001001", shop_id: shop.id, sku_id: teeM.id, qty: 2, unit_price_jpy: 3000 },
    { id: "oi-2", order_id: "00000000-0000-4000-b000-000000001001", shop_id: shop.id, sku_id: teeL.id, qty: 1, unit_price_jpy: 3200 },
  );
  sb.tables.customers.push(
    { id: "00000000-0000-4000-c000-000000000001", shop_id: shop.id, email: "yes@example.com", name: "同意", default_address: {}, attributes: {}, marketing_consent: true, created_at: now },
    { id: "00000000-0000-4000-c000-000000000002", shop_id: shop.id, email: "no@example.com", name: "不同意", default_address: {}, attributes: {}, marketing_consent: false, created_at: now },
  );
  const app = appWith(sb);
  return { sb, shop, app, base: `/admin/shops/${shop.id}` };
}
const lines = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n");

describe("CSV の書き出しの列と範囲", () => {
  it("注文: 会計用は個人情報を含まず、明細ごとは 1 明細 1 行。選んだ列だけ・UTF-8 なら BOM なし", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const acc = await (await b.get(`${base}/orders.csv?preset=accounting`)).text();
    expect(lines(acc)[0]).toBe("注文番号,日時,状態,決済,決済参照,合計,送料,値引き,クーポン");
    expect(acc).not.toContain("example.com");
    const sold = lines(await (await b.get(`${base}/orders.csv?preset=sold&status=paid`)).text());
    expect(sold[0]).toBe("注文番号,日時,品番,商品,数量,単価,小計");
    expect(sold.slice(1).map((l) => l.split(",")[2])).toEqual(["TEE-M", "TEE-L"]);
    expect(sold[1]).toContain(",TEE-M,Tシャツ,2,3000,6000");
    const picked = await (await b.get(`${base}/orders.csv?col=number&col=email&col=sku&format=utf8&status=paid`)).text();
    expect(picked.startsWith("﻿")).toBe(false);
    expect(lines(picked)).toEqual(["注文番号,メール,品番", "1001,c1001@example.com,TEE-M x2 / TEE-L x1"]);
  });

  it("範囲「すべて」は条件を外した URL へ。書き出しの値は残す", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await b.get(`${base}/orders.csv?status=paid&range=all&preset=accounting`);
    expect(res.headers.get("location")).toBe(`${base}/orders.csv?preset=accounting`);
    expect(lines(await (await b.get(res.headers.get("location")!)).text())).toHaveLength(3);
  });

  it("会員: 案内メールの宛先は、同意した会員だけに必ず絞る（範囲「すべて」でも外さない）", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await b.get(`${base}/customers.csv?preset=mail&range=all&consent=no`);
    expect(res.headers.get("location")).toBe(`${base}/customers.csv?preset=mail&consent=yes`);
    const csv = await (await b.get(res.headers.get("location")!)).text();
    expect(csv).toContain("yes@example.com");
    expect(csv).not.toContain("no@example.com");
  });

  it("商品: 列を選ばなければ SKU ごとの一覧（在庫つき）、商品ごとなら 1 商品 1 行。在庫表のひな形", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const def = lines(await (await b.get(`${base}/products.csv`)).text());
    expect(def[0]).toBe("slug,商品名,公開,カテゴリー,タグ,品番,SKU 名,選択肢,価格（税込）,通常価格,JAN,在庫");
    expect(def).toHaveLength(4);
    expect(def.find((l) => l.includes("TEE-M"))).toContain("size=M");
    const perProduct = lines(await (await b.get(`${base}/products.csv?unit=product&col=name&col=sku_count&col=price&col=stock&col=code`)).text());
    expect(perProduct[0]).toBe("商品名,SKU の数,価格（税込）,在庫");
    expect(perProduct).toContain("Tシャツ,2,3000,5");
    const stockOnly = lines(await (await b.get(`${base}/products.csv?preset=stock&state=published`)).text());
    expect(stockOnly.slice(1).every((l) => l.startsWith("Tシャツ"))).toBe(true);
  });

  it("一覧の下に書き出しの欄: 個人情報のまとまりに印、Shift_JIS はスクリプトがあるときだけ選べる", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`${base}/orders?status=paid`)).text();
    expect(html).toContain('<form method="get" action="' + base + '/orders.csv" data-csv-export="orders">');
    expect(html).toContain('<input type="hidden" name="status" value="paid"/>');
    expect(html).toMatch(/<legend>お客様<span class="badge warn">個人情報<\/span><\/legend>/);
    expect(html).toContain('<option value="sjis" disabled="" data-needs-script="1">Shift_JIS</option>');
    // ブラウザの側のスクリプト（前回の選び方を覚える・Shift_JIS に変換する）が文として読めること
    const script = /<details class="csv-export"[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("encodeSjis");
    expect(await (await b.get(`${base}/customers`)).text()).toContain("案内メールの宛先");
    expect(await (await b.get(`${base}/products`)).text()).toContain('data-csv-export="products"');
  });
});
