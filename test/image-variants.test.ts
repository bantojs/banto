import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { imageKeys, imageLadder, imageMaxLongSide, keyForWidth, readVariantFiles, resizeScript, variantKey, variantSizesFor } from "../src/media/variants";
import { responsiveImage } from "../src/media/images";

/** 商品画像の大きさの段（0091、docs/images.md）。縮小はブラウザ、サーバーは段を確かめて置くだけ */

/** 幅・高さだけを持つ WebP（VP8X の見出し） */
function webp(w: number, h: number, pad = 0): Uint8Array<ArrayBuffer> {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  const head = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1));
  return new Uint8Array([...head, ...new Array(pad).fill(0)]);
}

describe("段の決め方（src/media/variants.ts）", () => {
  it("本画像の長辺はショップの設定から（壊れていれば 1600）。中間は 400 と本画像のあいだ", () => {
    expect(imageMaxLongSide({})).toBe(1600);
    expect(imageMaxLongSide({ images: { max_long_side: 2560 } })).toBe(2560);
    expect(imageMaxLongSide({ images: { max_long_side: 999 } })).toBe(1600);
    expect(imageMaxLongSide({ images: { max_long_side: "3200" } })).toBe(3200);
    expect(variantSizesFor(1600)).toEqual([800]);
    expect(variantSizesFor(3200)).toEqual([800, 1600, 2048, 2560]);
    expect(variantSizesFor(700)).toEqual([]);
    expect(variantKey("shops/s/products/p/abc.png", 800)).toBe("shops/s/products/p/abc.800.webp");
    expect(imageKeys({ storage_key: "k/a.webp", thumb_key: "k/a.thumb.webp", variants: [800] })).toEqual(["k/a.webp", "k/a.thumb.webp", "k/a.800.webp"]);
  });

  it("持っている段の幅は本画像の縦横の比から（縦長も）。求める幅以上でいちばん小さい段を選ぶ", () => {
    const land = { storage_key: "a.webp", thumb_key: "a.thumb.webp", width: 2560, height: 1280, variants: [800, 1600, 2048] };
    expect(imageLadder(land).map((x) => [x.key, x.width])).toEqual([["a.thumb.webp", 400], ["a.800.webp", 800], ["a.1600.webp", 1600], ["a.2048.webp", 2048], ["a.webp", 2560]]);
    const tall = { storage_key: "b.webp", thumb_key: "b.thumb.webp", width: 1200, height: 1600, variants: [800] };
    expect(imageLadder(tall).map((x) => x.width)).toEqual([300, 600, 1200]);
    expect(keyForWidth(land, 600)).toBe("a.800.webp");
    expect(keyForWidth(land, 5000)).toBe("a.webp");
    expect(keyForWidth(tall, 250)).toBe("b.thumb.webp");
    // 寸法の無い前からある画像: 400 以下ならサムネイル、ほかは本画像（前と同じ）
    expect(keyForWidth({ storage_key: "c.png", thumb_key: "c.thumb.webp" }, 300)).toBe("c.thumb.webp");
    expect(keyForWidth({ storage_key: "c.png", thumb_key: "c.thumb.webp" }, 600)).toBe("c.png");
  });

  it("srcset は持っている段すべて。前からある画像（中間なし）はサムネイルと本画像", () => {
    const r = responsiveImage("https://m.example", { storage_key: "a.webp", thumb_key: "a.thumb.webp", width: 1600, height: 1600, variants: [800] });
    expect(r.srcset).toBe("https://m.example/a.thumb.webp 400w, https://m.example/a.800.webp 800w, https://m.example/a.webp 1600w");
    expect(r.src).toBe("https://m.example/a.thumb.webp");
    expect(responsiveImage("https://m.example", { storage_key: "b.webp", thumb_key: "b.thumb.webp", width: 1600, height: 1200 }).srcset).toBe("https://m.example/b.thumb.webp 400w, https://m.example/b.webp 1600w");
  });

  it("アップロードの中間の段は WebP・決まった長辺・本画像より小さい・長辺がその値を超えないものだけ", async () => {
    const blob = (b: Uint8Array<ArrayBuffer>) => new Blob([b]);
    expect(await readVariantFiles({ variant_800: blob(webp(800, 600)) }, 1600)).toEqual([{ size: 800, bytes: webp(800, 600) }]);
    expect(await readVariantFiles({}, 1600)).toEqual([]);
    expect(await readVariantFiles({ variant_1600: blob(webp(1600, 1200)) }, 1600)).toBeNull(); // 本画像と同じ
    expect(await readVariantFiles({ variant_900: blob(webp(900, 600)) }, 1600)).toBeNull(); // 決まった長辺ではない
    expect(await readVariantFiles({ variant_800: blob(webp(1200, 600)) }, 1600)).toBeNull(); // 中身が大きい
    expect(await readVariantFiles({ variant_800: blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) }, 1600)).toBeNull(); // WebP でない
    expect(await readVariantFiles({ variant_800: "text" }, 1600)).toBeNull();
  });

  it("ブラウザの縮小の関数は構文として読める", () => {
    expect(() => new Function(`${resizeScript()}; return bantoResize;`)).not.toThrow();
  });
});

