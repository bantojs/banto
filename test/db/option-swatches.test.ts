import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0115_option_swatches: 選択肢の値ごとの見本（形・上限・鍵の場所・権限・公開のショップ行） */
describe.skipIf(!dbAvailable)("選択肢の見本（0115）", () => {
  let a: Fixture;
  let b: Fixture;
  const set = (uid: string, shopId: string, axis: string, values: unknown) =>
    asUser(uid, async (c) => (await c.query<{ r: { swatches: Record<string, unknown>; removed_image_keys: string[] } }>("select option_swatches_set($1, $2, $3) as r", [shopId, axis, JSON.stringify(values)])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "sw-a@example.com", slug: "sw-a", publish: true });
    b = await createShopFixture({ email: "sw-b@example.com", slug: "sw-b", publish: true });
    await getPool().query(`update shops set option_names = '{"color":"カラー","size":"サイズ"}' where id in ($1, $2)`, [a.shopId, b.shopId]);
  });
  afterAll(closePool);

  it("色と画像を置け、公開のショップ行に出る。差し替えで使われなくなった画像の鍵を返す", async () => {
    const img = (n: string) => ({ image: { key: `swatches/${a.shopId}/${n}.webp`, width: 96, height: 96 } });
    let r = await set(a.ownerId, a.shopId, "color", { ネイビー: { color: "#1f2a44" }, チェック: img("0123456789abcdef") });
    expect(r.swatches).toEqual({ ネイビー: { color: "#1f2a44" }, チェック: img("0123456789abcdef") });
    expect(r.removed_image_keys).toEqual([]);
    const pub = (await asAnon((c) => c.query<{ s: { option_swatches: Record<string, unknown> } }>("select shop_public_get('sw-a') as s"))).rows[0]!.s;
    expect(pub.option_swatches).toEqual({ color: { ネイビー: { color: "#1f2a44" }, チェック: img("0123456789abcdef") } });
    r = await set(a.ownerId, a.shopId, "color", { ネイビー: { color: "#1f2a44" }, チェック: img("fedcba9876543210") });
    expect(r.removed_image_keys).toEqual([`swatches/${a.shopId}/0123456789abcdef.webp`]);
    // 空にすると軸ごと外し、画像の鍵を返す
    r = await set(a.ownerId, a.shopId, "color", {});
    expect(r.removed_image_keys).toEqual([`swatches/${a.shopId}/fedcba9876543210.webp`]);
    expect((await getPool().query("select option_swatches from shops where id = $1", [a.shopId])).rows[0].option_swatches).toEqual({});
  });

  it("形の違う値・名前の表に無い軸・よそのショップの画像・大きすぎる画像は断る", async () => {
    const bad = (axis: string, values: unknown) => expectDbError(() => set(a.ownerId, a.shopId, axis, values));
    expect(await bad("color", { ネイビー: { color: "navy" } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { ネイビー: { color: "#1F2A44" } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { ネイビー: { color: "#1f2a44", image: { key: `swatches/${a.shopId}/0123456789abcdef.webp`, width: 1, height: 1 } } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { x: { image: { key: `swatches/${b.shopId}/0123456789abcdef.webp`, width: 96, height: 96 } } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { x: { image: { key: `swatches/${a.shopId}/0123456789abcdef.webp`, width: 1024, height: 96 } } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { x: { image: { key: `swatches/${a.shopId}/0123456789abcdef.webp` } } })).toMatch(/invalid_option_swatches/);
    expect(await bad("color", { ["あ".repeat(61)]: { color: "#000000" } })).toMatch(/invalid_option_swatches/);
    expect(await bad("pattern", { x: { color: "#000000" } })).toMatch(/invalid_option_swatches/);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`v${i}`, { color: "#000000" }]));
    expect(await bad("color", many)).toMatch(/invalid_option_swatches/);
    // 列を直接書いても制約で止まる
    expect(await expectDbError(() => getPool().query(`update shops set option_swatches = '{"color":{"x":{"color":"red"}}}' where id = $1`, [a.shopId]))).toMatch(/shops_option_swatches_check/);
  });

  it("よそのショップの運営者・匿名は書けない", async () => {
    expect(await expectDbError(() => set(b.ownerId, a.shopId, "color", { x: { color: "#000000" } }))).toMatch(/forbidden/);
    expect(await expectDbError(() => asAnon((c) => c.query("select option_swatches_set($1, 'color', '{}')", [a.shopId])))).toMatch(/permission denied/);
  });
});
