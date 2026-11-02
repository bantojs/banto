import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0096_hook_manifest_refresh: 外部プラグインのマニフェストを Cron で取り直す */
describe.skipIf(!dbAvailable)("マニフェストの取り直し（0096）", () => {
  let a: Fixture;
  let ext: string;
  const rpc = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "mr-a@example.com", slug: "mr-a", publish: true });
    const ins = (url: string, enabled = true) =>
      getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, enabled, manifest) values ($1, 'x', $2, '{}', $3, $4) returning id", [a.shopId, url, enabled, JSON.stringify({ name: "old" })]).then((r) => r.rows[0]!.id);
    ext = await ins("https://plugin.example/hook");
    await ins("https://banto.invalid/plugins/email_resend");
    await ins("https://off.example/hook", false);
  });
  afterAll(closePool);

  it("期限の来た有効な外部の連携だけ。書いたら 1 日は出てこない。取れなければ前のまま時刻だけ", async () => {
    expect(await rpc<{ id: string; url: string }[]>("hook_manifests_due", [10])).toEqual([{ id: ext, url: "https://plugin.example/hook" }]);
    expect(await rpc<boolean>("hook_manifest_record", [ext, "https://plugin.example/hook", JSON.stringify({ name: "new", capabilities: ["images"] })])).toBe(true);
    expect((await getPool().query("select manifest from hook_endpoints where id = $1", [ext])).rows[0].manifest).toEqual({ name: "new", capabilities: ["images"] });
    expect(await rpc("hook_manifests_due", [10])).toEqual([]);
    await getPool().query("update hook_endpoints set manifest_checked_at = now() - interval '2 days' where id = $1", [ext]);
    expect(await rpc<boolean>("hook_manifest_record", [ext, "https://plugin.example/hook", null])).toBe(true);
    expect((await getPool().query("select manifest, manifest_checked_at > now() - interval '1 minute' as fresh from hook_endpoints where id = $1", [ext])).rows[0]).toEqual({ manifest: { name: "new", capabilities: ["images"] }, fresh: true });
  });

  it("URL が変わっていたら書かない。形の違うものは断る。service_role だけ", async () => {
    expect(await rpc<boolean>("hook_manifest_record", [ext, "https://other.example/hook", JSON.stringify({ name: "x" })])).toBe(false);
    expect(await expectDbError(() => rpc("hook_manifest_record", [ext, "https://plugin.example/hook", JSON.stringify(["x"])]))).toMatch(/invalid_manifest/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select hook_manifests_due(1)")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select hook_manifest_record($1, 'x', null)", [ext])))).toMatch(/permission denied/);
  });
});
