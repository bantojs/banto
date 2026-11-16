import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { AUDIENCE_API_MIGRATION } from "../src/members/audience";

/** 商品の会員限定の AI 用 API（0144、docs/ai-access.md §18）。判定と形の本物の検査は test/db/api-product-audience.test.ts */

async function setup(opts: { on?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { audiences: opts.on ?? true } } });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true });
  const vip = { id: crypto.randomUUID(), shop_id: shop.id, name: "VIP", condition: { member: true } };
  sb.tables.audiences.push(vip, { id: crypto.randomUUID(), shop_id: shop.id, name: "LP", condition: { param: "ref", set: true } });
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:read", "products:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  const rest = (method: string, path: string, body?: unknown) =>
    app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const mcp = (body: unknown) => app.request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { sb, product, vip, rest, mcp };
}

describe("REST /api/v1", () => {
  it("PATCH /products/{id} の audience を DB に渡す。GET /audiences は商品に付けられるかを添える", async () => {
    const s = await setup();
    expect((await s.rest("PATCH", `/products/${s.product.id}`, { audience: "VIP", audience_mode: "buy" })).status).toBe(200);
    expect(s.product["audience_id"]).toBe(s.vip.id);
    expect(s.product["audience_mode"]).toBe("buy");
    const bad = await s.rest("PATCH", `/products/${s.product.id}`, { audience: "ない" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid" } });
    const list = await s.rest("GET", "/audiences");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [{ id: expect.any(String), name: "LP", product_usable: false }, { id: s.vip.id, name: "VIP", product_usable: true }] });
  });

  it("モジュールが OFF なら GET /audiences は 409 module_disabled", async () => {
    const s = await setup({ on: false });
    const r = await s.rest("GET", "/audiences");
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/module_disabled/);
  });

  it("0144 が当たるまでは会員の条件の欄と GET /audiences を 409 migration_required（黙って捨てない）。ほかの欄の更新はそのまま", async () => {
    const s = await setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== AUDIENCE_API_MIGRATION);
    for (const body of [{ audience: "VIP" }, { audience_mode: "buy" }, { audience_hide: false }]) {
      const r = await s.rest("PATCH", `/products/${s.product.id}`, body);
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: { code: "migration_required" } });
    }
    expect((await s.rest("POST", "/products", { slug: "new", name: "new", audience: "VIP" })).status).toBe(409);
    expect((await s.rest("GET", "/audiences")).status).toBe(409);
    expect(s.product["audience_id"] ?? null).toBeNull();
    expect((await s.rest("PATCH", `/products/${s.product.id}`, { name: "T2" })).status).toBe(200);
  });
});

describe("MCP /mcp", () => {
  it("product_create / product_update が audience の欄を持ち、audiences_list は読み取り", async () => {
    const s = await setup();
    const list = (await (await s.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> }; annotations?: Record<string, unknown> }[] } };
    const tool = (n: string) => list.result.tools.find((t) => t.name === n)!;
    for (const n of ["product_create", "product_update"]) expect(Object.keys(tool(n).inputSchema.properties)).toEqual(expect.arrayContaining(["audience", "audience_mode", "audience_hide"]));
    expect(tool("audiences_list").annotations?.["readOnlyHint"]).toBe(true);
    await s.mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "product_update", arguments: { id: s.product.id, audience: s.vip.id } } });
    expect(s.product["audience_id"]).toBe(s.vip.id);
  });
});
