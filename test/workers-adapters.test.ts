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
