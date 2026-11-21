import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";
import { STOREFRONT_CACHE_TTL, StorefrontData, storefrontCacheTtl } from "../src/storefront/data";
import { createDbClient } from "../src/db/client";
import type { CacheAdapter } from "../src/adapters/types";

/** お店の画面の覚えておく時間（デプロイの設定 STOREFRONT_CACHE_TTL_SECONDS、5〜300 秒、既定 30） */
describe("覚えておく時間", () => {
  it("設定を読む。無い・数でない・範囲の外は既定の 30 秒", () => {
    const of = (v: string | undefined) => storefrontCacheTtl({ get: (n) => (n === "STOREFRONT_CACHE_TTL_SECONDS" ? v : undefined) });
    expect(of(undefined)).toBe(STOREFRONT_CACHE_TTL);
    expect(of("120")).toBe(120);
    expect(of(" 300 ")).toBe(300);
    expect(of("5")).toBe(5);
    for (const bad of ["4", "301", "abc", "-10", "1.5", "", "99999"]) expect([bad, of(bad)]).toEqual([bad, STOREFRONT_CACHE_TTL]);
  });

  it("お店の画面の覚え（ショップ行・カテゴリーなど）がその時間で置かれる。設定が無ければ 30 秒", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const ttls: number[] = [];
    const store = new Map<string, unknown>();
    const cache: CacheAdapter = { get: async <T>(k: string) => (store.get(k) as T) ?? null, set: async (k, v, ttl) => void (store.set(k, v), ttls.push(ttl)), delete: async (k) => void store.delete(k) };
    const db = createDbClient({ url: sb.url, anonKey: sb.anonKey, fetch: sb.fetch });
    const shop = await new StorefrontData(db, cache, null, 120).shopBySlug("my-shop");
    expect(shop).not.toBeNull();
    await new StorefrontData(db, cache, null, 120).listCategories(shop!);
    expect(ttls.length).toBeGreaterThan(0);
    expect(ttls.every((t) => t === 120)).toBe(true);
    ttls.length = 0;
    store.clear();
    await new StorefrontData(db, cache).shopBySlug("my-shop");
    expect(ttls.every((t) => t === STOREFRONT_CACHE_TTL)).toBe(true);
  });

  it("お店の画面はデプロイの設定の時間を使う（2 回目は覚えから。範囲の外の値でも動く）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    for (const v of ["120", "9999"]) {
      const app = appWith(sb, { STOREFRONT_CACHE_TTL_SECONDS: v });
      expect((await app.request(`${BASE}/my-shop`)).status).toBe(200);
      sb.calls.length = 0;
      expect((await app.request(`${BASE}/my-shop`)).status).toBe(200);
      expect(sb.calls).toHaveLength(0);
    }
  });
});
