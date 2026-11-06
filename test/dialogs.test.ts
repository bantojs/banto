import { afterEach, describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { dialogPageOf, dialogScript, dialogsFor, type PublicDialog } from "../src/modules/dialogs/dialogs";

/** 同梱モジュール「お店の画面のダイアログ」（0110、docs/dialogs.md）。形の確かめ・RLS・公開のショップ行の本物は test/db/dialogs.test.ts */

const GOLD = "11111111-1111-4111-8111-111111111111";
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function dialog(over: Partial<PublicDialog> & { id: string }): PublicDialog {
  return { layout: "bar", title: "お知らせ", body: "", image_url: null, buttons: [], coupon_code: null, audience: "all", audience_id: null, pages: { kinds: ["all"] }, trigger: {}, snooze_days: 7, ...over };
}

function setup(rows: Record<string, unknown>[] = [], modules: Record<string, boolean> = { dialogs: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c",
    settings: { members_enabled: true, modules, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }] },
  });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, tags: ["秋"] });
  sb.addSku(shop.id, tee.id, { code: "TEE", price_jpy: 3000, available: 3 });
  sb.addProduct(shop.id, { slug: "cap", name: "帽子", published: true });
  for (const r of rows) sb.tables.dialogs.push({ shop_id: shop.id, enabled: true, priority: 0, ...r });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, tee, app, mail };
}

describe("どのページ・だれに（サーバー）", () => {
  it("ページの種類をパスから決める。レジ・会員ページ・注文照会には出さない", () => {
    expect(dialogPageOf("", "", [])?.kind).toBe("home");
    expect(dialogPageOf("/", "", [])?.kind).toBe("home");
    expect(dialogPageOf("/products", "?q=tee", [])?.kind).toBe("list");
    expect(dialogPageOf("/categories/tops", "", [])?.kind).toBe("list");
    expect(dialogPageOf("/products/tee", "", [{ type: "product_view", value_jpy: 0, items: [], product: { id: "p-1", category_id: "c-1", tags: ["秋"] } }])).toEqual({ kind: "product", product: { id: "p-1", category_id: "c-1", tags: ["秋"] } });
    expect(dialogPageOf("/blogs/news/hello", "", [])?.kind).toBe("article");
    expect(dialogPageOf("/pages/about", "", [])?.kind).toBe("page");
    expect(dialogPageOf("/cart", "", [])?.kind).toBe("cart");
    for (const p of ["/checkout/address", "/checkout/confirm", "/account", "/account/login", "/orders/lookup", "/tryon", "/inquiries"]) expect(dialogPageOf(p, "", [])).toBeNull();
  });

  it("種類・商品・カテゴリー・タグ・だれに で絞る", () => {
    const product = { kind: "product" as const, product: { id: "p-1", category_id: "c-1", tags: ["秋"] } };
    const list = [
      dialog({ id: "all" }),
      dialog({ id: "cart", pages: { kinds: ["cart"] } }),
      dialog({ id: "tag", pages: { kinds: ["all"], tags: ["秋"] } }),
      dialog({ id: "other-tag", pages: { kinds: ["all"], tags: ["夏"] } }),
      dialog({ id: "cat", pages: { kinds: ["product"], categories: ["c-1"] } }),
      dialog({ id: "guests", audience: "guests" }),
      dialog({ id: "members", audience: "members" }),
      dialog({ id: "gold", audience: "audience", audience_id: GOLD }),
    ];
    const ids = (page: Parameters<typeof dialogsFor>[1], member: boolean, gold = false) => dialogsFor(list, page, { member, audienceOk: (id) => gold && id === GOLD }).map((d) => d.id);
    expect(ids(product, false)).toEqual(["all", "tag", "cat", "guests"]);
    expect(ids(product, true, true)).toEqual(["all", "tag", "cat", "members", "gold"]);
    expect(ids({ kind: "cart" }, false)).toEqual(["all", "cart", "guests"]);
  });
});

