import { describe, expect, it } from "vitest";
import { fetchLatestRelease, isNewer, parseVersion, RELEASES_URL } from "../src/updates/releases";
import type { CacheAdapter } from "../src/adapters/types";

function cache(): CacheAdapter & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T>(k: string) => (store.get(k) as T) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
}

describe("最新リリースの確認", () => {
  it("バージョン比較", () => {
    expect(parseVersion("v0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("1.2.3-beta")).toEqual([1, 2, 3]);
    expect(parseVersion("latest")).toBeNull();
    expect(isNewer("0.0.1", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(false);
    expect(isNewer("0.1.0", "garbage")).toBe(false);
  });

  it("GitHub から取得し、1時間キャッシュする", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      expect(String(input)).toBe(RELEASES_URL);
      return new Response(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://github.com/bantojs/banto/releases/tag/v0.2.0" }), { status: 200 });
    };
    const c = cache();
    expect(await fetchLatestRelease({ fetch: fetchImpl, cache: c })).toEqual({ version: "0.2.0", url: "https://github.com/bantojs/banto/releases/tag/v0.2.0" });
    expect(await fetchLatestRelease({ fetch: fetchImpl, cache: c })).toEqual({ version: "0.2.0", url: "https://github.com/bantojs/banto/releases/tag/v0.2.0" });
    expect(calls).toBe(1);
  });

  it("失敗したら null（表示しないだけ）。失敗もキャッシュして連打しない", async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls++;
      throw new Error("network down");
    };
    const c = cache();
    expect(await fetchLatestRelease({ fetch: failing, cache: c })).toBeNull();
    expect(await fetchLatestRelease({ fetch: failing, cache: c })).toBeNull();
    expect(calls).toBe(1);

    const notFound: typeof fetch = async () => new Response("{}", { status: 404 });
    expect(await fetchLatestRelease({ fetch: notFound, cache: cache() })).toBeNull();
    const weird: typeof fetch = async () => new Response(JSON.stringify({ tag_name: "nightly" }), { status: 200 });
    expect(await fetchLatestRelease({ fetch: weird, cache: cache() })).toBeNull();
  });
});
