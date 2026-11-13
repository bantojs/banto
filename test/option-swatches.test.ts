import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { colorFromForm, optionSwatchesOf } from "../src/products/option-swatches";

/** 選択肢の値ごとの見本（0115、src/products/option-swatches.ts、docs/storefront.md「選択肢の見本」） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(() => forgetThemes());

function webp(w: number, h: number): Uint8Array<ArrayBuffer> {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1)));
}

function setup(opts: { liquid?: Record<string, string>; applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } }, option_names: { size: "サイズ", color: "カラー" } });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["option_swatches"] = { color: { ネイビー: { color: "#1f2a44" }, チェック: { image: { key: `swatches/${shop.id}/0123456789abcdef.webp`, width: 96, height: 96 } } } };
  // SKU の選択肢は size → color の順だが、軸は color → size
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, option_axes: [{ key: "color" }, { key: "size" }] });
  const skus = [
    sb.addSku(shop.id, p.id, { code: "TEE-NV-S", options: { size: "S", color: "ネイビー" }, price_jpy: 3000, available: 2 }),
    sb.addSku(shop.id, p.id, { code: "TEE-NV-M", options: { size: "M", color: "ネイビー" }, price_jpy: 3000, available: 2 }),
    sb.addSku(shop.id, p.id, { code: "TEE-CK-S", options: { size: "S", color: "チェック" }, price_jpy: 3000, available: 0 }),
    sb.addSku(shop.id, p.id, { code: "TEE-WH-M", options: { size: "M", color: "ホワイト" }, price_jpy: 3000, available: 1 }),
  ];
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  return { sb, shop, row, p, skus, storage, app };
}

describe("表を読む", () => {
  it("形の違う見本は無いことにする。色は #rrggbb に", () => {
    expect(optionSwatchesOf({ color: { a: { color: "#ABCDEF" }, b: { color: "#abcdef" }, c: { image: { key: "x" } } }, "Bad": { a: { color: "#000000" } } })).toEqual({ color: { b: { color: "#abcdef" } } });
    expect(colorFromForm("#ABC")).toBe("#aabbcc");
    expect(colorFromForm("#1F2A44")).toBe("#1f2a44");
    expect(colorFromForm("red")).toBeNull();
  });
});

describe("お店の画面", () => {
  it("既定のテーマ: 選択欄のスクリプトに軸の順で見本を渡す", async () => {
    const { app } = setup();
    const html = await (await new Browser(app, BASE).get("/my-shop/products/tee")).text();
    const m = /data-axes="([^"]+)"/.exec(html);
    const axes = JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { key: string; name: string; swatches?: Record<string, { color: string | null; image: { src: string } | null }> }[];
    expect(axes.map((a) => a.key)).toEqual(["color", "size"]);
    expect(axes[0]!.swatches!["ネイビー"]).toEqual({ color: "#1f2a44", image: null });
    expect(axes[0]!.swatches!["チェック"]!.image!.src).toContain("/media/swatches/");
    expect(axes[1]!.swatches).toBeUndefined();
    expect(html).toContain(".swatch__dot");
  });

  it("本文の商品のブロック（show=options）: 見本・文字・在庫の無い値の印。押すとその SKU を選んだ商品ページ", async () => {
    const { app, sb, shop } = setup();
    sb.addPage(shop.id, { handle: "lp", title: "LP", body: "::: product slug=tee show=name,options" });
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/lp")).text();
    expect(html).toContain('<span class="banto-product__option-name">カラー</span>');
    expect(html).toContain('<a class="banto-swatch" href="/my-shop/products/tee?sku=TEE-NV-S" title="ネイビー" aria-label="ネイビー"><span class="banto-swatch__dot" style="background:#1f2a44"></span></a>');
    expect(html).toMatch(/<a class="banto-swatch banto-swatch--out" href="\/my-shop\/products\/tee\?sku=TEE-CK-S"[^>]*><span class="banto-swatch__dot"><img src="[^"]+0123456789abcdef\.webp"/);
    expect(html).toContain('<span class="banto-swatch__text">ホワイト</span>');
    expect(html).toContain('<span class="banto-swatch__text">S</span>');
  });

  it("公開 API: 軸ごとの swatches（見本のある値だけ）", async () => {
    const { app } = setup();
    const j = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { option_axes: { key: string; values: string[]; swatches: Record<string, unknown> }[] } };
    expect(j.product.option_axes[0]!.values).toEqual(["ネイビー", "チェック", "ホワイト"]);
    expect(j.product.option_axes[0]!.swatches["ネイビー"]).toEqual({ color: "#1f2a44", image: null });
    expect(Object.keys(j.product.option_axes[0]!.swatches)).toEqual(["ネイビー", "チェック"]);
    expect(j.product.option_axes[1]!.swatches).toEqual({});
  });

  it("Liquid: 値は名前の文字に見え、swatch・selected・available・variant を持つ。選択肢は軸の順", async () => {
    const tpl =
      "{% for o in product.options_with_values %}[{{ o.name }}:{% for v in o.values %}{{ v }}" +
      "{% if v.swatch.color %}={{ v.swatch.color }}{% endif %}{% if v.swatch.image %}=img{% endif %}" +
      "{% if v.selected %}*{% endif %}{% unless v.available %}!{% endunless %}{% if v == o.selected_value %}={% endif %}" +
      "({{ v.variant.sku }}){% if product.variants.first.options contains v %}c{% endif %};{% endfor %}]{% endfor %}|{{ product.options_with_values.first.values | json }}";
    const { app } = setup({
      liquid: {
        "layout/theme.liquid": "{{ content_for_layout }}",
        "templates/index.liquid": "x",
        "templates/product.liquid": tpl,
      },
    });
    const html = await (await new Browser(app, DOMAIN).get("/products/tee?sku=TEE-NV-M")).text();
    expect(html).toContain("[カラー:ネイビー=#1f2a44*=(TEE-NV-M)c;チェック=img!(TEE-CK-S);ホワイト(TEE-WH-M);]");
    expect(html).toContain("[サイズ:S(TEE-NV-S)c;M*=(TEE-NV-M);]");
    expect(html).toContain('|["ネイビー","チェック","ホワイト"]');
  });
});

describe("管理画面", () => {
  it("色と画像を保存し、置き換えた画像は消す", async () => {
    const { app, row, storage, shop } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get(`/admin/shops/${shop.id}/categories`)).text();
    expect(page).toContain(`action="/admin/shops/${shop.id}/option-swatches/color"`);
    expect(page).toContain('value="ホワイト"');
    const old = `swatches/${shop.id}/0123456789abcdef.webp`;
    await storage.put(old, new Uint8Array([1]).buffer as ArrayBuffer, "image/webp");
    // 値の並びは SKU に出てくる順（ネイビー・チェック・ホワイト）
    expect(page).not.toContain("kind_0");
    // 選択欄は無い。スクリプト無しのフォームのまま: 色を変えた値は色、画像を選んだ値は画像（色も変えていても画像）、触らない値はそのまま
    const form = { v_0: "ネイビー", color_prev_0: "#888888", v_1: "チェック", color_prev_1: "#888888", v_2: "ホワイト", color_prev_2: "#888888" };
    let res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, {
      ...form,
      color_0: "#112233",
      color_1: "#445566", image_1: new File([webp(96, 96)], "c.webp", { type: "image/webp" }),
      color_2: "#888888",
    });
    expect(res.headers.get("location")).toContain("flash=swatch_saved");
    const table = () => (row["option_swatches"] as Record<string, Record<string, { color?: string; image?: { key: string } }>>)["color"]!;
    expect(table()["ネイビー"]).toEqual({ color: "#112233" });
    expect(table()["チェック"]!.image!.key).toMatch(new RegExp(`^swatches/${shop.id}/[a-f0-9]+\\.webp$`));
    expect(table()["ホワイト"]).toBeUndefined();
    expect(storage.objects.has(old)).toBe(false);
    // 置いてある灰色そのものを選んだ（スクリプトが印を付けた）ときも色として残す
    res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, { v_0: "ホワイト", color_prev_0: "#888888", color_0: "#888888", color_set_0: "1" });
    expect(res.headers.get("location")).toContain("flash=swatch_saved");
    expect(table()["ホワイト"]).toEqual({ color: "#888888" });
    expect(table()["ネイビー"]).toEqual({ color: "#112233" }); // フォームに無い値は今のまま
    // 何も変えずに保存したら「保存しました」と言わない
    res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, { v_0: "ネイビー", color_prev_0: "#112233", color_0: "#112233" });
    expect(res.headers.get("location")).toContain("flash=swatch_unchanged");
    // 色の値が壊れていれば保存しない
    res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, { v_0: "ネイビー", color_prev_0: "#112233", color_0: "navy" });
    expect(res.headers.get("location")).toContain("flash=swatch_unchanged");
    // 「外す」で文字に戻す。画像の見本を外すと画像も置き場から消える
    const imgKey = table()["チェック"]!.image!.key;
    res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, { v_0: "チェック", color_prev_0: "#888888", color_0: "#888888", clear_0: "1" });
    expect(res.headers.get("location")).toContain("flash=swatch_saved");
    expect(table()["チェック"]).toBeUndefined();
    expect(storage.objects.has(imgKey)).toBe(false);
    res = await b.postMultipart(`/admin/shops/${shop.id}/option-swatches/color`, { v_0: "ネイビー", clear_0: "1", v_1: "ホワイト", clear_1: "1" });
    expect(res.headers.get("location")).toContain("flash=swatch_cleared");
  });
});
