import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { COUPON_CSV_COLUMNS, couponCsv, csvDate, parseCouponCsv, parseCsv } from "../src/modules/coupons/csv";
import { wooImporter } from "../src/modules/woo-import/client";

/**
 * クーポンの CSV（0043）。形の読み書き・取り込みの画面・WooCommerce の「プラグイン独自の設定」の扱い。
 * 値の範囲・既にあるかどうか・会員の確認は test/db/coupon-import.test.ts（実 PostgreSQL）。
 */
const HEADER = COUPON_CSV_COLUMNS.join(",");

describe("クーポン CSV の読み書き", () => {
  it("引用符・改行を含むセル・BOM・CRLF を読む", () => {
    expect(parseCsv('﻿a,b\r\n"x,""y""","1\n2"\r\n\r\n')).toEqual([
      ["a", "b"],
      ['x,"y"', "1\n2"],
    ]);
  });

  it("日時はショップの時間帯。日付だけの終了日はその日の 23:59、時差つきの ISO はそのまま", () => {
    expect(csvDate("2026-10-01", false)).toBe("2026-09-30T15:00:00.000Z");
    expect(csvDate("2026/10/31", true)).toBe("2026-10-31T14:59:00.000Z");
    expect(csvDate("2026-10-01 9:30", false)).toBe("2026-10-01T00:30:00.000Z");
    expect(csvDate("2026-10-01T00:00:00Z", false)).toBe("2026-10-01T00:00:00.000Z");
    expect(csvDate("10/01/2026", false)).toBe("bad");
    expect(csvDate("", true)).toBeNull();
  });

  it("行を import_coupons の形にする。知らない列に値がある行・形の違う行は DB に渡さない", () => {
    const csv = [
      "code,name,kind,value,ends_at,usage_limit,combinable,member_emails,min_subtotal_jpy,exclude_sale,product_slugs,category_slugs,tags,active,ref,note,source_meta,allowed_roles",
      'aut10,秋,percent,10,2026-10-31,"1,000",yes,,3000,true,tee;mug,sale,冬;セール,,,メモ,"{""x"":1}",',
      "VIP,VIP,fixed,500,,,,VIP1@example.com; vip2@example.com,,,,,,false,woocommerce:9,,,",
      "ROLE,ロール,percent,5,,,,,,,,,,,,,,wholesale",
      "BAD,x,percent,abc,,,,,,,,,,,,,,",
      "BADMAIL,x,fixed,100,,,,not-an-email,,,,,,,,,,",
    ].join("\n");
    const r = parseCouponCsv(csv);
    expect(r.fatal).toBeNull();
    expect(r.rows).toEqual([
      {
        line: 2,
        values: { name: "秋", code: "AUT10", kind: "percent", value: 10, ends_at: "2026-10-31T14:59:00.000Z", usage_limit: 1000, combinable: true },
        conditions: { min_subtotal_jpy: 3000, exclude_sale: true, tags: ["冬", "セール"] },
        product_slugs: ["tee", "mug"],
        exclude_product_slugs: [],
        category_slugs: ["sale"],
        exclude_category_slugs: [],
        member_emails: [],
      },
      expect.objectContaining({ line: 3, values: { name: "VIP", code: "VIP", kind: "fixed", value: 500, active: false, external_ref: "woocommerce:9" }, member_emails: ["vip1@example.com", "vip2@example.com"] }),
    ]);
    expect(r.errors).toEqual([
      { line: 4, code: "ROLE", error: "unknown_column: allowed_roles" },
      { line: 5, code: "BAD", error: "invalid_value" },
      { line: 6, code: "BADMAIL", error: "invalid_member_emails: not-an-email" },
    ]);
  });

  it("ブランドは ; で区切り（スペースを含む名前のため）、支払い方法は形を確かめる（0044）", () => {
    const csv = ["code,name,kind,value,brands,exclude_brands,payment_methods", 'A,a,fixed,100,Blue Bottle;HANARE,Other Brand,"stripe; komoju:PayPay"', "B,b,fixed,100,,,cod"].join("\n");
    const r = parseCouponCsv(csv);
    expect(r.rows[0]!.conditions).toEqual({ brands: ["Blue Bottle", "HANARE"], exclude_brands: ["Other Brand"], payment_methods: ["stripe", "komoju:paypay"] });
    expect(r.errors).toEqual([{ line: 3, code: "B", error: "invalid_conditions_payment_methods" }]);
  });

  it("見出しが無い・行が多すぎるファイルは全体を断る。書き出したものはそのまま読める", () => {
    expect(parseCouponCsv("a,b\n1,2").fatal).toBe("no_header");
    expect(parseCouponCsv([HEADER, ...Array.from({ length: 501 }, (_, i) => `C${i},,fixed,100`)].join("\n")).fatal).toBe("too_many_rows");
    const out = couponCsv([{ code: "X1", name: '名前, "引用"', kind: "fixed", value: 300, note: "改行\nあり", source_meta: '{"a":[1,2]}' }]);
    expect(out.startsWith(`﻿${HEADER}\r\n`)).toBe(true);
    const back = parseCouponCsv(out);
    expect(back.errors).toEqual([]);
    expect(back.rows[0]!.values).toEqual({ name: '名前, "引用"', code: "X1", kind: "fixed", value: 300 });
  });
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { coupons: true, woo_import: true } } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE-01", price_jpy: 1000, available: 1 });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "vip1@example.com", name: "会員" });
  return { sb, shop, app: appWith(sb) };
}

