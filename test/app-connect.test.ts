import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts } from "./helpers";
import { createPrivilegedDb } from "../src/db/privileged";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { endpointSecret, signHookPayload, verifyHookSignature } from "../src/hooks/signing";
import { hashApiToken } from "../src/api/tokens";
import { parseManifest } from "../src/hooks/manifest";

/**
 * 外部プラグインに「つなぐ」（0088、docs/hooks.md §6）。許す画面 → 連携を作って券を付けてプラグインへ → プラグインが裏で引き換え →
 * 接続ごとの署名シークレットで配信・テスト送信・プラグインの画面の券。DB の規則は test/db/app-connect.test.ts
 */
const VENDOR = "https://vendor.example";
const manifest = {
  name: "レビューの集め手",
  events: ["order.shipped"],
  app: "reviews",
  scopes: ["products:read", "app_data:write", "orders:pii", "bogus:write"],
  connect_url: `${VENDOR}/banto/connect`,
  admin_url: `${VENDOR}/banto/admin`,
  blocks: [{ id: "reviews", label: "レビュー", kind: "reviews.v1" }],
};
afterEach(() => externalHosts.delete(VENDOR));

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const posts: { body: string; sig: string | null }[] = [];
  externalHosts.set(VENDOR, async (req) => {
    if (req.method === "GET") return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
    posts.push({ body: await req.text(), sig: req.headers.get("x-banto-signature") });
    return new Response("ok");
  });
  const app = appWith(sb);
  return { sb, app, shop, owner, posts };
}

const form = (fields: [string, string][]) => new URLSearchParams(fields).toString();

async function connect(s: ReturnType<typeof setup>, scopes: string[]) {
  const b = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
  const res = await b.postRaw(`/admin/shops/${s.shop.id}/hooks/connect`, form([["url", `${VENDOR}/banto/hooks`], ["app_handle", "reviews"], ...scopes.map((x): [string, string] => ["scopes", x])]), "application/x-www-form-urlencoded");
  return { b, res };
}

