import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { LineInputError, lineMessagesFrom } from "../src/line/send";

/**
 * 外部プラグイン向けの口（0105）の Worker 側: LINE で送る口（文の組み立て・LINE へ送る・結果）と、注文の一覧の新しい引数。
 * 権限・冪等・月の上限・cursor の本物は test/db/ma-ports.test.ts（実 PostgreSQL）。
 */
afterEach(() => externalHosts.clear());

async function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const member = crypto.randomUUID();
  const mailOnly = crypto.randomUUID();
  sb.tables.customers.push({ id: member, shop_id: shop.id, email: "line@example.com", name: "会員" });
  sb.tables.customers.push({ id: mailOnly, shop_id: shop.id, email: "mail@example.com", name: "会員2" });
  sb.memberIdentities.push({ shop_id: shop.id, provider: "line", subject: "U-secret-id", customer_id: member });
  const app = appWith(sb, { LINE_CHANNEL_ACCESS_TOKEN: "line-token-123" }, new MemoryStorage(`${BASE}/media`));
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  const pushes: { headers: Headers; body: { to: string; messages: Record<string, unknown>[] } }[] = [];
  const line = { status: 200 };
  externalHosts.set("https://api.line.me/", async (req) => {
    pushes.push({ headers: req.headers, body: (await req.json()) as { to: string; messages: Record<string, unknown>[] } });
    return new Response("{}", { status: line.status });
  });
  return { sb, shop, app, issue, member, mailOnly, pushes, line };
}