describe("管理画面のアップロードとショップの設定", () => {
  async function setup(settings: Record<string, unknown> = {}, opts: { applied?: string[] } = {}) {
    const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", settings });
    const product = sb.addProduct(shop.id, { slug: "tee", name: "T" });
    const storage = new MemoryStorage(`${BASE}/media`);
    const app = appWith(sb, {}, storage);
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    return { sb, shop, product, storage, b, base: `/admin/shops/${shop.id}/products/${product.id}` };
  }
  const file = (b: Uint8Array<ArrayBuffer>, name: string) => new File([b], name, { type: "image/webp" });

  it("本画像・サムネイル・中間の段を置き、行に作った長辺を残す。消すと全部消える", async () => {
    const { sb, storage, b, base } = await setup({ images: { max_long_side: 2560 } });
    const page = await (await b.get(base)).text();
    expect(page).toContain('data-max="2560"');
    expect(page).toContain('data-variants="1"');
    const res = await b.postMultipart(`${base}/images`, { file: file(webp(2560, 1920), "a.webp"), thumb: file(webp(400, 300), "thumb.webp"), variant_800: file(webp(800, 600), "v.webp"), variant_1600: file(webp(1600, 1200), "v.webp"), variant_2048: file(webp(2048, 1536), "v.webp"), width: "2560", height: "1920" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const row = sb.tables.product_images[0]!;
    expect(row["variants"]).toEqual([800, 1600, 2048]);
    const key = String(row["storage_key"]);
    for (const s of [800, 1600, 2048]) expect(storage.objects.has(variantKey(key, s))).toBe(true);
    expect(storage.objects.size).toBe(5);
    await b.post(`${base}/images/${String(row["id"])}/delete`, {});
    expect(storage.objects.size).toBe(0);
  });

  it("形の違う中間の段は断る（何も置かない）。0091 の前は中間の段を受け取らない", async () => {
    let { sb, storage, b, base } = await setup();
    const res = await b.postMultipart(`${base}/images`, { file: file(webp(1600, 1200), "a.webp"), variant_1600: file(webp(1600, 1200), "v.webp") });
    expect(res.headers.get("location")).toContain("flash=image_type");
    expect(storage.objects.size).toBe(0);
    ({ sb, storage, b, base } = await setup({}, { applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0091_image_variants") }));
    expect(await (await b.get(base)).text()).toContain('data-variants="0"');
    await b.postMultipart(`${base}/images`, { file: file(webp(1600, 1200), "a.webp"), variant_800: file(webp(800, 600), "v.webp") });
    expect(sb.tables.product_images[0]!["variants"]).toBeUndefined();
    expect(storage.objects.size).toBe(1);
  });

  it("ショップの設定で大きさを選ぶ（決まった値だけ）", async () => {
    const { sb, shop, b } = await setup();
    const html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain('name="image_max"');
    const form = { mode: "flat", flat_fee_jpy: "0", free_over_jpy: "", tax_rate: "10", tax_rate_reduced: "8", tax_rounding: "floor", contact_email: "" };
    const action = /<form method="post" action="([^"]+)"[^>]*>(?:(?!<\/form>)[\s\S])*name="image_max"/.exec(html)?.[1];
    expect(action).toBeTruthy();
    await b.post(action!, { ...form, image_max: "3200" });
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["images"]).toEqual({ max_long_side: 3200 });
    await b.post(action!, { ...form, image_max: "9999" });
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["images"]).toEqual({ max_long_side: 1600 });
  });
});
