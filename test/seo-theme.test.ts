import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { theme_settings: { description: "手作りの陶器を販売しています", announcement: "年末年始は休業します", accent_color: "#aa3366", logo_url: "https://cdn.example/logo.png" } } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", description: "綿100%の定番", published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  sb.tables.product_images.push({ id: "img-1", shop_id: shop.id, product_id: tee.id, storage_key: "shops/x/tee.png", sort_order: 0, created_at: "" });
  sb.tables.product_images.push({ id: "img-2", shop_id: shop.id, product_id: tee.id, storage_key: "shops/x/tee2.png", sort_order: 1, created_at: "" });
  sb.addProduct(shop.id, { slug: "hidden", name: "非公開", published: false });
  const app = appWith(sb);
  return { sb, shop, tee, app, b: new Browser(app) };
}

describe("SEO とテーマ設定", () => {
  it("トップと商品ページに meta / OG / canonical、カートは noindex", async () => {
    const { b } = setup();
    let html = await (await b.get("/my-shop")).text();
    expect(html).toContain('<meta name="description" content="手作りの陶器を販売しています"');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/my-shop"`);
    expect(html).toContain('<meta property="og:site_name" content="マイショップ"');
    expect(html).toContain(`<meta property="og:image" content="${BASE}/media/shops/x/tee.png"`);
    expect(html).toContain("年末年始は休業します");
    expect(html).toContain("--accent:#aa3366");
    expect(html).toContain('src="https://cdn.example/logo.png"');
    expect(html).not.toContain('name="robots"');

    html = await (await b.get("/my-shop/p/tee")).text();
    expect(html).toContain('<meta property="og:type" content="product"');
    expect(html).toContain('<meta name="description" content="綿100%の定番"');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/my-shop/p/tee"`);
    expect(html).toContain('class="thumbs"');

    html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain('<meta name="robots" content="noindex"');
  });

  it("robots.txt と sitemap.xml（公開中の商品だけ）", async () => {
    const { app } = setup();
    const robots = await (await app.request(`${BASE}/robots.txt`)).text();
    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    const res = await app.request(`${BASE}/sitemap.xml`);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain(`<loc>${BASE}/my-shop</loc>`);
    expect(xml).toContain(`<loc>${BASE}/my-shop/p/tee</loc>`);
    expect(xml).toContain(`<loc>${BASE}/my-shop/shipping</loc>`);
    expect(xml).not.toContain("hidden");
  });

  it("管理画面でテーマ設定を保存できる（不正な色・http のロゴは捨てる）", async () => {
    const { app, shop, sb } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("見た目（テーマ）");
    expect(html).toContain('value="#aa3366"');
    const res = await admin.post(`/admin/shops/${shop.id}/theme`, { description: "新しい紹介", announcement: "", accent_color: "red", logo_url: "http://insecure.example/logo.png" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=theme_saved`);
    expect((sb.shops[0]!["settings"] as Record<string, unknown>)["theme_settings"]).toEqual({ description: "新しい紹介", announcement: "", accent_color: "#1f6feb", logo_url: "" });
    expect((sb.shops[0]!["settings"] as Record<string, unknown>)["shipping"]).toBeUndefined(); // 他の設定キーは触らない（元々無い）
  });
});

describe("商品画像の配信（サムネイル / srcset）", () => {
  it("サムネイルがある画像は一覧で srcset、無ければ本画像だけ。詳細は本画像に寸法を付ける", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const p1 = sb.addProduct(shop.id, { slug: "with-thumb", name: "A", published: true });
    sb.addSku(shop.id, p1.id, { code: "A1", price_jpy: 100, available: 1 });
    sb.tables.product_images.push({ id: "i1", shop_id: shop.id, product_id: p1.id, storage_key: "shops/s/a.webp", thumb_key: "shops/s/a.thumb.webp", width: 1600, height: 1200, sort_order: 0, created_at: "" });
    const p2 = sb.addProduct(shop.id, { slug: "legacy", name: "B", published: true });
    sb.addSku(shop.id, p2.id, { code: "B1", price_jpy: 100, available: 1 });
    sb.tables.product_images.push({ id: "i2", shop_id: shop.id, product_id: p2.id, storage_key: "shops/s/b.png", sort_order: 0, created_at: "" });
    const app = appWith(sb);
    const b = new Browser(app);

    const list = await (await b.get("/s")).text();
    expect(list).toContain(`src="${BASE}/media/shops/s/a.thumb.webp"`);
    expect(list).toContain(`srcset="${BASE}/media/shops/s/a.thumb.webp 400w, ${BASE}/media/shops/s/a.webp 1600w"`);
    expect(list).toContain('width="1600" height="1200"');
    expect(list).toContain(`src="${BASE}/media/shops/s/b.png"`);
    expect(list).not.toContain("b.thumb");
    expect(list).toContain('decoding="async"');

    const detail = await (await b.get("/s/p/with-thumb")).text();
    expect(detail).toContain(`<img src="${BASE}/media/shops/s/a.webp" width="1600" height="1200"`);
    expect(detail).toContain('fetchpriority="high"');

    // 公開 API にもサムネイルと寸法
    const api = (await (await app.request(`${BASE}/api/shops/s/products/with-thumb`)).json()) as { product: { image_variants: { thumb: string; width: number }[] } };
    expect(api.product.image_variants[0]).toMatchObject({ thumb: `${BASE}/media/shops/s/a.thumb.webp`, width: 1600 });
  });
});
