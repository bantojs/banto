import { describe, expect, it } from "vitest";
import { wooImporter } from "../src/modules/woo-import/client";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memberLogin, memberMail, tinyPng } from "./helpers";

/** WooCommerce の商品 CSV（英語の列名。日本語のサイトでもプロフィールの言語を English にして書き出す）を組み立てる。実データは使わない */
const HEADER = [
  "ID", "Type", "SKU", "GTIN, UPC, EAN, or ISBN", "Name", "Published", "Is featured?", "Short description", "Description", "In stock?", "Stock", "Sale price", "Regular price",
  "Categories", "Tags", "Images", "Parent", "Brands", "Attribute 1 name", "Attribute 1 value(s)", "Attribute 1 visible", "Attribute 2 name", "Attribute 2 value(s)", "WooGallery Variation Images",
  "Meta: _material", "Meta: _wc_facebook_sync_enabled", "Meta: %e7%9d%80%e4%b8%88_s", "素材",
];
type Cells = Partial<Record<(typeof HEADER)[number], string>>;
const row = (c: Cells) => HEADER.map((h) => c[h] ?? "");
const csv = (rows: string[][], header = HEADER) => "﻿" + [header, ...rows].map((r) => r.map((v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n") + "\r\n";

const BASIC = csv([
  row({
    ID: "10",
    Type: "variable",
    SKU: "TEE-01",
    Name: "Tシャツ",
    Published: "1",
    "Short description": "要約",
    Description: '<p>1 行目</p>\r\\n<p>2 行目 &amp; <strong>強調</strong></p>',
    "In stock?": "1",
    Categories: "トップス, トップス > カットソー, セール",
    Tags: "NEW, 夏物",
    Images: "https://shop.example/a.jpg, https://shop.example/b.jpg",
    Brands: "HANARE, バリューライン",
    "Attribute 1 name": "Color",
    "Attribute 1 value(s)": "Black, White",
    "Meta: _material": "綿100％",
    "Meta: _wc_facebook_sync_enabled": "yes",
    "Meta: %e7%9d%80%e4%b8%88_s": "65.5",
    素材: "綿100％",
  }),
  row({ ID: "11", Type: "variation", SKU: "TEE-01-BK", "GTIN, UPC, EAN, or ISBN": "4901234567894", Name: "Tシャツ - Black", Published: "1", "In stock?": "1", Stock: "3", "Regular price": "3000", "Sale price": "2500", Parent: "TEE-01", "Attribute 1 name": "Color", "Attribute 1 value(s)": "Black", "WooGallery Variation Images": "https://shop.example/bk.jpg,https://shop.example/a.jpg" }),
  row({ ID: "12", Type: "variation", SKU: "", "GTIN, UPC, EAN, or ISBN": "123", Name: "Tシャツ - White", Published: "1", "In stock?": "1", Stock: "", "Regular price": "3000", Parent: "id:10", "Attribute 1 name": "Color", "Attribute 1 value(s)": "White" }),
  row({ ID: "13", Type: "variation", SKU: "TEE-01-GR", Name: "Tシャツ - Green", Published: "-1", "In stock?": "1", Stock: "5", "Regular price": "3000", Parent: "TEE-01", "Attribute 1 name": "Color", "Attribute 1 value(s)": "Green" }),
  row({ ID: "14", Type: "variation", SKU: "TEE-01-RD", Name: "Tシャツ - Red", Published: "1", Stock: "1", "Regular price": "", Parent: "TEE-01", "Attribute 1 name": "Color", "Attribute 1 value(s)": "Red" }),
  row({ ID: "20", Type: "simple", SKU: "MUG", Name: "マグ", Published: "0", "In stock?": "0", "Regular price": "1500", Categories: "雑貨 > 食器 > マグ > 深すぎ", Brands: "K-LABO" }),
  row({ ID: "21", Type: "variation", SKU: "ORPHAN", Name: "迷子", Published: "1", "Regular price": "100", Parent: "NOPE" }),
]);

const OPTS = { brandMode: "first" as const, overwriteStock: true, skipDisabledVariations: true, includeVariationImages: true };

describe("WooCommerce インポーター: CSV の解析と対応付け（ブラウザ側のコード）", () => {
  const w = wooImporter();

  it("RFC 4180 の CSV（BOM・クォート・セル内改行・CRLF）を読む", () => {
    expect(w.parseCsv('﻿a,b\r\n"x, y","複数\n行 ""引用"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", '複数\n行 "引用"'],
    ]);
  });

  it("説明の HTML とエスケープされた改行をプレーンテキストにする。URL エンコードされたメタ名を戻す", () => {
    expect(w.htmlToText('<p>1 行目</p>\r\\n<p>2 &amp; <b>3</b>&#x30fc;</p>')).toBe("1 行目\n\n2 & 3ー");
    expect(w.decodeMetaName("Meta: %e7%9d%80%e4%b8%88_s")).toBe("着丈_s");
    expect(w.decodeMetaName("Meta: %e7%9d%80%e4%b8%88_%e3%83%95%e3%83%aa%e3%83%bc%e3%82%b5%")).toBe("着丈_フリーサ");
  });

  it("親とバリエーション（SKU / id: 参照）、価格・セール・在庫・JAN、警告", () => {
    const a = w.analyze(BASIC);
    expect(a.stats).toMatchObject({ rows: 7, products: 2, skus: 4, categories: 6 });
    const tee = a.products.find((p) => p.slug === "tee-01")!;
    expect(tee).toMatchObject({ name: "Tシャツ", published: true, tags: ["NEW", "夏物"], brands: ["HANARE", "バリューライン"] });
    expect(tee.description).toBe("要約\n\n1 行目\n\n2 行目 & 強調");
    expect(tee.skus.map((k) => [k.code, k.price_jpy, k.compare_at_price_jpy, k.available, k.gtin])).toEqual([
      ["TEE-01-BK", 2500, 3000, 3, "4901234567894"],
      ["tee-01-12", 3000, null, -1, null],
      ["TEE-01-GR", 3000, null, 5, null],
    ]);
    expect(tee.skus[0]!.options).toEqual({ Color: "Black" });
    const mug = a.products.find((p) => p.slug === "mug")!;
    expect(mug).toMatchObject({ published: false, categoryPaths: [["雑貨", "食器", "マグ"]] });
    expect(mug.skus).toEqual([expect.objectContaining({ code: "MUG", price_jpy: 1500, available: 0 })]);
    const codes = Object.fromEntries(a.warnings.map((x) => [x.code, x.count]));
    expect(codes).toMatchObject({ no_price: 1, disabled_variation: 1, stock_unknown: 1, bad_gtin: 1, orphan_variation: 1 });
  });

  it("カスタム項目の候補: 標準列を除き、内部用メタは既定で外す。日本語の名前はキーをハッシュにする", () => {
    const a = w.analyze(BASIC);
    expect(a.fields.map((f) => [f.label, f.type, f.suggested])).toEqual([
      ["material", "text", true],
      ["wc_facebook_sync_enabled", "text", false],
      ["着丈_s", "number", true],
      ["素材", "text", true],
    ]);
    expect(a.fields[0]!.key).toBe("material");
    expect(a.fields[2]!.key).toMatch(/^f_[0-9a-z]+$/);
  });

  it("送る形: カテゴリーの階層（3 段まで）、主カテゴリー以外とブランドの残りはタグ、無効なバリエーションを外す、画像をまとめる", () => {
    const a = w.analyze(BASIC);
    const plan = w.build(a, { ...OPTS, fields: a.fields.filter((f) => f.suggested).map((f) => ({ source: f.source, key: f.key, label: f.label, type: f.type })) });
    const bySlug = new Map(plan.categories.map((c) => [c.slug, c]));
    const tops = plan.categories.find((c) => c.name === "トップス")!;
    const cut = plan.categories.find((c) => c.name === "カットソー")!;
    expect(cut.parent_slug).toBe(tops.slug);
    expect(plan.categories.find((c) => c.name === "深すぎ")).toBeUndefined();
    // 親が先に並ぶ
    for (const c of plan.categories) if (c.parent_slug) expect(plan.categories.indexOf(bySlug.get(c.parent_slug)!)).toBeLessThan(plan.categories.indexOf(c));

    const tee = plan.products.find((p) => p.payload.slug === "tee-01")!;
    expect(tee.payload).toMatchObject({ brand: "HANARE", category_slug: cut.slug, attributes: { material: "綿100％" } });
    // 主カテゴリーの祖先でないカテゴリー（セール）は追加カテゴリー
    expect(tee.payload.tags).toEqual(["NEW", "夏物", "バリューライン"]);
    expect(tee.payload.extra_category_slugs).toEqual([plan.categories.find((c) => c.name === "セール")!.slug]);
    expect(tee.payload.skus.map((k) => k.code)).toEqual(["TEE-01-BK", "tee-01-12"]);
    expect(tee.payload.skus[1]!.available).toBe(0);
    expect(tee.images).toEqual(["https://shop.example/a.jpg", "https://shop.example/b.jpg", "https://shop.example/bk.jpg"]);
    expect(Object.values(tee.payload.attributes)).toContain(65.5);

    const last = w.build(a, { ...OPTS, brandMode: "last", skipDisabledVariations: false, includeVariationImages: false, fields: [] });
    const tee2 = last.products.find((p) => p.payload.slug === "tee-01")!;
    expect(tee2.payload.brand).toBe("バリューライン");
    expect(tee2.payload.skus.map((k) => [k.code, k.available])).toEqual([
      ["TEE-01-BK", 3],
      ["tee-01-12", 0],
      ["TEE-01-GR", 0],
    ]);
    expect(tee2.images).toHaveLength(2);
    expect(w.chunk(Array.from({ length: 130 }, (_, i) => ({ i })), 60)).toHaveLength(3);
  });

  it("WooCommerce の書き出しのメタ列ずれ: 別の列の値が流れ込んだ 50 行の塊は、カスタム項目だけ取り込まない", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "Regular price", "Parent", "Meta: _flag_a", "Meta: _flag_b", "Meta: _flag_c", "Meta: _length"];
    const rows: string[][] = [];
    for (let n = 0; n < 30; n++) {
      const yes = n % 2 === 0 ? "yes" : "no";
      // 1 件目（最初の塊）だけ、長さの列に yes/no が流れ込んでいる
      rows.push([String(100 + n), "variable", `P${n}`, `商品${n}`, "1", "", "", yes, "no", "yes", n === 0 ? "no" : String(60 + n)]);
      rows.push([String(200 + n), "variation", `P${n}-1`, `商品${n} - M`, "1", "1000", `P${n}`, "", "", "", ""]);
    }
    const text = csv(rows, header);
    const a = w.analyze(text);
    const misaligned = a.warnings.find((x) => x.code === "meta_misaligned")!;
    // 行 0〜49（商品 0〜24）が最初の塊
    expect(misaligned.count).toBe(25);
    expect(a.products.filter((p) => p.metaUnreliable).map((p) => p.slug)).toEqual(Array.from({ length: 25 }, (_, n) => `p${n}`));
    const length = a.fields.find((f) => f.label === "length")!;
    expect(length.type).toBe("number");
    const plan = w.build(a, { ...OPTS, fields: [{ source: length.source, key: "length", label: "length", type: "number" }] });
    expect(plan.products.find((p) => p.payload.slug === "p0")!.payload.attributes).toEqual({});
    expect(plan.products.find((p) => p.payload.slug === "p27")!.payload.attributes).toEqual({ length: 87 });
  });

  it("数値の列に文字が混ざっている（列ずれの可能性が高い）項目は既定で外し、印を付ける", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "Regular price", "Meta: _width", "Meta: _range"];
    const rows = [
      ["1", "simple", "A", "A", "1", "100", "50", "30～48"],
      ["2", "simple", "B", "B", "1", "100", "52", "40"],
      ["3", "simple", "C", "C", "1", "100", "yes", "41"],
      ["4", "simple", "D", "D", "1", "100", "55", "35-50"],
    ];
    const a = w.analyze(csv(rows, header));
    expect(a.fields.map((f) => [f.label, f.type, f.unstable, f.suggested])).toEqual([
      ["width", "text", true, false],
      // 範囲の表記が半分ある列は「数値の列」とは見なさない
      ["range", "text", false, true],
    ]);
  });

  it("WooCommerce の CSV でなければ何もしない", () => {
    expect(w.analyze("a,b\n1,2\n").warnings).toEqual([{ code: "not_woocommerce", count: 1, examples: [] }]);
  });

  it("列名が日本語（英語以外）の CSV は読まず、英語で書き出し直すよう案内する", () => {
    const ja = csv([["1", "simple", "A", "マグ", "1", "1500"]], ["ID", "タイプ", "SKU", "名前", "公開済み", "標準価格"]);
    const a = w.analyze(ja);
    expect(a.products).toEqual([]);
    expect(a.warnings).toEqual([{ code: "localized_headers", count: 1, examples: ["ID", "タイプ", "SKU", "名前", "公開済み"] }]);
    // 列名が英語なら、中身や追加の列（プラグインの列）が日本語でも読む
    expect(w.analyze(csv([["1", "simple", "A", "マグ", "1", "1500", "綿"]], ["ID", "Type", "SKU", "Name", "Published", "Regular price", "素材"])).products).toHaveLength(1);
  });

  it("Excel で保存し直した Shift_JIS のファイルも読む（UTF-8 として読めるものは UTF-8）", () => {
    const utf8 = new TextEncoder().encode("ID,Type,Name\n1,simple,マグ\n");
    expect(w.decode(utf8.buffer)).toEqual({ text: "ID,Type,Name\n1,simple,マグ\n", encoding: "utf-8" });
    // 「マグ」の Shift_JIS は 83 7D 83 4F
    const sjis = new Uint8Array([...new TextEncoder().encode("ID,Type,Name\n1,simple,"), 0x83, 0x7d, 0x83, 0x4f, 0x0a]);
    expect(w.decode(sjis.buffer)).toEqual({ text: "ID,Type,Name\n1,simple,マグ\n", encoding: "shift_jis" });
  });

  it("セール期間: 期間内だけセール価格にし、これからのセール・終わったセールは通常の価格で取り込む", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "Sale price", "Regular price", "Date sale price starts", "Date sale price ends", "Stock"];
    const text = csv(
      [
        ["1", "simple", "NOW", "期間内", "1", "800", "1000", "2026-10-01", "2026-10-31", "1"],
        ["2", "simple", "SOON", "これから", "1", "800", "1000", "2026-11-01 00:00:00", "", "1"],
        ["3", "simple", "PAST", "終わった", "1", "800", "1000", "", "2026-10-15", "1"],
        ["4", "simple", "LASTDAY", "最終日", "1", "800", "1000", "", "2026-10-16", "1"],
        ["5", "simple", "OPEN", "期間なし", "1", "800", "1000", "", "", "1"],
      ],
      header,
    );
    const a = w.analyze(text, new Date(2026, 9, 16, 12, 0, 0));
    expect(a.products.map((p) => [p.slug, p.skus[0]!.price_jpy, p.skus[0]!.compare_at_price_jpy])).toEqual([
      ["now", 800, 1000],
      ["soon", 1000, null],
      ["past", 1000, null],
      ["lastday", 800, 1000],
      ["open", 800, 1000],
    ]);
    const codes = Object.fromEntries(a.warnings.map((x) => [x.code, x.examples]));
    expect(codes["sale_scheduled"]).toEqual(["これから（2026-11-01〜）"]);
    expect(codes["sale_ended"]).toEqual(["終わった"]);
  });

  it("税抜で入力していたショップ: 税区分ごとの税率で税込に換算する（課税しない商品はそのまま、端数の扱いを選べる）", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "Tax status", "Tax class", "Sale price", "Regular price", "Parent", "Stock"];
    const text = csv(
      [
        ["1", "simple", "STD", "標準", "1", "taxable", "", "", "1000", "", "1"],
        ["2", "simple", "FOOD", "食品", "1", "taxable", "reduced-rate", "", "1234", "", "1"],
        ["3", "simple", "GIFT", "非課税", "1", "none", "", "", "500", "", "1"],
        ["4", "variable", "TEE", "Tシャツ", "1", "taxable", "reduced-rate", "", "", "", ""],
        ["5", "variation", "TEE-M", "Tシャツ - M", "1", "taxable", "parent", "909", "1001", "TEE", "1"],
        ["6", "grouped", "SET", "セット", "1", "taxable", "", "", "", "", ""],
        ["7", "simple", "BO", "取り寄せ", "1", "taxable", "", "", "100", "", ""],
      ],
      header,
    );
    const a = w.analyze(text);
    expect(a.stats.taxClasses).toEqual(
      expect.arrayContaining([
        { taxClass: "", skus: 2 },
        { taxClass: "reduced-rate", skus: 2 },
        { taxClass: "(none)", skus: 1 },
      ]),
    );
    expect(w.defaultTaxRate("")).toBe(10);
    expect(w.defaultTaxRate("reduced-rate")).toBe(8);
    expect(w.defaultTaxRate("zero-rate")).toBe(0);
    const prices = (plan: ReturnType<typeof w.build>) => Object.fromEntries(plan.products.flatMap((p) => p.payload.skus.map((k) => [k.code, [k.price_jpy, k.compare_at_price_jpy]])));
    // 換算しない（既定）
    expect(prices(w.build(a, { ...OPTS, fields: [] }))).toMatchObject({ STD: [1000, null], FOOD: [1234, null], "TEE-M": [909, 1001] });
    // 換算する: 標準 10%、軽減 8%（親の区分を引き継ぐ）、課税しない商品はそのまま
    const round = prices(w.build(a, { ...OPTS, fields: [], pricesExcludeTax: { rates: { "": 10, "reduced-rate": 8 }, rounding: "round" } }));
    expect(round).toMatchObject({ STD: [1100, null], FOOD: [1333, null], GIFT: [500, null], "TEE-M": [982, 1081] });
    const floor = prices(w.build(a, { ...OPTS, fields: [], pricesExcludeTax: { rates: { "": 10, "reduced-rate": 8 }, rounding: "floor" } }));
    expect(floor).toMatchObject({ STD: [1100, null], FOOD: [1332, null], "TEE-M": [981, 1081] });
    const ceil = prices(w.build(a, { ...OPTS, fields: [], pricesExcludeTax: { rates: { "": 10, "reduced-rate": 8 }, rounding: "ceil" } }));
    expect(ceil).toMatchObject({ STD: [1100, null], FOOD: [1333, null], "TEE-M": [982, 1082] });
    // 税区分: 既定は 標準 → standard、reduced-rate → reduced、課税しない → exempt。画面で選び直せる
    const classes = (plan: ReturnType<typeof w.build>) => Object.fromEntries(plan.products.map((p) => [p.payload.name, p.payload.tax_class]));
    expect(classes(w.build(a, { ...OPTS, fields: [] }))).toMatchObject({ 標準: "standard", 食品: "reduced", 非課税: "exempt", Tシャツ: "reduced" });
    expect(classes(w.build(a, { ...OPTS, fields: [], taxClasses: { "reduced-rate": "standard" } }))).toMatchObject({ 食品: "standard", 非課税: "exempt" });
    expect(w.defaultTaxClass("zero-rate")).toBe("exempt");
    const codes = Object.fromEntries(a.warnings.map((x) => [x.code, x.examples]));
    expect(codes["skipped_type"]).toEqual(["セット（grouped）"]);
    expect(codes["backorder"]).toBeUndefined();
  });

  it("画像が 20 枚を超える商品は、20 枚ずつに分けて全部送る", () => {
    const images = Array.from({ length: 45 }, (_, i) => `https://shop.example/${i}.jpg`);
    const reqs = w.imageRequests([{ payload: { slug: "a" }, images }, { payload: { slug: "b" }, images: [] }, { payload: { slug: "c" }, images: images.slice(0, 3) }]);
    expect(reqs.map((r) => [r.slug, r.urls.length])).toEqual([["a", 20], ["a", 20], ["a", 5], ["c", 3]]);
    expect(reqs.flatMap((r) => (r.slug === "a" ? r.urls : []))).toEqual(images);
  });

  it("バリエーション商品だけでバリエーションの行が無い CSV（カテゴリーで絞って書き出した）は、その旨を知らせる", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "Regular price", "Categories"];
    const a = w.analyze(csv([["1", "variable", "TEE", "Tシャツ", "1", "", "トップス"]], header));
    expect(a.warnings.map((x) => [x.code, x.examples])).toEqual([["no_sku", ["Tシャツ"]], ["no_variations_in_csv", []]]);
  });

  it("お取り寄せ可で数量の無い SKU は、在庫 0 で取り込み、在庫数の無い SKU とは分けて知らせる", () => {
    const header = ["ID", "Type", "SKU", "Name", "Published", "In stock?", "Stock", "Regular price"];
    const a = w.analyze(csv([["1", "simple", "BO", "取り寄せ", "1", "backorder", "", "100"], ["2", "simple", "NM", "管理なし", "1", "1", "", "100"]], header));
    expect(Object.fromEntries(a.warnings.map((x) => [x.code, x.examples]))).toEqual({ backorder: ["取り寄せ"], stock_unknown: ["管理なし"] });
  });
});

