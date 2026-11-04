import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0107_mod_event_relay: 運営者の許し（マニフェストの範囲まで）・送り先・列の直接の書き込みの禁止・監査ログ */
describe.skipIf(!dbAvailable)("お店の行動を連携に渡す（0107_mod_event_relay）", () => {
  let a: Fixture;
  let b: Fixture;
  let ep: string;
  let plain: string;

  const set = (uid: string, shopId: string, id: string, grant: unknown) =>
    asUser(uid, async (c) => (await c.query<{ r: unknown }>("select hook_storefront_events_set($1, $2, $3::jsonb) as r", [shopId, id, grant === null ? null : JSON.stringify(grant)])).rows[0]!.r);
  const targets = (shopId: string) => asService(async (c) => (await c.query<{ r: { endpoint_id: string; url: string; grant: { types: string[]; visitors: string } }[] }>("select event_relay_targets($1) as r", [shopId])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "er-a@example.com", slug: "er-a", publish: true });
    b = await createShopFixture({ email: "er-b@example.com", slug: "er-b", publish: true });
    const manifest = { name: "MA", events: [], settings: [], storefront_events: { types: ["product_view", "article_view"], visitors: "members" } };
    ep = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, manifest) values ($1, 'MA', 'https://ma.example.com/hook', '{}', $2) returning id", [a.shopId, manifest])).rows[0]!.id;
    plain = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, manifest) values ($1, 'X', 'https://x.example.com/hook', '{}', $2) returning id", [a.shopId, { name: "X", events: [], settings: [] }])).rows[0]!.id;
  });
  afterAll(closePool);

  it("許せるのはマニフェストが求めた範囲まで（知らない種類・求めていない種類・visitors の all は落とす）", async () => {
    const r = await set(a.ownerId, a.shopId, ep, { types: ["product_view", "cart_add", "nope", "article_view"], visitors: "all" });
    expect(r).toEqual({ types: ["article_view", "product_view"], visitors: "members" });
    expect(await targets(a.shopId)).toEqual([expect.objectContaining({ endpoint_id: ep, url: "https://ma.example.com/hook", grant: { types: ["article_view", "product_view"], visitors: "members" } })]);
    // 求めていない連携には許せない
    expect(await expectDbError(() => set(a.ownerId, a.shopId, plain, { types: ["product_view"], visitors: "members" }))).toMatch(/not_requested/);
    // 監査ログ
    const log = (await getPool().query("select action, detail from audit_log where action = 'app.storefront_events'")).rows;
    expect(log).toHaveLength(1);
  });

  it("マニフェストが狭まれば、渡すときも狭い方。取り消し・無効の連携は送り先から外れる", async () => {
    await getPool().query(`update hook_endpoints set manifest = jsonb_set(manifest, '{storefront_events,types}', '["article_view"]') where id = $1`, [ep]);
    expect((await targets(a.shopId))[0]!.grant.types).toEqual(["article_view"]);
    await getPool().query("update hook_endpoints set enabled = false where id = $1", [ep]);
    expect(await targets(a.shopId)).toEqual([]);
    await getPool().query("update hook_endpoints set enabled = true where id = $1", [ep]);
    expect(await set(a.ownerId, a.shopId, ep, null)).toBeNull();
    expect(await targets(a.shopId)).toEqual([]);
  });

  it("運営者の JWT から列を直接は書けない。ほかのショップ・権限の無い人は書けない。送り先は service_role だけ", async () => {
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query(`update hook_endpoints set storefront_events = '{"types":["product_view"],"visitors":"members"}' where id = $1`, [ep])))).toMatch(/use_hook_storefront_events_set/);
    expect(await expectDbError(() => set(b.ownerId, a.shopId, ep, { types: ["article_view"], visitors: "members" }))).toMatch(/forbidden/);
    expect(await expectDbError(() => set(b.ownerId, b.shopId, ep, { types: ["article_view"], visitors: "members" }))).toMatch(/not_found/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select event_relay_targets($1)", [a.shopId])))).toMatch(/permission denied|service_role only/);
  });
});
