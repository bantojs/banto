import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { externalHosts, memoryAdapters } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { deliverPendingHooks, describeError, EXTERNAL_CONCURRENCY } from "../src/hooks/deliver";
import { createPrivilegedDb, type PrivilegedDb } from "../src/db/privileged";
import { registerJobs } from "../src/jobs";
import { runScheduledJobs } from "../src/adapters/scheduler";

/**
 * hooks の配信で 1 件の失敗がほかの配信を巻き込まない（docs/hooks.md §5「配信の分け方」）。
 * - 遅い外部の送信先・結果の書き込みの失敗があっても、同じ回の同梱プラグイン（取引の知らせ）は送られて delivered になる
 * - 送れたのに書き込みが落ちても「失敗」とは書かない（再送で二重に届くため）。回の最後にもう 1 回書く
 * - 2xx の本文は読まずに閉じる・外部へ同時に送る数を絞る
 */
afterEach(() => {
  externalHosts.clear();
  vi.restoreAllMocks();
});

const SECRETS = { LINE_CHANNEL_ACCESS_TOKEN: "line-token" };

function setup(externals = 1) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true });
  sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: ["order.paid"], enabled: true, manifest: null, settings: { to: "U123" }, created_at: "" });
  for (let i = 0; i < externals; i++) {
    sb.tables.hook_endpoints.push({ id: `ep-ext-${i}`, shop_id: shop.id, name: `外部 ${i}`, url: `https://plugin${i}.example/hook`, events: ["order.paid"], enabled: true, manifest: null, settings: {}, created_at: "" });
  }
  sb.enqueue(shop.id, "order.paid", { order_id: "o1", total_jpy: 1000, items: [] });
  const idOf = (endpoint: string) => String(sb.tables.hook_deliveries.find((d) => d["endpoint_id"] === endpoint)!["id"]);
  const delivery = (endpoint: string) => sb.tables.hook_deliveries.find((d) => d["endpoint_id"] === endpoint)!;
  return { sb, shop, idOf, delivery };
}

/** 外部の送信先が返事をしない（打ち切られるまで待つ）fetch */
function hangingUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

/** 結果の書き込み（finish_hook_delivery）の RPC の中身 */
async function finishArgs(input: RequestInfo | URL, init?: RequestInit): Promise<{ p_id: string; p_success: boolean } | null> {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/rpc/finish_hook_delivery")) return null;
  return JSON.parse(String(init?.body ?? "{}")) as { p_id: string; p_success: boolean };
}