/** WooCommerce の REST API（/wp-json/wc/v3）の最小の偽物。実データは使わない */
function fakeWoo(opts: { plainPermalinks?: boolean; key?: string; pricesIncludeTax?: "yes" | "no"; products?: number; maxPerPage?: number; brokenBody?: string } = {}) {
  const calls: string[] = [];
  const cats = [
    { id: 1, name: "トップス", parent: 0 },
    { id: 2, name: "カットソー", parent: 1 },
    { id: 3, name: "セール", parent: 0 },
  ];
  const meta = (extra: Record<string, unknown> = {}) =>
    Object.entries({ material: "綿100％", _material: "field_6512ab34cd", length_cm: 65.5, _wc_facebook_sync_enabled: "yes", gallery: [1, 2], ...extra }).map(([key, value], i) => ({ id: i, key, value }));
  const products: Record<string, unknown>[] = [
    {
      id: 10, type: "variable", sku: "TEE-01", name: "Tシャツ", status: "publish", permalink: "https://old.example/product/tee/",
      short_description: "<p>要約</p>", description: "<p>本文</p>", categories: [{ id: 2 }, { id: 3 }], tags: [{ name: "NEW" }], brands: [{ name: "HANARE" }],
      images: [{ src: "https://old.example/a.jpg" }], tax_status: "taxable", tax_class: "", meta_data: meta(),
    },
    {
      id: 20, type: "simple", sku: "MUG", name: "マグ", status: "draft", permalink: "https://old.example/?p=20", short_description: "", description: "",
      categories: [], tags: [], images: [], regular_price: "1500", sale_price: "1200", date_on_sale_from: "2026-11-01T00:00:00", date_on_sale_to: "",
      manage_stock: true, stock_quantity: 4, stock_status: "instock", tax_status: "taxable", tax_class: "reduced-rate", global_unique_id: "4901234567894", meta_data: meta({ length_cm: 9 }),
    },
    { id: 30, type: "grouped", name: "セット", status: "publish", meta_data: [] },
  ];
  for (let i = 0; i < (opts.products ?? 0); i++)
    products.push({ id: 100 + i, type: "simple", sku: `P${i}`, name: `商品${i}`, status: "publish", regular_price: "100", manage_stock: false, stock_status: "instock", meta_data: [] });
  const variations: Record<string, Record<string, unknown>[]> = {
    "10": [
      { id: 12, sku: "", name: "Tシャツ - White", status: "publish", regular_price: "3000", manage_stock: false, stock_status: "onbackorder", attributes: [{ name: "Color", option: "White" }], image: { src: "https://old.example/w.jpg" }, tax_class: "parent" },
      { id: 11, sku: "TEE-01-BK", name: "Tシャツ - Black", status: "publish", regular_price: "3000", sale_price: "2500", manage_stock: true, stock_quantity: 3, stock_status: "instock", attributes: [{ name: "Color", option: "Black" }], tax_class: "parent", global_unique_id: "123" },
      { id: 13, sku: "TEE-01-GR", name: "Tシャツ - Green", status: "private", regular_price: "3000", manage_stock: true, stock_quantity: 5, attributes: [{ name: "Color", option: "Green" }], tax_class: "parent" },
    ],
  };
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => "application/json; charset=UTF-8" } });
  const fetch = async (raw: string) => {
    calls.push(raw);
    const u = new URL(raw);
    if (u.protocol !== "https:") throw new TypeError("insecure");
    const route = u.searchParams.get("rest_route") ?? u.pathname;
    if (opts.plainPermalinks && !u.searchParams.has("rest_route")) return json({ code: "rest_no_route" }, 404);
    if (u.searchParams.get("consumer_key") !== (opts.key ?? "ck_test") || u.searchParams.get("consumer_secret") !== "cs_test") return json({ code: "woocommerce_rest_cannot_view" }, 401);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const per = Number(u.searchParams.get("per_page") ?? 10);
    // 遅いサーバーの再現: 一度に返せる件数を超えると、空の本文（200）を返す
    if (opts.maxPerPage !== undefined && per > opts.maxPerPage) return { ok: true, status: 200, text: async () => opts.brokenBody ?? "", headers: { get: () => "text/html" } };
    const paged = (rows: unknown[]) => json(rows.slice(offset, offset + per));
    const path = route.replace(/^.*\/wc\/v3\//, "");
    if (path === "products/categories") return paged(cats);
    if (path === "products") {
      expect(u.searchParams.get("status")).toBe("any");
      // 使う項目だけを頼む（関連商品などの重い計算をさせない）
      expect(u.searchParams.get("_fields")).toContain("meta_data");
      return paged(products);
    }
    const v = /^products\/(\d+)\/variations$/.exec(path);
    if (v) return paged(variations[v[1]!] ?? []);
    if (path === "settings/general/woocommerce_calc_taxes") return json({ id: "woocommerce_calc_taxes", value: "yes" });
    if (path === "settings/tax/woocommerce_prices_include_tax") return json({ id: "woocommerce_prices_include_tax", value: opts.pricesIncludeTax ?? "no" });
    return json({ code: "rest_no_route" }, 404);
  };
  return { fetch, calls };
}

