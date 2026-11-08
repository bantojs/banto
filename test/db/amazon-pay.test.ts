import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0130_amazon_pay: 決済プラグインの一覧に amazon_pay、クーポンの条件の支払い方法に amazon_pay */
describe.skipIf(!dbAvailable)("Amazon Pay（0130）", () => {
  let a: Fixture;
  let token: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "apay-a@example.com", slug: "apay-a", publish: true, stock: 5 });
    await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true}}'::jsonb where id = $1`, [a.shopId]);
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = createHash("sha256").update(raw).digest("hex");
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["coupons:read", "coupons:write"]]));
  });
  afterAll(closePool);

  it("shop_payment_options が有効な amazon_pay を返す（設定は返さない鍵を落とす）", async () => {
    await getPool().query(
      `insert into hook_endpoints (shop_id, name, url, events, enabled, settings) values ($1, 'Amazon Pay', 'https://banto.invalid/plugins/amazon_pay', '{}', true, '{"secret_like":"x"}'::jsonb)`,
      [a.shopId],
    );
    const opts = await asAnon(async (c) => (await c.query<{ r: { id: string; settings: Record<string, unknown> }[] }>("select shop_payment_options($1) as r", [a.shopId])).rows[0]!.r);
    expect(opts).toEqual([{ id: "amazon_pay", settings: {} }]);
  });

  it("クーポンの条件の支払い方法に amazon_pay を受け付ける（AI 用 API と CSV の取り込み）", async () => {
    const r = await rpc<{ conditions: Record<string, unknown> }>("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { payment_methods: ["amazon_pay", "stripe"] } }]);
    expect([...(r.conditions["payment_methods"] as string[])].sort()).toEqual(["amazon_pay", "stripe"]);
    expect(await expectDbError(() => rpc("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { payment_methods: ["amazon_pay:card"] } }]))).toMatch(/invalid_conditions_payment_methods/);
    const run = (rows: unknown[]) => asUser(a.ownerId, async (c) => (await c.query<{ r: { status: string; error?: string }[] }>("select import_coupons($1, $2::jsonb, true) as r", [a.shopId, JSON.stringify(rows)])).rows[0]!.r);
    const row = { line: 2, values: { name: "x", code: "AP1", kind: "fixed", value: 100 }, conditions: { payment_methods: ["amazon_pay"] }, product_slugs: [], exclude_product_slugs: [], category_slugs: [], exclude_category_slugs: [], member_emails: [] };
    expect((await run([row]))[0]).toMatchObject({ status: "ok" });
  });
});
