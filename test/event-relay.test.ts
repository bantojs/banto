import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts, memberLogin, memberMail } from "./helpers";
import { endpointSecret, verifyHookSignature } from "../src/hooks/signing";
import { issueTokens } from "../src/members/auth";
import { memoryRateLimit } from "../src/adapters/rate-limit";
import { forwardRelay, normalizeRelayEvent, parseRelayBody, relayEventsFromPage, relayScript, type RelayTarget } from "../src/modules/event-relay/relay";
import { runInNewContext } from "node:vm";
import { parseManifest } from "../src/hooks/manifest";

/**
 * お店の行動の中継（同梱モジュール event_relay、0107）の Worker 側: スクリプト・中継の入口・ヘッドレスの入口・署名・許しの画面。
 * 許しの範囲（マニフェストまで）・守り・監査ログの本物は test/db/event-relay.test.ts
 */
afterEach(() => externalHosts.clear());

const SECRET = "test-session-secret";
const PLUGIN = "https://ma.example.com/hook";

function setup(opts: { relay?: boolean; grant?: string[] | null; guests?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { event_relay: opts.relay ?? true } } });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true, tags: ["秋"] });
  sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 3 });
  const visitors = opts.guests ? "all" : "members";
  const manifest = { name: "MA", events: [], settings: [], storefront_events: { types: ["product_view", "article_view"], visitors } };
  sb.tables.hook_endpoints.push({ id: "ep-ma", shop_id: shop.id, name: "MA", url: PLUGIN, events: [], enabled: true, settings: {}, manifest, created_at: "", storefront_events: opts.grant === null ? null : { types: opts.grant ?? ["product_view"], visitors } });
  const mail = memberMail(sb, shop.id);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, new MemoryStorage(`${BASE}/media`));
  const got: { headers: Headers; body: string }[] = [];
  externalHosts.set("https://ma.example.com/", async (req) => {
    got.push({ headers: req.headers, body: await req.text() });
    return new Response("ok");
  });
  return { sb, shop, p, app, mail, got };
}

const relay = (b: Browser, events: unknown[], visitor?: string) => b.postRaw("/my-shop/_x", JSON.stringify({ events, ...(visitor ? { visitor } : {}) }), "text/plain");
const V1 = "v_0123456789abcdef0123456789abcdef";

describe("出来事の形", () => {
  it("決まった形に組み直す（知らない種類・鍵は捨てる、時刻は 1 日以内、文字と数に上限）", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(normalizeRelayEvent({ type: "product_view", product_id: "p-1", tags: ["a", 1, "x".repeat(41)], extra: "drop", at: "2026-11-03T23:59:00Z" }, now)).toEqual({ type: "product_view", at: "2026-11-03T23:59:00.000Z", product_id: "p-1", tags: ["a"] });
    expect(normalizeRelayEvent({ type: "x.custom" }, now)).toBeNull();
    expect(normalizeRelayEvent({ type: "page_view", at: "1999-01-01T00:00:00Z", page_id: "<script>" }, now)).toEqual({ type: "page_view", at: "2026-11-04T00:00:00.000Z" });
    expect(parseRelayBody("not json")).toBeNull();
    expect(parseRelayBody(JSON.stringify({ events: Array.from({ length: 51 }, () => ({ type: "cart_view" })) }))).toBeNull();
    expect(parseRelayBody("x".repeat(17 * 1024))).toBeNull();
  });

  it("お店の画面の出来事を渡す形に（商品は ID・カテゴリー・タグ、カートは品番と数）", () => {
    expect(relayEventsFromPage([
      { type: "product_view", value_jpy: 3000, items: [{ sku: "TEE", name: "T", price: 3000 }], product: { id: "p-1", category_id: "c-1", tags: ["秋"] } },
      { type: "cart_add", value_jpy: 6000, items: [{ sku: "TEE", name: "T", price: 3000, quantity: 2 }] },
      { type: "article_view", value_jpy: 0, items: [], article: { id: "a-1", blog: "news", handle: "h", author: "スタッフX", tags: [] } },
    ])).toEqual([
      { type: "product_view", product_id: "p-1", category_id: "c-1", tags: ["秋"] },
      { type: "cart_add", sku: "TEE", quantity: 2 },
      { type: "article_view", article_id: "a-1", blog: "news", handle: "h", author: "スタッフX" },
    ]);
  });

  it("マニフェストの storefront_events を読む（知らない種類は捨てる、visitors の既定は members）", () => {
    expect(parseManifest({ name: "MA", storefront_events: { types: ["product_view", "nope", "product_view"], visitors: "everyone" } })?.storefront_events).toEqual({ types: ["product_view"], visitors: "members" });
    expect(parseManifest({ name: "MA", storefront_events: { types: [] } })?.storefront_events).toBeUndefined();
  });

  it("メモリの回数の制限（窓ごと）", async () => {
    let now = 0;
    const rl = memoryRateLimit(() => now);
    expect(await rl.hit("k", 2, 60)).toBe(true);
    expect(await rl.hit("k", 2, 60)).toBe(true);
    expect(await rl.hit("k", 2, 60)).toBe(false);
    now = 61_000;
    expect(await rl.hit("k", 2, 60)).toBe(true);
  });
});

