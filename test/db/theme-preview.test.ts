import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0074_theme_preview: プレビューの版の設定の値（service_role だけ、ショップと版の組で引く）と、
 * お店の画面が Liquid のテーマを描いてよいか（banto_site_liquid、anon 可。plan_limits.theme_versions が 0 なら描かない）
 */
describe.skipIf(!dbAvailable)("テーマのプレビューと描く条件（0074）", () => {
  let a: Fixture;
  let b: Fixture;
  const id = randomUUID();

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "tp-a@example.com", slug: "tp-a", publish: true });
    b = await createShopFixture({ email: "tp-b@example.com", slug: "tp-b", publish: true });
    await asUser(a.ownerId, (c) => c.query(`select theme_version_create($1, $2, 'v', 10, 1, '{}'::jsonb, '{"headline":"保存"}'::jsonb)`, [a.shopId, id]));
  });
  afterAll(closePool);

  it("設定の値は service_role だけが、ショップと版の組で引ける", async () => {
    const get = (shop: string) => asService(async (c) => (await c.query<{ r: unknown }>("select theme_preview_settings($1, $2) as r", [shop, id])).rows[0]!.r);
    expect(await get(a.shopId)).toEqual({ headline: "保存" });
    expect(await get(b.shopId)).toBeNull();
    expect(await expectDbError(() => asAnon((c) => c.query("select theme_preview_settings($1, $2)", [a.shopId, id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select theme_preview_settings($1, $2)", [a.shopId, id])))).toMatch(/permission denied/);
  });

  it("描く条件: プランと、theme_versions が 0 でないか", async () => {
    const liquid = async () => asAnon(async (c) => (await c.query<{ r: { plan: string; themes: boolean } }>("select banto_site_liquid() as r")).rows[0]!.r);
    expect(await liquid()).toEqual({ plan: "free", themes: true });
    await getPool().query(`select site_settings_set('workers_plan', '"paid"'::jsonb)`);
    await getPool().query(`select site_settings_set('plan_limits', '{"theme_versions": 0}'::jsonb)`);
    expect(await liquid()).toEqual({ plan: "paid", themes: false });
    await getPool().query(`select site_settings_set('plan_limits', '{"theme_versions": 3}'::jsonb)`);
    expect((await liquid()).themes).toBe(true);
    await getPool().query(`select site_settings_set('plan_limits', '{}'::jsonb)`);
  });
});
