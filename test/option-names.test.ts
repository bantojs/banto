import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { namedOptionEntries, optionKeyFor, optionLabel, optionNamesOf } from "../src/products/option-names";
import { axesLabel, codeFromPattern } from "../src/products/option-axes";
import { buildFeed } from "../src/modules/product-feed/feed";
import { productFromDetail } from "../src/themes/liquid/objects";
import type { ProductDetail } from "../src/storefront/data";

/** SKU の選択肢の key と表示名（0094）。DB が名前を key に直すところは test/db/option-keys.test.ts */
describe("表示名の読み替え（src/products/option-names.ts）", () => {
  const names = optionNamesOf({ size: "サイズ", color: "カラー", bad: 1 });
  it("表の値だけを読み、知らない key は key のまま出す。名前か key から key を引く（大文字小文字を区別しない）", () => {
    expect(names).toEqual({ size: "サイズ", color: "カラー" });
    expect(optionNamesOf(null)).toEqual({});
    expect(optionLabel(names, "size")).toBe("サイズ");
    expect(optionLabel(names, "カラー")).toBe("カラー");
    expect(optionKeyFor(names, "サイズ")).toBe("size");
    expect(optionKeyFor(names, "color")).toBe("color");
    expect(optionKeyFor(optionNamesOf({ size: "Size" }), "SIZE")).toBe("size");
    expect(optionKeyFor(names, "素材")).toBeNull();
    expect(namedOptionEntries({ size: "M", opt1: "A" }, names)).toEqual([["サイズ", "M"], ["opt1", "A"]]);
  });

  it("軸の短い表示と品番のひな形は表示名でも key でも書ける", () => {
    expect(axesLabel([{ key: "color" }, { key: "size" }], "品番だけ", "決めていない", names)).toBe("カラー × サイズ");
    expect(codeFromPattern("TEE-{カラー}-{size}", { color: "RED", size: "M" }, names)).toBe("TEE-RED-M");
  });

  it("Liquid の product.options は表示名、variant の値は位置で揃う", () => {
    const d = { product: { id: "p", slug: "tee", name: "T", description: null, tags: [], brand: null }, images: [], skus: [{ id: "s1", code: "A", name: null, price_jpy: 1000, available: 1, options: { color: "レッド", size: "M" } }] } as unknown as ProductDetail;
    const o = productFromDetail({ shopPath: "", mediaBaseUrl: "https://m.example", optionNames: names }, d);
    expect(o.options).toEqual(["カラー", "サイズ"]);
    expect(o.options_with_values.map((x) => [x.name, x.values.map(String)])).toEqual([["カラー", ["レッド"]], ["サイズ", ["M"]]]);
  });

  it("商品フィードは key が size / color の値を g:size / g:color に載せる", () => {
    const cat = { products: [{ id: "p1", slug: "tee", name: "T", description: null, brand: null, published: true, category_id: null }], skus: [{ id: "s1", product_id: "p1", code: "A", name: null, price_jpy: 1000, compare_at_price_jpy: null, gtin: null, options: { size: "M", color: "レッド", opt1: "x" } }], images: [{ product_id: "p1", storage_key: "a.png", sort_order: 0 }], inventory: [{ sku_id: "s1", shop_id: "x", available: 1 }], categories: [] };
    const r = buildFeed(cat as unknown as Parameters<typeof buildFeed>[0], { shopName: "S", home: "https://b.example/s", mediaBaseUrl: "https://m.example" });
    expect(r.items[0]).toMatchObject({ size: "M", color: "レッド" });
  });
});

describe("画面と API は表示名を出す", () => {
  function setup() {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.tables.shops.find((s) => s["id"] === shop.id)!["option_names"] = { color: "カラー", size: "サイズ" };
    const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true, option_axes: [{ key: "color" }, { key: "size" }] });
    sb.addSku(shop.id, p.id, { code: "R-S", price_jpy: 1000, available: 1, options: { color: "レッド", size: "S" } });
    sb.addSku(shop.id, p.id, { code: "B-S", price_jpy: 1000, available: 1, options: { color: "ブルー", size: "S" } });
    return { sb, shop, p, app: appWith(sb) };
  }

  it("お店の画面の軸の見出し・公開 API の軸と名前の表", async () => {
    const { app } = setup();
    const html = await (await new Browser(app).get("/my-shop/products/tee")).text();
    expect(html).toContain('data-axes="[{&quot;key&quot;:&quot;color&quot;,&quot;name&quot;:&quot;カラー&quot;},{&quot;key&quot;:&quot;size&quot;,&quot;name&quot;:&quot;サイズ&quot;}]"');
    const api = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { option_axes: unknown; option_names: unknown } };
    expect(api.product.option_axes).toEqual([{ key: "color", name: "カラー", values: ["レッド", "ブルー"], swatches: {} }, { key: "size", name: "サイズ", values: ["S"], swatches: {} }]);
    expect(api.product.option_names).toEqual({ color: "カラー", size: "サイズ" });
  });

  it("管理画面: 商品の画面は表示名、カテゴリーの画面で表示名を変える（key は変わらない）", async () => {
    const { sb, shop, p, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get(`/admin/shops/${shop.id}/products/${p.id}`)).text();
    expect(page).toContain("カラー × サイズ");
    expect(page).toContain("カラー=レッド");
    const cats = await (await b.get(`/admin/shops/${shop.id}/categories`)).text();
    expect(cats).toContain('name="name.size"');
    const res = await b.post(`/admin/shops/${shop.id}/option-names`, { "name.size": "Size", "name.color": "カラー" });
    expect(res.headers.get("location")).toContain("flash=names_saved");
    expect(sb.tables.shops.find((s) => s["id"] === shop.id)!["option_names"]).toEqual({ color: "カラー", size: "Size" });
    expect((await b.post(`/admin/shops/${shop.id}/option-names`, { "name.size": "カラー" })).headers.get("location")).toContain("flash=names_invalid");
    expect(sb.tables.skus.find((k) => k["code"] === "R-S")!["options"]).toEqual({ color: "レッド", size: "S" });
  });
});
