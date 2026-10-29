import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0073_plan_theme_limit: プランの上限にテーマの版の数（theme_versions）。この Banto 全体で数え、0 なら Liquid のテーマを取り込めない。
 * 書けるのは 0052 と同じく service_role と直接の SQL だけ。ほかの鍵は今までどおり 1 から
 */
describe.skipIf(!dbAvailable)("プランの上限: テーマの版（0073）", () => {
  let a: Fixture;
  const setLimits = (v: unknown) => getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify(v)]);
  const create = (shopId: string) =>
    asUser(a.ownerId, (c) => c.query("select theme_version_create($1, $2, 'v', 10, 1, '{}'::jsonb, '{}'::jsonb)", [shopId, randomUUID()]));

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pt-a@example.com", slug: "pt-a", publish: true });
  });
  afterAll(closePool);

  it("上限まで足せて、超えた文は巻き戻る。0 なら 1 つも足せない。使用量に出る", async () => {
    await setLimits({ theme_versions: 2 });
    await create(a.shopId);
    await create(a.shopId);
    expect(await expectDbError(() => create(a.shopId))).toMatch(/plan_limit_exceeded:theme_versions:2/);
    expect(Number((await getPool().query<{ n: string }>("select count(*)::text as n from theme_versions")).rows[0]!.n)).toBe(2);
    const usage = (await asService(async (c) => (await c.query<{ r: { usage: Record<string, number>; limits: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r));
    expect(usage.usage["theme_versions"]).toBe(2);
    expect(usage.limits).toEqual({ theme_versions: 2 });
    await getPool().query("delete from theme_versions");
    await setLimits({ theme_versions: 0 });
    expect(await expectDbError(() => create(a.shopId))).toMatch(/plan_limit_exceeded:theme_versions:0/);
    await setLimits({});
    await create(a.shopId);
  });

  it("0 を許すのは theme_versions だけ。組織の owner は書けない", async () => {
    for (const bad of [{ shops: 0 }, { theme_versions: -1 }, { theme_versions: 1.5 }, { theme_versions: 1000001 }]) {
      expect(await expectDbError(() => setLimits(bad)), JSON.stringify(bad)).toMatch(/invalid_value/);
    }
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select site_settings_set('plan_limits', '{\"theme_versions\": 100}'::jsonb)")))).toMatch(/forbidden/);
  });
});
