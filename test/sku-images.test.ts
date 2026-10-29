import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts, tinyPng } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { imageOptionsFromForm, orderImagesForSku, skuOptionChoices } from "../src/products/images";

/**
 * SKU ごとの画像（0063）の Worker 側。列の形・対応表のトリガー・権限は test/db/sku-images.test.ts（実 PostgreSQL）。
 */
const IMG = { all: "00000000-0000-4000-8000-000000000001", blue: "00000000-0000-4000-8000-000000000002", red: "00000000-0000-4000-8000-000000000003", red_l: "00000000-0000-4000-8000-000000000004" };

function setup(opts: { appliedMigrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.appliedMigrations ? { appliedMigrations: opts.appliedMigrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { product_feed: true } } });
  const tee = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "Tシャツ", published: true });
  const redM = sb.addSku(shop.id, tee.id, { code: "TEE-RED-M", price_jpy: 3000, available: 3, options: { color: "レッド", size: "M" } });
  const redL = sb.addSku(shop.id, tee.id, { code: "TEE-RED-L", price_jpy: 3000, available: 3, options: { color: "レッド", size: "L" } });
  const blueM = sb.addSku(shop.id, tee.id, { code: "TEE-BLUE-M", price_jpy: 3000, available: 3, options: { color: "ブルー", size: "M" } });
  const img = (id: string, key: string, sort: number, options?: Record<string, string>) =>
    sb.tables.product_images.push({ id, shop_id: shop.id, product_id: tee.id, storage_key: key, thumb_key: null, width: null, height: null, sort_order: sort, created_at: "", ...(options ? { options } : {}) });
  img(IMG.all, "shops/s/all.webp", 0);
  img(IMG.blue, "shops/s/blue.webp", 1, { color: "ブルー" });
  img(IMG.red, "shops/s/red.webp", 2, { color: "レッド" });
  img(IMG.red_l, "shops/s/red-l.webp", 3, { color: "レッド", size: "L" });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, tee, redM, redL, blueM, app, storage, issue };
}

const keys = (imgs: { storage_key: string }[]) => imgs.map((i) => i.storage_key.replace("shops/s/", ""));

describe("SKU ごとの画像: 判定（src/products/images.ts）", () => {
  const images = [
    { storage_key: "shops/s/all.webp", options: {} },
    { storage_key: "shops/s/blue.webp", options: { color: "ブルー" } },
    { storage_key: "shops/s/red.webp", options: { color: "レッド" } },
    { storage_key: "shops/s/red-l.webp", options: { color: "レッド", size: "L" } },
  ];

  it("その SKU に結んだ画像（細かいもの先）→ 商品全体 → ほかの SKU の画像。SKU が無ければ元の並び", () => {
    expect(keys(orderImagesForSku(images, { color: "レッド", size: "L" }))).toEqual(["red-l.webp", "red.webp", "all.webp", "blue.webp"]);
    expect(keys(orderImagesForSku(images, { color: "レッド", size: "M" }))).toEqual(["red.webp", "all.webp", "blue.webp", "red-l.webp"]);
    expect(keys(orderImagesForSku(images, { color: "ブルー", size: "M" }))).toEqual(["blue.webp", "all.webp", "red.webp", "red-l.webp"]);
    expect(keys(orderImagesForSku(images, null))).toEqual(["all.webp", "blue.webp", "red.webp", "red-l.webp"]);
    // 壊れた options は商品全体として扱う
    expect(keys(orderImagesForSku([{ storage_key: "x", options: [1] }, ...images.slice(1, 2)], { color: "ブルー" }))).toEqual(["blue.webp", "x"]);
  });

  it("管理画面の入力: SKU にある項目だけ、空は外す。選べる値は出てくる順", () => {
    expect(imageOptionsFromForm({ "options.color": "レッド", "options.size": "", "options.evil": "x" }, ["color", "size"])).toEqual({ color: "レッド" });
    expect(skuOptionChoices([{ options: { color: "レッド", size: "M" } }, { options: { color: "ブルー", size: "M" } }, { options: null }])).toEqual([
      { key: "color", values: ["レッド", "ブルー"] },
      { key: "size", values: ["M"] },
    ]);
  });
});

