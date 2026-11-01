import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { APP_DATA_MIGRATION, productReviews, reviewsJsonLd } from "../src/apps/app-data";
import { MCP_TOOLS } from "../src/mcp/tools";
import { productFromDetail } from "../src/themes/liquid/objects";

/**
 * 外部プラグインの拡張データ（0084、docs/app-data.md）。Worker は REST を api_app_data_* に渡し、
 * お店の画面・Liquid・ヘッドレスは product_public_get が返す公開の分だけで描く。形の検査と権限は test/db/app-data.test.ts（実 PostgreSQL）
 */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "星のお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T シャツ", published: true });
  sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 3 });
  sb.tables.hook_endpoints.push({ id: "ep-reviews", shop_id: shop.id, name: "レビュー", url: "https://reviews.example/banto", events: [], enabled: true, settings: {}, manifest: null, app_handle: "reviews", created_at: "" });
  const app = appWith(sb);
  const issue = async (scopes: string[], endpointId: string | null = "ep-reviews") => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, endpoint_id: endpointId, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  const rest = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  return { sb, app, shop, product: p, issue, rest };
}

const reviews = {
  rating_avg: 4.5,
  rating_count: 12,
  items: [
    { id: "r1", rating: 5, title: "最高", body: "<script>alert(1)</script>着心地がよい", author_display: "東京都 T さん", created_at: "2026-10-01T00:00:00Z", verified_purchase: true },
    { id: "r2", rating: 4, body: "お礼のクーポンをもらいました", author_display: "K さん", created_at: "2026-10-02T00:00:00Z", incentivized: true },
  ],
};

describe("拡張データ（0084）: REST", () => {
  it("置き直す → 一覧 → 消す。ほかの形・UUID でない商品は 400 / 404。MCP には出さない", async () => {
    const { rest, issue, product } = setup();
    const tok = await issue(["app_data:write"]);
    const put = await rest(tok, "PUT", `/products/${product.id}/app-data/reviews.v1`, { data: reviews });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ app: "reviews", kind: "reviews.v1", public: true });
    expect((await rest(tok, "GET", "/app-data")).json).toMatchObject({ app: "reviews", total: 1 });
    expect((await rest(tok, "PUT", `/products/${product.id}/app-data/qa.v1`, { data: reviews })).status).toBe(400);
    expect((await rest(tok, "PUT", `/products/${product.id}/app-data/reviews.v1`, {})).status).toBe(400);
    expect((await rest(tok, "PUT", "/products/not-a-uuid/app-data/reviews.v1", { data: reviews })).status).toBe(404);
    expect((await rest(tok, "DELETE", `/products/${product.id}/app-data/reviews.v1`)).json).toEqual({ deleted: true });
    expect(MCP_TOOLS.some((x) => /app_data/.test(x.name))).toBe(false);
  });

  it("スコープが無ければ 401、名前の無い送信先は 409 app_handle_required、0084 の前は 409 migration_required", async () => {
    const s = setup();
    const ro = await s.issue(["products:read"], null);
    expect((await s.rest(ro, "PUT", `/products/${s.product.id}/app-data/reviews.v1`, { data: reviews })).status).toBe(401);
    s.sb.tables.hook_endpoints[0]!["app_handle"] = null;
    const tok = await s.issue(["app_data:write"]);
    const r = await s.rest(tok, "PUT", `/products/${s.product.id}/app-data/reviews.v1`, { data: reviews });
    expect(r.status).toBe(409);
    expect(r.json.error?.message).toMatch(/^app_handle_required/);
    const old = setup();
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((v) => v !== APP_DATA_MIGRATION);
    const t2 = await old.issue(["app_data:write"]);
    const m = await old.rest(t2, "PUT", `/products/${old.product.id}/app-data/reviews.v1`, { data: reviews });
    expect(m.status).toBe(409);
    expect(m.json.error?.code).toBe("migration_required");
  });
});

