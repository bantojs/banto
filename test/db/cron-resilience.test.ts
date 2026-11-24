import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0160: 取り出したまま終わらなかった配信を回数で打ち切る。Cron の通信の予算の設定（cron_settings）は service_role だけ */
describe.skipIf(!dbAvailable)("Cron の配信の打ち切り（0160）", () => {
  let f: Fixture;
  let ep: string;
  const add = async (attempts: number, dueAgoSeconds = 1) =>
    (
      await getPool().query<{ id: string }>(
        "insert into hook_deliveries (shop_id, endpoint_id, event, payload, attempts, next_attempt_at) values ($1, $2, 'order.paid', '{}'::jsonb, $3, now() - make_interval(secs => $4)) returning id",
        [f.shopId, ep, attempts, dueAgoSeconds],
      )
    ).rows[0]!.id;
  const row = async (id: string) => (await getPool().query<{ status: string; attempts: number; last_error: string | null }>("select status, attempts, last_error from hook_deliveries where id = $1", [id])).rows[0]!;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cron-owner@example.com", slug: "cron-shop", publish: true });
    ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'img', 'https://plugin.example/hook', '{order.paid}') returning id", [f.shopId]))).rows[0]!.id;
  });
  afterAll(closePool);

  it("回数が 5 に達した pending（終わらなかった配信）は取り出さずに failed。4 回までのものは今までどおり取り出す。まだ時刻の来ていないものは触らない", async () => {
    const stuck = await add(5);
    const fresh = await add(4);
    const later = await add(5, -600);
    const claimed = await asService(async (c) => (await c.query<{ id: string; attempts: number }>("select id, attempts from claim_hook_deliveries(10)")).rows);
    expect(claimed.map((r) => r.id)).toEqual([fresh]);
    expect(claimed[0]!.attempts).toBe(5);
    expect(await row(stuck)).toMatchObject({ status: "failed", attempts: 5 });
    expect((await row(stuck)).last_error).toContain("interrupted");
    expect(await row(later)).toMatchObject({ status: "pending", attempts: 5 });
    // 取り出した 5 回目が失敗で終われば、今までどおり failed（finish_hook_delivery）
    await asService((c) => c.query("select finish_hook_delivery($1, false, 500, 'HTTP 500')", [fresh]));
    expect(await row(fresh)).toMatchObject({ status: "failed" });
  });

  it("release_hook_deliveries: 取り出したが送らなかった配信の回数を戻して、すぐ取り出せるようにする。service_role だけ", async () => {
    const id = await add(1);
    await asService((c) => c.query("select * from claim_hook_deliveries(10)"));
    expect((await row(id)).attempts).toBe(2);
    await asService((c) => c.query("select release_hook_deliveries($1::uuid[])", [[id]]));
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await getPool().query<{ due: boolean }>("select next_attempt_at <= now() as due from hook_deliveries where id = $1", [id])).rows[0]!.due).toBe(true);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select release_hook_deliveries($1::uuid[])", [[id]])))).toMatch(/permission denied/);
  });

  it("image_import_claim: p_limit の数だけ取り出す（渡さなければ今までどおりプランの数）。service_role だけ", async () => {
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"woo_import\":true}}'::jsonb where id = $1", [f.shopId]);
    const product = (await getPool().query<{ id: string }>("select id from products where shop_id = $1 limit 1", [f.shopId])).rows[0]!.id;
    for (let i = 0; i < 5; i++) {
      await getPool().query("insert into image_import_jobs (shop_id, product_id, url) values ($1, $2, $3)", [f.shopId, product, `https://img.example/${i}.jpg`]);
    }
    const got = await asService(async (c) => (await c.query("select * from image_import_claim(2)")).rows);
    expect(got).toHaveLength(2);
    expect((await getPool().query<{ n: number }>("select count(*)::int as n from image_import_jobs where status = 'pending' and attempts = 0")).rows[0]!.n).toBe(3);
    const rest = await asService(async (c) => (await c.query("select * from image_import_claim()")).rows);
    expect(rest).toHaveLength(3);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select * from image_import_claim(1)")))).toMatch(/permission denied/);
  });

  it("cron_settings は service_role だけ。workers_plan を返す（既定は free）", async () => {
    expect(await asService(async (c) => (await c.query<{ s: Record<string, unknown> }>("select cron_settings() as s")).rows[0]!.s)).toEqual({ workers_plan: "free" });
    await getPool().query("update banto_site_settings set settings = settings || '{\"workers_plan\":\"paid\"}'::jsonb");
    expect(await asService(async (c) => (await c.query<{ s: Record<string, unknown> }>("select cron_settings() as s")).rows[0]!.s)).toEqual({ workers_plan: "paid" });
    expect(await expectDbError(() => asAnon((c) => c.query("select cron_settings()")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select cron_settings()")))).toMatch(/permission denied/);
  });
});