describe("クーポンの「CSV から取り込む」", () => {
  it("確かめる（作らない）→ 取り込む。会員でない人がいる行は作らない。ひな形をダウンロードできる", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/coupons`;
    expect(await (await admin.get(base)).text()).toContain(`${base}/import`);
    const page = await (await admin.get(`${base}/import`)).text();
    expect(page).toContain("<code>member_emails</code>");
    expect(page).toContain("source_meta の列に");

    const csv = [HEADER.split(",").slice(0, 16).join(","), "AUT10,秋,percent,10,,,,,,,,,,,,tee", "VIP,VIP,fixed,500,,,,,,,vip1@example.com;nobody@example.com,,,,,", "VIP2,VIP2,fixed,500,,,,,,,vip1@example.com,,,,,", "X,x,percent,abc,,,,,,,,,,,,"].join("\n");
    let res = await admin.postMultipart(`${base}/import`, { step: "check", file: new File([csv], "c.csv", { type: "text/csv" }) });
    let html = await res.text();
    expect(sb.tables.coupon_campaigns).toHaveLength(0);
    expect(html).toContain("作れるもの 2 件 / 既にあるもの 0 件 / 直す必要があるもの 2 件");
    expect(html).toContain("このショップの会員でないメールアドレスがあります");
    expect(html).toContain("value の形が違います");
    expect(sb.lastImport).toMatchObject({ fn: "import_coupons", args: { p_dry_run: true } });

    res = await admin.post(`${base}/import`, { step: "import", csv });
    html = await res.text();
    expect(html).toContain("作ったもの 2 件");
    expect(sb.tables.coupon_campaigns.map((c) => [c["code"], c["external_ref"]])).toEqual([
      ["AUT10", null],
      [null, "csv:VIP2"],
    ]);
    expect(sb.tables.coupon_grants).toHaveLength(1);
    // もう一度流しても重複しない
    html = await (await admin.post(`${base}/import`, { step: "import", csv })).text();
    expect(html).toContain("作ったもの 0 件 / 既にあったもの 2 件");

    const tpl = await admin.get(`${base}/import/template.csv`);
    expect(tpl.headers.get("content-type")).toContain("text/csv");
    const parsed = parseCouponCsv(await tpl.text());
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
  });
});

describe("WooCommerce: プラグイン独自の設定があるクーポン", () => {
  const w = wooImporter();
  const NOW = new Date("2026-10-17T00:00:00Z");
  const base = { id: 1, code: "summer10", status: "publish", discount_type: "percent", amount: "10.00", individual_use: false, usage_count: 0, usage_limit: null, usage_limit_per_user: null, date_expires_gmt: null, free_shipping: false, product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [], exclude_sale_items: false, minimum_amount: "0", maximum_amount: "0", email_restrictions: [], description: "" };
  const page = (rows: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows), headers: { get: () => "application/json" } });

  it("中身のあるプラグインの設定があれば review に分ける。空・オフの値と WordPress 本体の meta は数えない", async () => {
    const coupons = [
      { ...base, meta_data: [{ id: 1, key: "_edit_lock", value: "1700000000:1" }, { id: 2, key: "_acfw_auto_apply_coupon", value: "" }, { id: 3, key: "_some_plugin_flag", value: "no" }, { id: 4, key: "_x_rules", value: { type: "", ids: [] } }] },
      { ...base, id: 2, code: "vip", meta_data: [{ id: 5, key: "_acfw_allowed_customers", value: [12, 34] }, { id: 6, key: "_other", value: "0" }] },
    ];
    const r = await w.fetchCoupons({ url: "https://old.example", key: "ck", secret: "cs" }, async (u: string) => page(u.includes("/coupons") ? coupons : []), () => {}, NOW);
    expect(r.coupons.map((c) => c.code)).toEqual(["SUMMER10"]);
    expect(r.review.map((c) => [c.code, c.plugin_meta])).toEqual([["VIP", [{ key: "_acfw_allowed_customers", value: [12, 34] }]]]);
  });

  it("ブランド（WooCommerce 本体）は名前に直して写し、除くブランドはタグでも除く。名前がわからなければ要確認に残す", async () => {
    const coupons = [
      { ...base, id: 3, code: "nobrand", meta_data: [{ id: 1, key: "exclude_product_brands", value: [116] }] },
      { ...base, id: 4, code: "unknown", exclude_product_brands: [999] },
    ];
    const r = await w.fetchCoupons({ url: "https://old.example", key: "ck", secret: "cs" }, async (u: string) => page(u.includes("/coupons") ? coupons : u.includes("/products/brands") ? [{ id: 116, name: "Outlet &amp; Co" }] : []), () => {}, NOW);
    expect(r.coupons.map((c) => [c.code, c.conditions])).toEqual([["NOBRAND", { exclude_brands: ["Outlet & Co"], exclude_tags: ["Outlet & Co"] }]]);
    expect(r.review.map((c) => c.code)).toEqual(["UNKNOWN"]);
  });

  it("顧客 ID とメールアドレスの対応表を作る", async () => {
    const csv = await w.customerIdTable({ url: "https://old.example", key: "ck", secret: "cs" }, async (u: string) => page(u.includes("/customers") ? [{ id: 12, email: "VIP1@Example.com" }, { id: 13, email: "" }] : []));
    expect(csv).toBe("﻿wc_customer_id,email\r\n12,vip1@example.com\r\n");
  });

  it("サーバー: 要確認の CSV は active を false にし、設定を source_meta に入れる。「無効で作る」なら必ず無効で作る", async () => {
    const { sb, shop, app } = setup();
    // インポーターが SKU から付けた slug
    sb.addProduct(shop.id, { slug: "tee-01", name: "T", published: true });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const wbase = `/admin/shops/${shop.id}/modules/woo-import`;
    expect(await (await admin.get(wbase)).text()).toContain(`"couponImport":"/admin/shops/${shop.id}/modules/coupons/import"`);
    const plan = {
      wc_id: "2",
      code: "VIP",
      name: "VIP",
      kind: "percent",
      value: 15,
      ends_at: "2026-12-31T14:59:59.000Z",
      usage_limit: null,
      per_customer_limit: 1,
      combinable: false,
      active: true,
      conditions: { products: [{ id: "7", sku: "TEE-01" }, { id: "8", sku: "GONE" }] },
      restricted_emails: [],
      plugin_meta: [{ key: "_acfw_allowed_customers", value: [12, 34] }],
    };
    const res = await admin.postJson(`${wbase}/coupons/review.csv`, { coupons: [plan] });
    expect(res.status).toBe(200);
    const parsed = parseCsv(await res.text());
    const row = Object.fromEntries(parsed[0]!.map((h, i) => [h, parsed[1]![i]]));
    expect(row).toMatchObject({ code: "VIP", kind: "percent", value: "15", ends_at: "2026-12-31 23:59", per_customer_limit: "1", product_slugs: "tee-01", active: "false", ref: "woocommerce:2", source_meta: '{"_acfw_allowed_customers":[12,34]}' });
    expect(row["note"]).toContain("WooCommerce では有効");
    expect(row["note"]).toContain("_acfw_allowed_customers");
    expect(row["note"]).toContain("Banto に無いもの");

    const { plugin_meta: _m, ...rest } = plan;
    await admin.postJson(`${wbase}/coupons`, { coupons: [{ ...rest, conditions: {}, plugin_keys: ["_acfw_allowed_customers"] }] });
    expect(sb.tables.coupon_campaigns.find((c) => c["code"] === "VIP")).toMatchObject({ active: false });
  });
});

