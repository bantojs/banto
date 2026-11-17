import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { RELEASED_AT_MIGRATION } from "../src/products/fields";
import { productFromDetail, productFromSummary } from "../src/themes/liquid/objects";

/** 商品の発売日（0146）。並びと形の本物の検査は test/db/product-released-at.test.ts */

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true });
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:read", "products:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  const rest = (method: string, path: string, body?: unknown) =>
    app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { sb, shop, product, app, rest };
}

describe("管理画面", () => {
  it("商品の編集に発売日の欄。デプロイの時間帯で読み、空にすると外す", async () => {
    const s = await setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const url = `/admin/shops/${s.shop.id}/products/${s.product.id}`;
    expect(await (await admin.get(url)).text()).toContain('name="released_at"');
    await admin.post(url, { name: "T", slug: "tee", released_present: "1", released_at: "2019-04-01T10:00", published: "on" });
    expect(s.product["released_at"]).toBe("2019-04-01T01:00:00.000Z");
    await admin.post(url, { name: "T", slug: "tee", released_present: "1", released_at: "", published: "on" });
    expect(s.product["released_at"]).toBeNull();
  });

  it("0146 が当たるまでは欄を出さず、列に触れない", async () => {
    const s = await setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== RELEASED_AT_MIGRATION);
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const url = `/admin/shops/${s.shop.id}/products/${s.product.id}`;
    expect(await (await admin.get(url)).text()).not.toContain('name="released_at"');
    await admin.post(url, { name: "T2", slug: "tee", published: "on" });
    expect("released_at" in s.product).toBe(false);
  });
});

describe("AI 用 API", () => {
  it("0146 が当たるまでは released_at を 409 migration_required で断る（黙って捨てない）", async () => {
    const s = await setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== RELEASED_AT_MIGRATION);
    const r = await s.rest("PATCH", `/products/${s.product.id}`, { released_at: "2019-04-01T10:00:00+09:00" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "migration_required" } });
    expect((await s.rest("PATCH", `/products/${s.product.id}`, { name: "T2" })).status).toBe(200);
  });
});

describe("テーマ（Liquid）", () => {
  const u = { shopPath: "", mediaBaseUrl: "" };
  it("released_at と、Shopify の名前の published_at（発売日、無ければ作成日）", () => {
    const base = { id: "p", slug: "tee", name: "T", tags: [], category_id: null, extra_category_ids: [], brand: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
    const card = productFromSummary(u, { product: { ...base, released_at: "2019-04-01T01:00:00Z" }, image: null, minPrice: 1000, compareAt: null });
    expect(card.released_at).toBe("2019-04-01T01:00:00Z");
    expect(card.published_at).toBe("2019-04-01T01:00:00Z");
    const plain = productFromSummary(u, { product: { ...base, released_at: null }, image: null, minPrice: 1000, compareAt: null });
    expect(plain.released_at).toBeNull();
    expect(plain.published_at).toBe("2026-11-01T00:00:00Z");
    const detail = productFromDetail(u, { product: { ...base, shop_id: "s", description: null, published: true, released_at: "2019-04-01T01:00:00Z" }, images: [], skus: [] } as unknown as Parameters<typeof productFromDetail>[1]);
    expect(detail.published_at).toBe("2019-04-01T01:00:00Z");
  });
});