const send = async (app: ReturnType<typeof appWith>, token: string, customer: string, body: unknown, key: string | null = "msg-0000001") => {
  const res = await app.request(`${BASE}/api/v1/customers/${customer}/line-message`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
};

describe("LINE で送る口の文（lineMessagesFrom）", () => {
  it("文・画像・ボタンを LINE の形に組み直す", () => {
    const m = lineMessagesFrom({ text: " 秋の新作です \r\n", image_url: "https://cdn.example.com/a.jpg", buttons: { text: "見てみる", actions: [{ label: "新作", url: "https://shop.example.jp/products/a" }] } });
    expect(m).toEqual([
      { type: "text", text: "秋の新作です" },
      { type: "image", originalContentUrl: "https://cdn.example.com/a.jpg", previewImageUrl: "https://cdn.example.com/a.jpg" },
      { type: "template", altText: "見てみる", template: { type: "buttons", text: "見てみる", actions: [{ type: "uri", label: "新作", uri: "https://shop.example.jp/products/a" }] } },
    ]);
  });

  it("決まった形のほかは受けない（知らない鍵・http・javascript:・長すぎる・ボタンが多すぎる）", () => {
    const bad: Record<string, unknown>[] = [
      {},
      { text: "" },
      { text: "a".repeat(2001) },
      { text: "a", flex: {} },
      { text: "a", image_url: "http://example.com/a.jpg" },
      { text: "a", image_url: "javascript:alert(1)" },
      { text: "a", image_url: "https://user:pw@example.com/a.jpg" },
      { text: "a", buttons: { text: "b", actions: [] } },
      { text: "a", buttons: { text: "b", actions: Array.from({ length: 5 }, () => ({ label: "x", url: "https://example.com/" })) } },
      { text: "a", buttons: { text: "b", actions: [{ label: "x".repeat(21), url: "https://example.com/" }] } },
      { text: "a", buttons: { text: "b".repeat(161), actions: [{ label: "x", url: "https://example.com/" }] } },
      { text: "a", buttons: { text: "b", actions: [{ label: "x", url: "https://example.com/a b" }] } },
    ];
    for (const b of bad) expect(() => lineMessagesFrom(b), JSON.stringify(b).slice(0, 80)).toThrow(LineInputError);
  });
});

describe("REST POST /api/v1/customers/{id}/line-message", () => {
  it("Banto がショップのトークンで送り、LINE の利用者 ID は応答に載せない。行の id を再送キーにする", async () => {
    const { app, issue, member, pushes } = await setup();
    const tok = await issue(["line:send"]);
    const r = await send(app, tok, member, { text: "こんにちは" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: expect.any(String), status: "sent" });
    expect(JSON.stringify(r.json)).not.toContain("U-secret-id");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toEqual({ to: "U-secret-id", messages: [{ type: "text", text: "こんにちは" }] });
    expect(pushes[0]!.headers.get("authorization")).toBe("Bearer line-token-123");
    expect(pushes[0]!.headers.get("x-line-retry-key")).toBe(r.json["id"]);
    // 同じキーは送り直さない
    expect((await send(app, tok, member, { text: "こんにちは" })).json).toEqual({ id: r.json["id"], status: "sent" });
    expect(pushes).toHaveLength(1);
  });

  it("LINE と結んでいない会員は no_line、友だちでない人は not_friend。LINE の一時的な失敗は 502 で、同じキーで送り直せる", async () => {
    const { app, issue, member, mailOnly, pushes, line } = await setup();
    const tok = await issue(["line:send"]);
    expect((await send(app, tok, mailOnly, { text: "a" }, "msg-0000002")).json).toMatchObject({ status: "no_line" });
    expect(pushes).toHaveLength(0);
    line.status = 403;
    expect((await send(app, tok, member, { text: "a" }, "msg-0000003")).json).toMatchObject({ status: "not_friend" });
    line.status = 500;
    const fail = await send(app, tok, member, { text: "a" }, "msg-0000004");
    expect(fail.status).toBe(502);
    expect(fail.json.error?.message).toMatch(/same Idempotency-Key/);
    line.status = 200;
    expect((await send(app, tok, member, { text: "a" }, "msg-0000004")).json).toMatchObject({ status: "sent" });
    // 失敗のあとの送り直しは同じ再送キー
    expect(pushes.at(-1)!.headers.get("x-line-retry-key")).toBe(pushes.at(-2)!.headers.get("x-line-retry-key"));
  });

  it("Idempotency-Key が無い・文の形が違えば 400（記録を作らない）。スコープが無ければ 401。月の上限は quota", async () => {
    const { sb, shop, app, issue, member, pushes } = await setup();
    const tok = await issue(["line:send"]);
    expect((await send(app, tok, member, { text: "a" }, null)).status).toBe(400);
    expect((await send(app, tok, member, { text: "a", flex: {} })).status).toBe(400);
    expect(sb.lineMessages).toHaveLength(0);
    expect((await send(app, await issue(["customers:read"]), member, { text: "a" })).status).toBe(401);
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { members_enabled: true, line_marketing_limit: 0 };
    expect((await send(app, tok, member, { text: "a" }, "msg-0000005")).json).toEqual({ status: "quota", limit: 0, count: 0 });
    expect(pushes).toHaveLength(0);
  });

  it("0105 が当たるまでは 409（migration_required）", async () => {
    const { app, issue, member } = await setup({ migrations: ["0088_app_connect"] });
    const tok = await issue(["line:send"]);
    const r = await send(app, tok, member, { text: "a" });
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("migration_required");
  });
});

describe("REST GET /api/v1/orders の新しい引数（0105）", () => {
  it("customer_id で絞る。after だけは 400。古い DB では 409", async () => {
    const { sb, shop, app, issue, member } = await setup();
    sb.tables.orders.push({ id: crypto.randomUUID(), shop_id: shop.id, status: "paid", total_jpy: 1000, number: 1001, customer_id: member });
    sb.tables.orders.push({ id: crypto.randomUUID(), shop_id: shop.id, status: "paid", total_jpy: 2000, number: 1002, customer_id: null });
    const tok = await issue(["orders:read"]);
    const get = async (q: string) => {
      const res = await app.request(`${BASE}/api/v1/orders${q}`, { headers: { authorization: `Bearer ${tok}` } });
      return { status: res.status, json: (await res.json()) as { items?: { number: number }[]; error?: { code: string } } };
    };
    expect((await get(`?customer_id=${member}`)).json.items!.map((o) => o.number)).toEqual([1001]);
    expect((await get("")).json.items).toHaveLength(2);
    expect((await get(`?after=${member}`)).status).toBe(400);
    expect((await get("?updated_since=yesterday")).status).toBe(400);

    const old = await setup({ migrations: ["0088_app_connect"] });
    const oldTok = await old.issue(["orders:read"]);
    const res = await old.app.request(`${BASE}/api/v1/orders?customer_id=${old.member}`, { headers: { authorization: `Bearer ${oldTok}` } });
    expect(res.status).toBe(409);
  });
});

describe("管理画面: 宣伝の月の上限（0105）", () => {
  it("今月の数と上限を出し、上限を保存する。0105 が当たるまでは出さない", async () => {
    const { sb, shop, app, issue, member } = await setup();
    await send(app, await issue(["line:send"]), member, { text: "a" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/line-messaging`;
    expect(await (await admin.get(base)).text()).toContain("今月（日本時間）の宣伝のメッセージ: 1 通 / 上限 150 通");
    expect((await admin.post(`${base}/limit`, { limit: "-1" })).headers.get("location")).toBe(`${base}?flash=invalid`);
    expect((await admin.post(`${base}/limit`, { limit: "500" })).headers.get("location")).toBe(`${base}?flash=limit_saved`);
    expect((sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>)["line_marketing_limit"]).toBe(500);

    const old = await setup({ migrations: ["0088_app_connect"] });
    const oldAdmin = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await oldAdmin.get(`/admin/shops/${old.shop.id}/line-messaging`)).text()).not.toContain("宣伝のメッセージの月の上限");
  });
});