describe("WooCommerce インポーター: REST API（ブラウザから WooCommerce を直接呼ぶ）", () => {
  const w = wooImporter();
  const access = { url: "https://old.example/wp-admin/", key: "ck_test", secret: "cs_test" };
  const NOW = new Date(2026, 9, 16, 12, 0, 0);

  it("商品・バリエーション・カテゴリーの階層・メタを読み、CSV と同じ対応付けにする", async () => {
    const woo = fakeWoo();
    const { analysis: a, pricesExcludeTax } = await w.fetchStore(access, woo.fetch, () => {}, NOW);
    expect(pricesExcludeTax).toBe(true);
    // キーはクエリ文字列で送り（Authorization ヘッダーは使わない）、ショップの根元にそろえる
    expect(woo.calls.every((c) => c.startsWith("https://old.example/wp-json/wc/v3/") && c.includes("consumer_key=ck_test"))).toBe(true);
    expect(a.stats).toMatchObject({ products: 2, skus: 4, categories: 3 });
    const tee = a.products.find((p) => p.slug === "tee-01")!;
    expect(tee).toMatchObject({ published: true, tags: ["NEW"], brands: ["HANARE"], categoryPaths: [["トップス", "カットソー"], ["セール"]], permalink: "https://old.example/product/tee/" });
    expect(tee.description).toBe("要約\n\n本文");
    // バリエーションは ID 順。backorder は在庫 0、JAN の桁違いは空、private は無効
    expect(tee.skus.map((k) => [k.code, k.price_jpy, k.compare_at_price_jpy, k.available, k.gtin, k.disabled ?? false])).toEqual([
      ["TEE-01-BK", 2500, 3000, 3, null, false],
      ["tee-01-12", 3000, null, -1, null, false],
      ["TEE-01-GR", 3000, null, 5, null, true],
    ]);
    expect(tee.skus[0]!.options).toEqual({ Color: "Black" });
    expect(tee.variationImages).toEqual(["https://old.example/w.jpg"]);
    const mug = a.products.find((p) => p.slug === "mug")!;
    // これからのセールは通常の価格。JAN は global_unique_id
    expect(mug).toMatchObject({ published: false, skus: [expect.objectContaining({ code: "MUG", price_jpy: 1500, available: 4, gtin: "4901234567894", taxClass: "reduced-rate" })] });
    const codes = Object.fromEntries(a.warnings.map((x) => [x.code, x.count]));
    expect(codes).toMatchObject({ skipped_type: 1, backorder: 1, bad_gtin: 1, disabled_variation: 1, sale_scheduled: 1 });

    // メタは key/value で受け取るのでずれない。ACF のフィールド参照・内部用・配列は外す
    expect(a.fields.map((f) => [f.source, f.label, f.type, f.suggested])).toEqual([
      ["m:material", "material", "text", true],
      ["m:_material", "material", "text", false],
      ["m:length_cm", "length_cm", "number", true],
      ["m:_wc_facebook_sync_enabled", "wc_facebook_sync_enabled", "text", false],
    ]);
    const plan = w.build(a, { ...OPTS, fields: a.fields.filter((f) => f.suggested).map((f) => ({ source: f.source, key: f.key, label: f.label, type: f.type })) });
    expect(plan.products.find((p) => p.payload.slug === "mug")!.payload.attributes).toEqual({ material: "綿100％", length_cm: 9 });
    const tee2 = plan.products.find((p) => p.payload.slug === "tee-01")!;
    expect(tee2.payload).toMatchObject({ brand: "HANARE", tags: ["NEW"], extra_category_slugs: [plan.categories.find((c) => c.name === "セール")!.slug] });
    expect(plan.categories.find((c) => c.name === "カットソー")!.parent_slug).toBe(plan.categories.find((c) => c.name === "トップス")!.slug);

    // 旧 URL → 新 URL
    expect(w.redirectsCsv(a, "https://banto.example/my-shop/")).toBe(
      "old_url,new_url\r\nhttps://old.example/product/tee/,https://banto.example/my-shop/p/tee-01\r\nhttps://old.example/?p=20,https://banto.example/my-shop/p/mug\r\n",
    );
  });

  it("CSV と REST API は同じ商品・カテゴリーに同じスラッグを付ける（どちらで取り込み直しても重複しない）", async () => {
    const { analysis: rest } = await w.fetchStore(access, fakeWoo().fetch, () => {}, NOW);
    const csvText = csv([row({ ID: "10", Type: "variable", SKU: "TEE-01", Name: "Tシャツ", Published: "1", Categories: "トップス > カットソー, セール" })]);
    const fromCsv = w.build(w.analyze(csvText, NOW), { ...OPTS, fields: [] });
    const fromRest = w.build(rest, { ...OPTS, fields: [] });
    expect(fromRest.products[0]!.payload.slug).toBe(fromCsv.products[0]!.payload.slug);
    expect(fromRest.products[0]!.payload.category_slug).toBe(fromCsv.products[0]!.payload.category_slug);
  });

  it("100 件を超える商品はページを送って全部読む。税込入力のショップは換算しない", async () => {
    const woo = fakeWoo({ products: 250, pricesIncludeTax: "yes" });
    const { analysis: a, pricesExcludeTax } = await w.fetchStore(access, woo.fetch);
    expect(a.stats.products).toBe(252);
    expect(pricesExcludeTax).toBe(false);
    expect(woo.calls.filter((c) => /\/products\?/.test(c)).length).toBe(3);
  });

  it("サーバーが 100 件の応答を作りきれない（空の本文）ときは、件数を減らして同じ位置から読み直す", async () => {
    const woo = fakeWoo({ products: 30, maxPerPage: 25 });
    const { analysis: a } = await w.fetchStore(access, woo.fetch);
    expect(a.stats.products).toBe(32);
    expect(woo.calls.filter((c) => c.includes("/products?")).map((c) => new URL(c).searchParams.get("per_page") + "@" + new URL(c).searchParams.get("offset"))).toEqual(["100@0", "25@0", "25@25"]);
  });

  it("件数を減らしても JSON が返らないときは、どの呼び出しで何が返ったかを添えて止める（キーは載せない）", async () => {
    const woo = fakeWoo({ maxPerPage: 1, brokenBody: "<html><body>Fatal error: Allowed memory size exhausted</body></html>" });
    const err = (await w.fetchStore(access, woo.fetch).then(
      () => null,
      (e: unknown) => e,
    )) as { reason: string; message: string };
    expect(err).toMatchObject({ reason: "bad_response" });
    expect(err.message).toContain("products/categories");
    expect(err.message).toContain("per_page=5");
    expect(err.message).toContain("Allowed memory size exhausted");
    expect(err.message).not.toContain("cs_test");
  });

  it("パーマリンク設定が「基本」のサイトは ?rest_route= で呼び直す", async () => {
    const woo = fakeWoo({ plainPermalinks: true });
    const { analysis: a } = await w.fetchStore(access, woo.fetch);
    expect(a.stats.products).toBe(2);
    expect(woo.calls[0]).toContain("/wp-json/wc/v3/products/categories");
    expect(woo.calls.slice(1).every((c) => c.startsWith("https://old.example/?rest_route=/wc/v3/"))).toBe(true);
  });

  it("http の URL・違うキー・接続できないときは、理由を分けて止める", async () => {
    await expect(w.fetchStore({ ...access, url: "http://old.example" }, fakeWoo().fetch)).rejects.toMatchObject({ reason: "bad_url" });
    await expect(w.fetchStore({ ...access, url: "not a url" }, fakeWoo().fetch)).rejects.toMatchObject({ reason: "bad_url" });
    await expect(w.fetchStore(access, fakeWoo({ key: "ck_other" }).fetch)).rejects.toMatchObject({ reason: "unauthorized" });
    await expect(w.fetchStore(access, async () => Promise.reject(new TypeError("Failed to fetch")))).rejects.toMatchObject({ reason: "network" });
    expect(w.storeBase("https://example.com/wp-json/wc/v3")).toBe("https://example.com");
    // WordPress をサブディレクトリに置いているサイト
    expect(w.storeBase("https://example.com/shop/wp-admin/admin.php?page=wc-settings")).toBe("https://example.com/shop");
    expect(w.storeBase("https://example.com/blog/")).toBe("https://example.com/blog");
  });
});

