import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0135_admin_views: 一覧のビュー（よく使う条件）。ショップのメンバーで共有し、その画面の項目を持つ人だけが views_add / views_remove で書く。
 * 並びは DB の中で今の値を読み直して直す。1 画面のビュー全体は 8 KiB まで
 */
describe.skipIf(!dbAvailable)("一覧のビュー（0135）", () => {
  let a: Fixture;
  let b: Fixture;
  let shipper: string;
  const add = (uid: string, shopId: string, screen: string, name: string, query: unknown) =>
    asUser(uid, async (c) => (await c.query<{ r: unknown }>("select views_add($1, $2, $3, $4::jsonb) as r", [shopId, screen, name, JSON.stringify(query)])).rows[0]!.r);
  const remove = (uid: string, shopId: string, screen: string, name: string) =>
    asUser(uid, async (c) => (await c.query<{ r: unknown }>("select views_remove($1, $2, $3) as r", [shopId, screen, name])).rows[0]!.r);
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

  it("その画面の項目だけを持つメンバー（settings の項目なし）が足し・消せ、その鍵だけが変わる。同じ名前は置き換え、空の値の条件は落とす", async () => {
    await getPool().query("update shops set settings = settings || '{\"shipping\": {\"mode\": \"flat\"}}' where id = $1", [a.shopId]);
    await add(shipper, a.shopId, "orders", " 発送待ち ", { status: "paid", tag: "" });
    const r = await add(shipper, a.shopId, "orders", "ギフト", { tag: "ギフト", sort: "old" });
    expect(r).toEqual([{ name: "発送待ち", query: { status: "paid" } }, { name: "ギフト", query: { tag: "ギフト", sort: "old" } }]);
    // 同じ名前は置き換えて最後へ
    expect(await add(shipper, a.shopId, "orders", "発送待ち", { status: "shipped" })).toEqual([{ name: "ギフト", query: { tag: "ギフト", sort: "old" } }, { name: "発送待ち", query: { status: "shipped" } }]);
    const s = await settings(a.shopId);
    expect(s["shipping"]).toEqual({ mode: "flat" });
    expect(await remove(shipper, a.shopId, "orders", "ギフト")).toEqual([{ name: "発送待ち", query: { status: "shipped" } }]);
    expect(await remove(shipper, a.shopId, "orders", "無い名前")).toEqual([{ name: "発送待ち", query: { status: "shipped" } }]);
    await remove(shipper, a.shopId, "orders", "発送待ち");
    expect((await settings(a.shopId))["views_orders"]).toEqual([]);
  });

  it("ほかの人が同時に足しても消えない（並びは DB の中で今の値から作る）", async () => {
    const owner = a.ownerId;
    await Promise.all(Array.from({ length: 6 }, (_, i) => add(i % 2 ? owner : shipper, a.shopId, "orders", `v${i}`, { status: "paid" })));
    const names = ((await settings(a.shopId))["views_orders"] as { name: string }[]).map((v) => v.name).sort();
    expect(names).toEqual(["v0", "v1", "v2", "v3", "v4", "v5"]);
    for (const n of names) await remove(owner, a.shopId, "orders", n);
  });

  it("ほかの画面・他人のショップ・知らない画面・項目の無い人は断る。anon からは呼べない", async () => {
    expect(await expectDbError(() => add(shipper, a.shopId, "customers", "x", {}))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => remove(shipper, a.shopId, "customers", "x"))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => add(b.ownerId, a.shopId, "orders", "x", {}))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "shops", "x", {}))).toMatch(/invalid_screen/);
    expect(await expectDbError(() => asAnon((c) => c.query("select views_add($1, 'orders', 'x', '{}'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select views_remove($1, 'orders', 'x')", [a.shopId])))).toMatch(/permission denied/);
    // 項目 orders だけの人が、ほかの鍵を直接書き換えることはできない（RLS で 0 行）
    expect((await asUser(shipper, (c) => c.query("update shops set settings = settings || '{\"views_orders\": []}' where id = $1", [a.shopId]))).rowCount).toBe(0);
  });

  it("形の決まり: 20 個まで・名前 1〜40 字・条件は英小文字の名前と 100 字までの文字だけ（12 個まで）", async () => {
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "", {}))).toMatch(/invalid_view_name/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "あ".repeat(41), {}))).toMatch(/invalid_view_name/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "v", { "Bad-Key": "x" }))).toMatch(/invalid_views/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "v", { state: 1 }))).toMatch(/invalid_views/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "v", { q: "x".repeat(101) }))).toMatch(/invalid_views/);
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "v", Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "x"]))))).toMatch(/invalid_views/);
    for (let i = 0; i < 20; i++) await add(a.ownerId, a.shopId, "products", `v${i}`, { state: "draft" });
    expect(await expectDbError(() => add(a.ownerId, a.shopId, "products", "v20", {}))).toMatch(/views_full/);
    // 同じ名前の置き換えは 20 個でもできる
    expect(((await add(a.ownerId, a.shopId, "products", "v0", { state: "published" })) as unknown[]).length).toBe(20);
    for (let i = 0; i < 20; i++) await remove(a.ownerId, a.shopId, "products", `v${i}`);
  });

  it("大きさ: 1 画面のビュー全体は 8 KiB まで（権限の低いメンバーがビューだけで設定全体の上限を埋められない）", async () => {
    const big = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "x".repeat(100)]));
    let n = 0;
    const err = await expectDbError(async () => {
      for (; n < 20; n++) await add(shipper, a.shopId, "orders", `big${n}`, big);
    });
    expect(err).toMatch(/views_too_large/);
    expect(n).toBeGreaterThan(0);
    const views = (await settings(a.shopId))["views_orders"] as unknown[];
    expect(Buffer.byteLength(JSON.stringify(views))).toBeLessThanOrEqual(8192 + 1024);
    // 4 画面ぶん埋めても、設定全体の上限（64 KiB）まで余裕が残る
    expect(views.length).toBeLessThan(20);
  });

  it("お客様の画面に渡す設定には入らない", async () => {
    const pub = (await getPool().query<{ r: Record<string, unknown> }>("select banto_shop_public_settings(settings) as r from shops where id = $1", [a.shopId])).rows[0]!.r;
    expect(Object.keys(pub).filter((k) => k.startsWith("views_"))).toEqual([]);
  });
});
