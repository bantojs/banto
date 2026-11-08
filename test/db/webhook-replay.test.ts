import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIRM_SQL, asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0128_webhook_replay: Webhook の再配信で、返金済みの決済が注文にならない。
 * - webhook_event_seen: 記録済みのイベントか
 * - reservation_mark_refunded: 返金すると決めたことを返金の前に残す（pending なら在庫も戻す）。同じイベント / 別のイベントの区別
 * - confirm_reservation: refunded の予約は reservation_refunded（detail に決めたときのイベント）
 */
describe.skipIf(!dbAvailable)("Webhook の再配信（0128_webhook_replay）", () => {
  let f: Fixture;

  const items = (qty: number) => JSON.stringify([{ sku_id: f.skuId, qty }]);
  const reserve = (qty: number) =>
    asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, null, null, null) as id", [f.shopId, items(qty)])).rows[0]!.id);
  const release = (id: string) => asService((c) => c.query("select release_reservation($1, $2)", [id, f.shopId]));
  const confirm = (id: string) =>
    asService(async (c) => (await c.query<{ id: string }>(CONFIRM_SQL, [id, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${id}` })])).rows[0]!.id);
  const mark = (id: string, provider: string, event: string) =>
    asService(async (c) => (await c.query<{ r: string }>("select reservation_mark_refunded($1, $2, $3, $4) as r", [id, f.shopId, provider, event])).rows[0]!.r);
  const seen = (provider: string, event: string) =>
    asService(async (c) => (await c.query<{ r: boolean }>("select webhook_event_seen($1, $2) as r", [provider, event])).rows[0]!.r);
  const record = (provider: string, event: string) =>
    asService(async (c) => (await c.query<{ r: boolean }>("select record_webhook_event($1, $2) as r", [provider, event])).rows[0]!.r);
  const available = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
  const status = async (id: string) => (await getPool().query<{ status: string; refund_event: string | null }>("select status, refund_event from reservations where id = $1", [id])).rows[0]!;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "replay-shop", publish: true, stock: 5 });
  });
  afterAll(closePool);

  it("記録済みのイベントは webhook_event_seen が true（記録の前は false）", async () => {
    expect(await seen("stripe", "evt_seen_1")).toBe(false);
    expect(await record("stripe", "evt_seen_1")).toBe(true);
    expect(await seen("stripe", "evt_seen_1")).toBe(true);
    expect(await record("stripe", "evt_seen_1")).toBe(false);
    expect(await seen("komoju", "evt_seen_1")).toBe(false);
  });

  it("解放済みの予約を返金すると決めたら refunded になり、在庫が戻っていても二度と確定しない（detail に決めたときのイベント）", async () => {
    const id = await reserve(2);
    await release(id);
    expect(await available()).toBe(5);
    expect(await mark(id, "stripe", "evt_1")).toBe("marked");
    expect(await status(id)).toEqual({ status: "refunded", refund_event: "stripe:evt_1" });
    // 在庫はある（他の人に渡って戻った）のに、確定しない
    const err = await asService(async (c) => {
      try {
        await c.query(CONFIRM_SQL, [id, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_x" })]);
        return null;
      } catch (e) {
        return e as { message: string; detail?: string };
      }
    });
    expect(err?.message).toBe("reservation_refunded");
    expect(err?.detail).toBe("stripe:evt_1");
    expect(await available()).toBe(5);
    expect((await getPool().query("select 1 from orders where reservation_id = $1", [id])).rowCount).toBe(0);
    // 同じイベントなら same_event（返金をやり直してよい）、別のイベントなら other_event（返金しない）
    expect(await mark(id, "stripe", "evt_1")).toBe("same_event");
    expect(await mark(id, "stripe", "evt_2")).toBe("other_event");
    expect(await mark(id, "komoju", "evt_1")).toBe("other_event");
    expect(await status(id)).toEqual({ status: "refunded", refund_event: "stripe:evt_1" });
  });

  it("生きている予約（支払額の不一致）を返金すると決めたら、在庫を戻してから refunded にする", async () => {
    const id = await reserve(3);
    expect(await available()).toBe(2);
    expect(await mark(id, "komoju", "evt_k1")).toBe("marked");
    expect(await available()).toBe(5);
    expect(await status(id)).toEqual({ status: "refunded", refund_event: "komoju:evt_k1" });
    // 解放の関数は refunded の予約に触らない
    const released = await asService(async (c) => (await c.query<{ r: boolean }>("select release_reservation($1, $2) as r", [id, f.shopId])).rows[0]!.r);
    expect(released).toBe(false);
    expect(await available()).toBe(5);
  });

  it("確定済みの予約は返金すると決められない（reservation_confirmed）。無い予約・空のイベントも断る", async () => {
    const id = await reserve(1);
    const orderId = await confirm(id);
    expect(orderId).toBeTruthy();
    expect(await expectDbError(() => mark(id, "stripe", "evt_c"))).toBe("reservation_confirmed");
    expect(await confirm(id)).toBe(orderId); // 同じ予約には同じ注文
    expect(await expectDbError(() => mark("00000000-0000-0000-0000-000000000000", "stripe", "evt_c"))).toBe("reservation_not_found");
    expect(await expectDbError(() => mark(id, "", "evt_c"))).toBe("invalid_event");
  });

  it("service_role だけが呼べる", async () => {
    const id = await reserve(1);
    for (const run of [asAnon, (fn: Parameters<typeof asUser>[1]) => asUser(f.ownerId, fn)]) {
      const e1 = await expectDbError(() => run((c) => c.query("select webhook_event_seen('stripe', 'x')")));
      expect(e1).toMatch(/service_role only|permission denied/);
      const e2 = await expectDbError(() => run((c) => c.query("select reservation_mark_refunded($1, $2, 'stripe', 'x')", [id, f.shopId])));
      expect(e2).toMatch(/service_role only|permission denied/);
    }
  });
});
