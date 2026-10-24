import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { Adapters } from "./adapters/types";

/** DB もストレージも触らない、ルーティングの煙テスト用アダプタ */
export function fakeAdapters(): Adapters {
  const mem = new Map<string, unknown>();
  return {
    storage: {
      put: async (key) => ({ url: `https://media.test/${key}` }),
      get: async () => null,
      delete: async () => undefined,
    },
    config: {
      get: (name) => ({ PUBLIC_BASE_URL: "http://localhost" })[name],
      secret: (name) => {
        throw new Error(`Missing secret: ${name}`);
      },
    },
    cache: {
      get: async <T>(key: string) => (mem.get(key) as T) ?? null,
      set: async (key, value) => void mem.set(key, value),
      delete: async (key) => void mem.delete(key),
    },
    scheduler: { register: () => undefined, runAll: async () => undefined },
  };
}

describe("createApp のエラー処理", () => {
  it("外部接続に失敗してもスタックを出さず、HTML は 500 ページ、API は JSON", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("getaddrinfo ENOTFOUND example.supabase.co");
    };
    const silent = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapters = fakeAdapters();
      adapters.config.get = (name) => ({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", PUBLIC_BASE_URL: "http://localhost" })[name];
      const app = createApp(() => adapters, { fetch: failing });
      const html = await app.request("/");
      expect(html.status).toBe(500);
      const body = await html.text();
      expect(body).toContain("一時的に利用できません");
      expect(body).not.toContain("ENOTFOUND");
      expect(body).not.toContain("example.supabase.co");
      const api = await app.request("/api/shops");
      expect(api.status).toBe(500);
      expect(await api.json()).toEqual({ error: "internal_error" });
      expect(silent).toHaveBeenCalled();
    } finally {
      silent.mockRestore();
    }
  });
});

describe("createApp", () => {
  const app = createApp(() => fakeAdapters());

  it("/health がバージョンを返す", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "banto" });
  });

  it("各ルート群がマウントされている", async () => {
    for (const path of ["/api", "/webhooks"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
    }
    // Supabase 未設定ならストアフロントはセットアップへ
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/admin/setup");
    // 管理画面は未ログインならログインへ
    const admin = await app.request("/admin");
    expect(admin.status).toBe(302);
    expect(admin.headers.get("location")).toBe("/admin/login");
  });
});