describe("拡張データ（0084）: お客様の画面", () => {
  it("既定のテーマ: 星と件数・一覧（エスケープ・PR と購入者の印）と構造化データ。非公開にすると消える", async () => {
    const { app, rest, issue, product } = setup();
    const tok = await issue(["app_data:write"]);
    await rest(tok, "PUT", `/products/${product.id}/app-data/reviews.v1`, { data: reviews });
    const html = await (await app.request(`${BASE}/my-shop/p/tee`)).text();
    expect(html).toContain('class="reviews-summary"');
    expect(html).toContain("12 件のレビュー");
    expect(html).toContain('id="reviews"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;着心地がよい");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("PR（お礼つきのレビュー）");
    expect(html).toContain("購入者");
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!) as Record<string, unknown>;
    expect(ld["aggregateRating"]).toMatchObject({ "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 12 });
    expect((ld["review"] as unknown[]).length).toBe(2);
    await rest(tok, "PUT", `/products/${product.id}/app-data/reviews.v1`, { data: reviews, public: false });
    const hidden = await (await app.request(`${BASE}/my-shop/p/tee`)).text();
    expect(hidden).not.toContain('id="reviews"');
    expect(hidden).not.toContain("aggregateRating");
  });

  it("ヘッドレスの商品: app_data と reviews。無ければ [] と null", async () => {
    const { app, rest, issue, product } = setup();
    const get = async () => ((await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: Record<string, unknown> }).product;
    expect(await get()).toMatchObject({ app_data: [], reviews: null });
    const tok = await issue(["app_data:write"]);
    await rest(tok, "PUT", `/products/${product.id}/app-data/reviews.v1`, { data: reviews });
    const p = await get();
    expect(p["app_data"]).toEqual([expect.objectContaining({ app: "reviews", kind: "reviews.v1" })]);
    expect(p["reviews"]).toMatchObject({ app: "reviews", rating_avg: 4.5, rating_count: 12 });
  });

  it("Liquid: product.reviews（rating・rating_count・items）と product.app_data", () => {
    const product = { id: "p1", shop_id: "s", slug: "tee", name: "T", description: null, tags: [], published: true, created_at: "", updated_at: "", app_data: [{ app: "reviews", kind: "reviews.v1", data: reviews }] };
    const o = productFromDetail({ shopPath: "/my-shop", mediaBaseUrl: "/media" }, { product, images: [], skus: [] } as never);
    expect(o.reviews).toMatchObject({ app: "reviews", rating: 4.5, rating_count: 12 });
    expect(o.reviews?.items[0]).toMatchObject({ author: "東京都 T さん", verified_purchase: true });
    expect(o.reviews?.items[1]).toMatchObject({ title: null, incentivized: true });
    expect(o.app_data).toEqual([{ app: "reviews", kind: "reviews.v1", data: reviews }]);
  });

  it("productReviews: 件数 0・壊れた行は出さない。構造化データは見えている分だけ", () => {
    expect(productReviews({ app_data: [{ app: "a", kind: "reviews.v1", data: { rating_avg: 0, rating_count: 0, items: [] } }] })).toBeNull();
    expect(productReviews({ app_data: [{ app: "a", kind: "reviews.v1", data: "x" }] })).toBeNull();
    expect(productReviews({})).toBeNull();
    const r = productReviews({ app_data: [{ app: "a", kind: "reviews.v1", data: { rating_avg: 4, rating_count: 3, items: [{ id: "x", rating: 9, body: "", author_display: "a", created_at: "2026-10-01" }] } }] })!;
    expect(r.items).toEqual([]);
    expect(reviewsJsonLd(r)).not.toHaveProperty("review");
  });
});

describe("拡張データ（0084）: 管理画面", () => {
  it("連携にプラグインの名前を付ける（形の誤りは保存しない）→ トークンの発行で結ぶ先を選ぶ（選ばなければ発行しない）", async () => {
    const { app, sb, shop } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await b.get(`/admin/shops/${shop.id}/hooks/ep-reviews`)).text();
    expect(html).toContain('name="app_handle"');
    expect(html).toContain('value="reviews"');
    let res = await b.post(`/admin/shops/${shop.id}/hooks/ep-reviews`, { name: "レビュー", url: "https://reviews.example/banto", app_handle: "Bad Name", enabled: "on" });
    expect(res.headers.get("location")).toContain("flash=invalid_app_handle");
    expect(sb.tables.hook_endpoints[0]!["app_handle"]).toBe("reviews");
    res = await b.post(`/admin/shops/${shop.id}/hooks/ep-reviews`, { name: "レビュー", url: "https://reviews.example/banto", app_handle: "stars", enabled: "on" });
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(sb.tables.hook_endpoints[0]!["app_handle"]).toBe("stars");

    html = await (await b.get(`/admin/shops/${shop.id}/tokens`)).text();
    expect(html).toContain('value="app_data:write"');
    expect(html).toContain('<option value="ep-reviews">レビュー (stars)</option>');
    res = await b.post(`/admin/shops/${shop.id}/tokens`, { name: "レビュー", scopes: "app_data:write" });
    expect(res.headers.get("location")).toContain("flash=app_endpoint");
    res = await b.post(`/admin/shops/${shop.id}/tokens`, { name: "レビュー", scopes: "app_data:write", endpoint_id: "ep-reviews" });
    expect(res.status).toBe(200);
    expect(sb.tables.api_tokens.at(-1)).toMatchObject({ scopes: ["app_data:write"], endpoint_id: "ep-reviews" });
    // ほかのスコープだけのトークンは結ばない
    await b.post(`/admin/shops/${shop.id}/tokens`, { name: "読む", scopes: "products:read", endpoint_id: "ep-reviews" });
    expect(sb.tables.api_tokens.at(-1)!["endpoint_id"]).toBeUndefined();
  });
});