describe("お店の画面", () => {
  it("会員のページにだけスクリプトを載せる（ゲスト・モジュール OFF には載せない）", async () => {
    const { app, mail } = setup();
    const guest = new Browser(app);
    expect(await (await guest.get("/my-shop/p/tee")).text()).not.toContain("/my-shop/_x");
    const member = new Browser(app);
    await memberLogin(member, mail, "/my-shop", "m@example.com");
    const html = await (await member.get("/my-shop/p/tee")).text();
    expect(html).toContain('"/my-shop/_x"');
    expect(html).toMatch(/"type":"product_view","product_id":"[^"]+","tags":\["秋"\]/);

    const off = setup({ relay: false });
    const m2 = new Browser(off.app);
    await memberLogin(m2, off.mail, "/my-shop", "m@example.com");
    expect(await (await m2.get("/my-shop/p/tee")).text()).not.toContain("_x");
  });

  it("中継: 会員の出来事を、許された種類だけ署名してプラグインへ。ゲスト・形の違い・モジュール OFF は送らずに 204", async () => {
    const { app, mail, got, sb } = setup();
    const member = new Browser(app);
    await memberLogin(member, mail, "/my-shop", "m@example.com");
    const res = await relay(member, [{ type: "product_view", product_id: "p-1" }, { type: "cart_add", sku: "TEE", quantity: 1 }]);
    expect(res.status).toBe(204);
    expect(got).toHaveLength(1);
    const env = JSON.parse(got[0]!.body) as { event: string; shop_id: string; data: { customer_id: string; source: string; events: { type: string }[] } };
    expect(env.event).toBe("storefront.events");
    expect(env.data.events.map((e) => e.type)).toEqual(["product_view"]);
    expect(env.data.customer_id).toBe(sb.tables.customers.find((c) => c["email"] === "m@example.com")!["id"]);
    expect(env.data.source).toBe("storefront");
    expect(got[0]!.headers.get("x-banto-event")).toBe("storefront.events");
    expect(await verifyHookSignature(await endpointSecret(SECRET, "ep-ma"), got[0]!.body, got[0]!.headers.get("x-banto-signature") ?? undefined)).toBe(true);
    expect(JSON.stringify(env)).not.toContain("m@example.com");

    const guest = new Browser(app);
    expect((await relay(guest, [{ type: "product_view", product_id: "p-1" }])).status).toBe(204);
    expect((await member.postRaw("/my-shop/_x", "nope", "text/plain")).status).toBe(204);
    expect(got).toHaveLength(1);
    expect((await member.postRaw("/my-shop/_x", "x".repeat(17 * 1024), "text/plain")).status).toBe(413);
  });

  it("許しが無い連携には送らない", async () => {
    const { app, mail, got } = setup({ grant: null });
    const member = new Browser(app);
    await memberLogin(member, mail, "/my-shop", "m@example.com");
    expect((await relay(member, [{ type: "product_view", product_id: "p-1" }])).status).toBe(204);
    expect(got).toHaveLength(0);
  });
});