describe("WooCommerce インポーター: 管理画面とサーバー側", () => {
  function setup() {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    return { sb, shop, app: appWith(sb) };
  }
  const json = (admin: Browser, path: string, body: unknown) => admin.postJson(path, body);

  it("既定 OFF。ON にすると画面とリンクが出る。画面のスクリプトは構文として正しい", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    expect((await admin.get(base)).status).toBe(404);
    expect((await json(admin, `${base}/batch`, { products: [] })).status).toBe(404);
    let html = await (await admin.get(`/admin/shops/${shop.id}/modules`)).text();
    expect(html).toContain("WooCommerce から取り込み");
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).not.toContain(base);

    const res = await admin.post(`/admin/shops/${shop.id}/modules/woo_import/enabled`, { enabled: "on" });
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ modules: { woo_import: true } });
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).toContain(base);
    html = await (await admin.get(base)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(html.indexOf('id="woo-import"')))![1]!;
    expect(script).toContain(".mount(document.getElementById");
    // 本番のバンドルが差し込む __name を補う前置き（scripts/check-client-scripts.mjs が本番のバンドルで確かめる）
    expect(script.startsWith("var __name = __name ||")).toBe(true);
    // REST API の入力欄（キーはこのページのスクリプトから WooCommerce に直接送る）
    expect(html).toContain("data-wc-url");
    expect(html).toContain('type="password" data-wc-secret');
    expect(script).toContain(`"shopUrl":"http://localhost:8787/my-shop"`);
    // 埋め込んだ関数がブラウザでそのまま読める JavaScript であること（構文の検査だけ。実行はしない）
    expect(() => new Function(script)).not.toThrow();
  });

  it("カスタム項目の定義を足し（既存は変えない、非公開で作る）、商品を書き込み、画像を取り込む（取り込み済みは飛ばす）", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/modules/woo_import/enabled`, { enabled: "on" });
    sb.tables.shops[0]!["settings"] = { ...(sb.tables.shops[0]!["settings"] as object), product_fields: [{ key: "material", label: "素材（手入力）", type: "text", public: true }] };
    const base = `/admin/shops/${shop.id}/modules/woo-import`;

    let res = await json(admin, `${base}/fields`, { fields: [{ key: "material", label: "material", type: "text" }, { key: "f_abc", label: "着丈_s", type: "number" }] });
    expect(await res.json()).toMatchObject({ added: 1, skipped: 1 });
    expect((sb.tables.shops[0]!["settings"] as { product_fields: unknown[] }).product_fields).toEqual([
      { key: "material", label: "素材（手入力）", type: "text", public: true },
      { key: "f_abc", label: "着丈_s", type: "number", public: false },
    ]);

    // ブラウザ側と同じ手順で組み立てて送る
    const w = wooImporter();
    const a = w.analyze(BASIC);
    const plan = w.build(a, { ...OPTS, fields: [] });
    res = await json(admin, `${base}/batch`, { categories: plan.categories, products: [], overwrite_stock: true });
    expect(await res.json()).toMatchObject({ categories: plan.categories.length });
    res = await json(admin, `${base}/batch`, { products: plan.products.map((p) => p.payload), overwrite_stock: true });
    expect(await res.json()).toMatchObject({ products_created: 2, skus_created: 3, errors: [], tax_classes: 2 });
    expect(sb.tables.products.map((p) => p["slug"]).sort()).toEqual(["mug", "tee-01"]);
    expect(sb.tables.products.every((p) => p["tax_class"] === "standard")).toBe(true);
    // 主カテゴリーのほかのカテゴリーは追加カテゴリーに（0042）
    const sale = sb.tables.categories.find((c) => c["name"] === "セール")!;
    expect(sb.tables.products.find((p) => p["slug"] === "tee-01")).toMatchObject({ extra_category_ids: [sale["id"]], tags: ["NEW", "夏物", "バリューライン"] });
    // 2 回目は更新だけ
    res = await json(admin, `${base}/batch`, { products: plan.products.map((p) => p.payload), overwrite_stock: true });
    expect(await res.json()).toMatchObject({ products_created: 0, products_updated: 2, skus_created: 0 });

    // Images: 2 枚は取得でき、1 枚は画像ではない
    const png = tinyPng();
    externalHosts.set("https://shop.example/", (req) => (req.url.endsWith("b.jpg") ? new Response("not an image", { headers: { "content-type": "text/html" } }) : new Response(png, { headers: { "content-type": "image/png" } })));
    const tee = plan.products.find((p) => p.payload.slug === "tee-01")!;
    res = await json(admin, `${base}/images`, { slug: "tee-01", urls: tee.images });
    const first = (await res.json()) as { failures: { url: string; code: string }[] };
    expect(first).toMatchObject({ added: 2, skipped: 0, failed: 1 });
    // 失敗は画像ごとに URL と理由（画面で一覧と CSV にする）
    expect(first.failures).toEqual([{ url: expect.stringMatching(/b\.jpg$/), code: "not_image" }]);
    const productId = sb.tables.products.find((p) => p["slug"] === "tee-01")!["id"];
    const imgs = sb.tables.product_images.filter((i) => i["product_id"] === productId);
    expect(imgs.map((i) => i["sort_order"])).toEqual([0, 1]);
    expect(String(imgs[0]!["storage_key"])).toMatch(new RegExp(`^shops/${shop.id}/products/${productId}/wc-[0-9a-z]+\\.png$`));
    // もう一度: 取り込み済みは飛ばし、失敗したものだけ再挑戦
    res = await json(admin, `${base}/images`, { slug: "tee-01", urls: tee.images });
    expect(await res.json()).toMatchObject({ added: 0, skipped: 2, failed: 1 });
    externalHosts.delete("https://shop.example/");

    // 社内ネットワークの URL は取りに行かない
    res = await json(admin, `${base}/images`, { slug: "mug", urls: ["http://127.0.0.1/x.png"] });
    expect(await res.json()).toMatchObject({ added: 0, failed: 1 });
  });

  it("大きすぎる・壊れた本文は受け付けない", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/modules/woo_import/enabled`, { enabled: "on" });
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    let res = await json(admin, `${base}/batch`, { products: [{ slug: "x".repeat(500_000) }] });
    expect(res.status).toBe(400);
    res = await admin.postRaw(`${base}/batch`, "{not json", "application/json");
    expect(res.status).toBe(400);
    // 別のオリジンからは呼べない（管理画面の CSRF 対策）
    res = await admin.postJson(`${base}/batch`, { products: [] }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    void BASE;
  });
});

