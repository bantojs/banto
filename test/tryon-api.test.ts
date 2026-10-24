import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { modules: { store_tryon: true }, members_enabled: true, ...settings },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const org = String(shop["org_id"]);
  const everyDay = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [["10:00", "20:00"]]]));
  sb.tables.stores.push({
    id: "st-1",
    org_id: org,
    name: "渋谷店",
    address: "東京都渋谷区1-1",
    phone: "03-0000-0000",
    email: "shibuya@example.com",
    notify_email: true,
    hours: everyDay,
    special_days: [],
    note: null,
    active: true,
    sort_order: 0,
  });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-1", tryon: true, sort_order: 0 });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await app.request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "https://wp.example.com", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, cors: res.headers.get("access-control-allow-origin"), json: (await res.json()) as Record<string, unknown> };
  };
  return { sb, owner, shop, sku, app, mail, call };
}

async function cartWith(call: ReturnType<typeof setup>["call"], skuId: string, qty: number) {
  return (await call("/api/shops/my-shop/cart", { op: "add", sku_id: skuId, qty })).json["cart"] as string;
}

const CUSTOMER = { store: "st-1", customer_name: "山田 花子", customer_email: "Hanako@example.com", customer_phone: "090-1111-2222" };

describe("ヘッドレスのお店で試着（/api/shops/:shop/stores・/tryon）", () => {
  it("店舗の一覧（営業時間・今日）→ カートのトークンで申し込み。在庫が減り、カートは空のトークンが返る", async () => {
    const { sb, sku, call } = setup();
    const stores = await call("/api/shops/my-shop/stores");
    expect(stores.status).toBe(200);
    expect(stores.cors).toBe("*");
    expect(stores.json["tryon"]).toMatchObject({ mode: "shop", max_items: 5 });
    const st = (stores.json["stores"] as Record<string, unknown>[])[0]!;
    expect(st).toMatchObject({ id: "st-1", name: "渋谷店", tryon: true, today: { open: true, hours: [["10:00", "20:00"]] } });
    expect(JSON.stringify(stores.json)).not.toContain("shibuya@example.com");

    const cart = await cartWith(call, sku.id, 2);
    expect((await call("/api/shops/my-shop/tryon", { cart, ...CUSTOMER, customer_email: "bad" })).json).toEqual({ error: "invalid_request", field: "email" });
    expect((await call("/api/shops/my-shop/tryon", { cart: "forged", ...CUSTOMER })).json).toEqual({ error: "invalid_cart" });
    const r = await call("/api/shops/my-shop/tryon", { cart, ...CUSTOMER, note: "比べたい" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ number: 1, store: { id: "st-1" }, member: null });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(3);
    expect(sb.tables.tryon_requests[0]).toMatchObject({ customer_email: "hanako@example.com", customer_id: null });
    const after = await call(`/api/shops/my-shop/cart?cart=${encodeURIComponent(String(r.json["cart"]))}`);
    expect(after.json["count"]).toBe(0);
    expect((await call("/api/shops/my-shop/tryon", { cart: r.json["cart"], ...CUSTOMER })).json).toEqual({ error: "empty_cart" });
  });

  it("点数の上限・来店日の形（選べる日）・モジュールが OFF なら 404", async () => {
    const { sb, sku, call } = setup({ store_tryon: { mode: "visit", min_days: 1, max_days: 5, max_items: 2 } });
    const stores = await call("/api/shops/my-shop/stores");
    const dates = (stores.json["stores"] as { visit_dates: string[] }[])[0]!.visit_dates;
    expect(dates).toHaveLength(5);
    expect((await call("/api/shops/my-shop/tryon", { cart: await cartWith(call, sku.id, 3), ...CUSTOMER })).json).toEqual({ error: "too_many_items", max_items: 2 });
    const cart = await cartWith(call, sku.id, 1);
    expect((await call("/api/shops/my-shop/tryon", { cart, ...CUSTOMER })).json).toEqual({ error: "invalid_request", field: "date" });
    expect((await call("/api/shops/my-shop/tryon", { cart, ...CUSTOMER, visit_date: dates[0] })).status).toBe(201);
    sb.tables.shops[0]!["settings"] = { members_enabled: true };
    const app2 = appWith(sb);
    expect((await app2.request(`${BASE}/api/shops/my-shop/stores`)).status).toBe(404);
  });

  it("会員: Bearer で申し込むと会員の申し込みになり、/members/tryon で読めて取り消せる", async () => {
    const { sb, sku, mail, call } = setup();
    const login = await call("/api/shops/my-shop/members/login", { email: "hanako@example.com" });
    const v = await call("/api/shops/my-shop/members/verify", { challenge_id: login.json["challenge_id"], code: mail.code("hanako@example.com") });
    const token = v.json["access_token"] as string;
    const r = await call("/api/shops/my-shop/tryon", { cart: await cartWith(call, sku.id, 1), ...CUSTOMER }, token);
    expect(r.json["member"]).toBeTruthy();
    const mine = await call("/api/shops/my-shop/members/tryon", undefined, token);
    expect(mine.json["requests"]).toMatchObject([{ number: 1, status: "requested", store_name: "渋谷店", cancellable: true, items: [{ name: "Tシャツ", qty: 1 }] }]);
    expect((await call("/api/shops/my-shop/members/tryon/1/cancel", {}, token)).json).toEqual({ ok: true });
    expect(sb.tables.tryon_requests[0]!["status"]).toBe("cancelled");
    expect((await call("/api/shops/my-shop/members/tryon/1/cancel", {}, token)).json).toEqual({ error: "not_cancellable" });
    expect((await call("/api/shops/my-shop/members/tryon")).status).toBe(401);
  });
});