describe("お店の画面", () => {
  it("当てはまるダイアログだけをスクリプトに載せる。中身は JSON の中でエスケープされ、HTML として差し込まない", async () => {
    const { app } = setup([
      { id: "d-1", title: "</script><script>alert(1)</script>", body: "初回 10% オフ", pages: { kinds: ["product"] }, audience: "guests", trigger: { delay_s: 3 }, coupon_code: "WELCOME10", buttons: [{ label: "見る", url: "/products/tee" }] },
      { id: "d-2", title: "カートの人へ", pages: { kinds: ["cart"] } },
    ]);
    const guest = new Browser(app, BASE);
    const html = await (await guest.get("/my-shop/products/tee")).text();
    expect(html).toContain('"id":"d-1"');
    expect(html).not.toContain('"id":"d-2"');
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
    expect(await (await guest.get("/my-shop")).text()).not.toContain("data-banto-dialog");
  });

  it("会員の条件のダイアログは合う会員だけ。モジュールが OFF なら出さない", async () => {
    const { app, mail } = setup([{ id: "d-gold", title: "ゴールドの方へ", audience: "audience", audience_id: GOLD }], { dialogs: true, audiences: true });
    expect(await (await new Browser(app, BASE).get("/my-shop/products/tee")).text()).not.toContain('"id":"d-gold"');
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    expect(await (await gold.get("/my-shop/products/tee")).text()).toContain('"id":"d-gold"');

    const off = setup([{ id: "d-1", title: "x" }], {});
    expect(await (await new Browser(off.app, BASE).get("/my-shop/products/tee")).text()).not.toContain('"id":"d-1"');
  });
});

