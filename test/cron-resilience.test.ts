import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith, memoryAdapters, Browser } from "./helpers";
import { JobRegistry, runScheduledJobs } from "../src/adapters/scheduler";
import { IntervalScheduler } from "../src/adapters/node/index";
import { registerJobs, CRON_RESILIENCE_MIGRATION } from "../src/jobs";
import { CRON_LIMIT_HEARTBEAT, DELIVERY_COST, DELIVERY_RESERVE, SubrequestBudget, isSubrequestLimitError, resetLearnedSubrequestLimit } from "../src/jobs/budget";

/** Cron の 1 回の実行: ジョブごとの例外・通信の予算・取り出したまま終わらなかった配信の打ち切り（0160）・ダッシュボードの知らせ */
afterEach(() => resetLearnedSubrequestLimit());

describe("スケジューラ（src/adapters/scheduler.ts）", () => {
  it("1 つが落ちても残りは走り、落ちたジョブは名前でログに出る。全部成功したときだけのジョブ（ハートビート）は走らない", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const reg = new JobRegistry();
    reg.register("a", async () => void ran.push("a"));
    reg.register("deliver_hooks", async () => {
      throw new Error("Too many subrequests by single Worker invocation.");
    });
    reg.register("mask", async () => void ran.push("mask"));
    reg.register("heartbeat", async () => void ran.push("heartbeat"), { afterAllSucceeded: true });
    const failed = await runScheduledJobs(reg.list(), (m) => void logs.push(m));
    expect(failed).toEqual(["deliver_hooks"]);
    expect(ran).toEqual(["a", "mask"]);
    expect(logs).toEqual(["[banto] job deliver_hooks failed:"]);
    // 全部成功ならハートビートも
    const ok = new JobRegistry();
    ok.register("a", async () => void ran.push("a2"));
    ok.register("heartbeat", async () => void ran.push("heartbeat2"), { afterAllSucceeded: true });
    expect(await runScheduledJobs(ok.list(), () => undefined)).toEqual([]);
    expect(ran).toContain("heartbeat2");
  });

  it("Node のスケジューラも同じ（落ちても先へ進み、ハートビートは全部成功した回だけ）", async () => {
    const ran: string[] = [];
    const s = new IntervalScheduler();
    s.register("bad", async () => {
      throw new Error("x");
    });
    s.register("next", async () => void ran.push("next"));
    s.register("heartbeat", async () => void ran.push("heartbeat"), { afterAllSucceeded: true });
    const orig = console.error;
    console.error = () => undefined;
    try {
      await s.runAll();
    } finally {
      console.error = orig;
    }
    expect(ran).toEqual(["next"]);
  });
});

describe("通信の予算（src/jobs/budget.ts）", () => {
  it("数え、残りから配信の数を決める。上限に当たったらその回数をこの isolate の上限として覚え、印を 1 回だけ渡す", async () => {
    const b = new SubrequestBudget();
    b.start(null);
    expect(b.deliveryLimit()).toBeUndefined();
    b.start(50);
    const ok = b.wrap(async () => new Response("ok"));
    for (let i = 0; i < 10; i++) await ok("https://x.invalid/");
    expect(b.used).toBe(10);
    expect(b.deliveryLimit()).toBe(Math.floor((50 - 10 - DELIVERY_RESERVE) / DELIVERY_COST));
    const over = b.wrap(async () => {
      throw new Error("Too many subrequests by single Worker invocation.");
    });
    await expect(over("https://x.invalid/")).rejects.toThrow(/Too many subrequests/);
    expect(isSubrequestLimitError(new Error("Too many subrequests"))).toBe(true);
    // 次の回: プランが paid（1,000）でも、この isolate では当たった回数（10）を上限に
    const next = new SubrequestBudget();
    next.start(1000);
    expect(next.limit).toBe(10);
    expect(next.deliveryLimit()).toBe(Math.floor((10 - DELIVERY_RESERVE) / DELIVERY_COST));
    expect(next.takePendingNotice()).toBe(true);
    expect(next.takePendingNotice()).toBe(false);
  });
});

