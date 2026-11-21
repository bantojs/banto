import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, memoryAdapters } from "./helpers";
import { createApp } from "../src/app";
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
    // ショップ行は設定に関係なく 30 秒（戻り先の許可リスト・送料・税などが乗るので）
    const shop = await new StorefrontData(db, cache, null, 120).shopBySlug("my-shop");
    expect(shop).not.toBeNull();
    expect(ttls).toEqual([STOREFRONT_CACHE_TTL]);
    ttls.length = 0;
    // カテゴリー（クーポンの条件）・実店舗（お店で試着の来店日）も 30 秒
    await new StorefrontData(db, cache, null, 120).listCategories(shop!);
    await new StorefrontData(db, cache, null, 120).listStores(shop!);
    expect(ttls).toEqual([STOREFRONT_CACHE_TTL, STOREFRONT_CACHE_TTL]);
    ttls.length = 0;
    // 表示の材料（ページの一覧）は設定の時間
    // （適用済みの版の確認は 60 秒で別に覚える）
    await new StorefrontData(db, cache, null, 120).pagesList(shop!);
    expect(ttls.filter((t) => t !== 60)).toEqual([120]);
    ttls.length = 0;
    store.clear();
    await new StorefrontData(db, cache).pagesList(shop!);
    expect(ttls.filter((t) => t !== 60)).toEqual([STOREFRONT_CACHE_TTL]);
  });

  it("お店の画面・公開 API はデプロイの設定の時間で覚える（範囲の外の値は 30 秒）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
    // お店の画面（domain.ts）・商品の公開 API（api/index.ts）・ページの公開 API（common.ts の publicShop）
    for (const [v, want] of [["120", 120], ["9999", STOREFRONT_CACHE_TTL]] as const) {
      for (const path of ["/my-shop", "/api/shops/my-shop/products", "/api/shops/my-shop/pages"]) {
        const ttls: number[] = [];
        const store = new Map<string, unknown>();
        const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, STOREFRONT_CACHE_TTL_SECONDS: v });
        adapters.cache = { get: async <T>(k: string) => (store.get(k) as T) ?? null, set: async (k, val, ttl) => void (store.set(k, val), ttls.push(ttl)), delete: async (k) => void store.delete(k) };
        const app = createApp(() => adapters, { fetch: sb.fetch });
        expect((await app.request(`${BASE}${path}`)).status).toBe(200);
        // 表示の材料は設定の時間（範囲の外の値は 30 秒）。範囲の外の値そのものは使わない
        expect([v, path, ttls.includes(want), ttls.includes(Number(v)) === (want === Number(v))]).toEqual([v, path, true, true]);
      }
    }
  });
});
