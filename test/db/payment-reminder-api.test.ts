import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0182_api_payment_reminder: お支払いのお願いの中身を AI 用 API で読む（orders:read、宛先は orders:contact / orders:pii） */
describe.skipIf(!dbAvailable)("お支払いのお願いの中身の API（0182）", () => {
  let f: Fixture;
  let other: Fixture;
  let rid: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function issue(scopes: string[], fx: Fixture = f) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(fx.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [fx.shopId, fx.ownerId, sha(raw), raw.slice(0, 12), scopes]));
    return sha(raw);
  }
  const get = (tok: string, id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_reservation_payment_reminder($1, $2) as r", [tok, id])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pra-owner@example.com", slug: "pra-shop", publish: true, stock: 10 });
    other = await createShopFixture({ email: "pra-other@example.com", slug: "pra-other", publish: true, stock: 10 });
    rid = (await asService((c) => c.query<{ r: string }>("select reserve_stock($1, $2::jsonb, 3600, 'q-pra-0001', $3, null) as r", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 2 }]), sha("x")]))).rows[0]!.r;
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [rid, f.shopId, JSON.stringify({ customer_email: "buyer@example.com", customer_name: "山田", shipping_address: { state: "東京都", line1: "一丁目" } })]));
    await asService((c) => c.query("select reservation_set_payment_session($1, $2, '{\"provider\":\"komoju\",\"id\":\"ses_1\"}'::jsonb, null)", [rid, f.shopId]));
  });
  afterAll(closePool);

  it("orders:read で品目・合計・期限。宛先・お名前は orders:contact / orders:pii だけ。住所は返さない", async () => {
    const plain = await get(await issue(["orders:read"]), rid);
    expect(plain).toMatchObject({ reservation_id: rid, total_jpy: expect.any(Number), expires_at: expect.any(String), items: [{ qty: 2, unit_price_jpy: expect.any(Number), sku_code: expect.any(String) }] });
    expect(plain).not.toHaveProperty("email");
    expect(JSON.stringify(plain)).not.toMatch(/buyer@example\.com|山田|一丁目|東京都/);
    for (const scopes of [["orders:read", "orders:contact"], ["orders:read", "orders:pii"]]) {
      const r = await get(await issue(scopes), rid);
      expect(r).toMatchObject({ email: "buyer@example.com", name: "山田" });
      expect(JSON.stringify(r)).not.toMatch(/一丁目|東京都/);
    }
    // orders:address だけでは宛先を返さない
    expect(await get(await issue(["orders:read", "orders:address"]), rid)).not.toHaveProperty("email");
  });

  it("ほかのショップのトークン・スコープ無し・払えない予約は断る", async () => {
    expect(await expectDbError(() => get(sha("nope"), rid))).toMatch(/invalid_token|unauthorized|token/);
    expect(await expectDbError(async () => get(await issue(["products:read"]), rid))).toMatch(/unauthorized|scope|forbidden/);
    expect(await expectDbError(async () => get(await issue(["orders:read"], other), rid))).toMatch(/not_found/);
    await asService((c) => c.query("select release_reservation($1, $2)", [rid, f.shopId]));
    expect(await expectDbError(async () => get(await issue(["orders:read"]), rid))).toMatch(/not_found/);
  });

  it("service_role 専用（anon・運営者からは呼べない）", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select api_reservation_payment_reminder('x', $1)", [rid])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select api_reservation_payment_reminder('x', $1)", [rid])))).toMatch(/permission denied/);
    expect((await getPool().query("select 1")).rowCount).toBe(1);
  });
});
