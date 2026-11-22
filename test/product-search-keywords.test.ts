import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { SEARCH_KEYWORDS_MIGRATION } from "../src/products/fields";

/** 商品の検索用のキーワード（0163）。正規化・インデックス・AI 用 API の本物の検査は test/db/search-keywords.test.ts */

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, product.id, { code: "TEE", price_jpy: 1000, available: 1 });
  return { sb, shop, product, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

describe("管理画面", () => {
  it("商品の編集に検索用のキーワードの欄。保存すると前後の空白を除いて書き、空なら外す。200 文字で切る", async () => {
    const s = setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const url = `/admin/shops/${s.shop.id}/products/${s.product.id}`;
    const form = await (await admin.get(url)).text();
    expect(form).toContain('name="search_keywords"');
    expect(form).toContain('maxlength="200"');
    await admin.post(url, { name: "Tシャツ", slug: "tee", published: "on", search_keywords_present: "1", search_keywords: "  カットソー 型番ABC-12  " });
    expect(s.product["search_keywords"]).toBe("カットソー 型番ABC-12");
    await admin.post(url, { name: "Tシャツ", slug: "tee", published: "on", search_keywords_present: "1", search_keywords: "あ".repeat(250) });
    expect([...String(s.product["search_keywords"])].length).toBe(200);
    await admin.post(url, { name: "Tシャツ", slug: "tee", published: "on", search_keywords_present: "1", search_keywords: "   " });
    expect(s.product["search_keywords"]).toBeNull();
  });

  it("0163 が当たるまでは欄を出さず、列に触れない", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== SEARCH_KEYWORDS_MIGRATION);
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const url = `/admin/shops/${s.shop.id}/products/${s.product.id}`;
    expect(await (await admin.get(url)).text()).not.toContain('name="search_keywords"');
    await admin.post(url, { name: "T2", slug: "tee", published: "on" });
    expect("search_keywords" in s.product).toBe(false);
  });
});

describe("お店の画面", () => {
  it("キーワードで探せるが、商品のページ・公開 API にはキーワードを出さない", async () => {
    const s = setup();
    s.product["search_keywords"] = "カットソー";
    const b = new Browser(s.app, BASE);
    const list = await (await b.get("/my-shop/products?q=%E3%82%AB%E3%83%83%E3%83%88%E3%82%BD%E3%83%BC")).text();
    expect(list).toContain("Tシャツ");
    expect(await (await b.get("/my-shop/products/tee")).text()).not.toContain("カットソー");
    expect(await (await s.app.request(`${BASE}/api/shops/my-shop/products/tee`)).text()).not.toContain("カットソー");
    expect(await (await s.app.request(`${BASE}/api/shops/my-shop/products`)).text()).not.toContain("search_keywords");
  });
});

describe("AI 用 API", () => {
  it("0163 が当たる前に search_keywords を送ると 409 migration_required（黙って捨てない）", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== SEARCH_KEYWORDS_MIGRATION);
    const { generateApiToken, hashApiToken, tokenPrefix } = await import("../src/api/tokens");
    const raw = generateApiToken();
    s.sb.tables.api_tokens.push({ id: "tok-1", shop_id: s.shop.id, owner_id: s.sb.tables.shops[0]!["owner_id"], name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:read", "products:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const r = await s.app.request(`${BASE}/api/v1/products/${s.product.id}`, { method: "PATCH", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify({ search_keywords: "x" }) });
    expect(r.status).toBe(409);
  });
});
