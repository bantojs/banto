import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { selectedRowValue, sizeChartOf, tsvToRows } from "../src/size-charts/chart";
import { productFromDetail } from "../src/themes/liquid/objects";

/** 採寸表（同梱モジュール size_charts、0095。docs/size-charts.md）。近い段から決める規則の本物は test/db/size-charts.test.ts */

/** 幅・高さだけを持つ WebP（VP8X の見出し） */
function webp(w: number, h: number): Uint8Array<ArrayBuffer> {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1)));
}

async function setup(opts: { on?: boolean; applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { size_charts: opts.on ?? true } }, option_names: { size: "サイズ" } });
  const tops = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tops", name: "トップス" });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true, category_id: tops.id });
  sb.addSku(shop.id, product.id, { code: "TEE-S", options: { size: "S" }, available: 3 });
  sb.addSku(shop.id, product.id, { code: "TEE-M", options: { size: "M" }, available: 3 });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  return { sb, shop, tops, product, storage, app };
}

const columnsForm = { own_columns: "on", col_label_0: "着丈", col_unit_0: "cm", col_label_1: "身幅", col_unit_1: "cm", axis: "size", note: "平置きで測っています" };

describe("読み取りと貼り付け", () => {
  it("壊れた値は捨てる。列が無ければ表なし。選んだ SKU の行は軸の値で決まる", () => {
    expect(sizeChartOf(null)).toBeNull();
    expect(sizeChartOf({ columns: [] })).toBeNull();
    const chart = sizeChartOf({ axis: "size", axis_name: "サイズ", columns: [{ key: "c1", label: "着丈", unit: "cm" }, { key: "BAD", label: "x" }], rows: [{ value: "M", cells: { c1: "70", c2: 1 } }, { cells: {} }], sources: { columns: "category", rows: "product" } })!;
    expect(chart.columns).toEqual([{ key: "c1", label: "着丈", unit: "cm" }]);
    expect(chart.rows).toEqual([{ value: "M", cells: { c1: "70" } }]);
    expect(selectedRowValue(chart, { size: "m" })).toBe("M");
    expect(selectedRowValue(chart, { color: "M" })).toBeNull();
  });

  it("表計算の貼り付け: タブ区切り、見出しの行は飛ばす。カンマ区切りも読む", () => {
    const cols = [{ key: "c1", label: "着丈", unit: "cm" }, { key: "c2", label: "身幅", unit: "cm" }];
    expect(tsvToRows(cols, "サイズ\t着丈\t身幅\nS\t66\t48\r\nM\t70\n\n")).toEqual([{ value: "S", cells: { c1: "66", c2: "48" } }, { value: "M", cells: { c1: "70" } }]);
    expect(tsvToRows(cols, "L,74,56")).toEqual([{ value: "L", cells: { c1: "74", c2: "56" } }]);
  });
});

describe("Liquid", () => {
  it("product.size_chart: セルは列の並びの配列と key ごと、選んだ SKU の行に selected、図は URL", () => {
    const product = { id: "p1", shop_id: "s", slug: "tee", name: "T", description: null, tags: [], published: true, created_at: "", updated_at: "", size_chart: { axis: "size", axis_name: "サイズ", columns: [{ key: "c1", label: "着丈", unit: "cm" }, { key: "c2", label: "身幅", unit: null }], rows: [{ value: "S", cells: { c2: "48" } }, { value: "M", cells: { c1: "70", c2: "52" } }], note: "平置き", image: { key: "size-charts/s/a.webp", width: 8, height: 6 } } };
    const skus = [{ id: "k1", code: "TEE-M", options: { size: "M" }, price_jpy: 1, available: 1 }];
    const o = productFromDetail({ shopPath: "/my-shop", mediaBaseUrl: "/media" }, { product, images: [], skus } as never, "TEE-M");
    expect(o.size_chart).toEqual({
      axis: "size",
      axis_name: "サイズ",
      columns: [{ key: "c1", label: "着丈", unit: "cm", heading: "着丈（cm）" }, { key: "c2", label: "身幅", unit: "", heading: "身幅" }],
      rows: [{ value: "S", cells: ["", "48"], cells_by_key: { c2: "48" }, selected: false }, { value: "M", cells: ["70", "52"], cells_by_key: { c1: "70", c2: "52" }, selected: true }],
      note: "平置き",
      image: { src: "/media/size-charts/s/a.webp", url: "/media/size-charts/s/a.webp", width: 8, height: 6, alt: "" },
    });
    expect(productFromDetail({ shopPath: "", mediaBaseUrl: "/media" }, { product: { ...product, size_chart: null }, images: [], skus: [] } as never).size_chart).toBeNull();
  });
});