describe("管理画面", () => {
  it("作る・直す・消す。商品はスラッグで受けて id にする。無いスラッグ・種類なしは保存しない", async () => {
    const { app, sb, shop, tee } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/dialogs`;
    expect((await owner.get(base)).status).toBe(200);
    const form = { name: "初回", enabled: "on", layout: "bar", title: "ようこそ", body: "初回 10% オフ", audience: "guests", kind_product: "on", products: "tee", delay_s: "5", exit_intent: "on", snooze_days: "7", priority: "10", button_label_0: "見る", button_url_0: "/products/tee", coupon_code: "WELCOME10" };
    expect((await owner.post(base, form)).headers.get("location")).toBe(`${base}?flash=saved`);
    const row = sb.tables.dialogs[0]!;
    expect(row).toMatchObject({ name: "初回", audience: "guests", pages: { kinds: ["product"], products: [tee.id] }, trigger: { delay_s: 5, exit_intent: true }, buttons: [{ label: "見る", url: "/products/tee" }], coupon_code: "WELCOME10", priority: 10 });
    expect(await (await owner.get(`${base}/${row["id"]}`)).text()).toContain('value="tee"');
    expect((await owner.post(base, { ...form, products: "nope" })).status).toBe(400);
    const { kind_product: _k, ...noKind } = form;
    expect((await owner.post(base, noKind)).status).toBe(400);
    await owner.post(`${base}/${row["id"]}/delete`, {});
    expect(sb.tables.dialogs).toHaveLength(0);
  });

  it("モジュールが OFF なら 404", async () => {
    const { app, shop } = setup([], {});
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await owner.get(`/admin/shops/${shop.id}/modules/dialogs`)).status).toBe(404);
  });
});

describe("ブラウザのスクリプト", () => {
  type El = { tag: string; className: string; textContent: string; children: El[]; attrs: Record<string, string>; listeners: Record<string, () => void>; [k: string]: unknown };
  function run(dialogs: PublicDialog[], opts: { store?: Map<string, string>; cart?: number | null; session?: Map<string, string>; loading?: boolean } = {}) {
    const store = opts.store ?? new Map<string, string>();
    const session = opts.session ?? new Map<string, string>();
    const timers: (() => void)[] = [];
    const events: { name: string; p: unknown }[] = [];
    const tracked: { type: string; d: unknown }[] = [];
    const docListeners: Record<string, ((e: unknown) => void)[]> = {};
    const mk = (tag: string): El => {
      const e: El = {
        tag, className: "", textContent: "", children: [], attrs: {}, listeners: {},
        setAttribute(k: string, v: string) { e.attrs[k] = v; },
        appendChild(c: El) { e.children.push(c); c["parentNode"] = e; return c; },
        removeChild(c: El) { e.children = e.children.filter((x) => x !== c); c["parentNode"] = null; },
        addEventListener(n: string, f: () => void) { e.listeners[n] = f; },
        attachShadow() { const r = mk("#shadow"); e["shadowRoot"] = r; return r; },
        focus() {},
      };
      return e;
    };
    const body = mk("body");
    const ctx: Record<string, unknown> = {
      Date, JSON, Number, String, Array,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) },
      document: { readyState: opts.loading ? "loading" : "complete", body: opts.loading ? null : body, createElement: mk, activeElement: null, documentElement: { scrollHeight: 2000 }, addEventListener: (n: string, f: (e: unknown) => void) => ((docListeners[n] ??= []).push(f)), removeEventListener: () => undefined },
      Element: { prototype: { attachShadow: () => undefined } },
      setTimeout: (f: () => void) => timers.push(f),
      addEventListener: () => undefined, removeEventListener: () => undefined,
      innerHeight: 800, scrollY: 0,
      gtag: (_e: string, name: string, p: unknown) => events.push({ name, p }),
      banto: { track: (type: string, d: unknown) => tracked.push({ type, d }) },
      navigator: {},
    };
    ctx["window"] = ctx;
    runInNewContext(dialogScript("/my-shop", dialogs, opts.cart ?? null), ctx);
    const shown = () => body.children.map((h) => h.attrs["data-banto-dialog"]);
    const fire = () => timers.splice(0).forEach((f) => f());
    const exit = () => (docListeners["mouseout"] ?? []).forEach((f) => f({ relatedTarget: null, clientY: 0 }));
    // <head> の中で動いたあと、<body> ができて DOMContentLoaded
    const ready = () => {
      (ctx["document"] as Record<string, unknown>)["body"] = body;
      (ctx["document"] as Record<string, unknown>)["readyState"] = "interactive";
      (docListeners["DOMContentLoaded"] ?? []).forEach((f) => f({}));
    };
    return { store, session, shown, fire, exit, ready, events, tracked, body };
  }

  it("秒数がたつと 1 つだけ出す（優先の高い順）。出したことを GA4 と行動の中継に知らせる", () => {
    const r = run([dialog({ id: "a", trigger: { delay_s: 3 } }), dialog({ id: "b" })]);
    expect(r.shown()).toEqual([]);
    r.fire();
    expect(r.shown()).toEqual(["a"]);
    expect(r.events).toEqual([{ name: "banto_dialog_view", p: { dialog_id: "a" } }]);
    expect(r.tracked).toEqual([{ type: "dialog_view", d: { dialog_id: "a" } }]);
  });

  it("<head> の中で動いても、<body> ができてから出す", () => {
    const r = run([dialog({ id: "a", trigger: { delay_s: 1 } })], { loading: true });
    r.fire();
    expect(r.shown()).toEqual([]);
    r.ready();
    r.fire();
    expect(r.shown()).toEqual(["a"]);
  });

  it("離脱しそう・カートの金額・訪問のページ数がそろうまで出さない", () => {
    const r = run([dialog({ id: "x", trigger: { exit_intent: true } })]);
    r.fire();
    expect(r.shown()).toEqual([]);
    r.exit();
    expect(r.shown()).toEqual(["x"]);
    const c1 = run([dialog({ id: "c", trigger: { cart_min_jpy: 5000 } })], { cart: 3000 });
    c1.fire();
    expect(c1.shown()).toEqual([]);
    const c2 = run([dialog({ id: "c", trigger: { cart_min_jpy: 5000 } })], { session: new Map([["banto_dc", "6000"]]) });
    c2.fire();
    expect(c2.shown()).toEqual(["c"]);
    const store = new Map<string, string>();
    const v1 = run([dialog({ id: "v", trigger: { visit_pages: 2 } })], { store });
    v1.fire();
    expect(v1.shown()).toEqual([]);
    const v2 = run([dialog({ id: "v", trigger: { visit_pages: 2 } })], { store });
    v2.fire();
    expect(v2.shown()).toEqual(["v"]);
  });

  it("同じ訪問で 2 回は出さない。閉じたら決めた日数は出さない", () => {
    const store = new Map<string, string>();
    const r1 = run([dialog({ id: "a", snooze_days: 3 })], { store });
    r1.fire();
    expect(r1.shown()).toEqual(["a"]);
    const r2 = run([dialog({ id: "a", snooze_days: 3 })], { store });
    r2.fire();
    expect(r2.shown()).toEqual([]);
    // 閉じる
    const host = r1.body.children[0]!;
    const shadow = host["shadowRoot"] as El;
    const findClose = (e: El): El | null => (e.className === "x" ? e : e.children.map(findClose).find(Boolean) ?? null);
    findClose(shadow)!.listeners["click"]!();
    expect(r1.shown()).toEqual([]);
    expect(r1.tracked.map((x) => x.type)).toEqual(["dialog_view", "dialog_close"]);
    expect(Number(store.get("banto_dlg_a"))).toBeGreaterThan(Date.now() + 2 * 86400000);
  });
});

describe("AI 用 API とつないだプラグイン（段階 2、0111）", () => {
  async function issue(sb: FakeSupabase, shopId: string, scopes: string[], endpointId: string | null = null) {
    const { generateApiToken, hashApiToken, tokenPrefix } = await import("../src/api/tokens");
    const owner = sb.tables.shops.find((s) => s["id"] === shopId)!["owner_id"];
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shopId, owner_id: owner, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, endpoint_id: endpointId, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  }
  const call = async (app: ReturnType<typeof appWith>, tok: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { items?: { id: string; name: string }[]; error?: { code: string } } };
  };

  it("作る・一覧・直す・消す。プラグインのトークンと運営者のトークンは、互いのものに触れない", async () => {
    const { app, sb, shop } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-ma", shop_id: shop.id, name: "MA", url: "https://ma.example.com/hook", events: [], enabled: true, settings: {}, manifest: null, created_at: "" });
    const plugin = await issue(sb, shop.id, ["dialogs:write"], "ep-ma");
    const op = await issue(sb, shop.id, ["dialogs:write"]);
    const made = await call(app, plugin, "POST", "/dialogs", { name: "カゴ", title: "カートに残っています", pages: { kinds: ["cart"] } });
    expect(made.status).toBe(201);
    const id = String(made.json["id"]);
    expect(sb.tables.dialogs[0]).toMatchObject({ endpoint_id: "ep-ma", name: "カゴ" });
    expect((await call(app, plugin, "GET", "/dialogs")).json.items!.map((d) => d.name)).toEqual(["カゴ"]);
    expect((await call(app, op, "GET", "/dialogs")).json.items).toEqual([]);
    expect((await call(app, op, "PATCH", `/dialogs/${id}`, { enabled: false })).status).toBe(404);
    expect((await call(app, plugin, "PATCH", `/dialogs/${id}`, { enabled: false })).json["enabled"]).toBe(false);
    expect((await call(app, plugin, "DELETE", `/dialogs/${id}`)).json).toEqual({ deleted: true });
    expect(sb.tables.dialogs).toHaveLength(0);
  });

  it("スコープが無ければ 401、モジュールが OFF なら 409、名前・見出しが無ければ 400", async () => {
    const off = setup([], {});
    expect((await call(off.app, await issue(off.sb, off.shop.id, ["dialogs:write"]), "GET", "/dialogs")).status).toBe(409);
    const { app, sb, shop } = setup();
    expect((await call(app, await issue(sb, shop.id, ["coupons:write"]), "GET", "/dialogs")).status).toBe(401);
    const bad = await call(app, await issue(sb, shop.id, ["dialogs:write"]), "POST", "/dialogs", { name: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error?.code).toBe("invalid");
  });

  it("管理画面の一覧に、プラグインが作ったものを連携の名前つきで出す", async () => {
    const { app, sb, shop } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-ma", shop_id: shop.id, name: "テスト MA", url: "https://ma.example.com/hook", events: [], enabled: true, settings: {}, manifest: null, created_at: "" });
    sb.tables.dialogs.push({ id: "d-p", shop_id: shop.id, endpoint_id: "ep-ma", name: "プラグインの", title: "x", enabled: true, priority: 0, layout: "bar", audience: "all", pages: { kinds: ["all"] }, trigger: {}, snooze_days: 7, buttons: [] });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/dialogs`;
    expect(await (await owner.get(base)).text()).toContain("連携「テスト MA」が作ったもの");
    expect(await (await owner.get(`${base}/d-p`)).text()).toContain("プラグインが後から書き直すことがあります");
  });
});

