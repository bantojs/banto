import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";
import { parseManifest } from "../src/hooks/manifest";
import { REVIEWS_MORE_SCRIPT, reviewsMoreHtml } from "../src/apps/reviews-html";
import { productFromDetail } from "../src/themes/liquid/objects";

/** レビューの「もっと見る」（0087、docs/app-data.md §7）。押した人のブラウザがプラグインの公開 API の JSON を取り、Banto の決まった形で描く */
const items = [
  { id: "r1", rating: 5, body: "よい", author_display: "T さん", created_at: "2026-10-01T00:00:00Z" },
  { id: "r2", rating: 4, body: "ふつう", author_display: "K さん", created_at: "2026-10-02T00:00:00Z" },
];

function setup(opts: { more?: unknown; count?: number } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T シャツ", published: true });
  sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 3 });
  sb.tables.hook_endpoints.push({ id: "ep-r", shop_id: shop.id, name: "レビュー", url: "https://r.example/b", events: [], enabled: true, settings: {}, manifest: { name: "レビュー", events: [], settings: [], ...(opts.more !== undefined ? { more: opts.more } : {}) }, app_handle: "reviews", created_at: "" });
  sb.tables.app_data.push({ shop_id: shop.id, endpoint_id: "ep-r", product_id: p.id, kind: "reviews.v1", key: "", data: { rating_avg: 4.5, rating_count: opts.count ?? 30, items }, public: true, updated_at: "" });
  return { app: appWith(sb), product: p };
}

describe("もっと見る", () => {
  it("マニフェストの more は reviews.v1 の https の URL だけ", () => {
    expect(parseManifest({ name: "x", more: { "reviews.v1": "https://r.example/api/reviews?shop=1" } })?.more).toEqual({ "reviews.v1": "https://r.example/api/reviews?shop=1" });
    for (const bad of ["http://r.example/a", "javascript:alert(1)", 'https://r.example/"><x>', "https://user:pw@r.example/"]) expect(parseManifest({ name: "x", more: { "reviews.v1": bad } })?.more, bad).toBeUndefined();
  });

  it("既定のテーマ: 置いた分より件数が多く URL があれば、ボタン（URL・商品の id・続きの位置）とスクリプトを 1 回", async () => {
    const { app, product } = setup({ more: { "reviews.v1": "https://r.example/api/reviews" } });
    const html = await (await app.request(`${BASE}/my-shop/products/tee`)).text();
    expect(html).toContain('<section class="reviews" data-banto-reviews id="reviews">');
    expect(html).toContain(`data-banto-more data-url="https://r.example/api/reviews" data-product="${product.id}" data-offset="2"`);
    expect(html).toContain(">もっと見る</button>");
    expect(html.split("<script>(function(){if(window.__bantoMore)").length - 1).toBe(1);
  });

  it("URL が無い・置いた分で全部ならボタンを出さない", async () => {
    for (const s of [setup(), setup({ more: { "reviews.v1": "https://r.example/api/reviews" }, count: 2 })]) {
      const html = await (await s.app.request(`${BASE}/my-shop/products/tee`)).text();
      expect(html).toContain("data-banto-reviews");
      expect(html).not.toContain("data-banto-more");
    }
  });

  it("Liquid: product.reviews.more_url と more_html", () => {
    const product = { id: "p1", shop_id: "s", slug: "tee", name: "T", description: null, tags: [], published: true, created_at: "", updated_at: "", app_data: [{ app: "reviews", kind: "reviews.v1", key: "", data: { rating_avg: 4, rating_count: 9, items }, more_url: "https://r.example/m" }] };
    const o = productFromDetail({ shopPath: "", mediaBaseUrl: "/media" }, { product, images: [], skus: [] } as never);
    expect(o.reviews?.more_url).toBe("https://r.example/m");
    expect(String(o.reviews?.more_html)).toContain('data-product="p1" data-offset="2"');
  });

  it("スクリプトはプラグインの HTML を使わない（innerHTML・eval なし、Cookie と参照元を送らない）", () => {
    expect(REVIEWS_MORE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|eval\(|new Function/);
    expect(REVIEWS_MORE_SCRIPT).toContain('credentials:"omit"');
    expect(REVIEWS_MORE_SCRIPT).toContain('referrerPolicy:"no-referrer"');
    expect(() => new Function(REVIEWS_MORE_SCRIPT)).not.toThrow();
    expect(reviewsMoreHtml({ app: "a", rating_avg: 4, rating_count: 3, items: [], more: { url: 'https://x.example/"', product_id: "p" } }, 0)).toContain('data-url="https://x.example/&quot;"');
  });
});