describe("管理画面とお店の画面", () => {
  it("カテゴリーで列と図、商品で行。お店の画面は近い段の表を出し、選んだ SKU の行を目立たせる", async () => {
    const { app, shop, tops, product, storage, sb } = await setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const catBase = `/admin/shops/${shop.id}/modules/size-charts/categories/${tops.id}`;
    // 商品とカテゴリーの画面から開ける
    expect(await (await b.get(`/admin/shops/${shop.id}/products/${product.id}`)).text()).toContain(`/modules/size-charts/products/${product.id}`);
    expect(await (await b.get(`/admin/shops/${shop.id}/categories`)).text()).toContain(catBase);
    let res = await b.postMultipart(catBase, { ...columnsForm, image: new File([webp(1600, 1200)], "how.webp", { type: "image/webp" }) });
    expect(res.headers.get("location")).toContain("flash=saved");
    const cat = sb.tables.size_charts.find((r) => r["category_id"] === tops.id)!;
    expect(cat).toMatchObject({ axis: "size", columns: [{ key: "c1", label: "着丈", unit: "cm" }, { key: "c2", label: "身幅", unit: "cm" }], image_width: 1600, image_height: 1200 });
    const firstImage = String(cat["image_key"]);
    expect(firstImage).toMatch(new RegExp(`^size-charts/${shop.id}/`));
    expect(storage.objects.has(firstImage)).toBe(true);

    // 商品の段: 上の段の列で行の欄が出る。貼り付けで行を入れる
    const prodBase = `/admin/shops/${shop.id}/modules/size-charts/products/${product.id}`;
    const page = await (await b.get(prodBase)).text();
    expect(page).toContain('name="cell_0_c1"');
    expect(page).toContain("上の段の列: 着丈・身幅");
    // 「この段で列（行）を決める」を付けずに入力して消える、を防ぐ: 欄に入力するとチェックが付く（autocheck）
    expect(page).toContain('data-autocheck="own_columns"');
    expect(page).toContain('data-autocheck="own_rows"');
    res = await b.post(prodBase, { own_rows: "on", rows_tsv: "サイズ\t着丈\t身幅\nS\t66\t48\nM\t70\t52" });
    expect(res.headers.get("location")).toContain("flash=saved");

    const html = await (await app.request(`${BASE}/my-shop/p/tee?sku=TEE-M`)).text();
    expect(html).toContain('class="size-chart"');
    expect(html).toContain("着丈（cm）");
    expect(html).toContain('data-axis="size"');
    expect(html).toMatch(/<tr data-value="M" class="selected"/);
    expect(html).toContain("平置きで測っています");
    expect(html).toContain(firstImage);

    // 図を差し替えると前の図は置き場から消える
    await b.postMultipart(catBase, { ...columnsForm, image: new File([webp(800, 600)], "how2.webp", { type: "image/webp" }) });
    expect(storage.objects.has(firstImage)).toBe(false);

    // 商品の段で隠す
    await b.post(prodBase, { hidden: "on" });
    expect(await (await app.request(`${BASE}/my-shop/p/tee`)).text()).not.toContain('class="size-chart"');
  });

  it("チェックを付けずに入力しても消えない（スクリプトが動かない・古い画面）。この段のものを持っていてチェックを外せば上の段に戻る。上の段の行は薄い字で見せる", async () => {
    const { app, shop, tops, product, sb } = await setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const catBase = `/admin/shops/${shop.id}/modules/size-charts/categories/${tops.id}`;
    const prodBase = `/admin/shops/${shop.id}/modules/size-charts/products/${product.id}`;
    // 列だけ（own_columns なし）
    await b.post(catBase, { col_label_0: "着丈", col_unit_0: "cm" });
    await b.post(catBase, { own_columns: "on", col_key_0: "c1", col_label_0: "着丈", col_unit_0: "cm", row_value_0: "F", cell_0_c1: "60" });
    expect(sb.tables.size_charts.find((r) => r["category_id"] === tops.id)).toMatchObject({ columns: [{ key: "c1", label: "着丈" }], rows: [{ value: "F", cells: { c1: "60" } }] });
    // 商品の画面: カテゴリーの行が薄い字。own_rows なしで入れても商品の値になる
    const page = await (await b.get(prodBase)).text();
    expect(page).toMatch(/name="row_value_0" value="" placeholder="F"/);
    expect(page).toMatch(/name="cell_0_c1" value="" placeholder="60"/);
    await b.post(prodBase, { row_value_0: "M", cell_0_c1: "70" });
    expect(await (await app.request(`${BASE}/my-shop/p/tee`)).text()).toContain(">70<");
    // 持っている行のチェックを外すと、カテゴリーの行に戻る
    await b.post(prodBase, { row_value_0: "M", cell_0_c1: "70" });
    expect(sb.tables.size_charts.some((r) => r["product_id"] === product.id && r["rows"] === null) || !sb.tables.size_charts.some((r) => r["product_id"] === product.id)).toBe(true);
    expect(await (await app.request(`${BASE}/my-shop/p/tee`)).text()).toContain(">60<");
  });

  it("公開 API・Liquid 用: 商品に size_chart（図は URL）。モジュールが OFF なら出さず、管理画面も開けない", async () => {
    const { app, shop, tops, sb } = await setup();
    sb.tables.size_charts.push({ id: "x", shop_id: shop.id, category_id: tops.id, product_id: null, hidden: false, axis: "size", columns: [{ key: "c1", label: "着丈", unit: "cm" }], rows: [{ value: "M", cells: { c1: "70" } }], note: null, image_key: `size-charts/${shop.id}/a.webp`, image_width: 10, image_height: 10 });
    const get = async () => ((await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: Record<string, unknown> }).product["size_chart"];
    expect(await get()).toEqual({ axis: "size", axis_name: "サイズ", columns: [{ key: "c1", label: "着丈", unit: "cm" }], rows: [{ value: "M", cells: { c1: "70" } }], note: null, image: { url: `${BASE}/media/size-charts/${shop.id}/a.webp`, width: 10, height: 10 } });
    (shop["settings"] as Record<string, unknown>)["modules"] = { size_charts: false };
    expect(await get()).toBeNull();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await b.get(`/admin/shops/${shop.id}/modules/size-charts`)).status).toBe(404);
  });
});

