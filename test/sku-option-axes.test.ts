import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { OPTION_AXES_SCRIPT, codeFromPattern, combinations, displayOptionAxes, inferOptionAxes, optionAxesFromForm, resolveOptionAxes } from "../src/products/option-axes";
import { CHIPS_SCRIPT } from "../src/routes/admin/option-axes";
import { SKU_IMAGE_SCRIPT } from "../src/products/images";
import type { CategoryRow } from "../src/db/types";

/**
 * SKU を分ける軸（0065）の Worker 側。ひな形を写す・SKU の守り・一括で当てる・取り込み・復元の本物は test/db/sku-option-axes.test.ts（実 PostgreSQL）。
 */
const COLOR_SIZE = [{ key: "カラー", values: ["レッド", "ブルー"] }, { key: "サイズ", values: ["S", "M"] }];

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const wear = sb.addCategory(shop.id, { slug: "wear", name: "ウェア", option_axes: COLOR_SIZE });
  const tops = sb.addCategory(shop.id, { slug: "tops", name: "トップス", parent_id: wear.id });
  const app = appWith(sb);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, wear, tops, app, issue };
}

describe("SKU を分ける軸: 判定（src/products/option-axes.ts）", () => {
  const cats = [
    { id: "c1", name: "ウェア", parent_id: null, option_axes: COLOR_SIZE },
    { id: "c2", name: "トップス", parent_id: "c1", option_axes: null },
    { id: "c3", name: "雑貨", parent_id: null, option_axes: [] },
  ] as unknown as CategoryRow[];

  it("上の段: 子は親を引き継ぎ、カテゴリーが無ければショップ。出どころも返す", () => {
    expect(resolveOptionAxes(cats, "c2", null)).toEqual({ axes: COLOR_SIZE, from: { kind: "category", name: "ウェア" } });
    expect(resolveOptionAxes(cats, "c3", null)).toEqual({ axes: [], from: { kind: "category", name: "雑貨" } });
    expect(resolveOptionAxes(cats, null, [{ key: "サイズ" }])).toEqual({ axes: [{ key: "サイズ" }], from: { kind: "shop" } });
    expect(resolveOptionAxes(cats, null, null)).toEqual({ axes: null, from: null });
  });

  it("今の SKU から推す: どの SKU も同じ項目のときだけ。お店の画面の軸は、決めていなければ推したもの", () => {
    const skus = [{ options: { カラー: "レッド", サイズ: "S" } }, { options: { サイズ: "M", カラー: "ブルー" } }];
    expect(inferOptionAxes(skus)).toEqual([{ key: "カラー", values: ["レッド", "ブルー"] }, { key: "サイズ", values: ["S", "M"] }]);
    expect(inferOptionAxes([{ options: { 色: "白" } }, { options: { サイズ: "M" } }])).toBeNull();
    expect(inferOptionAxes([{ options: {} }, { options: {} }])).toEqual([]);
    expect(displayOptionAxes(null, skus).map((a) => a.key)).toEqual(["カラー", "サイズ"]);
    expect(displayOptionAxes([], skus)).toEqual([]);
    expect(displayOptionAxes(null, skus.slice(0, 1))).toEqual([]);
  });

  it("画面に埋め込むスクリプトは JavaScript として読める（テンプレート文字列の \\n が改行に化けていない）", () => {
    for (const src of [CHIPS_SCRIPT, OPTION_AXES_SCRIPT, SKU_IMAGE_SCRIPT]) expect(() => new Function(src)).not.toThrow();
  });

  it("入力欄 → 軸、組み合わせ、品番のひな形", () => {
    expect(optionAxesFromForm({ axes_mode: "axes", "axis.0.key": "カラー", "axis.0.values": "レッド\nブルー\r\nレッド\n ", "axis.1.key": "", "axis.2.key": "サイズ" })).toEqual([{ key: "カラー", values: ["レッド", "ブルー"] }, { key: "サイズ" }]);
    // 区切りは改行だけ。カンマや読点を含む値はそのまま 1 つ
    expect(optionAxesFromForm({ axes_mode: "axes", "axis.0.key": "長さ", "axis.0.values": "1,000mm\n赤、白のボーダー" })).toEqual([{ key: "長さ", values: ["1,000mm", "赤、白のボーダー"] }]);
    expect(optionAxesFromForm({ axes_mode: "axes", "axis.0.key": "a", "axis.1.key": "a" })).toBe("invalid");
    expect(optionAxesFromForm({ axes_mode: "only_code" })).toEqual([]);
    expect(optionAxesFromForm({ axes_mode: "inherit", "axis.0.key": "x" })).toBeNull();
    expect(combinations(COLOR_SIZE, { カラー: ["レッド", "ブルー"], サイズ: ["S"] })).toEqual([{ カラー: "レッド", サイズ: "S" }, { カラー: "ブルー", サイズ: "S" }]);
    expect(combinations(COLOR_SIZE, { カラー: ["レッド"], サイズ: [] })).toEqual([]);
    expect(combinations([{ key: "a" }, { key: "b" }], { a: Array.from({ length: 11 }, (_, i) => String(i)), b: Array.from({ length: 10 }, (_, i) => String(i)) })).toBeNull();
    expect(codeFromPattern("TEE-{カラー}-{サイズ}-{無い}", { カラー: "レッド", サイズ: "M" })).toBe("TEE-レッド-M-{無い}");
  });
});

