import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0172_api_order_tracking: AI 用 API の注文の JSON にお問い合わせ番号（tracking）。個人情報ではないので orders:read で返す。
 * 運送会社の名前と照会ページの URL は Worker が足す（DB は carrier と number だけ）
 */
describe.skipIf(!dbAvailable)("AI 用 API の注文のお問い合わせ番号（0172）", () => {
  let f: Fixture;
  let shipped: string;
  let plain: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function issue(scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes]));
    return sha(raw);
  }
  const get = (tok: string, id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_order_get($1, $2) as r", [tok, id])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ot-owner@example.com", slug: "ot-shop", publish: true });
    const pool = getPool();
    shipped = (await pool.query<{ id: string }>(
      "insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref, tracking_carrier, tracking_number) values ($1, 1001, 'shipped', 100, 0, 'a@example.com', '山田', 'stripe', 'pi_a', 'yamato', '123456789012') returning id",
      [f.shopId],
    )).rows[0]!.id;
    plain = (await pool.query<{ id: string }>(
      "insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref, tracking_number) values ($1, 1002, 'shipped', 100, 0, 'b@example.com', '佐藤', 'stripe', 'pi_b', null) returning id",
      [f.shopId],
    )).rows[0]!.id;
  });
  afterAll(closePool);

  it("orders:read だけで tracking が入る（個人情報はマスクのまま）。番号が無ければ null", async () => {
    const tok = await issue(["orders:read"]);
    const r = await get(tok, shipped);
    expect(r["tracking"]).toEqual({ carrier: "yamato", number: "123456789012" });
    expect(r["customer"]).toMatchObject({ masked: true });
    expect((await get(tok, plain))["tracking"]).toBeNull();
  });

  it("運送会社が空なら other", async () => {
    await getPool().query("update orders set tracking_carrier = null, tracking_number = 'ABCD1234' where id = $1", [plain]);
    const tok = await issue(["orders:read"]);
    expect((await get(tok, plain))["tracking"]).toEqual({ carrier: "other", number: "ABCD1234" });
  });

  it("ほかの項目は今までどおり（0157 の手数料・お支払いの状態・印）", async () => {
    const tok = await issue(["orders:read"]);
    const r = await get(tok, shipped);
    for (const k of ["fee_jpy", "payment_status", "paid_at", "cancel_reason", "tags", "items", "discounts"]) expect(r).toHaveProperty(k);
    expect(r).not.toHaveProperty("note");
  });
});