describe("SKU ごとの画像: お店の画面", () => {
  const mainSrc = (html: string) => /<img src="([^"]+)"[^>]*data-main=""/.exec(html)?.[1];

  it("?sku=<品番> でその SKU の画像を先頭に描き、選択肢もその SKU にする。並べ替えのスクリプトを付ける", async () => {
    const { app } = setup();
    const b = new Browser(app);
    let html = await (await b.get("/my-shop/p/tee")).text();
    expect(mainSrc(html)).toBe(`${BASE}/media/shops/s/all.webp`);
    expect(html).toContain("data-sku-images");
    expect(html).toContain('data-image-options="{&quot;color&quot;:&quot;レッド&quot;}"');
    expect(html).toContain('data-code="TEE-RED-L"');
    expect(html).toContain('getElementById("sku_id")');

    html = await (await b.get("/my-shop/p/tee?sku=TEE-RED-L")).text();
    expect(mainSrc(html)).toBe(`${BASE}/media/shops/s/red-l.webp`);
    expect(html).toMatch(/<option value="[^"]+" selected="" data-options="[^"]*" data-code="TEE-RED-L">/);
    const thumbs = [...html.matchAll(/<a href="[^"]+\/media\/shops\/s\/([a-z-]+\.webp)"/g)].map((m) => m[1]);
    expect(thumbs).toEqual(["red-l.webp", "red.webp", "all.webp", "blue.webp"]);

    // 知らない品番は元の並び
    html = await (await b.get("/my-shop/p/tee?sku=NOPE")).text();
    expect(mainSrc(html)).toBe(`${BASE}/media/shops/s/all.webp`);
  });

  it("SKU に結んだ画像の無い商品には、データ属性もスクリプトも付けない", async () => {
    const { sb, app } = setup();
    for (const i of sb.tables.product_images) delete i["options"];
    const html = await (await new Browser(app).get("/my-shop/p/tee?sku=TEE-RED-L")).text();
    expect(html).not.toContain("data-sku-images");
    expect(html).not.toContain("data-image-options");
    expect(html).not.toContain(".gallery[data-sku-images]");
    expect(mainSrc(html)).toBe(`${BASE}/media/shops/s/all.webp`);
  });

  it("公開 API の image_variants に options を出す（ヘッドレスでも同じ並べ替えができる）", async () => {
    const { app } = setup();
    const res = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { image_variants: { options: Record<string, string> }[] } };
    expect(res.product.image_variants.map((v) => v.options)).toEqual([{}, { color: "ブルー" }, { color: "レッド" }, { color: "レッド", size: "L" }]);
  });

  it("商品フィード: SKU ごとの image_link と、?sku= 付きの link", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/modules/product-feed/generate`, {});
    const xml = await (await new Browser(app).get("/my-shop/feed/products.xml")).text();
    const item = (code: string) => xml.split("<item>").find((x) => x.includes(`<g:id>${code}</g:id>`))!;
    expect(item("TEE-RED-L")).toContain(`<g:image_link>${BASE}/media/shops/s/red-l.webp</g:image_link>`);
    expect(item("TEE-RED-L")).toContain(`<g:link>${BASE}/my-shop/p/tee?sku=TEE-RED-L</g:link>`);
    expect(item("TEE-RED-M")).toContain(`<g:image_link>${BASE}/media/shops/s/red.webp</g:image_link>`);
    expect(item("TEE-BLUE-M")).toContain(`<g:image_link>${BASE}/media/shops/s/blue.webp</g:image_link>`);
  });
});

describe("SKU ごとの画像: 管理画面・AI 用 API・復元", () => {
  it("画像ごとに SKU の項目を選んで保存する。SKU に無い項目は保存しない", async () => {
    const { sb, shop, tee, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/products/${tee.id}`)).text();
    expect(html).toContain(`action="/admin/shops/${shop.id}/products/${tee.id}/images/${IMG.all}/options"`);
    expect(html).toContain('name="options.color"');
    expect(html).toContain('name="options.size"');
    expect(html).toMatch(/<option value="レッド" selected="">レッド<\/option>/);

    const res = await admin.post(`/admin/shops/${shop.id}/products/${tee.id}/images/${IMG.all}/options`, { "options.color": "ブルー", "options.size": "M", "options.evil": "x" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/${tee.id}?flash=saved#images`);
    expect(sb.tables.product_images.find((i) => i["id"] === IMG.all)!["options"]).toEqual({ color: "ブルー", size: "M" });
    await admin.post(`/admin/shops/${shop.id}/products/${tee.id}/images/${IMG.all}/options`, { "options.color": "", "options.size": "" });
    expect(sb.tables.product_images.find((i) => i["id"] === IMG.all)!["options"]).toEqual({});
  });

  it("REST の PATCH /images/:id と MCP の product_image_set_options", async () => {
    const { sb, app, issue } = setup();
    const tok = await issue(["products:read", "products:write"]);
    const patch = (body: unknown) => app.request(`${BASE}/api/v1/images/${IMG.all}`, { method: "PATCH", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await patch({ options: { color: "レッド", size: "M" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { images: { id: string; options: unknown }[] }).images.find((i) => i.id === IMG.all)!.options).toEqual({ color: "レッド", size: "M" });
    expect((await patch({ options: [] })).status).toBe(400);
    expect((await patch({ options: { color: 1 } })).status).toBe(400);
    const readOnly = await issue(["products:read"]);
    expect((await app.request(`${BASE}/api/v1/images/${IMG.all}`, { method: "PATCH", headers: { authorization: `Bearer ${readOnly}`, "content-type": "application/json" }, body: JSON.stringify({ options: {} }) })).status).toBe(401);

    const mcp = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "product_image_set_options", arguments: { image_id: IMG.all, options: {} } } }),
    });
    expect(((await mcp.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    expect(sb.tables.product_images.find((i) => i["id"] === IMG.all)!["options"]).toEqual({});
  });

  it("バックアップの書き出しと復元で、画像の options が戻る", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const exported = await (await admin.get(`/admin/shops/${shop.id}/export.json`)).text();
    const dst = sb.addShop(sb.tables.shops[0]!["owner_id"] as string, { slug: "dst", name: "Dst", published: false, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const res = await admin.postMultipart(`/admin/shops/${dst.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("product_image_options: 3");
    const restored = sb.tables.product_images.filter((i) => i["shop_id"] === dst.id);
    expect(restored.find((i) => i["storage_key"] === "shops/s/red-l.webp")!["options"]).toEqual({ color: "レッド", size: "L" });
  });
});

describe("SKU ごとの画像: 登録と同時に結ぶ（AI 用 API）", () => {
  afterEach(() => externalHosts.clear());
  const newest = (sb: FakeSupabase) => sb.tables.product_images[sb.tables.product_images.length - 1]!;

  it("URL から: POST /products/{id}/images の options。MCP の product_image_add も同じ。形の違う options は 400 で画像を置かない", async () => {
    const { sb, tee, app, storage, issue } = setup();
    const tok = await issue(["products:read", "products:write"]);
    externalHosts.set("https://images.example/", () => new Response(tinyPng(), { headers: { "content-type": "image/png" } }));
    const post = (body: unknown) => app.request(`${BASE}/api/v1/products/${tee.id}/images`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await post({ image_url: "https://images.example/red.png", options: { color: "レッド" } });
    expect(res.status).toBe(201);
    expect(newest(sb)["options"]).toEqual({ color: "レッド" });
    // 省略は商品全体
    await post({ image_url: "https://images.example/all.png" });
    expect(newest(sb)["options"]).toEqual({});
    const before = storage.objects.size;
    res = await post({ image_url: "https://images.example/x.png", options: "red" });
    expect(res.status).toBe(400);
    res = await post({ image_url: "https://images.example/x.png", options: { color: 1 } });
    expect(res.status).toBe(400);
    expect(storage.objects.size).toBe(before);

    const mcp = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "product_image_add", arguments: { product_id: tee.id, image_url: "https://images.example/blue.png", options: { color: "ブルー", size: "M" } } } }),
    });
    expect(((await mcp.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    expect(newest(sb)["options"]).toEqual({ color: "ブルー", size: "M" });
  });

  it("ファイルで: multipart の options の欄、本文が画像そのものなら ?options=", async () => {
    const { sb, tee, app, issue } = setup();
    const tok = await issue(["products:write"]);
    const upload = (qs: string, body: Uint8Array<ArrayBuffer>, contentType: string) =>
      app.request(`${BASE}/api/v1/products/${tee.id}/images/upload${qs}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": contentType, "content-length": String(body.byteLength) }, body });
    const png = tinyPng(16, 16);
    let res = await upload(`?options=${encodeURIComponent(JSON.stringify({ color: "レッド", size: "L" }))}`, png, "image/png");
    expect(res.status).toBe(201);
    let id = ((await res.json()) as { image_id: string }).image_id;
    expect(sb.tables.product_images.find((i) => i["id"] === id)!["options"]).toEqual({ color: "レッド", size: "L" });

    const form = new FormData();
    form.append("image", new Blob([png]), "a.png");
    form.append("options", JSON.stringify({ color: "ブルー" }));
    const req = new Request("http://x", { method: "POST", body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    res = await upload("", body, req.headers.get("content-type")!);
    expect(res.status).toBe(201);
    id = ((await res.json()) as { image_id: string }).image_id;
    expect(sb.tables.product_images.find((i) => i["id"] === id)!["options"]).toEqual({ color: "ブルー" });

    expect((await upload("?options=not-json", png, "image/png")).status).toBe(400);
  });
});