describe("WooCommerce インポーター: 会員の取り込み", () => {
  const w = wooImporter();
  const access = { url: "https://old.example", key: "ck_test", secret: "cs_test" };

  it("顧客を読み、名前・メールアドレス・日本の住所（配送先 → 請求先）にする。パスワードは扱わない", async () => {
    const rows = [
      { id: 1, email: "Hanako@Example.com", first_name: "花子", last_name: "山田", billing: { first_name: "花子", last_name: "山田", phone: "0312345678", country: "JP", state: "JP13", postcode: "100-0001", city: "千代田区", address_1: "千代田1-1", address_2: "" }, shipping: { country: "JP", state: "", address_1: "" } },
      { id: 2, email: "taro@example.com", first_name: "", last_name: "", billing: { first_name: "太郎", last_name: "佐藤", country: "JP", state: "JP27" }, shipping: { first_name: "太郎", last_name: "佐藤", country: "JP", state: "大阪府", postcode: "530-0001", city: "大阪市北区", address_1: "梅田1-1", address_2: "201" } },
      { id: 3, email: "abroad@example.com", first_name: "Ann", last_name: "Lee", billing: { country: "US", state: "CA", address_1: "1 Main St" }, shipping: {} },
      { id: 4, email: "", first_name: "メール無し" },
      { id: 5, email: "hanako@example.com" },
    ];
    const calls: string[] = [];
    const fetchImpl = async (u: string) => {
      calls.push(u);
      return { ok: true, status: 200, text: async () => JSON.stringify(new URL(u).searchParams.get("offset") === "0" ? rows : []) };
    };
    const r = await w.fetchCustomers(access, fetchImpl);
    expect(calls[0]).toContain("/wp-json/wc/v3/customers?");
    expect(calls[0]).toContain("role=customer");
    expect(r.skipped).toBe(2);
    expect(r.customers).toEqual([
      { email: "hanako@example.com", name: "山田 花子", default_address: { name: "山田 花子", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" } },
      { email: "taro@example.com", name: "佐藤 太郎", default_address: { name: "佐藤 太郎", phone: "", postal_code: "530-0001", state: "大阪府", city: "大阪市北区", line1: "梅田1-1", line2: "201" } },
      { email: "abroad@example.com", name: "Lee Ann", default_address: null },
    ]);
  });

  function setup(members: boolean) {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: members, modules: { woo_import: true } } });
    return { sb, shop, app: appWith(sb, { RESEND_API_KEY: "re_test" }) };
  }

  it("会員機能が OFF なら画面に設定へのリンクを出し、取り込みは 409", async () => {
    const { shop, app } = setup(false);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    const html = await (await admin.get(base)).text();
    const markup = html.slice(0, html.indexOf("<script>"));
    expect(markup).not.toContain('data-wc-customers=""');
    expect(markup).toContain(`href="/admin/shops/${shop.id}#members"`);
    const res = await admin.postJson(`${base}/customers`, { customers: [{ email: "a@example.com" }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "members_disabled" });
  });

  it("会員を作る（Auth のユーザーは作らない）。同じアドレスの会員は足りない項目だけ埋める。2 回目は重複しない。取り込んだ会員はメールのコードで入れる", async () => {
    const { sb, shop, app } = setup(true);
    const mail = memberMail(sb, shop.id);
    try {
      const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
      const base = `/admin/shops/${shop.id}/modules/woo-import`;
      expect(await (await admin.get(base)).text()).toContain('<button type="button" data-wc-customers="">');
      // 先に自分で会員になっていた人
      await memberLogin(new Browser(app), mail, "/my-shop", "member@example.com");
      sb.tables.customers[0]!["name"] = "本人が入れた名前";

      expect((await admin.postJson(`${base}/customers`, { customers: Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@example.com` })) })).status).toBe(400);
      const body = {
        customers: [
          { email: "Hanako@example.com", name: "山田 花子", default_address: { name: "山田 花子", phone: "03", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" } },
          { email: "member@example.com", name: "旧サイトの名前" },
          { email: "not-an-email", name: "x" },
          { email: "bad-address@example.com", default_address: { state: "Somewhere", line1: "x" } },
        ],
      };
      let res = await admin.postJson(`${base}/customers`, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ customers_created: 2, customers_updated: 1, errors: [{ email: "not-an-email", message: "invalid_email" }] });
      expect(sb.users.size).toBe(1); // 運営者だけ
      expect(sb.tables.customers.find((c) => c["email"] === "hanako@example.com")).toMatchObject({ shop_id: shop.id, name: "山田 花子", default_address: { state: "東京都", country: "JP" } });
      expect(sb.tables.customers.find((c) => c["email"] === "member@example.com")).toMatchObject({ name: "本人が入れた名前" });
      expect(sb.tables.customers.find((c) => c["email"] === "bad-address@example.com")).toMatchObject({ default_address: null });

      res = await admin.postJson(`${base}/customers`, body);
      expect(await res.json()).toMatchObject({ customers_created: 0, customers_updated: 3 });
      expect(sb.tables.customers).toHaveLength(3);

      const b = new Browser(app);
      await memberLogin(b, mail, "/my-shop", "hanako@example.com");
      const html = await (await b.get("/my-shop/account")).text();
      expect(html).toContain("hanako@example.com");
      expect(html).toContain("千代田区");
    } finally {
      mail.dispose();
    }
  });

});

describe("WooCommerce インポーター: クーポン", () => {
  const w = wooImporter();
  const NOW = new Date("2026-10-17T00:00:00Z");
  const base = { id: 1, code: "summer10", status: "publish", discount_type: "percent", amount: "10.00", individual_use: false, usage_count: 3, usage_limit: 100, usage_limit_per_user: 1, date_expires_gmt: "2026-12-31T14:59:59", free_shipping: false, product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [], exclude_sale_items: true, minimum_amount: "3000.00", maximum_amount: "0.00", email_restrictions: [], description: "夏の 10%" };

  it("割合・定額・送料無料を写し、残りの回数・期限・条件を移す。移せないものは理由を返す", () => {
    const m = w.mapCoupon(base, () => [], () => "", NOW);
    expect("plan" in m && m.plan).toMatchObject({ code: "SUMMER10", name: "夏の 10%", kind: "percent", value: 10, usage_limit: 97, per_customer_limit: 1, combinable: true, active: true, ends_at: "2026-12-31T14:59:59.000Z", conditions: { min_subtotal_jpy: 3000, exclude_sale: true } });
    expect("plan" in m && m.notes).toEqual([]);
    // 1 人あたりの上限があって使った人がいれば、使用回数も移す
    expect(w.mapCoupon({ ...base, used_by: ["12", "guest@example.com"] }, () => [], () => "", NOW)).toMatchObject({ plan: { wc_id: "1", used_by: ["12", "guest@example.com"] }, notes: ["history_moved"] });
    expect(w.mapCoupon({ ...base, discount_type: "fixed_cart", amount: "500", individual_use: true }, () => [], () => "", NOW)).toMatchObject({ plan: { kind: "fixed", value: 500, combinable: false } });
    expect(w.mapCoupon({ ...base, discount_type: "fixed_cart", amount: "0", free_shipping: true }, () => [], () => "", NOW)).toMatchObject({ plan: { kind: "free_shipping", value: 0 } });
    expect(w.mapCoupon({ ...base, discount_type: "fixed_product" }, () => [], () => "", NOW)).toEqual({ skip: "fixed_product" });
    expect(w.mapCoupon({ ...base, date_expires_gmt: "2026-01-01T00:00:00" }, () => [], () => "", NOW)).toEqual({ skip: "expired" });
    expect(w.mapCoupon({ ...base, usage_count: 100 }, () => [], () => "", NOW)).toEqual({ skip: "exhausted" });
    expect(w.mapCoupon({ ...base, code: "夏" }, () => [], () => "", NOW)).toEqual({ skip: "code" });
    // メールアドレスで絞ったクーポンは、その人ごとの発行済みクーポンにする。ワイルドカードは移さない。決められる人がいなければ無効で作る
    expect(w.mapCoupon({ ...base, email_restrictions: ["A@example.com", "*@corp.example"] }, () => [], () => "", NOW)).toMatchObject({ plan: { active: true, restricted_emails: ["a@example.com"] }, notes: ["email_grants", "email_wildcard_dropped"] });
    expect(w.mapCoupon({ ...base, email_restrictions: ["*@corp.example"] }, () => [], () => "", NOW)).toMatchObject({ plan: { active: false, restricted_emails: [] }, notes: ["email_restricted"] });
  });

  it("REST API から読み、商品は SKU と ID、カテゴリーは階層の名前から Banto の slug に写す", async () => {
    const calls: string[] = [];
    const page = (rows: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows), headers: { get: () => "application/json" } });
    const fetchImpl = async (u: string) => {
      calls.push(u);
      if (u.includes("/coupons")) return page([{ ...base, product_ids: [7], product_categories: [2] }]);
      if (u.includes("/products/categories")) return page([{ id: 1, name: "服", parent: 0 }, { id: 2, name: "シャツ", parent: 1 }]);
      if (u.includes("/products")) return page([{ id: 7, sku: "TEE-01" }]);
      return page([]);
    };
    const r = await w.fetchCoupons({ url: "https://old.example", key: "ck", secret: "cs" }, fetchImpl, () => {}, NOW);
    expect(r.coupons).toHaveLength(1);
    expect(calls.some((u) => u.includes("/customers"))).toBe(false);
    expect(r.coupons[0]!.conditions.products).toEqual([{ id: "7", sku: "TEE-01" }]);
    expect(r.coupons[0]!.conditions.category_slugs).toHaveLength(1);
    expect(r.coupons[0]!.conditions.category_slugs![0]).toMatch(/^c-/);
  });

  it("REST API: used_by の会員の ID をメールアドレスにそろえ、上限まで使い終えた人には個別のクーポンを発行しない", async () => {
    const page = (rows: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows), headers: { get: () => "application/json" } });
    const calls: string[] = [];
    const fetchImpl = async (u: string) => {
      calls.push(u);
      if (u.includes("/coupons")) return page([{ ...base, used_by: ["12", "Guest@Example.com", "99"] }, { ...base, id: 2, code: "vip", email_restrictions: ["used@example.com", "fresh@example.com"], used_by: ["used@example.com"] }]);
      if (u.includes("/customers")) return page([{ id: 12, email: "Member@Example.com" }]);
      return page([]);
    };
    const r = await w.fetchCoupons({ url: "https://old.example", key: "ck", secret: "cs" }, fetchImpl, () => {}, NOW);
    expect(calls.find((u) => u.includes("/customers"))).toContain("role=all");
    expect(r.coupons[0]!.used_by).toEqual(["member@example.com", "guest@example.com"]);
    expect(r.coupons[1]!.restricted_emails).toEqual(["fresh@example.com"]);
  });

  it("サーバー: 同じコードは作らない。対象の商品が見つからないクーポンは無効で作る。モジュールが OFF なら 409", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { woo_import: true, coupons: true } } });
    const tee = sb.addProduct(shop.id, { slug: "tee-01", name: "T", published: true });
    sb.tables.coupon_campaigns.push({ id: "camp-x", shop_id: shop.id, name: "既存", code: "OLD", kind: "fixed", value: 100, conditions: {}, active: true });
    const app = appWith(sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const url = `/admin/shops/${shop.id}/modules/woo-import/coupons`;
    const plan = (code: string, conditions: Record<string, unknown> = {}) => ({ code, name: code, kind: "percent", value: 10, ends_at: null, usage_limit: 5, per_customer_limit: null, combinable: true, active: true, conditions });
    const res = await admin.postJson(url, { coupons: [plan("OLD"), plan("A10", { products: [{ id: "7", sku: "TEE-01" }] }), plan("B10", { products: [{ id: "8", sku: "NOPE" }] })] });
    expect(await res.json()).toEqual({ created: 2, existing: 1, inactive: 1, grants_members: 0, grant_codes: [] });
    const a = sb.tables.coupon_campaigns.find((x) => x["code"] === "A10")!;
    expect(a).toMatchObject({ active: true, usage_limit: 5, conditions: { product_ids: [tee.id] } });
    expect(sb.tables.coupon_campaigns.find((x) => x["code"] === "B10")).toMatchObject({ active: false });
    sb.tables.shops[0]!["settings"] = { modules: { woo_import: true } };
    const app2 = appWith(sb);
    const admin2 = await Browser.loggedIn(app2, "owner@example.com", "password-123");
    expect((await admin2.postJson(url, { coupons: [plan("C10")] })).status).toBe(409);
  });

  it("サーバー: メールアドレスで絞ったクーポンはコードの無いキャンペーン + 個別の発行済み。会員でない人のコードを返す。取り込み元の ID で二重に作らない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { woo_import: true, coupons: true } } });
    sb.tables.customers.push({ id: "cust-1", shop_id: shop.id, email: "member@example.com" });
    const app = appWith(sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const url = `/admin/shops/${shop.id}/modules/woo-import/coupons`;
    const vip = { wc_id: "9", code: "VIP", name: "VIP", kind: "percent", value: 10, ends_at: null, usage_limit: null, per_customer_limit: 1, combinable: true, active: true, conditions: {}, restricted_emails: ["member@example.com", "outside@example.com", "*@x.example"] };
    const res = await admin.postJson(url, { coupons: [vip] });
    expect(await res.json()).toEqual({ created: 1, existing: 0, inactive: 0, grants_members: 1, grant_codes: [{ coupon: "VIP", email: "outside@example.com", code: expect.stringMatching(/^G/) }] });
    expect(sb.tables.coupon_campaigns.find((x) => x["external_ref"] === "woocommerce:9")).toMatchObject({ code: null, active: true });
    expect(sb.tables.coupon_grants.map((g) => g["customer_id"])).toEqual(["cust-1", null]);
    expect(await (await admin.postJson(url, { coupons: [vip] })).json()).toMatchObject({ created: 0, existing: 1 });

    // 1 人ごとの使用回数・過去の注文は 0023 の RPC に渡す
    const usage = await admin.postJson(`${url}/usage`, { code: "summer10", emails: ["a@example.com", 1], reset: true });
    expect(await usage.json()).toEqual({ found: true, uses: 1 });
    expect(sb.lastImport).toMatchObject({ fn: "import_coupon_usage", args: { p_code: "SUMMER10", p_emails: ["a@example.com"], p_reset: true } });
    expect((await admin.postJson(`${url}/usage`, { code: "x y", emails: [] })).status).toBe(400);
    const orders = await admin.postJson(`/admin/shops/${shop.id}/modules/woo-import/orders`, { orders: [{ ref: "woocommerce:1", number: 1 }] });
    expect(await orders.json()).toMatchObject({ created: 1 });
    expect((await admin.postJson(`/admin/shops/${shop.id}/modules/woo-import/orders`, { orders: [] })).status).toBe(400);
  });
});

describe("WooCommerce インポーター: 過去の注文", () => {
  const w = wooImporter();
  const order = {
    id: 321,
    number: "1234",
    status: "completed",
    currency: "JPY",
    date_created_gmt: "2026-03-01T01:02:03",
    date_completed_gmt: "2026-03-03T00:00:00",
    total: "3410",
    shipping_total: "600",
    shipping_tax: "60",
    discount_total: "200",
    discount_tax: "16",
    transaction_id: "pi_123",
    billing: { first_name: "花子", last_name: "山田", email: "Hanako@Example.com", phone: "0312345678", country: "JP", state: "JP13", city: "千代田区", address_1: "1-1", postcode: "100-0001" },
    shipping: { first_name: "", last_name: "", country: "JP", state: "", address_1: "" },
    line_items: [
      { name: "お茶", sku: "TEA-1", quantity: 2, subtotal: "2000", subtotal_tax: "160", total: "1800", total_tax: "144", meta_data: [] },
      { name: "Tシャツ - M", sku: "", quantity: 1, subtotal: "1000", subtotal_tax: "100", total: "1000", total_tax: "100", meta_data: [{ key: "pa_size", display_key: "サイズ", display_value: "M" }, { key: "_reduced_stock", value: "1" }] },
    ],
  };

  it("税抜と税額を足して税込に、状態を写し、会員・住所・番号をそろえる。売上にならない注文は理由を返す", () => {
    const m = w.mapOrder(order);
    expect("plan" in m && m.plan).toEqual({
      ref: "woocommerce:321",
      number: 1234,
      status: "shipped",
      created_at: "2026-03-01T01:02:03.000Z",
      shipped_at: "2026-03-03T00:00:00.000Z",
      total_jpy: 3410,
      shipping_jpy: 660,
      discount_jpy: 216,
      shipping_tax_rate: 10,
      customer_email: "hanako@example.com",
      customer_name: "山田 花子",
      shipping_address: { name: "山田 花子", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "1-1", line2: "" },
      payment_ref: "pi_123",
      items: [
        { sku: "TEA-1", name: "お茶", variant: null, qty: 2, unit_price_jpy: 1080, discount_jpy: 216, tax_rate: 8 },
        { sku: "", name: "Tシャツ - M", variant: "M", qty: 1, unit_price_jpy: 1100, discount_jpy: 0, tax_rate: 10 },
      ],
    });
    expect(w.mapOrder({ ...order, status: "processing" })).toMatchObject({ plan: { status: "paid", shipped_at: null } });
    expect(w.mapOrder({ ...order, status: "on-hold" })).toEqual({ skip: "status_on-hold" });
    expect(w.mapOrder({ ...order, currency: "USD" })).toEqual({ skip: "currency" });
    // 番号に接頭辞がある（連番プラグイン）なら ID を番号にする
    expect(w.mapOrder({ ...order, number: "WC-1234" })).toMatchObject({ plan: { number: 321 } });
  });

  it("REST API から状態を問わず読み、移さないものは理由ごとに数える", async () => {
    const page = (rows: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows), headers: { get: () => "application/json" } });
    const calls: string[] = [];
    const fetchImpl = async (u: string) => {
      calls.push(u);
      return page(u.includes("/orders") ? [order, { ...order, id: 322, number: "1235", status: "failed" }, { ...order, id: 323, number: "1236", status: "pending" }] : []);
    };
    const r = await w.fetchOrders({ url: "https://old.example", key: "ck", secret: "cs" }, fetchImpl);
    expect(r.orders.map((o) => o.number)).toEqual([1234]);
    expect(r.skipped).toEqual({ "status_failed": 1, "status_pending": 1 });
    expect(calls[0]).toContain("status=any");
  });
});
