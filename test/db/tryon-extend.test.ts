import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/** 0151_tryon_extend: 会員が取り置きの期限を延ばす（回数・日数はショップの設定、休みの日は次の営業日へ、hooks で知らせる） */
describe.skipIf(!dbAvailable)("お店で試着の取り置きの延長（0151）", () => {
  let f: Fixture;
  let store: string;
  let customer: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const extend = (n: number, today = "2030-01-10", epoch = 0) => rpc<J>("member_tryon_extend", [f.shopId, customer, epoch, n, today]);
  const setLimits = (o: J) => getPool().query("update shops set settings = jsonb_set(coalesce(settings, '{}'), '{store_tryon}', $2::jsonb) where id = $1", [f.shopId, JSON.stringify({ max_open_per_customer: 50, ...o })]);
  const row = async (n: number) => (await getPool().query<{ status: string; hold_until: Date; extend_count: number }>("select status, hold_until, extend_count from tryon_requests where shop_id = $1 and number = $2", [f.shopId, n])).rows[0]!;
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const request = async (hold: string | null) => {
    const r = await rpc<{ id: string; number: number }>("tryon_request", [f.shopId, store, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), JSON.stringify({ customer_email: "m@example.com", customer_name: "会員", customer_phone: "0312345678", customer_id: customer }), null]);
    if (hold) await getPool().query("update tryon_requests set status = 'ready', hold_until = $2 where id = $1", [r.id, hold]);
    return r.number;
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "tx@example.com", slug: "tx-shop", publish: true, stock: 20 });
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    // 月〜土が営業、日曜は定休日。2030-01-14（月）は臨時休業
    const hours = JSON.stringify({ "0": [], "1": [["10:00", "20:00"]], "2": [["10:00", "20:00"]], "3": [["10:00", "20:00"]], "4": [["10:00", "20:00"]], "5": [["10:00", "20:00"]], "6": [["10:00", "20:00"]] });
    const special = JSON.stringify([{ date: "2030-01-14", closed: true, hours: [], note: "棚卸し" }]);
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name, hours, special_days) values ($1, '渋谷店', $2::jsonb, $3::jsonb) returning id", [orgId, hours, special]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id, sort_order) values ($1, $2, 0)", [f.shopId, store]));
    await getPool().query("update shops set settings = jsonb_set(coalesce(settings, '{}'), '{modules,store_tryon}', 'true') where id = $1", [f.shopId]);
    customer = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'm@example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{tryon.updated}')", [f.shopId]);
  });
  afterAll(closePool);

  it("既定（extend_max なし）では延ばせない", async () => {
    const n = await request("2030-01-10");
    expect(await extend(n)).toEqual({ ok: false, reason: "limit" });
  });

  it("extend_days 日後。休みの日（日曜・臨時休業）なら次の営業日。回数は extend_max まで。hooks に extended と前の期限", async () => {
    await setLimits({ extend_max: 2, extend_days: 3 });
    const n = await request("2030-01-10"); // 木曜
    // 1/13（日・定休）→ 1/14（月・臨時休業）→ 1/15（火）
    expect(await extend(n)).toEqual({ ok: true, hold_until: "2030-01-15", extend_count: 1 });
    expect(await extend(n)).toEqual({ ok: true, hold_until: "2030-01-18", extend_count: 2 });
    expect(await extend(n)).toEqual({ ok: false, reason: "limit" });
    const r = await row(n);
    expect([r.status, ymd(r.hold_until), r.extend_count]).toEqual(["ready", "2030-01-18", 2]);
    const hook = (await getPool().query<{ payload: J }>("select payload from hook_deliveries where shop_id = $1 and event = 'tryon.updated' order by created_at desc limit 1", [f.shopId])).rows[0]!.payload;
    expect(hook).toMatchObject({ number: n, status: "ready", hold_until: "2030-01-18", extended: true, previous_hold_until: "2030-01-15", extend_count: 2 });
    expect(hook["customer_email"]).toBeUndefined();
  });

  it("取り置き中（ready）で期限が今日か先のものだけ。ほかの会員・古いセッションは断る", async () => {
    await setLimits({ extend_max: 5, extend_days: 1 });
    const past = await request("2030-01-09");
    expect(await extend(past, "2030-01-10")).toEqual({ ok: false, reason: "not_extendable" });
    const requested = await request(null);
    expect(await extend(requested)).toEqual({ ok: false, reason: "not_extendable" });
    const today = await request("2030-01-10");
    expect((await extend(today, "2030-01-10"))["ok"]).toBe(true);
    expect(await extend(today, "2030-01-10", 9)).toEqual({ ok: false, reason: "session" });
    expect(await extend(9999)).toEqual({ ok: false, reason: "not_found" });
  });

  it("会員の一覧に extend_count。service_role だけが呼べる", async () => {
    const list = await rpc<{ number: number; extend_count: number }[]>("member_tryon_requests", [f.shopId, customer, 0]);
    expect(list.every((r) => typeof r.extend_count === "number")).toBe(true);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_tryon_extend($1, $2, 0, 1, '2030-01-10')", [f.shopId, customer])))).toMatch(/permission denied/);
  });
});
