import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, memoryAdapters } from "./helpers";
import { buildFeed, feedXml, type FeedCatalog } from "../src/modules/product-feed/feed";
import { registerJobs } from "../src/jobs";
import { jsonLdText, productJsonLd } from "../src/storefront/structured-data";
import type { ProductRow, SkuRow } from "../src/db/types";

const now = "2026-10-16T00:00:00Z";
const product = (o: Partial<ProductRow>): ProductRow => ({ id: "p1", shop_id: "s", slug: "tee", name: "Tシャツ", description: "綿 100%", tags: [], published: true, created_at: now, updated_at: now, ...o });
const sku = (o: Partial<SkuRow>): SkuRow => ({ id: "k1", shop_id: "s", product_id: "p1", code: "TEE-M", name: null, price_jpy: 3000, created_at: now, ...o });
const target = { shopName: "S & Co", home: "https://shop.example.jp", mediaBaseUrl: "https://media.example.jp" };

describe("商品フィード（src/modules/product-feed/feed.ts）", () => {
  it("SKU ごとに 1 件。複数 SKU は item_group_id で束ね、セール・GTIN・カテゴリー・在庫を載せる。画像・価格の無いものは載せない", () => {
    const cat: FeedCatalog = {
      products: [product({ brand: "ACME", category_id: "c2" }), product({ id: "p2", slug: "noimg", name: "画像なし" })],
      skus: [
        sku({ options: { サイズ: "M" }, gtin: "4901234567894", compare_at_price_jpy: 4000 }),
        sku({ id: "k2", code: "TEE-L", options: { サイズ: "L" }, price_jpy: 3200 }),
        sku({ id: "k3", product_id: "p2", code: "X" }),
      ],
      inventory: [
        { sku_id: "k1", shop_id: "s", available: 3 },
        { sku_id: "k2", shop_id: "s", available: 0 },
      ] as FeedCatalog["inventory"],
      images: [
        { id: "i1", shop_id: "s", product_id: "p1", storage_key: "a.webp", thumb_key: null, width: null, height: null, sort_order: 0, created_at: now },
        { id: "i2", shop_id: "s", product_id: "p1", storage_key: "b.webp", thumb_key: null, width: null, height: null, sort_order: 1, created_at: now },
      ],
      categories: [
        { id: "c1", shop_id: "s", parent_id: null, slug: "wear", name: "服", sort_order: 0, created_at: now },
        { id: "c2", shop_id: "s", parent_id: "c1", slug: "tops", name: "トップス", sort_order: 0, created_at: now },
      ],
    };
    const r = buildFeed(cat, target);
    expect(r.skipped).toEqual({ no_image: 1, no_price: 0 });
    expect(r.items).toHaveLength(2);
    const [m, l] = r.items;
    expect(m).toMatchObject({
      id: "TEE-M",
      item_group_id: "p1",
      title: "Tシャツ M",
      link: "https://shop.example.jp/p/tee",
      image_link: "https://media.example.jp/a.webp",
      additional_image_link: ["https://media.example.jp/b.webp"],
      availability: "in_stock",
      price: "4000 JPY",
      sale_price: "3000 JPY",
      brand: "ACME",
      gtin: "4901234567894",
      product_type: "服 > トップス",
    });
    expect(l).toMatchObject({ id: "TEE-L", availability: "out_of_stock", price: "3200 JPY", identifier_exists: "no" });
    expect(l!.sale_price).toBeUndefined();
    const xml = feedXml(r, target);
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain("<title>S &amp; Co</title>");
    expect(xml).toContain("<g:price>4000 JPY</g:price>");
  });
});