describe("ヘッドレスと貼れるタグ（段階 3）", () => {
  const get = (app: ReturnType<typeof appWith>, q: string, token?: string) => app.request(`${BASE}/api/shops/my-shop/dialogs${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("ページの種類と商品の手がかりで当てはまるものを返す。だれにはトークンで決める。中身だけ（だれに・どのページは返さない）", async () => {
    const { app, shop, tee, sb } = setup([
      { id: "d-all", title: "みなさまへ", pages: { kinds: ["all"] } },
      { id: "d-tag", title: "秋物", pages: { kinds: ["product"], tags: ["秋"] } },
      { id: "d-guest", title: "はじめての方へ", audience: "guests", pages: { kinds: ["product"] } },
      { id: "d-member", title: "会員の方へ", audience: "members", pages: { kinds: ["all"] } },
      { id: "d-cart", title: "カート", pages: { kinds: ["cart"] } },
    ]);
    const r = await get(app, `?kind=product&product_id=${tee.id}&tags=${encodeURIComponent("秋")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await r.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((d) => d["id"])).toEqual(["d-all", "d-tag", "d-guest"]);
    expect(body.items[0]).not.toHaveProperty("audience");
    expect(body.items[0]).not.toHaveProperty("pages");
    // 会員トークン
    const { issueTokens } = await import("../src/members/auth");
    sb.tables.customers.push({ id: "cust-1", shop_id: shop.id, email: "h@example.com", session_epoch: 0 });
    const { access_token } = await issueTokens("test-session-secret", shop.id, "cust-1", 0, null);
    const m = (await (await get(app, "?kind=cart", access_token)).json()) as { items: { id: string }[] };
    expect(m.items.map((d) => d.id)).toEqual(["d-all", "d-member", "d-cart"]);
    expect((await get(app, "?kind=cart", "bm1.broken")).status).toBe(401);
    expect((await get(app, "?kind=nope")).status).toBe(400);
    const off = setup([{ id: "x", title: "x" }], {});
    expect((await get(off.app, "?kind=home")).status).toBe(404);
  });

  it("貼れるタグのスクリプトに、お店の画面と同じダイアログの本体と <banto-dialogs> が入っている（構文として読める）", async () => {
    const { embedScript } = await import("../src/modules/embed/script");
    const { DIALOG_RUNTIME } = await import("../src/modules/dialogs/dialogs");
    const js = embedScript("https://banto.example.com", "ja");
    expect(js).toContain(DIALOG_RUNTIME);
    expect(js).toContain('define("banto-dialogs"');
    expect(() => new Function(js)).not.toThrow();
  });
});