describe("ヘッドレス POST /api/shops/{shop}/events", () => {
  it("会員トークンの会員の出来事を送る。壊れたトークンは 401、トークンなし（ゲスト）は送らない", async () => {
    const { app, shop, got, sb } = setup({ grant: ["product_view", "article_view"] });
    sb.tables.customers.push({ id: "cust-1", shop_id: shop.id, email: "h@example.com", session_epoch: 0 });
    const { access_token } = await issueTokens(SECRET, shop.id, "cust-1", 0, null);
    const post = (headers: Record<string, string>) => app.request(`${BASE}/api/shops/my-shop/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ events: [{ type: "article_view", article_id: "a-1", author: "スタッフX" }] }) });
    expect((await post({ authorization: `Bearer ${access_token}` })).status).toBe(204);
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!.body).data).toMatchObject({ customer_id: "cust-1", source: "headless", events: [{ type: "article_view", article_id: "a-1", author: "スタッフX" }] });
    expect((await post({ authorization: "Bearer bm1.broken" })).status).toBe(401);
    expect((await post({})).status).toBe(204);
    expect(got).toHaveLength(1);
  });
});

describe("管理画面: 連携ごとの許し", () => {
  it("求められた種類だけを並べ、選んだものを許す（外すと取り消し）", async () => {
    const { app, sb, shop } = setup({ grant: null });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/hooks/ep-ma`;
    const html = await (await owner.get(base)).text();
    expect(html).toContain(`action="${base}/storefront-events"`);
    expect(html).toContain('value="article_view"');
    expect(html).not.toContain('value="cart_add"');
    expect((await owner.post(`${base}/storefront-events`, { types: "article_view" })).headers.get("location")).toBe(`${base}?flash=saved`);
    expect(sb.tables.hook_endpoints.find((e) => e["id"] === "ep-ma")!["storefront_events"]).toEqual({ types: ["article_view"], visitors: "members" });
    await owner.post(`${base}/storefront-events`, {});
    expect(sb.tables.hook_endpoints.find((e) => e["id"] === "ep-ma")!["storefront_events"]).toBeNull();
  });

  it("マニフェストを読めていない外部の送信先には、欄が出ない理由と読み直し方を出す", async () => {
    const { app, sb, shop } = setup({ grant: null });
    sb.tables.hook_endpoints.push({ id: "ep-none", shop_id: shop.id, name: "n8n", url: "https://n8n.example.com/hook", events: [], enabled: true, settings: {}, manifest: null, created_at: "" });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`/admin/shops/${shop.id}/hooks/ep-none`)).text()).toContain("マニフェストを読めていません");
    expect(await (await owner.get(`/admin/shops/${shop.id}/hooks/ep-ma`)).text()).not.toContain("マニフェストを読めていません");
  });
});

