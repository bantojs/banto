import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0049_coupon_attributes: クーポンの条件に会員の独自項目（customers.attributes、0047）。
 * - 値の検査（banto_api_coupon_apply）: 定義にある鍵だけ、select は選択肢の中、個数と長さ
 * - coupon_lookup が p_customer_id を受け、各行にその会員の attributes を載せる。判定は src/commerce/discounts.ts（test/discounts.test.ts）
 */
describe.skipIf(!dbAvailable)("クーポンの条件: 会員の独自項目（0049）", () => {
  let a: Fixture;
  let token: string;
  let memberId: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const create = (conditions: Record<string, unknown>) => rpc<{ conditions: Record<string, unknown> }>("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions }]);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ca-a@example.com", slug: "ca-a", publish: true, stock: 5 });
    await getPool().query(
      `update shops set settings = settings || $2::jsonb where id = $1`,
      [a.shopId, JSON.stringify({ modules: { coupons: true }, members_enabled: true, customer_fields: [{ key: "rank", label: "会員ランク", type: "select", options: ["regular", "silver", "gold"] }, { key: "owner", label: "担当者", type: "text" }, { key: "score", label: "スコア", type: "number" }] })],
    );
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = createHash("sha256").update(raw).digest("hex");
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["coupons:read", "coupons:write", "customers:write"]]));
    memberId = (await rpc<{ id: string }>("api_customer_create", [token, { email: "gold@example.com", attributes: { rank: "gold", score: 12 } }])).id;
  });
  afterAll(closePool);

  it("attributes を受け付ける: 定義にある鍵だけ、select は選択肢の中、値は文字列か数で前後の空白を落として重複を除く", async () => {
    const r = await create({ attributes: { rank: [" gold ", "silver", "gold"], owner: ["田中"], score: [12, "15"] } });
    expect(r.conditions["attributes"]).toEqual({ rank: ["gold", "silver"], owner: ["田中"], score: ["12", "15"] });
    // 空の配列・null の鍵は条件なし
    expect((await create({ attributes: { rank: [], owner: null } })).conditions["attributes"]).toBeUndefined();
    expect(await expectDbError(() => create({ attributes: { nope: ["x"] } }))).toMatch(/invalid_conditions_attributes_nope/);
    expect(await expectDbError(() => create({ attributes: { rank: ["platinum"] } }))).toMatch(/invalid_conditions_attributes_rank/);
    expect(await expectDbError(() => create({ attributes: { rank: "gold" } }))).toMatch(/invalid_conditions_attributes_rank/);
    expect(await expectDbError(() => create({ attributes: ["rank"] }))).toMatch(/invalid_conditions_attributes/);
    expect(await expectDbError(() => create({ attributes: { owner: ["x".repeat(101)] } }))).toMatch(/invalid_conditions_attributes_owner/);
    expect(await expectDbError(() => create({ attributes: { owner: Array.from({ length: 21 }, (_, i) => `v${i}`) } }))).toMatch(/invalid_conditions_attributes_owner/);
    expect(await expectDbError(() => create({ attributes: { owner: [true] } }))).toMatch(/invalid_conditions_attributes_owner/);
  });

  it("CSV の取り込み（import_coupons）も同じ検査を通る", async () => {
    const run = (rows: unknown[]) => asUser(a.ownerId, async (c) => (await c.query<{ r: { status: string; error?: string }[] }>("select import_coupons($1, $2::jsonb, true) as r", [a.shopId, JSON.stringify(rows)])).rows[0]!.r);
    const row = (code: string, conditions: Record<string, unknown>) => ({ line: 2, values: { name: "x", code, kind: "fixed", value: 100 }, conditions, product_slugs: [], exclude_product_slugs: [], category_slugs: [], exclude_category_slugs: [], member_emails: [] });
    expect((await run([row("CA1", { attributes: { rank: ["gold"] } })]))[0]).toMatchObject({ status: "ok" });
    expect((await run([row("CA2", { attributes: { rank: ["platinum"] } })]))[0]!.error).toMatch(/invalid_conditions_attributes_rank/);
  });

  it("coupon_lookup: p_customer_id を渡すと各行にその会員の attributes が載る。渡さなければ null。他のショップの会員・無い会員は null。3 引数でも呼べる", async () => {
    await rpc("api_coupon_create", [token, { name: "lookup", code: "CA1", kind: "percent", value: 10, conditions: { attributes: { rank: ["gold"] } } }]);
    const lookup = (customerId: string | null) => asService(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select coupon_lookup($1, $2::text[], $3, $4) as r", [a.shopId, ["CA1"], `c:${memberId}`, customerId])).rows[0]!.r);
    const withMember = await lookup(memberId);
    expect(withMember).toHaveLength(1);
    expect(withMember[0]!["customer_attributes"]).toEqual({ rank: "gold", score: 12 });
    expect((await lookup(null))[0]!["customer_attributes"]).toBeNull();
    expect((await lookup(a.shopId))[0]!["customer_attributes"]).toBeNull();
    const three = await asService(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select coupon_lookup($1, $2::text[], $3) as r", [a.shopId, ["CA1"], null])).rows[0]!.r);
    expect(three[0]!["customer_attributes"]).toBeNull();
    expect(await expectDbError(() => asAnon((c) => c.query("select coupon_lookup($1, $2::text[], null, $3)", [a.shopId, ["CA1"], memberId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select coupon_lookup($1, $2::text[], null, $3)", [a.shopId, ["CA1"], memberId])))).toMatch(/permission denied/);
  });
});
