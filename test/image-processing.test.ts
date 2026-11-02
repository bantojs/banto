import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { imageProcessing, thumbScript, variantKey } from "../src/media/variants";
import { parseManifest } from "../src/hooks/manifest";

/** 商品画像の変換を外部プラグインに任せる（0092、docs/images.md「外部の変換プラグインに任せる」） */

/** 幅・高さだけを持つ WebP（VP8X の見出し） */
function webp(w: number, h: number): Uint8Array<ArrayBuffer> {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1)));
}
/** 見出しだけの JPEG（SOF に寸法）。後ろを詰めて大きさを作る */
function jpeg(w: number, h: number, pad = 0): Uint8Array<ArrayBuffer> {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03];
  const out = new Uint8Array(head.length + 20 + pad);
  out.set(head);
  return out;
}

async function setup(opts: { settings?: Record<string, unknown>; applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: opts.settings ?? {} });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, product, storage, app, issue };
}

const multipart = async (parts: Record<string, Uint8Array<ArrayBuffer>>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) form.append(k, new Blob([v]), k);
  const req = new Request("http://x", { method: "POST", body: form });
  const body = new Uint8Array(await req.arrayBuffer());
  return { body, headers: { "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) } };
};

describe("設定とマニフェスト", () => {
  it("任せるかはショップの設定（既定はブラウザ）。マニフェストの capabilities は知っている値だけ", () => {
    expect(imageProcessing({})).toBe("browser");
    expect(imageProcessing({ images: { processing: "plugin" } })).toBe("plugin");
    expect(imageProcessing({ images: { processing: "x" } })).toBe("browser");
    expect(parseManifest({ name: "webp", events: [], capabilities: ["images", "evil", "images"] })?.capabilities).toEqual(["images"]);
    expect(parseManifest({ name: "x", events: [] })?.capabilities).toBeUndefined();
    expect(() => new Function(`${thumbScript()}; return bantoThumb;`)).not.toThrow();
  });
});

describe("AI 用 API（プラグインが使う口）", () => {
  it("GET /image-settings はショップの設定（products:read）", async () => {
    const { app, issue } = await setup({ settings: { images: { max_width: 2560, processing: "plugin" } } });
    const tok = await issue(["products:read"]);
    const res = await app.request(`${BASE}/api/v1/image-settings`, { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ max_width: 2560, max_height: 4096, thumb_width: 400, variant_widths: [800, 1600, 2048, 2560], processing: "plugin" });
  });

  it("差し替えで本画像・サムネイル・中間の段を置き、行に横幅を残す。もう一度差し替えると前の段も消える", async () => {
    const { app, issue, sb, product, storage, shop } = await setup();
    const tok = await issue(["products:write"]);
    const id = crypto.randomUUID();
    const oldKey = `shops/${shop.id}/products/${product.id}/${"a".repeat(24)}.jpg`;
    sb.tables.product_images.push({ id, shop_id: shop.id, product_id: product.id, storage_key: oldKey, thumb_key: null, width: 4000, height: 3000, sort_order: 0, options: {}, variants: [], thumb_width: null });
    await storage.put(oldKey, jpeg(4000, 3000).buffer, "image/jpeg");
    const put = async (parts: Record<string, Uint8Array<ArrayBuffer>>) => {
      const m = await multipart(parts);
      const res = await app.request(`${BASE}/api/v1/images/${id}/file`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, ...m.headers }, body: m.body });
      return res.status;
    };
    expect(await put({ image: webp(2048, 1536), thumbnail: webp(400, 300), variant_800: webp(800, 600), variant_1600: webp(1600, 1200) })).toBe(200);
    const row = sb.tables.product_images.find((i) => i["id"] === id)!;
    expect(row).toMatchObject({ width: 2048, height: 1536, variants: [800, 1600], thumb_width: 400 });
    const key = String(row["storage_key"]);
    expect(storage.objects.has(oldKey)).toBe(false);
    for (const s of [800, 1600]) expect(storage.objects.has(variantKey(key, s))).toBe(true);
    expect(storage.objects.size).toBe(4);
    // 本画像より広い段・形の違う段は断る（何も置かない）
    expect(await put({ image: webp(1600, 1200), variant_2048: webp(2048, 1536) })).toBe(400);
    expect(await put({ image: webp(1600, 1200), variant_800: webp(900, 600) })).toBe(400);
    expect(storage.objects.size).toBe(4);
    // 段なしで差し替え: 前の段のファイルも消え、行の段も空
    expect(await put({ image: webp(1600, 1200), thumbnail: webp(400, 300) })).toBe(200);
    for (const s of [800, 1600]) expect(storage.objects.has(variantKey(key, s))).toBe(false);
    expect(row).toMatchObject({ variants: [], thumb_width: 400 });
    expect(storage.objects.size).toBe(2);
  });

  it("0092 の前は段を受けない（409）。段なしの差し替えは今までどおり", async () => {
    const { app, issue, sb, product, shop } = await setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0092_image_processing") });
    const tok = await issue(["products:write", "products:read"]);
    const id = crypto.randomUUID();
    sb.tables.product_images.push({ id, shop_id: shop.id, product_id: product.id, storage_key: `shops/${shop.id}/products/${product.id}/${"b".repeat(24)}.jpg`, thumb_key: null, width: 10, height: 10, sort_order: 0, options: {} });
    let m = await multipart({ image: webp(1600, 1200), variant_800: webp(800, 600) });
    expect((await app.request(`${BASE}/api/v1/images/${id}/file`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, ...m.headers }, body: m.body })).status).toBe(409);
    m = await multipart({ image: webp(1600, 1200) });
    expect((await app.request(`${BASE}/api/v1/images/${id}/file`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, ...m.headers }, body: m.body })).status).toBe(200);
    expect((await app.request(`${BASE}/api/v1/image-settings`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(409);
  });
});

