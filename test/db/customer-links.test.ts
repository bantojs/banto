import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type Links = { items: Record<string, unknown>[]; total: number; limit: number; offset: number };

/**
 * 0167_customer_links: 会員の結びつけの一覧（customers:links）。個人情報なし、LINE の UID は HMAC-SHA256 の 16 進だけ。
 * 発行者の項目は customers。service_role だけが呼べる
 */
describe.skipIf(!dbAvailable)("会員の結びつけの一覧（0167）", () => {
  let f: Fixture;
  let other: Fixture;
  let lineCid: string;
  let plainCid: string;
  const KEY = "link-key-for-db-tests-0123456789-abcdef";
  const UID = "U0123456789abcdef0123456789abcdef";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const links = (tok: string, key: string | null = KEY, limit: number | null = 100, offset: number | null = 0) =>
    svc<Links>("select api_customers_links($1, $2, $3, $4) as r", [tok, key, limit, offset]);
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, f.shopId, perms]);
    return uid;
  };
  async function issue(scopes: string[], uid = f.ownerId) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, uid, sha(raw), raw.slice(0, 12), scopes]));
    return sha(raw);
  }

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cl-owner@example.com", slug: "cl-shop", publish: true });
    other = await createShopFixture({ email: "cl-other@example.com", slug: "cl-other", publish: true });
    const pool = getPool();
    await pool.query(`update shops set settings = settings || '{"members_enabled": true, "customer_fields": [{"key": "rank", "label": "rank", "type": "text"}]}' where id = $1`, [f.shopId]);
    lineCid = (await pool.query<{ id: string }>(
      `insert into customers (shop_id, email, name, default_address, attributes, external_ref, marketing_consent, created_at)
       values ($1, 'cl1@example.com', '山田 花子', '{"state": "東京都"}', '{"rank": "gold"}', '{"provider": "crm", "id": "C001"}', true, now() - interval '2 day') returning id`, [f.shopId])).rows[0]!.id;
    plainCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, created_at) values ($1, 'cl2@example.com', now() - interval '1 day') returning id", [f.shopId])).rows[0]!.id;
    await pool.query("insert into customers (shop_id, email) values ($1, 'cl3@example.com')", [other.shopId]);
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', $2, $3)", [f.shopId, UID, lineCid]);
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'google', 'g-sub-1', $2)", [f.shopId, plainCid]);
    // ほかのショップの同じ UID（ショップをまたいで混ざらない）
    const otherCid = (await pool.query<{ id: string }>("select id from customers where shop_id = $1", [other.shopId])).rows[0]!.id;
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', $2, $3)", [other.shopId, UID, otherCid]);
  });
  afterAll(closePool);

  it("スコープ: customers:links だけで読める。customers:read では読めない。知らないスコープは発行できない", async () => {
    const tok = await issue(["customers:links"]);
    expect((await links(tok)).total).toBe(2);
    const readOnly = await issue(["customers:read"]);
    expect(await expectDbError(() => links(readOnly))).toMatch(/unauthorized/);
    const writeOnly = await issue(["customers:write"]);
    expect(await expectDbError(() => links(writeOnly))).toMatch(/unauthorized/);
    expect(await expectDbError(() => issue(["customers:linkz"]))).toMatch(/api_tokens_scopes_valid/);
  });

  it("発行者の項目: customers の無いメンバーは customers:links を付けられない", async () => {
    const noCustomers = await member("cl-int@example.com", ["integrations"]);
    const withCustomers = await member("cl-cust@example.com", ["integrations", "customers"]);
    expect(await expectDbError(() => issue(["customers:links"], noCustomers))).toBeTruthy();
    const tok = await issue(["customers:links"], withCustomers);
    expect((await links(tok)).total).toBe(2);
  });

  it("中身: 5 つの項目だけ・作った順・line_link は HMAC-SHA256 の 16 進・LINE でなければ null・ほかのショップは出ない", async () => {
    const r = await links(await issue(["customers:links"]));
    expect(r).toMatchObject({ total: 2, limit: 100, offset: 0 });
    expect(r.items.map((i) => i["id"])).toEqual([lineCid, plainCid]);
    for (const it of r.items) expect(Object.keys(it).sort()).toEqual(["attributes", "external_ref", "id", "line_link", "updated_at"]);
    expect(r.items[0]!["line_link"]).toBe(createHmac("sha256", Buffer.from(KEY, "utf8")).update(Buffer.from(UID, "utf8")).digest("hex"));
    expect(r.items[0]).toMatchObject({ external_ref: { provider: "crm", id: "C001" }, attributes: { rank: "gold" } });
    expect(r.items[1]).toMatchObject({ line_link: null, external_ref: null, attributes: {} });
    const text = JSON.stringify(r);
    for (const pii of [UID, "@example.com", "山田", "東京都", "marketing_consent", "orders", "g-sub-1"]) expect(text).not.toContain(pii);
  });

  it("鍵は 32〜256 文字。ページ送りと limit の上限", async () => {
    const tok = await issue(["customers:links"]);
    for (const key of [null, "", "x".repeat(31), "x".repeat(257), `${"x".repeat(40)} y`, `${"x".repeat(40)}\u00e9`]) expect(await expectDbError(() => links(tok, key))).toMatch(/invalid_link_key/);
    expect((await links(tok, "x".repeat(256))).total).toBe(2);
    const p2 = await links(tok, KEY, 1, 1);
    expect(p2).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(p2.items.map((i) => i["id"])).toEqual([plainCid]);
    expect((await links(tok, KEY, 1000, -5))).toMatchObject({ limit: 100, offset: 0 });
    expect((await links(tok, KEY, 0, null))).toMatchObject({ limit: 1, offset: 0 });
    expect((await links(tok, KEY, null, 0))).toMatchObject({ limit: 100 });
  });

  it("anon と authenticated は呼べない", async () => {
    const tok = await issue(["customers:links"]);
    expect(await expectDbError(() => asAnon((c) => c.query("select api_customers_links($1, $2, 100, 0)", [tok, KEY])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select api_customers_links($1, $2, 100, 0)", [tok, KEY])))).toMatch(/permission denied/);
  });
});
