import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("配送の指定（0018_delivery）", () => {
  let f: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "dl@example.com", slug: "dl-shop", publish: true, stock: 5 });
  });
  afterAll(closePool);

  const reserve = () => asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
  const confirm = (id: string) => asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [id, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${id}` })])).rows[0]!.id);

  it("予約の customer.delivery を注文に写す。無ければ null", async () => {
    const r1 = await reserve();
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r1, f.shopId, JSON.stringify({ customer_email: "a@example.com", customer_name: "A", shipping_address: { state: "東京都" }, shipping_jpy: 0, delivery: { date: "2026-10-20", slot: "am" } })]));
    const o1 = await confirm(r1);
    expect((await getPool().query("select delivery from orders where id = $1", [o1])).rows[0].delivery).toEqual({ date: "2026-10-20", slot: "am" });

    const r2 = await reserve();
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r2, f.shopId, JSON.stringify({ customer_email: "b@example.com", customer_name: "B", shipping_address: { state: "東京都" }, shipping_jpy: 0 })]));
    const o2 = await confirm(r2);
    expect((await getPool().query("select delivery from orders where id = $1", [o2])).rows[0].delivery).toBeNull();
  });
});
