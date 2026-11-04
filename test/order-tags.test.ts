import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { parseOrderTags } from "../src/orders/tags";

/** 注文の印とメモ（0106）の Worker 側: 管理画面の一覧・詳細・保存・CSV、AI 用 API。形・権限・マスキングの本物は test/db/order-tags.test.ts */

function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const o1 = { id: crypto.randomUUID(), shop_id: shop.id, status: "paid", total_jpy: 1000, shipping_jpy: 0, number: 1001, customer_name: "山田", created_at: "2026-11-01T00:00:00Z", tags: ["要確認"], note: null };
  const o2 = { id: crypto.randomUUID(), shop_id: shop.id, status: "paid", total_jpy: 2000, shipping_jpy: 0, number: 1002, customer_name: "佐藤", created_at: "2026-11-02T00:00:00Z", tags: [], note: null };
  sb.tables.orders.push(o1, o2);
  const app = appWith(sb);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, app, o1, o2, issue, base: `/admin/shops/${shop.id}/orders` };
}

describe("印の入力", () => {
  it("カンマ・読点・改行で区切り、空を捨てて重なりを消す", () => {
    expect(parseOrderTags(" 要確認, ギフト、要確認\n\n電話済み ")).toEqual(["要確認", "ギフト", "電話済み"]);
    expect(parseOrderTags("")).toEqual([]);
  });
});

describe("管理画面", () => {
  it("一覧に印を出し、印で絞る。詳細で印とメモを保存する。CSV に印とメモ", async () => {
    const { sb, app, o1, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const list = await (await owner.get(base)).text();
    expect(list).toContain(`href="${base}?tag=%E8%A6%81%E7%A2%BA%E8%AA%8D"`);
    const filtered = await (await owner.get(`${base}?tag=${encodeURIComponent("要確認")}`)).text();
    expect(filtered).toContain("#1001");
    expect(filtered).not.toContain("#1002");

    const detail = await (await owner.get(`${base}/${o1.id}`)).text();
    expect(detail).toContain(`action="${base}/${o1.id}/annotate"`);
    const r = await owner.post(`${base}/${o1.id}/annotate`, { tags: "ギフト, 電話済み", note: "折り返し済み" });
    expect(r.headers.get("location")).toBe(`${base}/${o1.id}?flash=saved`);
    const row = sb.tables.orders.find((o) => o["id"] === o1.id)!;
    expect(row["tags"]).toEqual(["ギフト", "電話済み"]);
    expect(row["note"]).toBe("折り返し済み");
    expect((await owner.post(`${base}/${o1.id}/annotate`, { tags: "x".repeat(41), note: "" })).headers.get("location")).toBe(`${base}/${o1.id}?flash=tags_invalid`);

    const csv = await (await owner.get(`/admin/shops/${String(row["shop_id"])}/orders.csv`)).text();
    expect(csv.split("\r\n")[0]).toContain("印,メモ");
    expect(csv).toContain("ギフト, 電話済み");
  });
});

describe("REST /api/v1/orders", () => {
  const call = async (app: ReturnType<typeof appWith>, token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };

  it("PATCH で印を足す・外す。メモは orders:pii のときだけ。一覧を tag で絞る", async () => {
    const { app, o1, issue } = setup();
    const write = await issue(["orders:read", "orders:write"]);
    const pii = await issue(["orders:read", "orders:write", "orders:pii"]);
    let r = await call(app, write, "PATCH", `/orders/${o1.id}`, { add_tags: ["処理済み"], remove_tags: ["要確認"] });
    expect(r.status).toBe(200);
    expect(r.json["tags"]).toEqual(["処理済み"]);
    expect(r.json).not.toHaveProperty("note");
    expect((await call(app, write, "PATCH", `/orders/${o1.id}`, { note: "x" })).status).toBe(401);
    r = await call(app, pii, "PATCH", `/orders/${o1.id}`, { note: "メモ" });
    expect(r.json["note"]).toBe("メモ");
    expect((await call(app, write, "PATCH", `/orders/${o1.id}`, { colour: "red" })).status).toBe(400);
    const list = await call(app, write, "GET", `/orders?tag=${encodeURIComponent("処理済み")}`);
    expect((list.json["items"] as { number: number }[]).map((o) => o.number)).toEqual([1001]);
  });
});