describe("ゲストの訪問者 ID と visitor.identified（段階 4b、0108）", () => {
  it("visitor は決まった形だけ受ける。visitor.identified は形として受ける", () => {
    expect(parseRelayBody(JSON.stringify({ visitor: V1, events: [{ type: "visitor.identified" }] }))).toMatchObject({ visitor: V1, events: [{ type: "visitor.identified" }] });
    expect(parseRelayBody(JSON.stringify({ visitor: "m@example.com", events: [] }))?.visitor).toBeNull();
  });

  it("渡し分け: ゲストは「ゲストも」の連携にだけ、会員の訪問者 ID も「ゲストも」の連携にだけ、結ぶ知らせは会員のまとまりだけ", async () => {
    const sent: { url: string; data: { customer_id: string | null; visitor: string | null; events: { type: string }[] } }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, data: JSON.parse(String(init.body)).data });
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    const targets: RelayTarget[] = [
      { endpoint_id: "e-all", url: "https://all.example.com/h", secret_box: null, grant: { types: ["product_view"], visitors: "all" } },
      { endpoint_id: "e-mem", url: "https://mem.example.com/h", secret_box: null, grant: { types: ["product_view"], visitors: "members" } },
    ];
    const at = "2026-11-04T00:00:00.000Z";
    const base = { targets, shopId: "s", source: "storefront" as const, sessionSecret: SECRET, fetch };
    // ゲスト
    expect(await forwardRelay({ ...base, customerId: null, visitor: V1, events: [{ type: "product_view", at, product_id: "p" }, { type: "visitor.identified", at }] })).toBe(1);
    expect(sent).toEqual([{ url: "https://all.example.com/h", data: expect.objectContaining({ customer_id: null, visitor: V1, events: [{ type: "product_view", at, product_id: "p" }] }) }]);
    // 訪問者 ID の無いゲストは送らない
    sent.length = 0;
    expect(await forwardRelay({ ...base, customerId: null, visitor: null, events: [{ type: "product_view", at }] })).toBe(0);
    // 会員
    expect(await forwardRelay({ ...base, customerId: "c-1", visitor: V1, events: [{ type: "visitor.identified", at }, { type: "product_view", at }] })).toBe(2);
    const all = sent.find((x) => x.url.includes("all"))!.data;
    const mem = sent.find((x) => x.url.includes("mem"))!.data;
    expect(all).toMatchObject({ customer_id: "c-1", visitor: V1, events: [{ type: "visitor.identified" }, { type: "product_view" }] });
    expect(mem).toMatchObject({ customer_id: "c-1", visitor: null, events: [{ type: "product_view" }] });
  });

  it("お店の画面: ゲストも許した連携があるショップだけ、ゲストのページにスクリプトを載せて訪問者 ID で送る", async () => {
    const { app, got } = setup({ guests: true });
    const guest = new Browser(app);
    const html = await (await guest.get("/my-shop/p/tee")).text();
    expect(html).toContain('"/my-shop/_x"');
    expect(html).toContain("banto_v");
    expect((await relay(guest, [{ type: "product_view", product_id: "p-1" }], V1)).status).toBe(204);
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!.body).data).toMatchObject({ customer_id: null, visitor: V1, events: [{ type: "product_view" }] });
    // 訪問者 ID の無いゲストのまとまりは送らない
    await relay(guest, [{ type: "product_view", product_id: "p-1" }]);
    expect(got).toHaveLength(1);
  });

  it("会員だけの連携しか無いショップのゲストには、スクリプトも載せず、届いても送らない", async () => {
    const { app, got } = setup();
    const guest = new Browser(app);
    expect(await (await guest.get("/my-shop/p/tee")).text()).not.toContain("_x");
    expect((await relay(guest, [{ type: "product_view", product_id: "p-1" }], V1)).status).toBe(204);
    expect(got).toHaveLength(0);
  });

  it("ログインした会員のまとまりから visitor.identified を渡す（ゲストからは渡さない）", async () => {
    const { app, mail, got, sb } = setup({ guests: true });
    const guest = new Browser(app);
    await relay(guest, [{ type: "visitor.identified" }], V1);
    expect(got).toHaveLength(0);
    const member = new Browser(app);
    await memberLogin(member, mail, "/my-shop", "m@example.com");
    await relay(member, [{ type: "visitor.identified" }], V1);
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!.body).data).toMatchObject({ customer_id: sb.tables.customers.find((c) => c["email"] === "m@example.com")!["id"], visitor: V1, events: [{ type: "visitor.identified" }] });
  });

  it("ヘッドレス: トークンなしは訪問者 ID のゲストとして、トークンありは会員として", async () => {
    const { app, shop, got, sb } = setup({ guests: true });
    sb.tables.customers.push({ id: "cust-1", shop_id: shop.id, email: "h@example.com", session_epoch: 0 });
    const { access_token } = await issueTokens(SECRET, shop.id, "cust-1", 0, null);
    const post = (headers: Record<string, string>, events: unknown[]) => app.request(`${BASE}/api/shops/my-shop/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ visitor: V1, events }) });
    expect((await post({}, [{ type: "product_view", product_id: "p-1" }])).status).toBe(204);
    expect((await post({ authorization: `Bearer ${access_token}` }, [{ type: "visitor.identified" }])).status).toBe(204);
    expect(got.map((g) => JSON.parse(g.body).data)).toEqual([
      expect.objectContaining({ customer_id: null, visitor: V1, source: "headless" }),
      expect.objectContaining({ customer_id: "cust-1", visitor: V1, events: [expect.objectContaining({ type: "visitor.identified" })] }),
    ]);
  });

  describe("ブラウザのスクリプト", () => {
    function run(code: string, store: Map<string, string>) {
      const beacons: string[] = [];
      const ctx = {
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
        sessionStorage: { getItem: () => null, setItem: () => undefined },
        crypto: globalThis.crypto,
        navigator: { sendBeacon: (_u: string, b: { s: string }) => (beacons.push(b.s), true) },
        Blob: class {
          s: string;
          constructor(parts: string[]) {
            this.s = parts[0] ?? "";
          }
        },
        document: { visibilityState: "visible", addEventListener: () => undefined },
        addEventListener: (_n: string, f: () => void) => ((ctx as { flush?: () => void }).flush = f),
        setInterval: () => 0,
        Date,
        JSON,
        Uint8Array,
      };
      runInNewContext(code, ctx);
      (ctx as unknown as { flush: () => void }).flush();
      return beacons.map((b) => JSON.parse(b) as { visitor?: string; events: { type: string }[] });
    }
    const ev = [{ type: "product_view" as const, product_id: "p-1" }];

    it("ゲストで作った訪問者 ID を、ログインで結び（visitor.identified）、ログアウトで作り直す", () => {
      const store = new Map<string, string>();
      const g1 = run(relayScript("/s/_x", ev, { member: false, visitors: true }), store)[0]!;
      expect(g1.visitor).toMatch(/^v_[0-9a-f]{32}$/);
      expect(g1.events.map((e) => e.type)).toEqual(["product_view"]);
      const m1 = run(relayScript("/s/_x", ev, { member: true, visitors: true }), store)[0]!;
      expect(m1.visitor).toBe(g1.visitor);
      expect(m1.events.map((e) => e.type)).toEqual(["visitor.identified", "product_view"]);
      const m2 = run(relayScript("/s/_x", ev, { member: true, visitors: true }), store)[0]!;
      expect(m2.events.map((e) => e.type)).toEqual(["product_view"]);
      const g2 = run(relayScript("/s/_x", ev, { member: false, visitors: true }), store)[0]!;
      expect(g2.visitor).not.toBe(g1.visitor);
      expect(g2.events.map((e) => e.type)).toEqual(["product_view"]);
    });

    it("ゲストを渡さないショップでは訪問者 ID を作らず、前のものを消す", () => {
      const store = new Map<string, string>([["banto_v", JSON.stringify({ id: V1, m: false })]]);
      const b = run(relayScript("/s/_x", ev, { member: true, visitors: false }), store)[0]!;
      expect(b.visitor).toBeUndefined();
      expect(store.has("banto_v")).toBe(false);
    });
  });
});
