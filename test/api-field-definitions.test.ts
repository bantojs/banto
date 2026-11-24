import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { FIELD_DEFS_MIGRATION } from "../src/products/fields";

/** 商品・会員の項目の定義の AI 用 API（0145、docs/ai-access.md §19）。形の本物の検査は test/db/api-field-definitions.test.ts */

async function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings });
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:read", "products:write", "customers:read"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  const rest = (method: string, path: string, body?: unknown) =>
    app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const mcp = (body: unknown) => app.request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { sb, shop, rest, mcp };
}

describe("REST /api/v1", () => {
  it("GET は管理画面と同じ読み手を通す（形の違う古い行は捨て、会員の項目は public: false）", async () => {
    const s = await setup({
      product_fields: [{ key: "material", label: "素材", type: "text" }, { key: "Bad", type: "text" }, { key: "cost", type: "number", public: false }],
      customer_fields: [{ key: "rank", type: "text", public: true }, { key: "photo", type: "image" }],
    });
    expect(await (await s.rest("GET", "/product-fields")).json()).toEqual({ fields: [{ key: "material", label: "素材", type: "text", public: true }, { key: "cost", label: "cost", type: "number", public: false }] });
    expect(await (await s.rest("GET", "/customer-fields")).json()).toEqual({ fields: [{ key: "rank", label: "rank", type: "text", public: false }] });
  });

  it("PUT は { fields: [...] } で丸ごと置き換える。customers:write の無いトークンでは会員の項目を書けない", async () => {
    const s = await setup();
    const r = await s.rest("PUT", "/product-fields", { fields: [{ key: "origin", type: "select", options: ["日本"] }] });
    expect(r.status).toBe(200);
    expect((s.shop["settings"] as Record<string, unknown>)["product_fields"]).toEqual([{ key: "origin", type: "select", options: ["日本"] }]);
    expect((await s.rest("PUT", "/customer-fields", { fields: [] })).status).toBe(401);
    const bad = await s.rest("PUT", "/product-fields", { fields: "x" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toMatch(/invalid_fields:not_array/);
  });

  it("0145 が当たるまでは 409 migration_required", async () => {
    const s = await setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== FIELD_DEFS_MIGRATION);
    for (const [m, p] of [["GET", "/product-fields"], ["PUT", "/product-fields"], ["GET", "/customer-fields"]] as const) {
      const r = await s.rest(m, p, m === "PUT" ? { fields: [] } : undefined);
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: { code: "migration_required" } });
    }
  });
});

describe("MCP /mcp", () => {
  it("product_fields_get / set と customer_fields_get / set。書き込みは destructiveHint", async () => {
    const s = await setup();
    const list = (await (await s.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string; annotations?: Record<string, unknown> }[] } };
    const tool = (n: string) => list.result.tools.find((t) => t.name === n);
    for (const n of ["product_fields_get", "customer_fields_get"]) expect(tool(n)?.annotations?.["readOnlyHint"]).toBe(true);
    for (const n of ["product_fields_set", "customer_fields_set"]) expect(tool(n)?.annotations?.["destructiveHint"]).toBe(true);
    await s.mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "product_fields_set", arguments: { fields: [{ key: "material", type: "text" }] } } });
    expect((s.shop["settings"] as Record<string, unknown>)["product_fields"]).toEqual([{ key: "material", type: "text" }]);
  });
});
