import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";

function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings });
  const app = appWith(sb);
  return { sb, shop, app };
}

const FIELDS = [
  { key: "material", label: "素材", type: "text", public: true },
  { key: "origin", label: "原産国", type: "select", options: ["日本", "中国"], public: true },
  { key: "cost", label: "原価", type: "number", public: false },
];

describe("商品マスタの拡張: 管理画面", () => {
  it("カテゴリーを作り、商品にカテゴリー・ブランド・カスタム項目、SKU に選択肢・通常価格・JAN を付ける", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");

    // カスタム項目の定義（1 行 1 項目）
    let res = await admin.post(`/admin/shops/${shop.id}/fields`, { definitions: "material | 素材 | text\norigin | 原産国 | select | 日本/中国\ncost | 原価 | number | | private\nBad Key | x | text" });
    expect(res.headers.get("location")).toContain("flash=fields_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ product_fields: FIELDS });
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).toContain("origin | 原産国 | select | 日本/中国");

    // カテゴリー
    res = await admin.post(`/admin/shops/${shop.id}/categories`, { name: "ウェア", slug: "wear", parent_id: "", sort_order: "0" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const wear = sb.tables.categories[0]!;
    await admin.post(`/admin/shops/${shop.id}/categories`, { name: "トップス", slug: "tops", parent_id: String(wear["id"]), sort_order: "0" });
    expect((await admin.post(`/admin/shops/${shop.id}/categories`, { name: "重複", slug: "tops", parent_id: "" })).headers.get("location")).toContain("flash=slug_taken");
    expect((await admin.post(`/admin/shops/${shop.id}/categories`, { name: "x", slug: "Bad Slug" })).headers.get("location")).toContain("flash=invalid_slug");
    const tops = sb.tables.categories.find((c) => c["slug"] === "tops")!;
    let html = await (await admin.get(`/admin/shops/${shop.id}/categories`)).text();
    expect(html).toContain('value="ウェア"');
    expect(html).toContain('value="トップス"');

    // 商品: カテゴリー・ブランド・カスタム項目（select の選択肢外と定義外のキーは捨てる）
    res = await admin.post(`/admin/shops/${shop.id}/products/new`, {
      name: "Tシャツ",
      slug: "tee",
      category_id: String(tops["id"]),
      brand: " Banto ",
      attr_material: "綿100%",
      attr_origin: "火星",
      attr_cost: "800",
      attr_unknown: "x",
      published: "on",
    });
    const product = sb.tables.products[0]!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/${product["id"]}?flash=saved`);
    expect(product).toMatchObject({ category_id: tops["id"], brand: "Banto", attributes: { material: "綿100%", cost: 800 } });
    html = await (await admin.get(`/admin/shops/${shop.id}/products/${product["id"]}`)).text();
    expect(html).toContain('<option value="' + tops["id"] + '" selected="">');
    expect(html).toContain("原価 (非公開)");

    // SKU: 選択肢・通常価格・JAN。通常価格が販売価格以下、JAN の桁が違えば拒否
    const base = `/admin/shops/${shop.id}/products/${product["id"]}`;
    expect((await admin.post(`${base}/skus`, { code: "TEE-M", price_jpy: "3000", compare_at_price_jpy: "3000", available: "1" })).headers.get("location")).toContain("flash=sku_invalid");
    expect((await admin.post(`${base}/skus`, { code: "TEE-M", price_jpy: "3000", gtin: "123", available: "1" })).headers.get("location")).toContain("flash=sku_invalid");
    res = await admin.post(`${base}/skus`, { code: "TEE-M", price_jpy: "3000", compare_at_price_jpy: "4000", gtin: "4901234567894", options: "サイズ=M\n色＝黒", available: "5" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const sku = sb.tables.skus[0]!;
    expect(sku).toMatchObject({ options: { サイズ: "M", 色: "黒" }, gtin: "4901234567894", compare_at_price_jpy: 4000 });

    // SKU の編集（セールをやめる）
    res = await admin.post(`${base}/skus/${sku["id"]}`, { name: "M / 黒", price_jpy: "3500", compare_at_price_jpy: "", gtin: "4901234567894", options: "サイズ=M" });
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(sku).toMatchObject({ name: "M / 黒", price_jpy: 3500, compare_at_price_jpy: null, options: { サイズ: "M" } });

    // カテゴリーの削除 → 商品は未分類（外部キーの on delete set null は DB テストで確認。ここは画面の流れ）
    res = await admin.post(`/admin/shops/${shop.id}/categories/${tops["id"]}/delete`, {});
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(sb.tables.categories.map((c) => c["slug"])).toEqual(["wear"]);
  });

});

describe("商品マスタの拡張: ストアフロントと公開 API", () => {
  function catalog() {
    const ctx = setup({ product_fields: FIELDS });
    const { sb, shop } = ctx;
    const wear = sb.addCategory(shop.id, { slug: "wear", name: "ウェア", sort_order: 0 });
    const tops = sb.addCategory(shop.id, { slug: "tops", name: "トップス", parent_id: wear.id });
    const goods = sb.addCategory(shop.id, { slug: "goods", name: "雑貨", sort_order: 1 });
    const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, category_id: tops.id, brand: "Banto", attributes: { material: "綿", cost: 800 } });
    sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, compare_at_price_jpy: 4000, options: { サイズ: "M", 色: "黒" }, gtin: "4901234567894", available: 3 });
    const mug = sb.addProduct(shop.id, { slug: "mug", name: "マグ", published: true, category_id: goods.id, brand: "Other" });
    sb.addSku(shop.id, mug.id, { code: "MUG", price_jpy: 1500, available: 3 });
    const plain = sb.addProduct(shop.id, { slug: "plain", name: "無分類", published: true });
    sb.addSku(shop.id, plain.id, { code: "PLAIN", price_jpy: 500, available: 3 });
    return { ...ctx, wear, tops, goods };
  }
  type Item = { slug: string; brand: string | null; category: { slug: string } | null; compare_at_price_jpy: number | null };
  const list = async (app: ReturnType<typeof appWith>, qs: string) => ((await (await app.request(`${BASE}/api/shops/my-shop/products${qs}`)).json()) as { products: Item[] }).products;

  it("公開 API: category（子孫を含む）・brand の絞り込み、カテゴリーの木、詳細の拡張項目（非公開項目は出さない）", async () => {
    const { app } = catalog();
    expect((await list(app, "?category=wear")).map((p) => p.slug)).toEqual(["tee"]);
    expect((await list(app, "?category=tops")).map((p) => p.slug)).toEqual(["tee"]);
    expect((await list(app, "?category=nope")).map((p) => p.slug)).toEqual([]);
    expect((await list(app, "?brand=Other")).map((p) => p.slug)).toEqual(["mug"]);
    const all = await list(app, "");
    expect(all.find((p) => p.slug === "tee")).toMatchObject({ brand: "Banto", category: { slug: "tops", name: "トップス" }, compare_at_price_jpy: 4000 });
    expect(all.find((p) => p.slug === "plain")).toMatchObject({ category: null, brand: null });

    const tree = (await (await app.request(`${BASE}/api/shops/my-shop/categories`)).json()) as { categories: unknown[] };
    expect(tree.categories).toEqual([
      { slug: "wear", name: "ウェア", count: 1, children: [{ slug: "tops", name: "トップス", count: 1, children: [] }] },
      { slug: "goods", name: "雑貨", count: 1, children: [] },
    ]);

    const detail = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: Record<string, unknown> };
    expect(detail.product).toMatchObject({
      brand: "Banto",
      category: { slug: "tops" },
      category_path: [
        { slug: "wear", name: "ウェア" },
        { slug: "tops", name: "トップス" },
      ],
      attributes: [{ key: "material", label: "素材", value: "綿" }],
      skus: [{ code: "TEE-M", options: { サイズ: "M", 色: "黒" }, gtin: "4901234567894", price_jpy: 3000, compare_at_price_jpy: 4000 }],
    });
    expect(JSON.stringify(detail)).not.toContain("800");
  });

  it("ストアフロント: カテゴリーのナビとカテゴリー別一覧、パンくず、ブランド、セール価格、選択肢、公開項目", async () => {
    const { app } = catalog();
    const b = new Browser(app);
    let html = await (await b.get("/my-shop")).text();
    expect(html).toContain('href="/my-shop?category=wear"');
    expect(html).toContain('href="/my-shop?category=tops"');
    expect(html).toContain("<s");
    expect(html).toContain("¥4,000");
    html = await (await b.get("/my-shop?category=wear")).text();
    expect(html).toContain("Tシャツ");
    expect(html).not.toContain("マグ</div>");
    expect(html).toContain(`rel="canonical" href="${BASE}/my-shop?category=wear"`);
    expect((await b.get("/my-shop?category=nope")).status).toBe(404);

    html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain('<a href="/my-shop?category=wear">ウェア</a>');
    expect(html).toContain('<a href="/my-shop?category=tops">トップス</a>');
    expect(html).toContain("Banto");
    expect(html).toContain("M / 黒");
    expect(html).toContain("通常 ¥4,000");
    expect(html).toContain("<th>素材</th>");
    expect(html).not.toContain("原価");
  });

});

describe("商品マスタの拡張: バックアップの往復", () => {
  it("カテゴリー（親子）・ブランド・カスタム項目・SKU の拡張列が戻る", async () => {
    const { sb, shop, app } = setup();
    const wear = sb.addCategory(shop.id, { slug: "wear", name: "ウェア" });
    const tops = sb.addCategory(shop.id, { slug: "tops", name: "トップス", parent_id: wear.id });
    const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", category_id: tops.id, brand: "Banto", attributes: { material: "綿" } });
    sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, compare_at_price_jpy: 4000, options: { サイズ: "M" }, gtin: "4901234567894" });
    sb.tables.coupon_campaigns.push({ id: "camp-1", shop_id: shop.id, name: "セール", code: "SALE", kind: "fixed", value: 100, active: true, conditions: {}, created_at: "2026-10-01T00:00:00Z" });
    sb.tables.coupon_grants.push({ id: "grant-1", shop_id: shop.id, campaign_id: "camp-1", code: "AAAA-BBBB-CCCC", customer_id: null, status: "available", created_at: "2026-10-01T00:00:00Z" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const exported = await (await admin.get(`/admin/shops/${shop.id}/export.json`)).text();
    // クーポン（キャンペーン・発行済み）も書き出す（0022 で戻す）
    expect(JSON.parse(exported)).toMatchObject({ counts: { coupon_campaigns: 1, coupon_grants: 1, coupon_slots: 0 } });
    const dst = sb.addShop(sb.tables.shops[0]!["owner_id"] as string, { slug: "dst", name: "Dst" });
    const res = await admin.postMultipart(`/admin/shops/${dst.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("categories: 2");
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("coupon_grants: 1");
    expect(Object.keys(sb.lastRestoreCommerce ?? {}).sort()).toEqual(["categories", "coupon_campaigns", "coupon_grants", "coupon_slots", "order_items", "orders", "products", "skus"]);
    const p = sb.tables.products.find((x) => x["shop_id"] === dst.id)!;
    const cat = sb.tables.categories.find((c) => c["id"] === p["category_id"])!;
    expect(cat).toMatchObject({ slug: "tops", shop_id: dst.id });
    expect(sb.tables.categories.find((c) => c["id"] === cat["parent_id"])).toMatchObject({ slug: "wear", shop_id: dst.id });
    expect(p).toMatchObject({ brand: "Banto", attributes: { material: "綿" } });
    expect(sb.tables.skus.find((k) => k["shop_id"] === dst.id)).toMatchObject({ options: { サイズ: "M" }, gtin: "4901234567894", compare_at_price_jpy: 4000 });
  });
});

describe("会員の項目（顧客マスタの外部連携、0047）: 管理画面", () => {
  it("定義を保存し、会員の一覧に独自項目と外部の ID が出る", async () => {
    const { sb, shop, app } = setup({ members_enabled: true });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/shops/${shop.id}/customer-fields`, { definitions: "rank | 会員ランク | select | regular/gold\nnewsletter | メルマガ | select | yes/no\nBad Key | x | text" });
    expect(res.headers.get("location")).toContain("flash=customer_fields_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({
      customer_fields: [
        { key: "rank", label: "会員ランク", type: "select", options: ["regular", "gold"], public: false },
        { key: "newsletter", label: "メルマガ", type: "select", options: ["yes", "no"], public: false },
      ],
    });
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).toContain("rank | 会員ランク | select | regular/gold");

    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "m@example.com", name: "会員", attributes: { rank: "gold", stale: "x" }, external_ref: { provider: "hubspot", id: "101" }, created_at: "2026-10-23T00:00:00Z" });
    const html = await (await admin.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).toContain("会員ランク: gold");
    expect(html).toContain("hubspot / 101");
    expect(html).not.toContain("stale"); // 定義に無い鍵は出さない
  });

  it("独自項目を手で直す（customer_set_attributes）、項目の値で絞る、CSV に書き出す", async () => {
    const { sb, shop, app } = setup({ members_enabled: true, customer_fields: [{ key: "rank", label: "会員ランク", type: "select", options: ["regular", "gold"] }, { key: "score", label: "スコア", type: "number" }] });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const m1 = crypto.randomUUID();
    const m2 = crypto.randomUUID();
    sb.tables.customers.push({ id: m1, shop_id: shop.id, email: "gold@example.com", name: "金", attributes: { rank: "gold" }, external_ref: { provider: "hubspot", id: "7" }, default_address: { phone: "090", state: "東京都" }, created_at: "2026-10-23T00:00:00Z" });
    sb.tables.customers.push({ id: m2, shop_id: shop.id, email: "plain@example.com", name: "普通", attributes: {}, external_ref: null, default_address: null, created_at: "2026-10-22T00:00:00Z" });

    // 編集: 選択肢と数。空欄は消す
    let res = await admin.post(`/admin/shops/${shop.id}/customers/${m2}/attributes?f=rank&v=gold`, { attr_rank: "gold", attr_score: "12.5" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?f=rank&v=gold&flash=attributes_saved`);
    expect(sb.tables.customers.find((c) => c["id"] === m2)!["attributes"]).toEqual({ rank: "gold", score: 12.5 });
    res = await admin.post(`/admin/shops/${shop.id}/customers/${m2}/attributes`, { attr_rank: "", attr_score: "" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?flash=attributes_saved`);
    expect(sb.tables.customers.find((c) => c["id"] === m2)!["attributes"]).toEqual({});
    res = await admin.post(`/admin/shops/${shop.id}/customers/${m2}/attributes`, { attr_rank: "platinum" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?error=attributes_invalid`);

    // 絞り込み
    let html = await (await admin.get(`/admin/shops/${shop.id}/customers?f=rank&v=gold`)).text();
    expect(html).toContain("gold@example.com");
    expect(html).not.toContain("plain@example.com");
    expect(html).toContain('name="attr_rank"'); // 編集フォーム
    html = await (await admin.get(`/admin/shops/${shop.id}/customers?f=rank&v=`)).text();
    expect(html).toContain("plain@example.com");

    // CSV（同じ絞り込み、独自項目と外部の ID の列）
    const csv = await admin.get(`/admin/shops/${shop.id}/customers.csv?f=rank&v=gold`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("id,email,name,phone,postal_code,state,city,line1,line2,created_at,last_login_at,marketing_consent,marketing_consent_at,marketing_consent_source,external_provider,external_id,rank,score"); // 先頭の BOM は text() が落とす
    expect(text).toContain(`${m1},gold@example.com,金,090,,東京都,,,,`);
    expect(text).toContain(",hubspot,7,gold,");
    expect(text).not.toContain("plain@example.com");
  });
});
