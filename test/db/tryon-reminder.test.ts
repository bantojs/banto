import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/** 0152_tryon_reminder: 来店期限の前日のお知らせ（ショップの時刻の設定・1 回だけ・取り置きを始めて 24 時間たっていないものは送らない） */
describe.skipIf(!dbAvailable)("お店で試着の前日のお知らせ（0152）", () => {
  let f: Fixture;
  let store: string;
  const remind = (today: string, hour: number) => asService(async (c) => (await c.query<{ n: number }>("select tryon_remind($1, $2) as n", [today, hour])).rows[0]!.n);
  const setTryon = (o: J) => getPool().query("update shops set settings = jsonb_set(coalesce(settings, '{}'), '{store_tryon}', $2::jsonb) where id = $1", [f.shopId, JSON.stringify({ max_open_per_customer: 50, ...o })]);
  const request = async (hold: string, readyHoursAgo = 48) => {
    const r = await asService(async (c) => (await c.query<{ r: { id: string; number: number } }>("select tryon_request($1, $2, $3::jsonb, $4::jsonb, null) as r", [f.shopId, store, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), JSON.stringify({ customer_email: "m@example.com", customer_name: "会員", customer_phone: "0312345678" })])).rows[0]!.r);
    await getPool().query("update tryon_requests set status = 'ready', hold_until = $2 where id = $1", [r.id, hold]);
    await getPool().query("update tryon_requests set ready_at = now() - make_interval(hours => $2) where id = $1", [r.id, readyHoursAgo]);
    return r;
  };
  const hooks = async () => (await getPool().query<{ payload: J }>("select payload from hook_deliveries where shop_id = $1 and event = 'tryon.updated' and payload ? 'reminder' order by created_at", [f.shopId])).rows.map((x) => x.payload);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "trm@example.com", slug: "trm-shop", publish: true, stock: 20 });
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '渋谷店') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id, sort_order) values ($1, $2, 0)", [f.shopId, store]));
    await getPool().query("update shops set settings = coalesce(settings, '{}') || jsonb_build_object('modules', coalesce(settings->'modules', '{}') || '{\"store_tryon\": true}') where id = $1", [f.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{tryon.updated}')", [f.shopId]);
  });
  afterAll(closePool);

  it("取り置きを始めたとき ready_at が入る（状態が ready になったときだけ）", async () => {
    const r = await asService(async (c) => (await c.query<{ r: { id: string } }>("select tryon_request($1, $2, $3::jsonb, $4::jsonb, null) as r", [f.shopId, store, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), JSON.stringify({ customer_email: "a@example.com", customer_name: "a", customer_phone: "0312345678" })])).rows[0]!.r);
    const at = async () => (await getPool().query<{ ready_at: Date | null }>("select ready_at from tryon_requests where id = $1", [r.id])).rows[0]!.ready_at;
    expect(await at()).toBeNull();
    await getPool().query("update tryon_requests set status = 'ready', hold_until = '2030-01-11' where id = $1", [r.id]);
    expect(await at()).not.toBeNull();
    await getPool().query("update tryon_requests set status = 'cancelled' where id = $1", [r.id]);
  });

  it("設定が無ければ送らない。時刻になるまで送らない。期限が明日の取り置きに 1 回だけ。24 時間たっていないものは送らない", async () => {
    const due = await request("2030-01-11");
    const fresh = await request("2030-01-11", 2);
    const later = await request("2030-01-12");
    expect(await remind("2030-01-10", 23)).toBe(0);
    await setTryon({ reminder_hour: 18 });
    expect(await remind("2030-01-10", 17)).toBe(0);
    expect(await remind("2030-01-10", 18)).toBe(1);
    expect(await remind("2030-01-10", 19)).toBe(0);
    const sent = await hooks();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ number: due.number, status: "ready", hold_until: "2030-01-11", reminder: true });
    expect(sent[0]!["customer_email"]).toBeUndefined();
    void fresh;
    void later;
  });

  it("設定の時刻から 3 時間のあいだだけ（遅れて夜中に送らない）。数でない時刻の設定は送らない", async () => {
    await setTryon({ reminder_hour: 9 });
    const r = await request("2030-03-11");
    expect(await remind("2030-03-10", 12)).toBe(0);
    expect(await remind("2030-03-10", 11)).toBe(1);
    await setTryon({ reminder_hour: "9" });
    await request("2030-03-11");
    expect(await remind("2030-03-10", 10)).toBe(0);
    void r;
  });

  it("モジュールが OFF なら送らない。service_role だけが呼べる", async () => {
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules,store_tryon}', 'false') where id = $1", [f.shopId]);
    await request("2030-02-11");
    expect(await remind("2030-02-10", 23)).toBe(0);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select tryon_remind('2030-02-10', 23)")))).toMatch(/permission denied/);
  });
});
