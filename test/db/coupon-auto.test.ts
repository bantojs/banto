import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("クーポンの自動発行と先着（0020_coupon_auto）", () => {
  let f: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "a@example.com", slug: "a-shop", publish: true });
  });
  afterAll(closePool);

  const campaign = (fields: string) => asUser(f.ownerId, async (c) => (await c.query<{ id: string }>(`insert into coupon_campaigns (shop_id, name, kind, value, ${fields.split("=")[0]}) values ($1, 'x', 'fixed', 100, ${fields.split("=")[1]}) returning id`, [f.shopId])).rows[0]!.id);
  const grants = async (campaignId: string) => (await getPool().query<{ customer_id: string }>("select customer_id from coupon_grants where campaign_id = $1", [campaignId])).rows;

  it("初めてログインしたときに配る（2 回目のログインでは配らない）", async () => {
    const id = await campaign("auto_grant='first_login'");
    const c = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'new@example.com') returning id", [f.shopId])).rows[0]!.id;
    expect(await grants(id)).toHaveLength(0);
    await getPool().query("update customers set last_login_at = now() where id = $1", [c]);
    await getPool().query("update customers set last_login_at = now() where id = $1", [c]);
    expect(await grants(id)).toEqual([{ customer_id: c }]);
  });

  it("会員の注文が確定したときに配る。使っていないものを持っていれば重ねない。ゲストには配らない", async () => {
    const id = await campaign("auto_grant='after_purchase'");
    const c = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'buyer@example.com') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into orders (shop_id, total_jpy, customer_id, number) values ($1, 1000, $2, 5001)", [f.shopId, c]);
    await getPool().query("insert into orders (shop_id, total_jpy, customer_id, number) values ($1, 1000, $2, 5002)", [f.shopId, c]);
    await getPool().query("insert into orders (shop_id, total_jpy, number) values ($1, 1000, 5003)", [f.shopId]);
    expect(await grants(id)).toEqual([{ customer_id: c }]);
  });

  it("先着: 1 人 1 枚、上限の枚数まで。獲得ページの情報は公開中のショップの獲得できるものだけ", async () => {
    const id = await campaign("claimable,usage_limit=true, 1");
    const info = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select coupon_claim_info($1, $2) as r", [f.shopId, id])).rows[0]!.r);
    expect(info).toMatchObject({ id, live: true, remaining: 1 });
    const m1 = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'c1@example.com') returning id", [f.shopId])).rows[0]!.id;
    const m2 = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'c2@example.com') returning id", [f.shopId])).rows[0]!.id;
    const claim = (m: string, ep = 0) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select member_claim_coupon($1, $2, $3, $4) as r", [f.shopId, m, ep, id])).rows[0]!.r);
    expect(await claim(m1, 5)).toEqual({ ok: false, reason: "session" });
    expect(await claim(m1)).toMatchObject({ ok: true, code: expect.stringMatching(/^[A-Z0-9-]{14}$/) });
    expect(await claim(m1)).toEqual({ ok: false, reason: "already" });
    expect(await claim(m2)).toEqual({ ok: false, reason: "exhausted" });
    expect((await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select coupon_claim_info($1, $2) as r", [f.shopId, id])).rows[0]!.r)).remaining).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select member_claim_coupon($1, $2, 0, $3)", [f.shopId, m2, id])))).toMatch(/permission denied|service_role only/);
  });
});
