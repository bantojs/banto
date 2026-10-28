import { describe, expect, it } from "vitest";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { APPLIED_MIGRATIONS_CACHE_KEY, BASELINE_MIGRATION, forgetAppliedMigrations, migrated } from "../src/db/migration-state";
import { createDbClient } from "../src/db/client";
import { StorefrontData } from "../src/storefront/data";
import { FakeSupabase } from "./fake-supabase";
import { memoryAdapters } from "./helpers";

function deps(applied: string[]) {
  const sb = new FakeSupabase({ appliedMigrations: applied });
  const cache = memoryAdapters({}).cache;
  return { sb, cache, deps: { db: createDbClient({ url: sb.url, anonKey: sb.anonKey, fetch: sb.fetch }), cache } };
}

describe("新しい機能を出すかどうか（migrated）", () => {
  it("土台（v0.3.0 の前提 = v0.2.0 のセットアップで当たる 0061 まで）は同梱のマイグレーションのひとつ", () => {
    expect(BASELINE_MIGRATION).toBe("0061_mod_inquiries");
    expect(BUNDLED_MIGRATIONS).toContain(BASELINE_MIGRATION);
  });

  it("土台までの版は問い合わせずに適用済み。その後の版は適用済みの一覧で決め、一覧はキャッシュする", async () => {
    const { sb, cache, deps: d } = deps([...BUNDLED_MIGRATIONS]);
    expect(await migrated(d, "0010_coupons")).toBe(true);
    expect(await migrated(d, BASELINE_MIGRATION)).toBe(true);
    expect(sb.calls.filter((x) => x.includes("banto_setup_state"))).toHaveLength(0);

    expect(await migrated(d, "9999_future")).toBe(false);
    expect(await migrated(d, "9999_future")).toBe(false);
    expect(sb.calls.filter((x) => x.includes("banto_setup_state"))).toHaveLength(1);

    // 当てたら（アップデートの画面）その isolate の一覧を捨てて、次から新しい一覧で決める
    sb.appliedMigrations.push("9999_future");
    expect(await migrated(d, "9999_future")).toBe(false); // キャッシュのあいだは古いまま
    await forgetAppliedMigrations(cache);
    expect(await cache.get(APPLIED_MIGRATIONS_CACHE_KEY)).toBeNull();
    expect(await migrated(d, "9999_future")).toBe(true);
  });

  it("お客様の画面のデータ取得（StorefrontData）は、並べて判定しても適用済みの一覧を 1 回だけ引く", async () => {
    const { sb, deps: d } = deps([...BUNDLED_MIGRATIONS]);
    const sf = new StorefrontData(d.db, d.cache);
    expect(await Promise.all([sf.migratedTo("0062_legal_links"), sf.migratedTo("0065_sku_option_axes"), sf.migratedTo("9999_future"), sf.migratedTo("0058_product_listing")])).toEqual([true, true, false, true]);
    expect(sb.calls.filter((x) => x.includes("banto_setup_state"))).toHaveLength(1);
  });
});
