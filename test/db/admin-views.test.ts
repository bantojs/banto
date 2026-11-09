import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0135_admin_views: 一覧のビュー（よく使う条件）。ショップのメンバーで共有し、その画面の項目を持つ人だけが views_set で書く
 */
describe.skipIf(!dbAvailable)("一覧のビュー（0135）", () => {
  let a: Fixture;
  let b: Fixture;
  let shipper: string;
  const set = (uid: string, shopId: string, screen: string, views: unknown) =>
    asUser(uid, async (c) => (await c.query<{ r: unknown }>("select views_set($1, $2, $3::jsonb) as r", [shopId, screen, JSON.stringify(views)])).rows[0]!.r);
  const settings = async (shopId: string) => (await getPool().query<{ settings: Record<string, unknown> }>("select settings from shops where id = $1", [shopId])).rows[0]!.settings;
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, a.shopId, perms]);
    return uid;
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "vw-a@example.com", slug: "vw-a", publish: true });
    b = await createShopFixture({ email: "vw-b@example.com", slug: "vw-b", publish: true });
    shipper = await member("vw-ship@example.com", ["orders"]);
  });
  afterAll(closePool);

  it("その画面の項目だけを持つメンバー（settings の項目なし）が保存でき、その鍵だけが書き換わる。空の値の条件は落とす", async () => {
    await getPool().query("update shops set settings = settings || '{\"shipping\": {\"mode\": \"flat\"}}' where id = $1", [a.shopId]);
    const r = await set(shipper, a.shopId, "orders", [{ name: " 発送待ち ", query: { status: "paid", tag: "" } }, { name: "ギフト", query: { tag: "ギフト", sort: "old" } }]);
    expect(r).toEqual([{ name: "発送待ち", query: { status: "paid" } }, { name: "ギフト", query: { tag: "ギフト", sort: "old" } }]);
    const s = await settings(a.shopId);
    expect(s["views_orders"]).toEqual(r);
    expect(s["shipping"]).toEqual({ mode: "flat" });
    // 空の配列で全部消す
    expect(await set(shipper, a.shopId, "orders", [])).toEqual([]);
  });

  it("ほかの画面・他人のショップ・知らない画面・項目の無い人は断る。anon からは呼べない", async () => {
    expect(await expectDbError(() => set(shipper, a.shopId, "customers", []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => set(b.ownerId, a.shopId, "orders", []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "shops", []))).toMatch(/invalid_screen/);
    expect(await expectDbError(() => asAnon((c) => c.query("select views_set($1, 'orders', '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
    // 項目 orders だけの人が、ほかの鍵を直接書き換えることはできない（RLS で 0 行）
    expect((await asUser(shipper, (c) => c.query("update shops set settings = settings || '{\"views_orders\": []}' where id = $1", [a.shopId]))).rowCount).toBe(0);
  });

  it("形の決まり: 20 個まで・名前 1〜40 字・条件は英小文字の名前と 200 字までの文字だけ（12 個まで）", async () => {
    const one = (q: Record<string, unknown>, name = "v") => [{ name, query: q }];
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, query: {} }))))).toMatch(/invalid_views/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", one({}, "")))).toMatch(/invalid_view_name/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", one({}, "あ".repeat(41))))).toMatch(/invalid_view_name/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", one({ "Bad-Key": "x" })))).toMatch(/invalid_views/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", one({ state: 1 })))).toMatch(/invalid_views/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", one({ q: "x".repeat(201) })))).toMatch(/invalid_views/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, "products", { name: "x" }))).toMatch(/invalid_views/);
    expect(await set(a.ownerId, a.shopId, "products", one({ state: "draft" }, "下書き"))).toEqual([{ name: "下書き", query: { state: "draft" } }]);
  });

  it("お客様の画面に渡す設定には入らない", async () => {
    const pub = (await getPool().query<{ r: Record<string, unknown> }>("select banto_shop_public_settings(settings) as r from shops where id = $1", [a.shopId])).rows[0]!.r;
    expect(Object.keys(pub).filter((k) => k.startsWith("views_"))).toEqual([]);
  });
});