function cronSetup(opts: { plan?: "free" | "paid"; limits?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  if (opts.plan) sb.siteSettings = { ...sb.siteSettings, workers_plan: opts.plan };
  const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
  if (opts.limits !== false) adapters.cronSubrequestLimits = { free: 50, paid: 1000 };
  const reg = new JobRegistry();
  adapters.scheduler = { register: (n, j, o) => reg.register(n, j, o), runAll: async () => void (await runScheduledJobs(reg.list(), () => undefined)) };
  // 送信先への配信の数を数える（hooks の送信先は外の URL）
  let posted = 0;
  // 通信を落とす差し込み口（Workers の「Too many subrequests」の再現）
  const ctl: { intercept: ((url: string) => void) | null } = { intercept: null };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    ctl.intercept?.(u);
    if (u.startsWith("https://plugin.example/")) {
      // マニフェストの取り直し（GET）は数えない
      if ((init?.method ?? "GET") === "POST") posted += 1;
      return new Response("ok");
    }
    return sb.fetch(input, init);
  };
  registerJobs(adapters, { fetch });
  sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: shop.id, name: "img", url: "https://plugin.example/hook", events: ["product.updated"], enabled: true, manifest: null, settings: {}, created_at: "" });
  const add = (n: number, attempts = 0) => {
    for (let i = 0; i < n; i++) {
      sb.tables.hook_deliveries.push({ id: crypto.randomUUID(), shop_id: shop.id, endpoint_id: "ep-1", event: "product.updated", payload: { i }, status: "pending", attempts, next_attempt_at: new Date(Date.now() - 1000).toISOString(), created_at: new Date().toISOString() });
    }
  };
  return { sb, adapters, reg, add, ctl, posted: () => posted };
}

describe("Cron のジョブ（src/jobs/index.ts）", () => {
  it("free（50 回）: 配信は残りの回数から取り出す数を決め、上限を超えない。ハートビートは進む。配信は最後のほう", async () => {
    const { sb, adapters, reg, add, posted } = cronSetup({ plan: "free" });
    add(200);
    const names = reg.list().map((j) => j.name);
    expect(names[0]).toBe("cron_start");
    expect(names.at(-1)).toBe("heartbeat");
    expect(names.at(-2)).toBe("deliver_hooks");
    await adapters.scheduler.runAll();
    expect(posted()).toBeGreaterThan(0);
    expect(posted()).toBeLessThan(13);
    expect(sb.heartbeats.has("cron")).toBe(true);
  });

  it("paid（1,000 回）: 残りが多いので 1 回にもっと取り出す。上限の無い実行（Node）では今までどおり DB の既定（50）", async () => {
    const paid = cronSetup({ plan: "paid" });
    paid.add(200);
    await paid.adapters.scheduler.runAll();
    expect(paid.posted()).toBe(200);
    const node = cronSetup({ limits: false });
    node.add(80);
    await node.adapters.scheduler.runAll();
    expect(node.posted()).toBe(50);
  });

  it("0160 を当てる前の DB では予算で絞らない（今までどおり）", async () => {
    const { sb, adapters, add, posted } = cronSetup({ plan: "free" });
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== CRON_RESILIENCE_MIGRATION);
    add(80);
    await adapters.scheduler.runAll();
    expect(posted()).toBe(50);
  });

  it("取り出したまま終わらなかった配信（回数が 5 に達した pending）は取り出さずに failed にする（0160）", async () => {
    const { sb, adapters, add } = cronSetup({ plan: "paid" });
    add(1, 5);
    add(1, 2);
    await adapters.scheduler.runAll();
    const [stuck, normal] = sb.tables.hook_deliveries;
    expect(stuck).toMatchObject({ status: "failed" });
    expect(String(stuck!["last_error"])).toContain("interrupted");
    expect(normal).toMatchObject({ status: "delivered" });
  });

  it("配信が上限に当たっても、ほかのジョブは走りきる。ハートビートは進まない。次の回は絞って上限の印を書き、ダッシュボードに出る", async () => {
    const { sb, adapters, reg, add, ctl } = cronSetup({ plan: "paid" });
    add(10);
    // 予約の解放は走ったか
    let released = 0;
    let calls = 0;
    ctl.intercept = (u) => {
      if (u.includes("release_expired_reservations")) released += 1;
      calls += 1;
      if (calls > 30 && u.includes("finish_hook_delivery")) throw new Error("Too many subrequests by single Worker invocation.");
    };
    const failed = await runScheduledJobs(reg.list(), () => undefined);
    expect(failed).toEqual(["deliver_hooks"]);
    expect(released).toBe(1);
    expect(sb.heartbeats.has("cron")).toBe(false);
    // 次の回（同じ isolate）: 上限の印を書く
    ctl.intercept = null;
    await adapters.scheduler.runAll();
    expect(sb.heartbeats.has(CRON_LIMIT_HEARTBEAT)).toBe(true);
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await admin.get("/admin")).text()).toContain("Too many subrequests");
    expect(BASE).toBeTruthy();
  });
});
