/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({ connect: () => { throw new Error("not in tests"); } }));

/** Workers のアダプタはリクエストごとに作るが、キャッシュは isolate に 1 つ（作り直すとキャッシュが毎回捨てられる） */
describe("createWorkersAdapters", () => {
  it("何度作っても同じキャッシュを返し、前のリクエストで置いた値が読める", async () => {
    const { createWorkersAdapters } = await import("../src/adapters/workers");
    const env = { MEDIA: {}, MEDIA_BASE_URL: "https://media.example", PUBLIC_BASE_URL: "https://shop.example", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" } as unknown as Parameters<typeof createWorkersAdapters>[0];
    const first = createWorkersAdapters(env);
    await first.cache.set("k", { v: 1 }, 30);
    const second = createWorkersAdapters(env);
    expect(second.cache).toBe(first.cache);
    expect(await second.cache.get("k")).toEqual({ v: 1 });
    // 設定（env）はリクエストごと
    expect(second.config).not.toBe(first.config);
  });
});

/**
 * 公開の置き場（MEDIA）は R2 のカスタムドメインから Worker を通らずに配られるので、置くときに Cache-Control を付ける
 * （付けないとブラウザが毎回取り直す）。上書きする feeds/ と公開しない置き場（PRIVATE）には付けない
 */
describe("R2 に置くときの Cache-Control", () => {
  function fakeBucket() {
    const puts: { key: string; meta: R2HTTPMetadata | undefined }[] = [];
    const bucket = {
      put: async (key: string, _body: unknown, opts?: R2PutOptions) => {
        puts.push({ key, meta: opts?.httpMetadata as R2HTTPMetadata | undefined });
        return null;
      },
    };
    return { bucket, puts };
  }

  it("公開の置き場の画像には長い期限を付け、feeds/ と非公開の置き場には付けない", async () => {
    const { createWorkersAdapters } = await import("../src/adapters/workers");
    const media = fakeBucket();
    const priv = fakeBucket();
    const env = { MEDIA: media.bucket, PRIVATE: priv.bucket, MEDIA_BASE_URL: "https://media.example", PUBLIC_BASE_URL: "https://shop.example", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" } as unknown as Parameters<typeof createWorkersAdapters>[0];
    const a = createWorkersAdapters(env);
    const put = await a.storage.put("shops/s/products/p/abc.webp", new ArrayBuffer(1), "image/webp");
    expect(put.url).toBe("https://media.example/shops/s/products/p/abc.webp");
    await a.storage.put("feeds/s/meta.json", new ArrayBuffer(1), "application/json");
    await a.privateStorage!.put("inquiries/s/x.png", new ArrayBuffer(1), "image/png");
    expect(media.puts).toEqual([
      { key: "shops/s/products/p/abc.webp", meta: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" } },
      { key: "feeds/s/meta.json", meta: { contentType: "application/json" } },
    ]);
    expect(priv.puts).toEqual([{ key: "inquiries/s/x.png", meta: { contentType: "image/png" } }]);
  });
});
