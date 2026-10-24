import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  asService,
  asUser,
  closePool,
  createShopFixture,
  dbAvailable,
  expectDbError,
  getPool,
  resetDatabase,
  TEST_DB_URL,
  type Fixture,
} from "./harness";

const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);

async function available(skuId: string): Promise<number> {
  const r = await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [skuId]);
  return r.rows[0]!.available;
}

describe.skipIf(!dbAvailable)("在庫 RPC（CLAUDE.md §6）", () => {
  let f: Fixture;
  let sku2: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true, stock: 5 });
    sku2 = await asUser(f.ownerId, async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'TEE-L', 3500) returning id",
        [f.shopId, f.productId],
      );
      await c.query("select set_stock($1, 2)", [r.rows[0]!.id]);
      return r.rows[0]!.id;
    });
  });

  beforeEach(async () => {
    // 各テストの前に在庫を既定値へ戻し、予約を消す
    await getPool().query("delete from order_items");
    await getPool().query("delete from orders");
    await getPool().query("delete from reservations");
    await getPool().query("update inventory set available = case sku_id when $1 then 5 else 2 end", [f.skuId]);
  });

  afterAll(closePool);

  describe("reserve_stock", () => {
    it("在庫を減算し、単価スナップショット付きの予約を返す", async () => {
      const id = await asService(async (c) => {
        const r = await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900) as id", [f.shopId, items(f.skuId, 2)]);
        return r.rows[0]!.id;
      });
      expect(await available(f.skuId)).toBe(3);
      const res = await getPool().query("select status, items, expires_at > now() as alive from reservations where id = $1", [id]);
      expect(res.rows[0].status).toBe("pending");
      expect(res.rows[0].alive).toBe(true);
      expect(res.rows[0].items).toEqual([{ sku_id: f.skuId, qty: 2, unit_price_jpy: 3000 }]);
    });

    it("在庫不足なら例外、複数品目でも全体がロールバックされる", async () => {
      const msg = await expectDbError(() =>
        asService((c) =>
          c.query("select reserve_stock($1, $2::jsonb)", [
            f.shopId,
            JSON.stringify([
              { sku_id: f.skuId, qty: 1 },
              { sku_id: sku2, qty: 3 }, // 在庫 2 なので失敗
            ]),
          ]),
        ),
      );
      expect(msg).toMatch(/insufficient_stock/);
      expect(await available(f.skuId)).toBe(5);
      expect(await available(sku2)).toBe(2);
      const n = await getPool().query("select count(*)::int as n from reservations");
      expect(n.rows[0].n).toBe(0);
    });

    it("他ショップの SKU・非公開商品・不正な数量は受け付けない", async () => {
      const other = await createShopFixture({ email: "other@example.com", slug: "other", publish: true, stock: 10 });
      // 他ショップの SKU を自ショップとして予約しようとする
      let msg = await expectDbError(() => asService((c) => c.query("select reserve_stock($1, $2::jsonb)", [f.shopId, items(other.skuId, 1)])));
      expect(msg).toMatch(/sku_not_available/);
      // 非公開にした商品
      await getPool().query("update products set published = false where id = $1", [other.productId]);
      msg = await expectDbError(() => asService((c) => c.query("select reserve_stock($1, $2::jsonb)", [other.shopId, items(other.skuId, 1)])));
      expect(msg).toMatch(/sku_not_available/);
      // qty 0 / 空配列
      msg = await expectDbError(() => asService((c) => c.query("select reserve_stock($1, $2::jsonb)", [f.shopId, items(f.skuId, 0)])));
      expect(msg).toMatch(/invalid_item/);
      msg = await expectDbError(() => asService((c) => c.query("select reserve_stock($1, '[]'::jsonb)", [f.shopId])));
      expect(msg).toMatch(/empty_items/);
      expect(await available(other.skuId)).toBe(10);
    });

    it("同時購入: 在庫 5 に対して 12 件の同時予約は 5 件だけ成功し、在庫は 0 で止まる", async () => {
      // 各リクエストが独立したコネクション = 独立したトランザクションで走るよう、専用プールを使う
      const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 12 });
      try {
        const attempts = Array.from({ length: 12 }, async () => {
          const c = await pool.connect();
          try {
            await c.query("begin");
            await c.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
            await c.query("set local role service_role");
            await c.query("select reserve_stock($1, $2::jsonb)", [f.shopId, items(f.skuId, 1)]);
            await c.query("commit");
            return "ok" as const;
          } catch (e) {
            await c.query("rollback").catch(() => undefined);
            return e instanceof Error && /insufficient_stock/.test(e.message) ? ("sold_out" as const) : ("error" as const);
          } finally {
            c.release();
          }
        });
        const results = await Promise.all(attempts);
        expect(results.filter((r) => r === "ok")).toHaveLength(5);
        expect(results.filter((r) => r === "sold_out")).toHaveLength(7);
        expect(results.filter((r) => r === "error")).toHaveLength(0);
      } finally {
        await pool.end();
      }
      expect(await available(f.skuId)).toBe(0);
      const n = await getPool().query("select count(*)::int as n from reservations where status = 'pending'");
      expect(n.rows[0].n).toBe(5);
    });
  });

  describe("confirm_reservation", () => {
    const order = {
      customer_email: "buyer@example.com",
      customer_name: "山田 太郎",
      shipping_address: { postal: "100-0001", line1: "東京都千代田区1-1" },
      payment_provider: "stripe",
      payment_ref: "cs_test_123",
    };

    it("予約を注文に変換し、同じ予約 ID では同じ注文 ID を返す（冪等）", async () => {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 2)])).rows[0]!.id);
      const [first, second] = await asService(async (c) => {
        const a = await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify(order)]);
        const b = await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify(order)]);
        return [a.rows[0]!.id, b.rows[0]!.id];
      });
      expect(first).toBe(second);

      const o = await getPool().query("select * from orders where id = $1", [first]);
      expect(o.rows[0]).toMatchObject({ shop_id: f.shopId, status: "paid", total_jpy: 6000, customer_email: order.customer_email, payment_ref: "cs_test_123" });
      expect(o.rows[0].shipping_address).toEqual(order.shipping_address);
      const oi = await getPool().query("select sku_id, qty, unit_price_jpy from order_items where order_id = $1", [first]);
      expect(oi.rows).toEqual([{ sku_id: f.skuId, qty: 2, unit_price_jpy: 3000 }]);
      const res = await getPool().query("select status from reservations where id = $1", [resId]);
      expect(res.rows[0].status).toBe("confirmed");
      expect(await available(f.skuId)).toBe(3); // 確定しても在庫は二重に減らない
      const count = await getPool().query("select count(*)::int as n from orders");
      expect(count.rows[0].n).toBe(1);
    });

    it("別ショップの shop_id では見つからない", async () => {
      const other = await createShopFixture({ email: "x@example.com", slug: "x-shop", publish: true, stock: 1 });
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
      const msg = await expectDbError(() => asService((c) => c.query("select confirm_reservation($1, $2)", [resId, other.shopId])));
      expect(msg).toMatch(/reservation_not_found/);
    });

    it("owner は注文を閲覧・発送済みに更新できる", async () => {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
      const orderId = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify(order)])).rows[0]!.id);
      await asUser(f.ownerId, async (c) => {
        const r = await c.query("update orders set status = 'shipped', shipped_at = now() where id = $1", [orderId]);
        expect(r.rowCount).toBe(1);
        const o = await c.query<{ status: string }>("select status from orders where id = $1", [orderId]);
        expect(o.rows[0]!.status).toBe("shipped");
      });
    });
  });

  describe("release_expired_reservations", () => {
    it("期限切れの pending 予約だけを在庫に戻す", async () => {
      const expired = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 1) as id", [f.shopId, items(f.skuId, 2)])).rows[0]!.id);
      const alive = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
      await getPool().query("update reservations set expires_at = now() - interval '1 second' where id = $1", [expired]);
      expect(await available(f.skuId)).toBe(2);

      const released = await asService(async (c) => (await c.query<{ n: number }>("select release_expired_reservations() as n")).rows[0]!.n);
      expect(released).toBe(1);
      expect(await available(f.skuId)).toBe(4);
      const st = await getPool().query("select id, status from reservations order by created_at");
      expect(Object.fromEntries(st.rows.map((r) => [r.id, r.status]))).toEqual({ [expired]: "released", [alive]: "pending" });

      // 2回目は何も解放しない
      const again = await asService(async (c) => (await c.query<{ n: number }>("select release_expired_reservations() as n")).rows[0]!.n);
      expect(again).toBe(0);
    });

    it("解放後に決済が完了した場合、在庫があれば再度引いて確定し、無ければ例外", async () => {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 1) as id", [f.shopId, items(f.skuId, 3)])).rows[0]!.id);
      await getPool().query("update reservations set expires_at = now() - interval '1 second' where id = $1", [resId]);
      await asService((c) => c.query("select release_expired_reservations()"));
      expect(await available(f.skuId)).toBe(5);

      // 在庫あり → 再予約して確定
      const orderId = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2) as id", [resId, f.shopId])).rows[0]!.id);
      expect(orderId).toBeTruthy();
      expect(await available(f.skuId)).toBe(2);

      // 在庫なし → 例外（呼び出し側が返金する）
      const res2 = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 1) as id", [f.shopId, items(f.skuId, 2)])).rows[0]!.id);
      await getPool().query("update reservations set expires_at = now() - interval '1 second' where id = $1", [res2]);
      await asService((c) => c.query("select release_expired_reservations()"));
      await getPool().query("update inventory set available = 1 where sku_id = $1", [f.skuId]);
      const msg = await expectDbError(() => asService((c) => c.query("select confirm_reservation($1, $2)", [res2, f.shopId])));
      expect(msg).toMatch(/insufficient_stock_after_release/);
      expect(await available(f.skuId)).toBe(1);
    });
  });

  describe("release_reservation", () => {
    it("pending の予約だけ在庫に戻し、2回目や confirmed では false", async () => {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 2)])).rows[0]!.id);
      expect(await available(f.skuId)).toBe(3);
      const first = await asService(async (c) => (await c.query<{ ok: boolean }>("select release_reservation($1, $2) as ok", [resId, f.shopId])).rows[0]!.ok);
      expect(first).toBe(true);
      expect(await available(f.skuId)).toBe(5);
      const again = await asService(async (c) => (await c.query<{ ok: boolean }>("select release_reservation($1, $2) as ok", [resId, f.shopId])).rows[0]!.ok);
      expect(again).toBe(false);
      expect(await available(f.skuId)).toBe(5);

      // 他ショップの id では見つからず false
      const other = await createShopFixture({ email: "rel@example.com", slug: "rel", publish: true, stock: 1 });
      const res2 = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
      const wrong = await asService(async (c) => (await c.query<{ ok: boolean }>("select release_reservation($1, $2) as ok", [res2, other.shopId])).rows[0]!.ok);
      expect(wrong).toBe(false);
      expect(await available(f.skuId)).toBe(4);

      // confirmed 済みは戻さない
      await asService((c) => c.query("select confirm_reservation($1, $2)", [res2, f.shopId]));
      const confirmed = await asService(async (c) => (await c.query<{ ok: boolean }>("select release_reservation($1, $2) as ok", [res2, f.shopId])).rows[0]!.ok);
      expect(confirmed).toBe(false);
      expect(await available(f.skuId)).toBe(4);
    });

    it("anon / owner からは呼べない", async () => {
      const msg = await expectDbError(() => asUser(f.ownerId, (c) => c.query("select release_reservation($1, $2)", ["00000000-0000-0000-0000-000000000000", f.shopId])));
      expect(msg).toMatch(/permission denied/);
    });
  });

  describe("record_webhook_event", () => {
    it("初見は true、2回目以降は false", async () => {
      const [first, second] = await asService(async (c) => {
        const a = await c.query<{ fresh: boolean }>("select record_webhook_event('stripe', 'evt_1') as fresh");
        const b = await c.query<{ fresh: boolean }>("select record_webhook_event('stripe', 'evt_1') as fresh");
        return [a.rows[0]!.fresh, b.rows[0]!.fresh];
      });
      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  describe("個人情報のマスキング（CLAUDE.md §8）", () => {
    async function paidOrder(email: string): Promise<string> {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
      return asService(async (c) =>
        (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [
          resId,
          f.shopId,
          JSON.stringify({ customer_email: email, customer_name: "名前", shipping_address: { line1: "住所" } }),
        ])).rows[0]!.id,
      );
    }

    it("mask_shipped_orders: 発送から既定 180 日を過ぎた注文だけマスクする", async () => {
      const old = await paidOrder("old@example.com");
      const recent = await paidOrder("recent@example.com");
      await getPool().query("update orders set status = 'shipped', shipped_at = now() - interval '200 days' where id = $1", [old]);
      await getPool().query("update orders set status = 'shipped', shipped_at = now() - interval '10 days' where id = $1", [recent]);

      const n = await asService(async (c) => (await c.query<{ n: number }>("select mask_shipped_orders() as n")).rows[0]!.n);
      expect(n).toBe(1);
      const rows = await getPool().query("select id, customer_email, customer_name, shipping_address from orders order by created_at");
      expect(rows.rows.find((r) => r.id === old)).toMatchObject({ customer_email: null, customer_name: "[masked]", shipping_address: null });
      expect(rows.rows.find((r) => r.id === recent)).toMatchObject({ customer_email: "recent@example.com" });

      // 冪等: 2回目は 0 件
      const again = await asService(async (c) => (await c.query<{ n: number }>("select mask_shipped_orders() as n")).rows[0]!.n);
      expect(again).toBe(0);
    });

    it("mask_customer: owner が顧客単位でマスクできる。他人のショップでは不可", async () => {
      await paidOrder("del@example.com");
      await paidOrder("keep@example.com");
      const n = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select mask_customer($1, 'DEL@example.com') as n", [f.shopId])).rows[0]!.n);
      expect(n).toBe(1);
      const emails = await getPool().query<{ customer_email: string | null }>("select customer_email from orders order by customer_email nulls first");
      expect(emails.rows.map((r) => r.customer_email)).toEqual([null, "keep@example.com"]);

      const other = await createShopFixture({ email: "o2@example.com", slug: "o2", publish: false });
      const msg = await expectDbError(() => asUser(other.ownerId, (c) => c.query("select mask_customer($1, 'keep@example.com')", [f.shopId])));
      expect(msg).toMatch(/shop_not_found/);
    });
  });
});
