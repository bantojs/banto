import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts, memoryAdapters } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { registerJobs } from "../src/jobs";
import type { ScheduledJob } from "../src/adapters/types";

/** 外部プラグインのマニフェストの取り直し（0096、docs/hooks.md「マニフェストの取り直し」） */
const PLUGIN = "https://webp.example/hook";
const OLD = { name: "webp", events: ["product.updated"], settings: [] };
const NEW = { name: "webp", events: ["product.updated"], settings: [], capabilities: ["images"] };

afterEach(() => externalHosts.delete("https://webp.example/"));

function setup(applied?: string[]) {
  const sb = new FakeSupabase(applied ? { appliedMigrations: applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { images: { processing: "plugin" } } });
  sb.tables.hook_endpoints.push({ id: "ep-webp", shop_id: shop.id, name: "WebP", url: PLUGIN, events: ["product.updated"], enabled: true, settings: {}, manifest: OLD, created_at: "" });
  return { sb, shop };
}

describe("設定画面: 知らせる前に取り直す", () => {
  it("古いマニフェストのままでも、取り直して画像を変換できると分かれば知らせない（マニフェストも新しくする）", async () => {
    const { sb, shop } = setup();
    let hits = 0;
    externalHosts.set("https://webp.example/", () => (hits++, Response.json(NEW)));
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).not.toContain("画像を変換できるプラグインがつながっていません");
    expect(sb.tables.hook_endpoints[0]!["manifest"]).toMatchObject({ capabilities: ["images"] });
    // 次からは保存済みのマニフェストで分かるので、取りに行かない
    await b.get(`/admin/shops/${shop.id}`);
    expect(hits).toBe(1);
  });

  it("取り直しても無い・取れなければ知らせる（マニフェストは前のまま）", async () => {
    const { sb, shop } = setup();
    externalHosts.set("https://webp.example/", () => new Response("down", { status: 502 }));
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(`/admin/shops/${shop.id}`)).text()).toContain("画像を変換できるプラグインがつながっていません");
    expect(sb.tables.hook_endpoints[0]!["manifest"]).toEqual(OLD);
  });
});

describe("Cron: 1 日 1 回取り直す", () => {
  async function runJob(sb: FakeSupabase) {
    const vars = { SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "s", PUBLIC_BASE_URL: BASE };
    const jobs = new Map<string, ScheduledJob>();
    const adapters = { ...memoryAdapters(vars), scheduler: { register: (name: string, job: ScheduledJob) => void jobs.set(name, job), runAll: async () => undefined } };
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      for (const [prefix, handler] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(handler(new Request(input, init)));
      return sb.fetch(input, init);
    };
    registerJobs(adapters, { fetch: fetchImpl });
    await jobs.get("hook_manifests")!();
  }

  it("期限の来た外部の連携を取り直す。取れなければ前のまま時刻だけ進む。同梱プラグインは取りに行かない", async () => {
    const { sb, shop } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-bundled", shop_id: shop.id, name: "mail", url: "https://banto.invalid/plugins/email_resend", events: [], enabled: true, settings: {}, manifest: null, created_at: "" });
    externalHosts.set("https://webp.example/", () => Response.json(NEW));
    await runJob(sb);
    const ep = sb.tables.hook_endpoints.find((e) => e["id"] === "ep-webp")!;
    expect(ep["manifest"]).toMatchObject({ capabilities: ["images"] });
    expect(ep["manifest_checked_at"]).toBeTruthy();
    expect(sb.tables.hook_endpoints.find((e) => e["id"] === "ep-bundled")!["manifest_checked_at"]).toBeUndefined();
    // 取れないとき
    ep["manifest_checked_at"] = null;
    externalHosts.set("https://webp.example/", () => new Response("x", { status: 500 }));
    await runJob(sb);
    expect(ep["manifest"]).toMatchObject({ capabilities: ["images"] });
    expect(ep["manifest_checked_at"]).toBeTruthy();
  });

  it("0096 の前は何もしない", async () => {
    const { sb } = setup(BUNDLED_MIGRATIONS.filter((v) => v !== "0096_hook_manifest_refresh"));
    let hits = 0;
    externalHosts.set("https://webp.example/", () => (hits++, Response.json(NEW)));
    await runJob(sb);
    expect(hits).toBe(0);
  });
});