describe("管理画面", () => {
  it("ショップの設定で任せるを選ぶ。画像を変換できるプラグインがつながっていなければ知らせる", async () => {
    const { app, sb, shop } = await setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain('name="image_processing"');
    const action = /<form method="post" action="([^"]+)"[^>]*>(?:(?!<\/form>)[\s\S])*name="image_processing"/.exec(html)![1]!;
    const form = { mode: "flat", flat_fee_jpy: "0", free_over_jpy: "", tax_rate: "10", tax_rate_reduced: "8", tax_rounding: "floor", contact_email: "", image_max: "2048", image_processing: "plugin" };
    await b.post(action, form);
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["images"]).toEqual({ max_width: 2048, processing: "plugin" });
    html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("画像を変換できるプラグインがつながっていません");
    sb.tables.hook_endpoints.push({ id: "ep-webp", shop_id: shop.id, name: "WebP", url: "https://webp.example/hook", events: ["product.updated"], enabled: true, settings: {}, manifest: { name: "webp", events: ["product.updated"], settings: [], capabilities: ["images"] }, created_at: "" });
    html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).not.toContain("画像を変換できるプラグインがつながっていません");
  });

  it("任せるショップは元の写真を 20MB まで受け、ブラウザはサムネイルだけ作る", async () => {
    const { app, sb, shop, product, storage } = await setup({ settings: { images: { processing: "plugin" } } });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products/${product.id}`;
    expect(await (await b.get(base)).text()).toContain('data-processing="plugin"');
    const big = jpeg(4032, 3024, 8 * 1024 * 1024);
    const res = await b.postMultipart(`${base}/images`, { file: new File([big], "IMG_0001.jpg", { type: "image/jpeg" }), thumb: new File([webp(400, 300)], "thumb.webp", { type: "image/webp" }), width: "4032", height: "3024" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const row = sb.tables.product_images[0]!;
    expect(String(row["storage_key"])).toMatch(/\.jpg$/);
    expect(row).toMatchObject({ width: 4032, height: 3024, thumb_width: 400, variants: [] });
    expect(storage.objects.size).toBe(2);
    // ブラウザで変換するショップは今までどおり 5MB まで
    const { app: app2, shop: shop2, product: p2 } = await setup();
    const b2 = await Browser.loggedIn(app2, "owner@example.com", "password-123");
    const r2 = await b2.postMultipart(`/admin/shops/${shop2.id}/products/${p2.id}/images`, { file: new File([big], "IMG_0001.jpg", { type: "image/jpeg" }) });
    expect(r2.headers.get("location")).toContain("flash=image_size");
  });

  it("0092 の前は任せるの欄を出さず、元の写真も 5MB まで", async () => {
    const { app, shop, product } = await setup({ settings: { images: { processing: "plugin" } }, applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0092_image_processing") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(`/admin/shops/${shop.id}`)).text()).not.toContain('name="image_processing"');
    expect(await (await b.get(`/admin/shops/${shop.id}/products/${product.id}`)).text()).toContain('data-processing="browser"');
  });
});