describe("hooks の配信を配信ごとに分ける", () => {
  it("外部の送信が打ち切られ、その結果の書き込みが Workers の fetch の例外で落ちても、同じ回の LINE の通知は送られて delivered。ジョブは最後に失敗にする", async () => {
    const { sb, idOf, delivery } = setup();
    const extId = idOf("ep-ext-0");
    const order: string[] = [];
    const pushes: string[] = [];
    externalHosts.set("https://api.line.me/", async () => {
      order.push("line");
      pushes.push("push");
      return Response.json({});
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://plugin0.example/")) {
        order.push("external");
        return hangingUntilAbort(init);
      }
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return h(new Request(input, init));
      const f = await finishArgs(input, init);
      // Workers の fetch が文の無い例外で落ちる（PostgREST の応答ではない）
      if (f?.p_id === extId) throw new TypeError("");
      return sb.fetch(input, init);
    };
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", ...SECRETS });
    const jobs: Parameters<typeof runScheduledJobs>[0] extends Iterable<infer J> ? J[] : never = [];
    adapters.scheduler = { register: (name, job, opts) => void jobs.push({ name, job, opts: opts ?? {} }), runAll: async () => {} };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      // 打ち切り（10 秒）を待たない
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    registerJobs(adapters, { fetch: fetchImpl });
    const failed = await runScheduledJobs(jobs.filter((j) => j.name === "deliver_hooks"), (m, e) => errors.push(`${m} ${describeError(e)}`));

    expect(pushes).toHaveLength(1);
    expect(delivery("ep-line")).toMatchObject({ status: "delivered" });
    // 同梱プラグインが先（外部の遅さを待たない）
    expect(order).toEqual(["line", "external"]);
    // 外部の配信は書けずに pending のまま（貸し出しが切れたら取り出し直される）
    expect(delivery("ep-ext-0")).toMatchObject({ status: "pending", last_error: null });
    // ジョブは全部を進めた後で失敗にする（ハートビートを止める）。ログに配信 ID と原因の種類
    expect(failed).toEqual(["deliver_hooks"]);
    expect(errors.join("\n")).toContain(`could not record delivery ${extId} (failed)`);
    expect(errors.join("\n")).toContain("TypeError (no message)");
    expect(errors.join("\n")).toContain("1 hook delivery result(s) could not be recorded");
  });

  it("送れた後に結果の書き込みが 1 回落ちても「失敗」とは書かない。回の最後に書き直して delivered", async () => {
    const { sb, idOf, delivery } = setup(0);
    const lineId = idOf("ep-line");
    let pushes = 0;
    externalHosts.set("https://api.line.me/", async () => {
      pushes++;
      return Response.json({});
    });
    const written: boolean[] = [];
    let dropped = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return h(new Request(input, init));
      const f = await finishArgs(input, init);
      if (f?.p_id === lineId) {
        written.push(f.p_success);
        if (!dropped) {
          dropped = true;
          throw new TypeError("Network connection lost.");
        }
      }
      return sb.fetch(input, init);
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const r = await deliverPendingHooks({ db, sessionSecret: "s", fetch: fetchImpl, config: memoryAdapters(SECRETS).config });
    expect(r).toEqual({ claimed: 1, delivered: 1, failed: 0, unrecorded: 0 });
    expect(written).toEqual([true, true]);
    expect(pushes).toBe(1);
    expect(delivery("ep-line")).toMatchObject({ status: "delivered" });
  });

  it("通信の上限に当たった書き込みは書き直さない（同じ理由で落ちる）。数えて返す", async () => {
    const rows = [{ id: "d1", shop_id: "s", endpoint_id: "e1", event: "order.paid", payload: {}, attempts: 1, url: "https://crm.example/hook", settings: {}, created_at: "", secret_box: null }];
    let finishes = 0;
    const db = {
      claimHookDeliveries: async () => rows,
      finishHookDelivery: async () => {
        finishes++;
        throw new Error("Too many subrequests.");
      },
    } as unknown as PrivilegedDb;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await deliverPendingHooks({ db, sessionSecret: "s", fetch: async () => new Response(null, { status: 204 }) });
    expect(r).toEqual({ claimed: 1, delivered: 1, failed: 0, unrecorded: 1 });
    expect(finishes).toBe(1);
  });

  it("送る前の不調（署名の失敗など）も、その配信の失敗にとどめる", async () => {
    const rows = ["d1", "d2"].map((id, i) => ({ id, shop_id: "s", endpoint_id: `e${i}`, event: "order.paid", payload: {}, attempts: 1, url: "https://crm.example/hook", settings: {}, created_at: "", secret_box: i === 0 ? "broken" : null }));
    const finished: [string, boolean][] = [];
    const db = {
      claimHookDeliveries: async () => rows,
      finishHookDelivery: async (id: string, ok: boolean) => void finished.push([id, ok]),
    } as unknown as PrivilegedDb;
    const r = await deliverPendingHooks({ db, sessionSecret: "s", fetch: async () => new Response("ok") });
    expect(r).toEqual({ claimed: 2, delivered: 1, failed: 1, unrecorded: 0 });
    expect(finished.sort()).toEqual([
      ["d1", false],
      ["d2", true],
    ]);
  });

  it("2xx の本文は読まずに閉じる。失敗の本文は上限まで読んで記録する", async () => {
    const rows = ["d1", "d2"].map((id, i) => ({ id, shop_id: "s", endpoint_id: `e${i}`, event: "order.paid", payload: {}, attempts: 1, url: `https://p${i}.example/hook`, settings: {}, created_at: "", secret_box: null }));
    const cancelled: string[] = [];
    const finished: [string, boolean, number | null, string | null][] = [];
    const db = {
      claimHookDeliveries: async () => rows,
      finishHookDelivery: async (id: string, ok: boolean, status: number | null, err: string | null) => void finished.push([id, ok, status, err]),
    } as unknown as PrivilegedDb;
    // 2xx の本文は終わらない（読めば待ち続ける）。読まずに閉じれば cancel が呼ばれる。失敗の本文は終わりまで読む
    const body = (label: string, text: string, end: boolean) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          if (end) c.close();
        },
        cancel() {
          cancelled.push(label);
        },
      });
    const r = await deliverPendingHooks({
      db,
      sessionSecret: "s",
      fetch: async (input) => {
        const url = String(input);
        return url.startsWith("https://p0.") ? new Response(body("ok", "accepted", false), { status: 200 }) : new Response(body("ng", "busy", true), { status: 503 });
      },
    });
    expect(r).toEqual({ claimed: 2, delivered: 1, failed: 1, unrecorded: 0 });
    expect(cancelled).toEqual(["ok"]);
    expect(finished.sort()).toEqual([
      ["d1", true, 200, null],
      ["d2", false, 503, "busy"],
    ]);
  });

  it("打ち切りは記録に分かる文で残す", async () => {
    const rows = [{ id: "d1", shop_id: "s", endpoint_id: "e1", event: "order.paid", payload: {}, attempts: 1, url: "https://slow.example/hook", settings: {}, created_at: "", secret_box: null }];
    const finished: (string | null)[] = [];
    const db = {
      claimHookDeliveries: async () => rows,
      finishHookDelivery: async (_id: string, _ok: boolean, _s: number | null, err: string | null) => void finished.push(err),
    } as unknown as PrivilegedDb;
    const r = await deliverPendingHooks({ db, sessionSecret: "s", timeoutMs: 5, fetch: (_i, init) => hangingUntilAbort(init) });
    expect(r.failed).toBe(1);
    expect(finished).toEqual(["timeout after 5ms"]);
  });

  it("外部へ同時に送る数を絞る（Workers の同時接続の枠を残す）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, shop_id: "s", endpoint_id: `e${i}`, event: "order.paid", payload: {}, attempts: 1, url: `https://p${i}.example/hook`, settings: {}, created_at: "", secret_box: null }));
    const db = { claimHookDeliveries: async () => rows, finishHookDelivery: async () => undefined } as unknown as PrivilegedDb;
    let inFlight = 0;
    let peak = 0;
    const r = await deliverPendingHooks({
      db,
      sessionSecret: "s",
      fetch: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 2));
        inFlight--;
        return new Response(null, { status: 204 });
      },
    });
    expect(r).toEqual({ claimed: 12, delivered: 12, failed: 0, unrecorded: 0 });
    expect(peak).toBe(EXTERNAL_CONCURRENCY);
  });
});