describe("AI 用 API", () => {
  it("GET は products:read、PUT は products:write。図は API では変わらない", async () => {
    const { app, sb, shop, product, tops } = await setup();
    const issue = async (scopes: string[]) => {
      const raw = generateApiToken();
      sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: sb.tables.shops[0]!["owner_id"], name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
      return raw;
    };
    const rw = await issue(["products:read", "products:write"]);
    const ro = await issue(["products:read"]);
    const put = (tok: string, q: string, body: unknown) => app.request(`${BASE}/api/v1/size-chart${q}`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put(ro, `?category_id=${tops.id}`, { columns: [{ label: "着丈" }] })).status).toBe(401);
    expect((await put(rw, `?category_id=${tops.id}`, { columns: [{ label: "着丈", unit: "cm" }], image: { key: "evil", width: 1, height: 1 } })).status).toBe(200);
    expect(sb.tables.size_charts[0]).toMatchObject({ image_key: null, columns: [{ key: "c1", label: "着丈", unit: "cm" }] });
    expect((await put(rw, `?product_id=${product.id}`, { rows: [{ value: "M", cells: { c1: "70" } }] })).status).toBe(200);
    const res = await app.request(`${BASE}/api/v1/size-chart?product_id=${product.id}`, { headers: { authorization: `Bearer ${ro}` } });
    expect(res.status).toBe(200);
    const got = (await res.json()) as { effective: { rows: unknown; sources: unknown } };
    expect(got.effective).toMatchObject({ rows: [{ value: "M", cells: { c1: "70" } }], sources: { columns: "category", rows: "product" } });
    expect((await put(rw, `?product_id=${product.id}&category_id=${tops.id}`, {})).status).toBe(400);
    expect((await put(rw, `?product_id=nope`, {})).status).toBe(404);
  });
});