describe("会員ページのお店で試着", () => {
  it("申し込みが会員ページに出て、取り置きが終わる前なら取り消せる", async () => {
    const { sb, sku, app, mail } = setup();
    const b = new Browser(app);
    await memberLogin(b, mail, "/my-shop", "hanako@example.com");
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect((await b.post("/my-shop/tryon/submit", CUSTOMER)).status).toBe(302);
    let html = await (await b.get("/my-shop/account")).text();
    expect(html).toContain("お店で試着のお申し込み");
    expect(html).toContain("渋谷店");
    expect(html).toContain("/my-shop/account/tryon/1/cancel");
    const res = await b.post("/my-shop/account/tryon/1/cancel", {});
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=tryon_cancelled");
    expect(sb.tables.tryon_requests[0]!["status"]).toBe("cancelled");
    html = await (await b.get("/my-shop/account")).text();
    expect(html).not.toContain("/my-shop/account/tryon/1/cancel");
    expect((await b.post("/my-shop/account/tryon/1/cancel", {})).headers.get("location")).toBe("/my-shop/account?error=tryon_not_cancellable");
  });
});

describe("AI 用トークンのお店で試着（REST / MCP）", () => {
  async function withToken(sb: FakeSupabase, shopId: string, ownerId: string, scopes: string[]) {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({
      id: `tok-${sb.tables.api_tokens.length + 1}`,
      shop_id: shopId,
      owner_id: ownerId,
      name: "t",
      token_hash: await hashApiToken(raw),
      prefix: tokenPrefix(raw),
      scopes,
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      created_at: "",
    });
    return raw;
  }
  it("一覧・1 件（連絡先は orders:pii）・状態を進める・終わった申し込みの在庫を EC に戻す", async () => {
    const { sb, owner, shop, sku, app, call } = setup();
    await call("/api/shops/my-shop/tryon", { cart: await cartWith(call, sku.id, 1), ...CUSTOMER });
    const read = await withToken(sb, shop.id, owner.id, ["orders:read", "shop:read"]);
    const rest = (token: string, method: string, path: string, body?: unknown) =>
      app.request(`${BASE}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const list = (await (await rest(read, "GET", "/tryon-requests")).json()) as { items: Record<string, unknown>[]; pii: boolean };
    expect(list.pii).toBe(false);
    expect(list.items[0]).toMatchObject({ number: 1, status: "requested", store_name: "渋谷店" });
    expect(list.items[0]!["customer"]).toBeUndefined();
    expect(((await (await rest(read, "GET", "/stores")).json()) as { stores: unknown[] }).stores).toHaveLength(1);
    expect((await rest(read, "POST", "/tryon-requests/1/status", { status: "sent" })).status).toBe(401);

    const write = await withToken(sb, shop.id, owner.id, ["orders:read", "orders:write", "orders:pii"]);
    expect(((await (await rest(write, "GET", "/tryon-requests/1")).json()) as Record<string, unknown>)["customer"]).toMatchObject({ email: "hanako@example.com" });
    expect((await rest(write, "POST", "/tryon-requests/1/status", { status: "ready" })).status).toBe(400);
    const ready = await rest(write, "POST", "/tryon-requests/1/status", { status: "ready", hold_until: "2099-01-10" });
    expect(await ready.json()).toMatchObject({ status: "ready", hold_until: "2099-01-10" });
    expect((await rest(write, "POST", "/tryon-requests/1/status", { status: "sent" })).status).toBe(409);
    expect((await rest(write, "POST", "/tryon-requests/1/status", { status: "expired" })).status).toBe(400);

    // MCP
    const mcp = async (name: string, args: Record<string, unknown>) =>
      (await (
        await app.request(`${BASE}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${write}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        })
      ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const tools = (await (
      await app.request(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${write}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string; annotations?: Record<string, unknown> }[] } };
    const upd = tools.result.tools.find((t) => t.name === "tryon_request_update_status")!;
    expect(upd.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.result.tools.find((t) => t.name === "tryon_request_restock")!.annotations).toMatchObject({ destructiveHint: true });
    const early = await mcp("tryon_request_restock", { number: 1 });
    expect(early.result.isError).toBe(true);
    const done = await mcp("tryon_request_update_status", { number: 1, status: "not_purchased" });
    expect(done.result.isError).toBeFalsy();
    expect(JSON.parse(done.result.content[0]!.text)).toMatchObject({ status: "not_purchased" });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(4); // 状態を進めただけでは在庫は戻らない
    const back = await mcp("tryon_request_restock", { number: 1 });
    expect(JSON.parse(back.result.content[0]!.text)).toMatchObject({ restocked: true, restocked_skus: 1 });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(5);
    // REST でも 2 回目は何もしない
    const again = (await (await rest(write, "POST", "/tryon-requests/1/restock")).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ restocked: true, restocked_skus: 0 });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(5);
    expect((await rest(read, "POST", "/tryon-requests/1/restock")).status).toBe(401);
  });
});