describe("SKU を分ける軸: 管理画面", () => {
  it("カテゴリーのひな形が商品に写り、SKU は軸ごとの欄で足す。合わない・重なる SKU は断る", async () => {
    const { sb, shop, tops, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let res = await admin.post(`/admin/shops/${shop.id}/products/new`, { name: "パーカー", slug: "hoodie", category_id: tops.id });
    const loc = res.headers.get("location")!;
    const productId = /products\/([^?]+)/.exec(loc)![1]!;
    expect(sb.tables.products.find((p) => p["id"] === productId)!["option_axes"]).toEqual(COLOR_SIZE);
    const html = await (await admin.get(`/admin/shops/${shop.id}/products/${productId}`)).text();
    expect(html).toContain("カラー × サイズ");
    expect(html).toContain("カテゴリー「ウェア」のひな形");
    expect(html).toContain('name="opt.0"');
    expect(html).toContain('<datalist id="axis_0"><option value="レッド"></option><option value="ブルー"></option></datalist>');
    expect(html).toContain("組み合わせをまとめて作る");

    const base = `/admin/shops/${shop.id}/products/${productId}`;
    res = await admin.post(`${base}/skus`, { code: "H-R-S", price_jpy: "3000", available: "2", options_mode: "axes", "opt.0": "レッド", "opt.1": "S" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect(sb.tables.skus.find((k) => k["code"] === "H-R-S")!["options"]).toEqual({ カラー: "レッド", サイズ: "S" });
    res = await admin.post(`${base}/skus`, { code: "H-R-S2", price_jpy: "3000", options_mode: "axes", "opt.0": "レッド", "opt.1": "S" });
    expect(res.headers.get("location")).toBe(`${base}?flash=axes_duplicate#skus`);
    expect(await (await admin.get(`${base}?flash=axes_duplicate`)).text()).toContain("同じ組み合わせの SKU がすでにあります");
    res = await admin.post(`${base}/skus`, { code: "H-R", price_jpy: "3000", options_mode: "axes", "opt.0": "レッド" });
    expect(res.headers.get("location")).toBe(`${base}?flash=axes_mismatch#skus`);
  });

  it("組み合わせをまとめて作る: チェックとほかの値の組み合わせ。すでにある組み合わせは飛ばし、品番はひな形から", async () => {
    const { sb, shop, tops, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", category_id: tops.id, option_axes: COLOR_SIZE });
    sb.addSku(shop.id, p.id, { code: "TEE-レッド-S", price_jpy: 1000, options: { カラー: "レッド", サイズ: "S" } });
    const body = new URLSearchParams([["mx.0", "レッド"], ["mx.0", "ブルー"], ["mx_other.0", "グリーン"], ["mx.1", "S"], ["mx_other.1", ""], ["code_pattern", "TEE-{カラー}-{サイズ}"], ["price_jpy", "2500"], ["available", "4"]]);
    const res = await admin.postRaw(`/admin/shops/${shop.id}/products/${p.id}/sku-matrix`, body.toString(), "application/x-www-form-urlencoded");
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/${p.id}?flash=matrix&n=2&skip=1#skus`);
    const codes = sb.tables.skus.filter((k) => k["product_id"] === p.id).map((k) => k["code"]).sort();
    expect(codes).toEqual(["TEE-グリーン-S", "TEE-ブルー-S", "TEE-レッド-S"]);
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sb.tables.skus.find((k) => k["code"] === "TEE-ブルー-S")!["id"])!["available"]).toBe(4);
    expect(await (await admin.get(`/admin/shops/${shop.id}/products/${p.id}?flash=matrix&n=2&skip=1`)).text()).toContain("2 個の SKU を作りました");
  });

  it("軸を決めていない商品の SKU の選択肢は 1 行に 1 つ。値にカンマを入れられる", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const p = sb.addProduct(shop.id, { slug: "free", name: "自由", option_axes: null });
    const base = `/admin/shops/${shop.id}/products/${p.id}`;
    await admin.post(`${base}/skus`, { code: "F-1", price_jpy: "1000", options: "長さ=1,000mm\r\n色=赤、白", available: "0" });
    expect(sb.tables.skus.find((k) => k["code"] === "F-1")!["options"]).toEqual({ 長さ: "1,000mm", 色: "赤、白" });
    const html = await (await admin.get(base)).text();
    expect(html).toContain('name="options" rows="3"');
    expect(html).toContain(">長さ=1,000mm\n色=赤、白</textarea>");
  });

  it("商品で決める・上の段に戻す・今の SKU から推す。SKU が合わない軸は保存しない", async () => {
    const { sb, shop, tops, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const p = sb.addProduct(shop.id, { slug: "free", name: "自由", category_id: tops.id, option_axes: null });
    sb.addSku(shop.id, p.id, { code: "F-1", price_jpy: 1000, options: { 長さ: "1m" } });
    sb.addSku(shop.id, p.id, { code: "F-2", price_jpy: 1000, options: { 長さ: "3m" } });
    const base = `/admin/shops/${shop.id}/products/${p.id}`;
    let res = await admin.post(`${base}/option-axes`, { axes_mode: "axes", "axis.0.key": "型番" });
    expect(res.headers.get("location")).toBe(`${base}?flash=axes_mismatch#option-axes`);
    res = await admin.post(`${base}/option-axes/infer`, {});
    expect(res.headers.get("location")).toBe(`${base}?flash=axes_saved#option-axes`);
    expect(sb.tables.products.find((x) => x["id"] === p.id)).toMatchObject({ option_axes: [{ key: "長さ", values: ["1m", "3m"] }], option_axes_custom: true });
    // 上の段（カラー × サイズ）には SKU が合わないので戻せない
    res = await admin.post(`${base}/option-axes/reset`, {});
    expect(res.headers.get("location")).toBe(`${base}?flash=axes_mismatch#option-axes`);
    res = await admin.post(`${base}/option-axes`, { axes_mode: "none" });
    expect(sb.tables.products.find((x) => x["id"] === p.id)).toMatchObject({ option_axes: null, option_axes_custom: false });
  });

  it("カテゴリーの画面: ショップの既定・カテゴリーの軸を保存し、一括で当てる（合わない商品は名前を出す）", async () => {
    const { sb, shop, wear, tops, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}/categories`)).text();
    expect(html).toContain("SKU を分ける軸");
    expect(html).toContain(`action="/admin/shops/${shop.id}/option-axes/shop"`);
    // 値の候補はチップの入力（正体は 1 行に 1 つの textarea）
    expect(html).toContain('<textarea name="axis.0.values" rows="3" aria-label="ウェア 値の候補');
    expect(html).toMatch(/data-chips="" [^>]*>レッド\nブルー<\/textarea>/);
    expect(html).toContain('querySelectorAll("textarea[data-chips]")');
    let res = await admin.post(`/admin/shops/${shop.id}/option-axes/shop`, { axes_mode: "only_code" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/categories?flash=axes_saved#option-axes`);
    expect(sb.tables.shops[0]!["option_axes"]).toEqual([]);
    res = await admin.post(`/admin/shops/${shop.id}/option-axes/categories/${tops.id}`, { axes_mode: "axes", "axis.0.key": "カラー", "axis.1.key": "サイズ", "axis.2.key": "丈" });
    expect(sb.tables.categories.find((x) => x["id"] === tops.id)!["option_axes"]).toEqual([{ key: "カラー" }, { key: "サイズ" }, { key: "丈" }]);

    const empty = sb.addProduct(shop.id, { slug: "empty", name: "空", category_id: tops.id, option_axes: COLOR_SIZE });
    const old = sb.addProduct(shop.id, { slug: "old", name: "古い", category_id: tops.id, option_axes: COLOR_SIZE });
    sb.addSku(shop.id, old.id, { code: "O-1", price_jpy: 1000, options: { カラー: "白", サイズ: "M" } });
    res = await admin.post(`/admin/shops/${shop.id}/option-axes/apply`, { category_id: wear.id });
    const loc = res.headers.get("location")!;
    expect(loc).toContain("applied=1");
    expect(decodeURIComponent(loc)).toContain("skipped=old");
    expect(sb.tables.products.find((x) => x["id"] === empty.id)!["option_axes"]).toEqual([{ key: "カラー" }, { key: "サイズ" }, { key: "丈" }]);
    html = await (await admin.get(loc.replace(/#.*$/, ""))).text();
    expect(html).toContain("SKU が合わず当てられなかった商品: old");
  });
});

describe("SKU を分ける軸: お店の画面と API", () => {
  it("お店の画面: 軸ごとの選択欄のスクリプトと軸を載せる。品番だけの商品には付けない", async () => {
    const { sb, shop, app } = setup();
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, option_axes: COLOR_SIZE });
    sb.addSku(shop.id, p.id, { code: "R-S", price_jpy: 1000, available: 1, options: { カラー: "レッド", サイズ: "S" } });
    sb.addSku(shop.id, p.id, { code: "B-S", price_jpy: 1000, available: 0, options: { カラー: "ブルー", サイズ: "S" } });
    const b = new Browser(app);
    let html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain('data-axes="[{&quot;key&quot;:&quot;カラー&quot;},{&quot;key&quot;:&quot;サイズ&quot;}]"');
    expect(html).toContain('data-options="{&quot;カラー&quot;:&quot;レッド&quot;,&quot;サイズ&quot;:&quot;S&quot;}"');
    expect(html).toContain("data-axes-price");
    expect(html).toContain('closest("[data-axes]")');
    const mug = sb.addProduct(shop.id, { slug: "mug", name: "マグ", published: true, option_axes: [] });
    sb.addSku(shop.id, mug.id, { code: "M-1", price_jpy: 1000, available: 1 });
    sb.addSku(shop.id, mug.id, { code: "M-2", price_jpy: 1000, available: 1 });
    html = await (await b.get("/my-shop/p/mug")).text();
    expect(html).not.toContain("data-axes");
    // 公開 API は軸と SKU に出てくる値を返す
    const r = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { option_axes: unknown } };
    expect(r.product.option_axes).toEqual([{ key: "カラー", values: ["レッド", "ブルー"] }, { key: "サイズ", values: ["S"] }]);
  });

  it("AI 用 API: PUT /products/{id}/option-axes と MCP。SKU が合わない軸は 400、重なる SKU の作成は 409", async () => {
    const { sb, shop, app, issue } = setup();
    const tok = await issue(["products:read", "products:write"]);
    const p = sb.addProduct(shop.id, { slug: "cable", name: "ケーブル", option_axes: null });
    sb.addSku(shop.id, p.id, { code: "C-1", price_jpy: 1000, options: { 型番: "A", 長さ: "1m" } });
    const put = (body: unknown) => app.request(`${BASE}/api/v1/products/${p.id}/option-axes`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ option_axes: [{ key: "型番" }] })).status).toBe(400);
    expect((await put({ option_axes: "x" })).status).toBe(400);
    const res = await put({ option_axes: [{ key: "型番" }, { key: "長さ", values: ["1m", "3m"] }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { option_axes: unknown }).option_axes).toEqual([{ key: "型番" }, { key: "長さ", values: ["1m", "3m"] }]);
    const dup = await app.request(`${BASE}/api/v1/products/${p.id}/skus`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ code: "C-2", price_jpy: 1000, options: { 型番: "A", 長さ: "1m" } }) });
    expect(dup.status).toBe(409);
    const mcp = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "product_set_option_axes", arguments: { product_id: p.id, option_axes: null } } }),
    });
    expect(((await mcp.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    expect(sb.tables.products.find((x) => x["id"] === p.id)).toMatchObject({ option_axes: null, option_axes_custom: false });
  });

  it("ヘッドレス・AI 用 API は配列とオブジェクトでやり取りする（区切りの文字を読まない）。カンマ・読点を含む値もそのまま", async () => {
    const { sb, shop, app, issue } = setup();
    const tok = await issue(["products:read", "products:write"]);
    const p = sb.addProduct(shop.id, { slug: "cable", name: "ケーブル", published: true, option_axes: null });
    const call = (method: string, path: string, body: unknown) => app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await call("PUT", `/products/${p.id}/option-axes`, { option_axes: [{ key: "長さ", values: ["1,000mm", "2,000mm"] }, { key: "柄", values: ["赤、白のボーダー"] }] });
    expect(res.status).toBe(200);
    res = await call("POST", `/products/${p.id}/skus`, { code: "C-1", price_jpy: 1000, available: 1, options: { 長さ: "1,000mm", 柄: "赤、白のボーダー" } });
    expect(res.status).toBe(201);
    await call("POST", `/products/${p.id}/skus`, { code: "C-2", price_jpy: 1200, available: 1, options: { 長さ: "2,000mm", 柄: "赤、白のボーダー" } });
    const detail = (await (await app.request(`${BASE}/api/shops/my-shop/products/cable`)).json()) as { product: { option_axes: unknown; skus: { options: unknown }[] } };
    expect(detail.product.option_axes).toEqual([{ key: "長さ", values: ["1,000mm", "2,000mm"] }, { key: "柄", values: ["赤、白のボーダー"] }]);
    expect(detail.product.skus[0]!.options).toEqual({ 長さ: "1,000mm", 柄: "赤、白のボーダー" });
    // お店の画面の軸ごとの選択欄にも、値はそのまま載る
    const html = await (await new Browser(app).get("/my-shop/p/cable")).text();
    expect(html).toContain("1,000mm");
    expect(html).toContain('data-options="{&quot;長さ&quot;:&quot;1,000mm&quot;,&quot;柄&quot;:&quot;赤、白のボーダー&quot;}"');
  });

  it("バックアップの書き出しと復元で、ショップ・カテゴリー・商品の軸が戻る", async () => {
    const { sb, shop, tops, app } = setup();
    sb.tables.shops[0]!["option_axes"] = [];
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", category_id: tops.id, option_axes: [{ key: "サイズ" }], option_axes_custom: true });
    sb.addSku(shop.id, p.id, { code: "T-M", price_jpy: 1000, options: { サイズ: "M" } });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const exported = await (await admin.get(`/admin/shops/${shop.id}/export.json`)).text();
    const dst = sb.addShop(sb.tables.shops[0]!["owner_id"] as string, { slug: "dst", name: "Dst", published: false, legal_notice: "a", privacy_policy: "b", return_policy: "c", option_axes: [{ key: "色" }] });
    const res = await admin.postMultipart(`/admin/shops/${dst.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("option_axes_products: 1");
    expect(sb.tables.shops.find((x) => x["id"] === dst.id)!["option_axes"]).toEqual([]);
    expect(sb.tables.categories.find((x) => x["shop_id"] === dst.id && x["slug"] === "wear")!["option_axes"]).toEqual(COLOR_SIZE);
    expect(sb.tables.products.find((x) => x["shop_id"] === dst.id && x["slug"] === "tee")).toMatchObject({ option_axes: [{ key: "サイズ" }], option_axes_custom: true });
  });
});
