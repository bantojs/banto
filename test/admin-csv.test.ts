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

  it("商品: 在庫は SKU と一緒に読み、DB への問い合わせは SKU の数に比例しない", async () => {
    const { sb, shop, app, base } = setup();
    for (let i = 0; i < 300; i++) {
      const p = sb.addProduct(shop.id, { slug: `p${i}`, name: `商品${i}`, published: true });
      for (let j = 0; j < 5; j++) sb.addSku(shop.id, p.id, { code: `P${i}-${j}`, price_jpy: 1000, available: j });
    }
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const before = sb.calls.length;
    const csv = lines(await (await b.get(`${base}/products.csv`)).text());
    expect(csv).toHaveLength(1 + 3 + 1500);
    expect(csv.find((l) => l.startsWith("p7,"))?.endsWith(",0")).toBe(true);
    const calls = sb.calls.slice(before);
    expect(calls.filter((x) => x.includes("/inventory")).length).toBe(0);
    expect(calls.length).toBeLessThan(15);
  });

  it("上限に届いたら黙って切らない: 最後の行で知らせ、商品は SKU を全部読めた商品の区切りで止める", async () => {
    const { sb, shop, app, base } = setup();
    // SKU の上限（10,000）を越える: 101 商品 × 100 SKU
    for (let i = 0; i < 101; i++) {
      const p = sb.addProduct(shop.id, { slug: `big${i}`, name: `大${i}`, published: true });
      for (let j = 0; j < 100; j++) sb.addSku(shop.id, p.id, { code: `B${i}-${String(j).padStart(3, "0")}`, price_jpy: 1000, available: 1 });
    }
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const csv = lines(await (await b.get(`${base}/products.csv?preset=stock`)).text());
    const note = csv[csv.length - 1]!;
    expect(note).toMatch(/^書き出せる上限に届いたので、ここまでの商品 \d+ 件で切りました/);
    const body = csv.slice(1, -1);
    const perProduct = new Map<string, number>();
    for (const l of body) perProduct.set(l.split(",")[0]!, (perProduct.get(l.split(",")[0]!) ?? 0) + 1);
    // 出した商品は SKU を全部出す（途中で切れた商品・「SKU 無し」の行は無い）
    for (const [name, n] of perProduct) expect(n, name).toBe(name === "Tシャツ" ? 2 : name === "キャップ" ? 1 : 100);
    expect(body.every((l) => l.split(",")[1] !== "")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(10000);
    expect(note).toContain(`ここまでの商品 ${perProduct.size} 件`);
    // 書き出しの欄に上限を出す
    expect(await (await b.get(`${base}/products`)).text()).toContain("一度に書き出せるのは 1,000 件までです。");
  });

  it("上限に届いたら黙って切らない: 注文 2,000 件・会員 5,000 件（案内メールの宛先も）", async () => {
    const { sb, shop, app, base } = setup();
    const now = new Date().toISOString();
    for (let n = 2001; n <= 4000; n++) sb.tables.orders.push({ id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, shop_id: shop.id, number: n, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: `c${n}@example.com`, customer_name: `客${n}`, shipping_address: {}, tags: [], created_at: now });
    for (let n = 3; n <= 5002; n++) sb.tables.customers.push({ id: `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`, shop_id: shop.id, email: `m${n}@example.com`, name: `会員${n}`, default_address: {}, attributes: {}, marketing_consent: true, created_at: now });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    // 件数に「,」が入るので、CSV の欄としては "" で囲まれる
    const truncatedNote = (what: string, n: string) => `"書き出せる上限に届いたので、ここまでの${what} ${n} 件で切りました。条件で絞って、分けて書き出してください。"`;
    for (const url of [`${base}/orders.csv`, `${base}/orders.csv?preset=accounting`]) {
      const res = await b.get(url);
      // ファイル名にも切ったことを出す
      expect(res.headers.get("content-disposition"), url).toMatch(/-partial\.csv"$/);
      const csv = lines(await res.text());
      expect(csv, url).toHaveLength(1 + 2000 + 1);
      expect(csv[csv.length - 1], url).toBe(truncatedNote("注文", "2,000"));
    }
    // 案内メールの宛先: 同意した会員は 5,001 人。切れたことが分かる
    const mailRes = await b.get(`${base}/customers.csv?preset=mail&consent=yes`);
    expect(mailRes.headers.get("content-disposition")).toBe('attachment; filename="customers-my-shop-mail-partial.csv"');
    const mail = lines(await mailRes.text());
    expect(mail).toHaveLength(1 + 5000 + 1);
    expect(mail[mail.length - 1]).toBe(truncatedNote("会員", "5,000"));
    const legacy = lines(await (await b.get(`${base}/customers.csv`)).text());
    expect(legacy[legacy.length - 1]).toBe(truncatedNote("会員", "5,000"));
    // 上限に届かなければファイル名も今までどおり
    expect((await b.get(`${base}/orders.csv?status=shipped`)).headers.get("content-disposition")).toBe('attachment; filename="orders-my-shop.csv"');
  });

  it("商品: 1 つのまとまり（100 商品）だけで SKU の上限を越えても、一覧の順に収まる分を出す", async () => {
    const { sb, shop, app, base } = setup();
    // 100 商品 × 120 SKU（10 色 × 12 サイズ）= 12,000 SKU。既存の 2 商品と合わせて 102 商品
    for (let i = 0; i < 100; i++) {
      const p = sb.addProduct(shop.id, { slug: `wide${i}`, name: `広${i}`, published: true });
      for (let j = 0; j < 120; j++) sb.addSku(shop.id, p.id, { code: `W${i}-${String(j).padStart(3, "0")}`, price_jpy: 1000, available: 1 });
    }
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const csv = lines(await (await b.get(`${base}/products.csv?preset=stock`)).text());
    const body = csv.slice(1, -1);
    // 上限 10,000 SKU に収まるのは 83 商品（83 × 120 = 9,960）。新しい順の先頭から
    expect(body).toHaveLength(83 * 120);
    expect(body[0]!.startsWith("広99,")).toBe(true);
    expect(body.some((l) => l.startsWith("広17,"))).toBe(true);
    expect(body.some((l) => l.startsWith("広16,"))).toBe(false);
    expect(csv[csv.length - 1]).toContain("ここまでの商品 83 件で切りました");
  });

  it("商品: 条件の無い書き出しでも 1,000 商品を越えたら知らせる（PostgREST は 1 回に 1,000 行まで）", async () => {
    const { sb, shop, app, base } = setup();
    for (let i = 0; i < 1000; i++) sb.addProduct(shop.id, { slug: `many${i}`, name: `多${i}`, published: true });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await b.get(`${base}/products.csv?unit=product&col=name`);
    expect(res.headers.get("content-disposition")).toMatch(/-partial\.csv"$/);
    const csv = lines(await res.text());
    expect(csv).toHaveLength(1 + 1000 + 1);
    expect(csv[csv.length - 1]).toContain("ここまでの商品 1,000 件で切りました");
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
