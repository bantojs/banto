import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/** 会員の結びつけの一覧（0167、GET /api/v1/customers/links、customers:links）。DB の規則は test/db/customer-links.test.ts */
const KEY = "k".repeat(16) + "-link-key-for-tests-0123456789";

function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "結びつけのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const other = sb.addShop(owner.id, { slug: "o", name: "ほかのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const app = appWith(sb);
  return { sb, shop, other, app };
}

async function issue(sb: FakeSupabase, shopId: string, scopes: string[]) {
  const owner = sb.tables.shops.find((s) => s["id"] === shopId)!["owner_id"];
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shopId, owner_id: owner, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, endpoint_id: null, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  return raw;
}

function addMember(sb: FakeSupabase, shopId: string, n: number, extra: Record<string, unknown> = {}) {
  const row = { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, shop_id: shopId, email: `m${n}@example.com`, name: `会員 ${n}`, default_address: { state: "東京都" }, marketing_consent: true, created_at: `2026-11-0${n}T00:00:00Z`, updated_at: `2026-11-1${n}T00:00:00Z`, ...extra };
  sb.tables.customers.push(row);
  return row;
}

async function get(app: ReturnType<typeof appWith>, tok: string, query = "", key: string | null = KEY) {
  const headers: Record<string, string> = { authorization: `Bearer ${tok}` };
  if (key !== null) headers["x-banto-link-key"] = key;
  const res = await app.request(`${BASE}/api/v1/customers/links${query}`, { headers });
  return { status: res.status, cache: res.headers.get("cache-control"), json: (await res.json()) as { items: Record<string, unknown>[]; total: number; limit: number; offset: number; error?: { code: string; message: string } } };
}

describe("GET /api/v1/customers/links", () => {
  it("同じトークンで会員の項目の定義も読める（0169）", async () => {
    const { sb, shop, app } = setup();
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["customer_fields"] = [{ key: "card_no", label: "会員カード", type: "text" }];
    for (const scopes of [["customers:links"], ["customers:write"]]) {
      const res = await app.request(`${BASE}/api/v1/customer-fields`, { headers: { authorization: `Bearer ${await issue(sb, shop.id, scopes)}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { fields: { key: string }[] }).fields.map((f) => f.key)).toEqual(["card_no"]);
    }
    const res = await app.request(`${BASE}/api/v1/customer-fields`, { headers: { authorization: `Bearer ${await issue(sb, shop.id, ["products:read"])}` } });
    expect(res.status).toBe(401);
  });

  it("customers:links だけで読める。customers:read だけでは読めない", async () => {
    const { sb, shop, app } = setup();
    addMember(sb, shop.id, 1);
    expect((await get(app, await issue(sb, shop.id, ["customers:read"]))).status).toBe(401);
    expect((await get(app, await issue(sb, shop.id, ["customers:write"]))).status).toBe(401);
    const r = await get(app, await issue(sb, shop.id, ["customers:links"]));
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.json.total).toBe(1);
  });

  it("返すのは 5 つの項目だけ。LINE の UID は鍵付きハッシュ、結んでいなければ null。ほかのショップの会員は出ない", async () => {
    const { sb, shop, other, app } = setup();
    const a = addMember(sb, shop.id, 1, { external_ref: { provider: "crm", id: "C001" }, attributes: { rank: "gold" } });
    addMember(sb, shop.id, 2);
    addMember(sb, other.id, 3);
    sb.memberIdentities.push({ shop_id: shop.id, provider: "line", subject: "U1234567890abcdef1234567890abcdef", customer_id: a.id });
    sb.memberIdentities.push({ shop_id: shop.id, provider: "google", subject: "g-1", customer_id: `00000000-0000-4000-8000-${"2".padStart(12, "0")}` });
    const r = await get(app, await issue(sb, shop.id, ["customers:links"]));
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    expect(r.json.items).toHaveLength(2);
    for (const it of r.json.items) expect(Object.keys(it).sort()).toEqual(["attributes", "external_ref", "id", "line_link", "updated_at"]);
    const want = createHmac("sha256", Buffer.from(KEY, "utf8")).update(Buffer.from("U1234567890abcdef1234567890abcdef", "utf8")).digest("hex");
    expect(r.json.items[0]).toEqual({ id: a.id, line_link: want, external_ref: { provider: "crm", id: "C001" }, attributes: { rank: "gold" }, updated_at: a.updated_at });
    expect(r.json.items[1]!["line_link"]).toBeNull();
    const text = JSON.stringify(r.json);
    expect(text).not.toContain("U1234567890abcdef");
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("会員 1");
    // 鍵が違えば別の値（鍵を変えれば前の値とは照らせない）
    const r2 = await get(app, await issue(sb, shop.id, ["customers:links"]), "", "x".repeat(32));
    expect(r2.json.items[0]!["line_link"]).not.toBe(want);
  });

  it("鍵が無い・32 文字未満・256 文字を超えると 400 invalid_link_key", async () => {
    const { sb, shop, app } = setup();
    const tok = await issue(sb, shop.id, ["customers:links"]);
    for (const key of [null, "", "short", "x".repeat(31), "x".repeat(257), `${"x".repeat(40)} y`, `${"x".repeat(40)}\u00e9`]) {
      const r = await get(app, tok, "", key);
      expect(r.status).toBe(400);
      expect(r.json.error?.message).toContain("invalid_link_key");
    }
    expect((await get(app, tok, "", "x".repeat(32))).status).toBe(200);
  });

  it("ページ送りと total。limit は 100 まで", async () => {
    const { sb, shop, app } = setup();
    for (let n = 1; n <= 5; n++) addMember(sb, shop.id, n);
    const tok = await issue(sb, shop.id, ["customers:links"]);
    const p1 = await get(app, tok, "?limit=2&offset=0");
    const p3 = await get(app, tok, "?limit=2&offset=4");
    expect(p1.json).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect(p1.json.items.map((i) => String(i["id"]).slice(-1))).toEqual(["1", "2"]);
    expect(p3.json.items.map((i) => String(i["id"]).slice(-1))).toEqual(["5"]);
    expect((await get(app, tok, "?limit=500")).json.limit).toBe(100);
    expect((await get(app, tok)).json.limit).toBe(100);
  });

  it("0167 を当てる前は 409 migration_required", async () => {
    const { sb, shop, app } = setup({ migrations: BUNDLED_MIGRATIONS.filter((m) => m !== "0167_customer_links") });
    const r = await get(app, await issue(sb, shop.id, ["customers:links"]));
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("migration_required");
  });

  it("/customers/{id} とぶつからない（links を会員 id として引かない: 引けば 404、ここはスコープで 401）", async () => {
    const { sb, shop, app } = setup();
    const tok = await issue(sb, shop.id, ["customers:read"]);
    const res = await app.request(`${BASE}/api/v1/customers/links`, { headers: { authorization: `Bearer ${tok}`, "x-banto-link-key": KEY } });
    expect(res.status).toBe(401);
  });
});

describe("発行の画面", () => {
  it("customers:links を選べる。0167 の前は出さない", async () => {
    const s = setup();
    const b2 = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const html = await (await b2.get(`/admin/shops/${s.shop.id}/tokens`)).text();
    expect(html).toContain('value="customers:links"');
    expect(html).toContain("LINE の UID の鍵付きハッシュだけ");
    const old = setup({ migrations: BUNDLED_MIGRATIONS.filter((m) => m !== "0167_customer_links") });
    const b3 = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await b3.get(`/admin/shops/${old.shop.id}/tokens`)).text()).not.toContain('value="customers:links"');
  });
});
