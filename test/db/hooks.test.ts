import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);

describe.skipIf(!dbAvailable)("hooks（0002_hooks）", () => {
  let f: Fixture;
  let other: Fixture;
  let endpointId: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true, stock: 5 });
    other = await createShopFixture({ email: "other@example.com", slug: "other", publish: true, stock: 5 });
    endpointId = await asUser(f.ownerId, async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into hook_endpoints (shop_id, name, url, events) values ($1, 'crm', 'https://crm.example/hook', $2) returning id",
        [f.shopId, ["order.paid", "inventory.low", "product.updated"]],
      );
      return r.rows[0]!.id;
    });
  });

  beforeEach(async () => {
    await getPool().query("delete from hook_deliveries");
    await getPool().query("delete from order_items");
    await getPool().query("delete from orders");
    await getPool().query("delete from reservations");
    await getPool().query("update inventory set available = 5");
  });

  afterAll(closePool);

  it("RLS: owner は自分の送信先だけ。anon は何も見えない。URL は http(s) のみ", async () => {
    await asUser(other.ownerId, async (c) => {
      const r = await c.query("select id from hook_endpoints");
      expect(r.rows).toHaveLength(0);
    });
    await asAnon(async (c) => {
      const r = await c.query("select count(*)::int as n from hook_endpoints");
      expect(r.rows[0].n).toBe(0);
    });
    const msg = await expectDbError(() =>
      asUser(other.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url) values ($1, 'x', 'https://x.example')", [f.shopId])),
    );
    expect(msg).toMatch(/row-level security/);
    const bad = await expectDbError(() =>
      asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url) values ($1, 'x', 'ftp://x.example')", [f.shopId])),
    );
    expect(bad).toMatch(/check constraint/);
  });

  it("enqueue_hook: 購読している有効な送信先ごとに1行。owner は自ショップのみ、イベント名を検証", async () => {
    const n = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'product.updated', '{\"product_id\":\"p1\"}') as n", [f.shopId])).rows[0]!.n);
    expect(n).toBe(1);
    const zero = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'order.shipped', '{}') as n", [f.shopId])).rows[0]!.n);
    expect(zero).toBe(0); // 購読していない
    const msg = await expectDbError(() => asUser(other.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', '{}')", [f.shopId])));
    expect(msg).toMatch(/shop_not_found/);
    const bad = await expectDbError(() => asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'DROP TABLE', '{}')", [f.shopId])));
    expect(bad).toMatch(/invalid_event/);
    const anon = await expectDbError(() => asAnon((c) => c.query("select enqueue_hook($1, 'product.updated', '{}')", [f.shopId])));
    expect(anon).toMatch(/permission denied/);

    // 無効化した送信先には積まれない
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = false where id = $1", [endpointId]));
    const off = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'product.updated', '{}') as n", [f.shopId])).rows[0]!.n);
    expect(off).toBe(0);
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = true where id = $1", [endpointId]));
  });

  it("confirm_reservation が order.created / order.paid / inventory.low を積む（個人情報は含まない）", async () => {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 3)])).rows[0]!.id);
    const orderId = await asService(async (c) =>
      (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ customer_email: "secret@example.com", customer_name: "秘密", payment_provider: "stripe", payment_ref: "pi_1" })])).rows[0]!.id,
    );
    const rows = await getPool().query<{ event: string; payload: Record<string, unknown> }>("select event, payload from hook_deliveries order by event");
    // order.created は購読していないので積まれない。在庫 5-3=2 <= 3 なので inventory.low
    expect(rows.rows.map((r) => r.event)).toEqual(["inventory.low", "order.paid"]);
    const paid = rows.rows.find((r) => r.event === "order.paid")!.payload;
    expect(paid).toMatchObject({ order_id: orderId, shop_id: f.shopId, total_jpy: 9000, status: "paid", payment_provider: "stripe" });
    expect(JSON.stringify(paid)).not.toContain("secret@example.com");
    expect(JSON.stringify(paid)).not.toContain("秘密");
    const low = rows.rows.find((r) => r.event === "inventory.low")!.payload;
    expect(low).toMatchObject({ sku_id: f.skuId, available: 2, threshold: 3 });

    // owner は配信履歴を読める（他人は読めない）
    await asUser(f.ownerId, async (c) => {
      const r = await c.query("select count(*)::int as n from hook_deliveries");
      expect(r.rows[0].n).toBe(2);
    });
    await asUser(other.ownerId, async (c) => {
      const r = await c.query("select count(*)::int as n from hook_deliveries");
      expect(r.rows[0].n).toBe(0);
    });
  });

  it("claim → finish: 失敗は指数バックオフ、5回で failed。成功は delivered。リース中は再取得されない", async () => {
    await asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', '{\"product_id\":\"p1\"}')", [f.shopId]));

    const claim = () => asService(async (c) => (await c.query<{ id: string; attempts: number; url: string; event: string }>("select * from claim_hook_deliveries(10)")).rows);
    let picked = await claim();
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ attempts: 1, url: "https://crm.example/hook", event: "product.updated" });
    const id = picked[0]!.id;

    // リース中（next_attempt_at が未来）は取れない
    expect(await claim()).toHaveLength(0);

    // 失敗 → 2^1 分後に再送
    await asService((c) => c.query("select finish_hook_delivery($1, false, 500, 'boom')", [id]));
    let row = await getPool().query("select status, attempts, last_status, last_error, next_attempt_at > now() + interval '90 seconds' as later from hook_deliveries where id = $1", [id]);
    expect(row.rows[0]).toMatchObject({ status: "pending", attempts: 1, last_status: 500, last_error: "boom", later: true });

    // 時間を進めたことにして、残り4回失敗させる
    for (let i = 2; i <= 5; i++) {
      await getPool().query("update hook_deliveries set next_attempt_at = now() where id = $1", [id]);
      picked = await claim();
      expect(picked[0]!.attempts).toBe(i);
      await asService((c) => c.query("select finish_hook_delivery($1, false, 502, 'bad gateway')", [id]));
    }
    row = await getPool().query("select status, attempts from hook_deliveries where id = $1", [id]);
    expect(row.rows[0]).toMatchObject({ status: "failed", attempts: 5 });
    await getPool().query("update hook_deliveries set next_attempt_at = now() where id = $1", [id]);
    expect(await claim()).toHaveLength(0); // failed は取り出されない

    // 成功パス
    await asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', '{}')", [f.shopId]));
    picked = await claim();
    await asService((c) => c.query("select finish_hook_delivery($1, true, 200, null)", [picked[0]!.id]));
    row = await getPool().query("select status, delivered_at is not null as done from hook_deliveries where id = $1", [picked[0]!.id]);
    expect(row.rows[0]).toMatchObject({ status: "delivered", done: true });

    // claim / finish は service_role 専用
    const msg = await expectDbError(() => asUser(f.ownerId, (c) => c.query("select * from claim_hook_deliveries(1)")));
    expect(msg).toMatch(/permission denied/);
  });

  it("予約の購入者情報: attach → confirm で orders に移り、予約側は null。解放時も null", async () => {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, f.shopId, JSON.stringify({ customer_email: "k@example.com", customer_name: "小森", shipping_address: { line1: "住所" } })]));
    let r = await getPool().query("select customer from reservations where id = $1", [resId]);
    expect(r.rows[0].customer).toMatchObject({ customer_email: "k@example.com" });
    const orderId = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ payment_provider: "komoju", payment_ref: "pay_1" })])).rows[0]!.id);
    const o = await getPool().query("select customer_email, customer_name, shipping_address, payment_provider from orders where id = $1", [orderId]);
    expect(o.rows[0]).toEqual({ customer_email: "k@example.com", customer_name: "小森", shipping_address: { line1: "住所" }, payment_provider: "komoju" });
    r = await getPool().query("select customer from reservations where id = $1", [resId]);
    expect(r.rows[0].customer).toBeNull();

    const res2 = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, 1)])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [res2, f.shopId, JSON.stringify({ customer_email: "x@example.com" })]));
    await asService((c) => c.query("select release_reservation($1, $2)", [res2, f.shopId]));
    r = await getPool().query("select customer, status from reservations where id = $1", [res2]);
    expect(r.rows[0]).toEqual({ customer: null, status: "released" });

    // 確定済み・他ショップには attach できない
    const msg = await expectDbError(() => asService((c) => c.query("select attach_reservation_customer($1, $2, '{}')", [resId, f.shopId])));
    expect(msg).toMatch(/reservation_not_found/);
    const anon = await expectDbError(() => asAnon((c) => c.query("select attach_reservation_customer($1, $2, '{}')", [resId, f.shopId])));
    expect(anon).toMatch(/permission denied/);
  });

  it("shop_payment_options: 公開ショップの有効な同梱決済プラグインだけ anon から読める", async () => {
    await asUser(f.ownerId, (c) =>
      c.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'KOMOJU', 'https://banto.invalid/plugins/komoju', '{}', '{\"payment_types\":\"konbini\"}')", [f.shopId]),
    );
    const opts = await asAnon(async (c) => (await c.query<{ o: unknown }>("select shop_payment_options($1) as o", [f.shopId])).rows[0]!.o);
    expect(opts).toEqual([{ id: "komoju", settings: { payment_types: "konbini" } }]);
    // 外部送信先は含まれない。無効化すると消える
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = false where url like 'https://banto.invalid/%'"));
    const none = await asAnon(async (c) => (await c.query<{ o: unknown }>("select shop_payment_options($1) as o", [f.shopId])).rows[0]!.o);
    expect(none).toEqual([]);
  });
});
