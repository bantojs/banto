import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0044_coupon_brand_payment: クーポンの条件のブランドと支払い方法（AI 用 API と CSV の取り込みの値の検査） */
describe.skipIf(!dbAvailable)("クーポンの条件: ブランドと支払い方法（0044）", () => {
  let a: Fixture;
  let token: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "bp-a@example.com", slug: "bp-a", publish: true, stock: 5 });
    await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true}}'::jsonb where id = $1`, [a.shopId]);
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = createHash("sha256").update(raw).digest("hex");
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["coupons:read", "coupons:write"]]));
  });
  afterAll(closePool);

  it("brands / exclude_brands / payment_methods を受け付け、形の違うものは断る", async () => {
    const r = await rpc<{ conditions: Record<string, unknown> }>("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { brands: [" HANARE ", "HANARE"], exclude_brands: ["Other"], payment_methods: ["komoju:paypay", "stripe", "stripe"] } }]);
    expect(r.conditions["brands"]).toEqual(["HANARE"]);
    expect(r.conditions["exclude_brands"]).toEqual(["Other"]);
    expect([...(r.conditions["payment_methods"] as string[])].sort()).toEqual(["komoju:paypay", "stripe"]);
    expect(await expectDbError(() => rpc("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { payment_methods: ["cod"] } }]))).toMatch(/invalid_conditions_payment_methods/);
    expect(await expectDbError(() => rpc("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { brands: ["x".repeat(101)] } }]))).toMatch(/invalid_conditions_brands/);
  });

  it("CSV の取り込み（import_coupons）も同じ検査を通る", async () => {
    const run = (rows: unknown[]) => asUser(a.ownerId, async (c) => (await c.query<{ r: { status: string; error?: string }[] }>("select import_coupons($1, $2::jsonb, true) as r", [a.shopId, JSON.stringify(rows)])).rows[0]!.r);
    const row = (conditions: Record<string, unknown>) => ({ line: 2, values: { name: "x", code: "BP1", kind: "fixed", value: 100 }, conditions, product_slugs: [], exclude_product_slugs: [], category_slugs: [], exclude_category_slugs: [], member_emails: [] });
    expect((await run([row({ exclude_brands: ["HANARE"], payment_methods: ["komoju"] })]))[0]).toMatchObject({ status: "ok" });
    expect((await run([row({ payment_methods: ["komoju:"] })]))[0]!.error).toMatch(/invalid_conditions_payment_methods/);
  });
});