const exchange = (app: ReturnType<typeof appWith>, ticket: unknown) => app.request(`${BASE}/api/connect/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });

describe("つなぐ", () => {
  it("マニフェストの connect_url（https）と scopes（語彙のものだけ）", () => {
    const m = parseManifest(manifest)!;
    expect(m.connect_url).toBe(`${VENDOR}/banto/connect`);
    expect(m.scopes).toEqual(["products:read", "app_data:write", "orders:pii"]);
    expect(parseManifest({ name: "x", connect_url: "http://vendor.example/c" })).not.toHaveProperty("connect_url");
  });

  it("登録の URL に connect_url があれば、許す画面（求めるスコープ・移る先・プラグインの名前）", async () => {
    const s = setup();
    const b = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const html = await (await b.post(`/admin/shops/${s.shop.id}/hooks/new`, { url: `${VENDOR}/banto/hooks` })).text();
    expect(html).toContain(`action="/admin/shops/${s.shop.id}/hooks/connect"`);
    expect(html).toContain('value="app_data:write" checked');
    expect(html).toContain("<code>https://vendor.example</code>");
    expect(html).toContain('name="app_handle" value="reviews"');
    expect(html).not.toContain("bogus:write");
  });

  it("許す → 券を付けて移す → プラグインが引き換える（1 回だけ）→ トークンで拡張データを書ける", async () => {
    const s = setup();
    const { res } = await connect(s, ["products:read", "app_data:write", "shop:write"]);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${VENDOR}/banto/connect`);
    expect(to.searchParams.get("banto")).toBe(BASE);
    expect(to.searchParams.get("shop_id")).toBe(s.shop.id);
    const ticket = to.searchParams.get("ticket")!;
    const ep = s.sb.tables.hook_endpoints.find((e) => e["id"] === to.searchParams.get("endpoint_id"))!;
    expect(ep).toMatchObject({ url: `${VENDOR}/banto/hooks`, app_handle: "reviews", events: ["order.shipped"], enabled: true });
    // マニフェストが求めていないスコープ（shop:write）は付かない
    expect(s.sb.tables.app_connections[0]).toMatchObject({ scopes: ["products:read", "app_data:write"] });
    expect(JSON.stringify(s.sb.tables)).not.toContain(ticket);

    const r = await exchange(s.app, ticket);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = (await r.json()) as { token: string; signing_secret: string; shop: { id: string }; endpoint_id: string; app: string; api_base: string };
    expect(j).toMatchObject({ shop: { id: s.shop.id }, endpoint_id: ep["id"], app: "reviews", api_base: `${BASE}/api/v1` });
    expect(j.signing_secret).toMatch(/^[0-9a-f]{64}$/);
    // DB には生の値を置かない（トークンはハッシュ、シークレットは暗号文）
    const dump = JSON.stringify(s.sb.tables);
    expect(dump).not.toContain(j.token);
    expect(dump).not.toContain(j.signing_secret);
    expect(s.sb.tables.api_tokens.at(-1)).toMatchObject({ token_hash: await hashApiToken(j.token), endpoint_id: ep["id"] });
    // 券は 1 回だけ。形の違う券も同じ答え
    expect((await exchange(s.app, ticket)).status).toBe(400);
    expect((await exchange(s.app, "x")).status).toBe(400);
    // トークンで拡張データを書ける
    const p = s.sb.addProduct(s.shop.id, { slug: "tee", name: "T", published: true });
    const put = await s.app.request(`${BASE}/api/v1/products/${p.id}/app-data/reviews.v1`, { method: "PUT", headers: { authorization: `Bearer ${j.token}`, "content-type": "application/json" }, body: JSON.stringify({ data: { rating_avg: 5, rating_count: 1 } }) });
    expect(put.status).toBe(200);
  });

  it("配信・テスト送信・プラグインの画面の券は接続ごとの署名シークレット（サイトの秘密から作る値ではない）。画面にはシークレットを出さない", async () => {
    const s = setup();
    const { b, res } = await connect(s, ["products:read"]);
    const to = new URL(res.headers.get("location")!);
    const epId = to.searchParams.get("endpoint_id")!;
    const { signing_secret } = (await (await exchange(s.app, to.searchParams.get("ticket"))).json()) as { signing_secret: string };
    // 配信
    s.sb.enqueue(s.shop.id, "order.shipped", { order_id: "o1" });
    const db = createPrivilegedDb({ url: s.sb.url, serviceRoleKey: s.sb.serviceRoleKey, fetch: (i, init) => s.sb.fetch(i, init) });
    const fetchVendor: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      s.posts.push({ body: await req.text(), sig: req.headers.get("x-banto-signature") });
      return new Response("ok");
    };
    expect(await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchVendor })).toMatchObject({ delivered: 1 });
    const sent = s.posts.at(-1)!;
    expect(await verifyHookSignature(signing_secret, sent.body, sent.sig ?? undefined)).toBe(true);
    expect(await verifyHookSignature(await endpointSecret("test-session-secret", epId), sent.body, sent.sig ?? undefined)).toBe(false);
    // サイトの秘密が変わって開けなければ送らずに失敗
    s.sb.enqueue(s.shop.id, "order.shipped", { order_id: "o2" });
    expect(await deliverPendingHooks({ db, sessionSecret: "another-secret", fetch: fetchVendor })).toMatchObject({ delivered: 0, failed: 1 });
    // 管理画面: シークレットは出さない・つないだ連携のカード
    const html = await (await b.get(`/admin/shops/${s.shop.id}/hooks/${epId}`)).text();
    expect(html).not.toContain(signing_secret);
    expect(html).not.toContain(await endpointSecret("test-session-secret", epId));
    expect(html).toContain(`/hooks/${epId}/reconnect`);
    // テスト送信
    await b.post(`/admin/shops/${s.shop.id}/hooks/${epId}/test`, {});
    const ping = s.posts.at(-1)!;
    expect(JSON.parse(ping.body)["event"]).toBe("banto.ping");
    expect(await verifyHookSignature(signing_secret, ping.body, ping.sig ?? undefined)).toBe(true);
    // プラグインの画面: 署名付きの券（ショップ・連携・開いた人・5 分）
    const ui = await (await b.get(`/admin/shops/${s.shop.id}/hooks/${epId}/ui`)).text();
    const src = new URL(ui.match(/<iframe src="([^"]+)"/)![1]!.replace(/&amp;/g, "&"));
    const [body, mac] = src.searchParams.get("banto_ticket")!.split(".");
    const claims = JSON.parse(Buffer.from(body!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ shop_id: s.shop.id, endpoint_id: epId });
    expect(Number(claims["exp"])).toBeGreaterThan(Date.now() / 1000);
    const { createHmac } = await import("node:crypto");
    expect(createHmac("sha256", signing_secret).update(`banto-plugin-ticket.${body}`).digest("hex")).toBe(mac);
    void signHookPayload;
  });

  it("つなぎ直すと新しい券（引き換えると前のトークンは取り消し）。外す（消す）とトークン・接続も消える", async () => {
    const s = setup();
    const { b, res } = await connect(s, ["products:read"]);
    const first = new URL(res.headers.get("location")!);
    const epId = first.searchParams.get("endpoint_id")!;
    const a = (await (await exchange(s.app, first.searchParams.get("ticket"))).json()) as { token: string };
    const again = await b.post(`/admin/shops/${s.shop.id}/hooks/${epId}/reconnect`, {});
    expect(again.status).toBe(303);
    const t2 = new URL(again.headers.get("location")!).searchParams.get("ticket");
    const b2 = (await (await exchange(s.app, t2)).json()) as { token: string };
    expect(b2.token).not.toBe(a.token);
    const oldHash = await hashApiToken(a.token);
    const old = s.sb.tables.api_tokens.find((x) => x["token_hash"] === oldHash);
    expect(old?.["revoked_at"]).not.toBeNull();
    await b.post(`/admin/shops/${s.shop.id}/hooks/${epId}/delete`, {});
    expect(s.sb.tables.app_connections).toHaveLength(0);
    expect(s.sb.tables.api_tokens.filter((x) => x["endpoint_id"] === epId)).toHaveLength(0);
  });
});