describe("構造化データ（JSON-LD）", () => {
  it("商品と価格・在庫。</script> で抜けられない", () => {
    const ld = productJsonLd({ url: "https://s/p/tee", product: { name: "</script><script>alert(1)</script>", description: null, brand: "B" }, images: ["https://m/a.webp"], skus: [{ code: "A", name: null, price_jpy: 1000, gtin: "4901234567894", available: 0 }] });
    expect(ld).toMatchObject({ "@type": "Product", sku: "A", gtin13: "4901234567894", brand: { name: "B" }, offers: { price: 1000, priceCurrency: "JPY", availability: "https://schema.org/OutOfStock" } });
    const text = jsonLdText(ld);
    expect(text).not.toContain("</script>");
    expect(JSON.parse(text)).toEqual(ld);
  });

  it("商品ページに入る", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
    sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1500, available: 2 });
    sb.addSku(shop.id, p.id, { code: "B", price_jpy: 1800, available: 0 });
    const html = await (await new Browser(appWith(sb)).get("/my-shop/p/tee")).text();
    const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
    expect(m).not.toBeNull();
    const ld = JSON.parse(m![1]!) as { url: string; offers: { price: number; availability: string }[] };
    expect(ld.url).toBe(`${BASE}/my-shop/p/tee`);
    expect(ld.offers.map((o) => [o.price, o.availability])).toEqual([
      [1500, "https://schema.org/InStock"],
      [1800, "https://schema.org/OutOfStock"],
    ]);
  });
});

describe("商品フィードのモジュール（product_feed）", () => {
  function setup(modules: Record<string, boolean>) {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules } });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
    sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1500, available: 2 });
    sb.tables.product_images.push({ id: "img-1", shop_id: shop.id, product_id: p.id, storage_key: "products/a.webp", thumb_key: null, width: null, height: null, sort_order: 0, created_at: now });
    const hidden = sb.addProduct(shop.id, { slug: "secret", name: "非公開", published: false });
    sb.addSku(shop.id, hidden.id, { code: "H", price_jpy: 900, available: 1 });
    sb.tables.product_images.push({ id: "img-2", shop_id: shop.id, product_id: hidden.id, storage_key: "products/h.webp", thumb_key: null, width: null, height: null, sort_order: 0, created_at: now });
    const storage = new MemoryStorage(`${BASE}/media`);
    return { sb, shop, storage, app: appWith(sb, {}, storage) };
  }

  it("管理画面の「今すぐ作る」で作り、/<スラッグ>/feed/products.xml で配る。非公開の商品は載らない", async () => {
    const { shop, app } = setup({ product_feed: true });
    const admin = await Browser.loggedIn(app, "o@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}/modules/product-feed`)).text();
    expect(page).toContain(`${BASE}/my-shop/feed/products.xml`);
    expect((await new Browser(app).get("/my-shop/feed/products.xml")).status).toBe(404);
    const gen = await admin.post(`/admin/shops/${shop.id}/modules/product-feed/generate`, {});
    expect(gen.headers.get("location")).toBe(`/admin/shops/${shop.id}/modules/product-feed?flash=generated`);
    const res = await new Browser(app).get("/my-shop/feed/products.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<g:id>A</g:id>");
    expect(xml).toContain(`<g:link>${BASE}/my-shop/p/tee</g:link>`);
    expect(xml).toContain(`<g:image_link>${BASE}/media/products/a.webp</g:image_link>`);
    expect(xml).not.toContain("非公開");
    expect(await (await admin.get(`/admin/shops/${shop.id}/modules/product-feed`)).text()).toContain("載せた商品 1 件");
  });

  it("Cron: モジュールが ON のショップだけ作る。1 時間以内なら作り直さない", async () => {
    const { sb, shop, storage } = setup({ product_feed: true });
    const off = sb.addShop(sb.tables.shops[0]!["owner_id"] as string, { slug: "off", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, PUBLIC_BASE_URL: BASE }, storage);
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => undefined };
    registerJobs(adapters, { fetch: sb.fetch });
    await jobs.get("product_feeds")!();
    expect(storage.objects.has(`feeds/${shop.id}/products.xml`)).toBe(true);
    expect(storage.objects.has(`feeds/${off.id}/products.xml`)).toBe(false);
    const first = storage.objects.get(`feeds/${shop.id}/meta.json`)!.body;
    await jobs.get("product_feeds")!();
    expect(storage.objects.get(`feeds/${shop.id}/meta.json`)!.body).toBe(first);
  });

  it("モジュールが OFF なら配らない・画面も無い", async () => {
    const { shop, app } = setup({});
    expect((await new Browser(app).get("/my-shop/feed/products.xml")).status).toBe(404);
    const admin = await Browser.loggedIn(app, "o@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${shop.id}/modules/product-feed`)).status).toBe(404);
  });
});
