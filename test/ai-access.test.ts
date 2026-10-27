import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts, tinyPng } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

afterEach(() => externalHosts.clear());

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  const other = sb.addUser("other@example.com", "password-456", { owner: true });
  const otherShop = sb.addShop(other.id, { slug: "other", name: "他店", published: true });
  const otherProduct = sb.addProduct(otherShop.id, { slug: "secret", name: "秘密の商品", published: true });
  sb.tables.orders.push({ id: "order-1", shop_id: shop.id, reservation_id: null, status: "paid", total_jpy: 6000, customer_email: "buyer@example.com", customer_name: "山田", shipping_address: { state: "東京都", line1: "秘密の住所" }, payment_provider: "stripe", payment_ref: "pi_1", shipped_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  sb.tables.order_items.push({ id: "oi-1", shop_id: shop.id, order_id: "order-1", sku_id: sku.id, qty: 2, unit_price_jpy: 3000 });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const issue = async (scopes: string[], extra: Record<string, unknown> = {}) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "", ...extra });
    return raw;
  };
  return { sb, owner, shop, tee, sku, otherProduct, storage, app, issue };
}

const rest = (app: ReturnType<typeof appWith>, token: string | null, method: string, path: string, body?: unknown) =>
  app.request(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("REST /api/v1", () => {
  it("認証: ヘッダ無し・形式違い・未知・失効・期限切れはすべて 401。Cookie では入れない", async () => {
    const { app, issue, sb } = await setup();
    expect((await rest(app, null, "GET", "/products")).status).toBe(401);
    expect((await rest(app, "nope", "GET", "/products")).status).toBe(401);
    expect((await rest(app, generateApiToken(), "GET", "/products")).status).toBe(401);
    const revoked = await issue(["products:read"], { revoked_at: new Date().toISOString() });
    expect((await rest(app, revoked, "GET", "/products")).status).toBe(401);
    const expired = await issue(["products:read"], { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await rest(app, expired, "GET", "/products")).status).toBe(401);
    const body = (await (await rest(app, null, "GET", "/products")).json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    // 管理画面にログインした Cookie を付けても API は通らない
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await app.request(`${BASE}/api/v1/products`, { headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(res.status).toBe(401);
    expect(sb.tables.api_tokens.every((t) => t["last_used_at"] === null)).toBe(true);
  });

  it("スコープ: 読み取りトークンでは書けない。他ショップの ID は not_found", async () => {
    const { app, issue, otherProduct, tee } = await setup();
    const ro = await issue(["products:read"]);
    expect((await rest(app, ro, "GET", "/products")).status).toBe(200);
    const w = await rest(app, ro, "PATCH", `/products/${tee.id}`, { name: "x" });
    expect(w.status).toBe(401);
    expect((await rest(app, ro, "GET", `/products/${otherProduct.id}`)).status).toBe(404);
    expect((await rest(app, ro, "GET", "/orders")).status).toBe(401);
    expect((await rest(app, ro, "GET", "/shop")).status).toBe(401);
  });

  it("本文は 1MB まで。超えたら読まずに 413（Content-Length の申告が無い・偽っても上限で止める）", async () => {
    const { app, issue, tee, sb } = await setup();
    const tok = await issue(["products:write"]);
    const big = JSON.stringify({ description: "あ".repeat(400_000) }); // UTF-8 で 1.2MB
    const res = await rest(app, tok, "PATCH", `/products/${tee.id}`, JSON.parse(big));
    expect(res.status).toBe(413);
    // 申告の無い本文（ストリーム）も上限で止める
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) ctl.enqueue(bytes.subarray(i, i + 64 * 1024));
        ctl.close();
      },
    });
    const streamed = await app.request(`${BASE}/api/v1/products/${tee.id}`, { method: "PATCH", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(sb.tables.products.find((p) => p.id === tee.id)?.["description"]).not.toBe("あ".repeat(400_000));
    // 上限より小さければ今までどおり
    expect((await rest(app, tok, "PATCH", `/products/${tee.id}`, { description: "あ".repeat(1000) })).status).toBe(200);
  });

  it("ショップ: 購入前の確認画面の文言（checkout_terms）を読み書きする。渡した鍵だけ変え、null で消す", async () => {
    const { app, issue, sb, shop } = await setup();
    const tok = await issue(["shop:read", "shop:write"]);
    let res = await rest(app, tok, "GET", "/shop");
    expect(((await res.json()) as { checkout_terms: unknown }).checkout_terms).toEqual({ delivery: null, cancellation: null, payment_note: null });

    res = await rest(app, tok, "PATCH", "/shop", { checkout_terms: { delivery: " ご入金確認後 3 営業日以内に発送します。\r\n ", cancellation: "決済完了後のキャンセルはお受けできません。" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checkout_terms: unknown }).checkout_terms).toEqual({ delivery: "ご入金確認後 3 営業日以内に発送します。", cancellation: "決済完了後のキャンセルはお受けできません。", payment_note: null });

    // 渡していない鍵はそのまま。null で消す。ほかの settings は触らない
    const before = { ...(sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>) };
    res = await rest(app, tok, "PATCH", "/shop", { checkout_terms: { cancellation: null, payment_note: "銀行振込は 7 日以内にお振り込みください。" } });
    expect(((await res.json()) as { checkout_terms: unknown }).checkout_terms).toEqual({ delivery: "ご入金確認後 3 営業日以内に発送します。", cancellation: null, payment_note: "銀行振込は 7 日以内にお振り込みください。" });
    const after = sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>;
    expect({ ...after, checkout_terms: undefined }).toEqual({ ...before, checkout_terms: undefined });

    res = await rest(app, tok, "PATCH", "/shop", { checkout_terms: { delivery: "x".repeat(2001) } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: "invalid", message: "invalid_checkout_terms" });

    // 読み取りだけのトークンでは書けない
    const ro = await issue(["shop:read"]);
    expect((await rest(app, ro, "PATCH", "/shop", { checkout_terms: { delivery: "x" } })).status).toBe(401);
  });

  it("商品: 一覧 → 作成 → SKU → 更新 → 画像（URL 取り込み、SSRF 拒否）", async () => {
    const { app, issue, sb, storage, shop } = await setup();
    const tok = await issue(["products:read", "products:write"]);
    const list = (await (await rest(app, tok, "GET", "/products?q=T")).json()) as { items: { slug: string; skus: { available: number }[] }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.items[0]!.skus[0]!.available).toBe(5);

    let res = await rest(app, tok, "POST", "/products", { slug: "mug", name: "マグ" });
    expect(res.status).toBe(201);
    const mug = (await res.json()) as { id: string; published: boolean };
    expect(mug.published).toBe(false);
    expect((await rest(app, tok, "POST", "/products", { slug: "mug", name: "重複" })).status).toBe(409);
    expect((await rest(app, tok, "POST", "/products", "not-an-object")).status).toBe(400);

    res = await rest(app, tok, "POST", `/products/${mug.id}/skus`, { code: "MUG-1", price_jpy: 1200, available: 3 });
    expect(res.status).toBe(201);
    const withSku = (await res.json()) as { skus: { id: string; available: number }[] };
    expect(withSku.skus[0]!.available).toBe(3);
    res = await rest(app, tok, "PATCH", `/skus/${withSku.skus[0]!.id}`, { available: 9, price_jpy: 1500 });
    expect(((await res.json()) as { skus: { available: number; price_jpy: number }[] }).skus[0]).toMatchObject({ available: 9, price_jpy: 1500 });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === withSku.skus[0]!.id)!["available"]).toBe(9);

    // 画像
    const png = tinyPng();
    externalHosts.set("https://images.example/", (req) => (req.url.endsWith("big.png") ? new Response(new Uint8Array(6 * 1024 * 1024), { headers: { "content-type": "image/png" } }) : req.url.endsWith("page.html") ? new Response("<html>", { headers: { "content-type": "text/html" } }) : new Response(png, { headers: { "content-type": "image/png" } })));
    res = await rest(app, tok, "POST", `/products/${mug.id}/images`, { image_url: "https://images.example/a.png" });
    expect(res.status).toBe(201);
    const img = ((await res.json()) as { images: { id: string; storage_key: string }[] }).images[0]!;
    expect(img.storage_key).toMatch(new RegExp(`^shops/${shop.id}/products/${mug.id}/`));
    expect(storage.objects.has(img.storage_key)).toBe(true);
    for (const bad of ["https://images.example/page.html", "https://images.example/big.png", "http://127.0.0.1/x.png", "http://localhost:8787/admin", "http://169.254.169.254/latest", "ftp://x/y.png", "not a url", "http://10.0.0.1/a.png", "http://metadata.internal/a.png"]) {
      const r = await rest(app, tok, "POST", `/products/${mug.id}/images`, { image_url: bad });
      expect(`${bad} -> ${r.status}`).toBe(`${bad} -> 400`);
    }
    expect(storage.objects.size).toBe(1);
    expect((await rest(app, tok, "DELETE", `/images/${img.id}`)).status).toBe(204);
    expect(storage.objects.size).toBe(0);
    expect((await rest(app, tok, "DELETE", `/images/${img.id}`)).status).toBe(404);
  });

  it("注文: orders:read はマスク、orders:pii で個人情報。発送は orders:write", async () => {
    const { app, issue } = await setup();
    const ro = await issue(["orders:read"]);
    let body = (await (await rest(app, ro, "GET", "/orders")).json()) as { items: { customer: Record<string, unknown> }[]; pii: boolean };
    expect(body.pii).toBe(false);
    expect(body.items[0]!.customer).toEqual({ masked: true, prefecture: "東京都" });
    expect(JSON.stringify(body)).not.toContain("buyer@example.com");
    const pii = await issue(["orders:read", "orders:pii", "orders:write"]);
    body = (await (await rest(app, pii, "GET", "/orders")).json()) as typeof body;
    expect(body.items[0]!.customer).toMatchObject({ email: "buyer@example.com" });
    expect((await rest(app, ro, "POST", "/orders/order-1/status", { status: "shipped" })).status).toBe(401);
    expect((await rest(app, pii, "POST", "/orders/order-1/status", { status: "refunded" })).status).toBe(400);
    const shipped = await rest(app, pii, "POST", "/orders/order-1/status", { status: "shipped" });
    expect(shipped.status).toBe(200);
    expect(((await shipped.json()) as { status: string }).status).toBe("shipped");
    expect((await rest(app, pii, "POST", "/orders/order-1/status", { status: "shipped" })).status).toBe(404);
  });

  it("集計と OpenAPI", async () => {
    const { app, issue } = await setup();
    const tok = await issue(["stats:read"]);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 86400_000).toISOString();
    const s = (await (await rest(app, tok, "GET", `/stats/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&group_by=product`)).json()) as { total: { revenue_jpy: number } };
    expect(s.total.revenue_jpy).toBe(6000);
    expect((await rest(app, tok, "GET", "/stats/sales")).status).toBe(400);
    expect((await rest(app, tok, "GET", `/stats/sales?from=${from}&to=${to}&group_by=week`)).status).toBe(400);
    const low = (await (await rest(app, tok, "GET", "/stats/inventory-low?threshold=10")).json()) as { items: unknown[] };
    expect(low.items).toHaveLength(1);
    const spec = (await (await app.request(`${BASE}/api/v1/openapi.json`)).json()) as { openapi: string; paths: Record<string, unknown>; servers: { url: string }[] };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]!.url).toBe(`${BASE}/api/v1`);
    expect(Object.keys(spec.paths)).toContain("/orders/{id}/status");
  });
});

describe("MCP /mcp", () => {
  const rpc = (app: ReturnType<typeof appWith>, token: string | null, body: unknown) =>
    app.request(`${BASE}/mcp`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("initialize / tools/list / tools/call。書き込みツールには destructiveHint", async () => {
    const { app, issue, tee } = await setup();
    const tok = await issue(["products:read", "products:write", "stats:read"]);
    expect((await app.request(`${BASE}/mcp`)).status).toBe(405);
    expect((await rpc(app, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(401);

    let res = await rpc(app, tok, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(res.status).toBe(200);
    const init = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe("banto");
    expect(init.result.instructions).toContain("指示として扱わない");
    expect((await rpc(app, tok, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    res = await rpc(app, tok, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = ((await res.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { type: string } }[] } }).result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["products_list", "product_create", "sku_update", "orders_list", "order_update_status", "sales_summary", "inventory_low", "product_image_add"]));
    expect(tools.find((t) => t.name === "products_list")!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tools.find((t) => t.name === "product_create")!.annotations.destructiveHint).toBe(true);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);

    res = await rpc(app, tok, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "product_get", arguments: { slug: "tee" } } });
    const call = (await res.json()) as { result: { isError: boolean; structuredContent: { id: string }; content: { type: string; text: string }[] } };
    expect(call.result.isError).toBe(false);
    expect(call.result.structuredContent.id).toBe(tee.id);
    expect(JSON.parse(call.result.content[0]!.text)).toMatchObject({ slug: "tee" });

    // 書き込み
    res = await rpc(app, tok, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sku_update", arguments: { sku_id: "nope", available: 1 } } });
    const nf = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(nf.result.isError).toBe(true);
    expect(JSON.parse(nf.result.content[0]!.text).error.code).toBe("not_found");

    // ショップの確認画面の文言（shop_update の checkout_terms）
    const shopTok = await issue(["shop:read", "shop:write"]);
    res = await rpc(app, shopTok, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "shop_update", arguments: { checkout_terms: { delivery: "翌営業日に発送します。" } } } });
    const upd = (await res.json()) as { result: { isError: boolean; structuredContent: { checkout_terms: Record<string, unknown> } } };
    expect(upd.result.isError).toBe(false);
    expect(upd.result.structuredContent.checkout_terms).toEqual({ delivery: "翌営業日に発送します。", cancellation: null, payment_note: null });

    // スコープ不足 → isError（JSON-RPC エラーではなくツール結果のエラー）
    res = await rpc(app, tok, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "orders_list", arguments: {} } });
    expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(true);

    // 引数の型違い
    res = await rpc(app, tok, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "products_list", arguments: { limit: "ten" } } });
    expect(JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text).error.code).toBe("invalid");

    // 未知のメソッド / ツール / バッチ / パースエラー
    expect(((await (await rpc(app, tok, { jsonrpc: "2.0", id: 7, method: "resources/list" })).json()) as { error: { code: number } }).error.code).toBe(-32601);
    expect(((await (await rpc(app, tok, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "drop_everything" } })).json()) as { error: { code: number } }).error.code).toBe(-32602);
    const batch = (await (await rpc(app, tok, [{ jsonrpc: "2.0", id: 9, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).json()) as unknown[];
    expect(batch).toHaveLength(1);
    const parse = await app.request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{" });
    expect(parse.status).toBe(400);
    const tooMany = await rpc(app, tok, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })));
    expect(tooMany.status).toBe(400);
    // 本文は 1MB まで
    const tooBig = await rpc(app, tok, { jsonrpc: "2.0", id: 10, method: "ping", params: { pad: "x".repeat(1024 * 1024) } });
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("集計ツールは group_by を検証する", async () => {
    const { app, issue } = await setup();
    const tok = await issue(["stats:read"]);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 86400_000).toISOString();
    const res = await rpc(app, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sales_summary", arguments: { from, to, group_by: "day" } } });
    const r = (await res.json()) as { result: { structuredContent: { total: { orders: number } } } };
    expect(r.result.structuredContent.total.orders).toBe(1);
  });
});

describe("管理画面: AI 連携（トークン）", () => {
  it("発行（一度だけ表示、DB はハッシュ）→ 利用 → 失効 → 利用不可。他人のショップでは発行できない", async () => {
    const { app, sb, shop } = await setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await b.get(`/admin/shops/${shop.id}/tokens`)).text();
    expect(html).toContain("トークンはまだありません");
    expect(html).toContain(`${BASE}/mcp`);
    expect(html).toMatch(/value="products:read" checked/);
    expect(html).not.toMatch(/value="orders:pii" checked/);

    const res = await b.post(`/admin/shops/${shop.id}/tokens`, { name: "Claude", scopes: "products:read", expires_days: "30" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    html = await res.text();
    const raw = html.match(/banto_[A-Za-z0-9_-]{40,50}/)![0];
    expect(html).toContain(`data-copy="${raw}"`); // コピーのボタン
    const row = sb.tables.api_tokens[0]!;
    expect(row["token_hash"]).toBe(await hashApiToken(raw));
    expect(row["prefix"]).toBe(raw.slice(0, 12));
    expect(row["scopes"]).toEqual(["products:read"]);
    expect(row["expires_at"]).toBeTruthy();
    expect(JSON.stringify(sb.tables.api_tokens)).not.toContain(raw);

    expect((await rest(app, raw, "GET", "/products")).status).toBe(200);
    html = await (await b.get(`/admin/shops/${shop.id}/tokens`)).text();
    expect(html).toContain("Claude");
    expect(html).not.toContain(raw); // 一覧では二度と出ない

    const revoke = await b.post(`/admin/shops/${shop.id}/tokens/${row["id"]}/revoke`, {});
    expect(revoke.headers.get("location")).toBe(`/admin/shops/${shop.id}/tokens?flash=revoked`);
    expect((await rest(app, raw, "GET", "/products")).status).toBe(401);

    // 他人のショップ
    const otherShop = sb.shops.find((s) => s.slug === "other")!;
    expect((await b.get(`/admin/shops/${otherShop.id}/tokens`)).status).toBe(404);
    expect((await b.post(`/admin/shops/${otherShop.id}/tokens`, { name: "x", scopes: "products:read" })).status).toBe(404);
    expect(sb.tables.api_tokens).toHaveLength(1);
  });

  it("ダッシュボードに直近 30 日の売上が出る", async () => {
    const { app } = await setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get("/admin")).text();
    expect(html).toMatch(/¥6,000<small>1件<\/small>/);
  });
});

describe("導入の進捗 status.json", () => {
  it("未設定の名前と次の手順を返し、秘密は返さない。運営者登録後は 404", async () => {
    const sb = new FakeSupabase({ appliedMigrations: ["0001_init"] });
    const app = appWith(sb, { SUPABASE_SERVICE_ROLE_KEY: undefined });
    let res = await app.request(`${BASE}/admin/setup/status.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ env: { missing: ["SUPABASE_SERVICE_ROLE_KEY"] }, db: { status: "ok" }, owner: { exists: false }, next: "env" });
    expect(JSON.stringify(body)).not.toContain(sb.anonKey);
    const ready = appWith(new FakeSupabase({ appliedMigrations: ["0001_init"] }));
    expect(((await (await ready.request(`${BASE}/admin/setup/status.json`)).json()) as { next: string }).next).toBe("migrate");
    const sb2 = new FakeSupabase();
    sb2.addUser("o@example.com", "pw", { owner: true });
    res = await appWith(sb2).request(`${BASE}/admin/setup/status.json`);
    expect(res.status).toBe(404);
  });
});

describe("AI 用 API: 商品マスタの拡張（0008）", () => {
  it("REST でカテゴリーを作り、商品と SKU に拡張項目を付ける。MCP にもツールがある", async () => {
    const { app, issue, sb } = await setup();
    const tok = await issue(["products:read", "products:write"]);
    let res = await rest(app, tok, "POST", "/categories", { slug: "wear", name: "ウェア" });
    expect(res.status).toBe(200);
    res = await rest(app, tok, "POST", "/categories", { slug: "tops", name: "トップス", parent: "wear" });
    expect(await res.json()).toMatchObject({ slug: "tops", parent_id: sb.tables.categories[0]!["id"] });
    res = await rest(app, tok, "GET", "/categories");
    expect(((await res.json()) as { categories: unknown[] }).categories).toHaveLength(2);

    res = await rest(app, tok, "POST", "/products", { slug: "hoodie", name: "パーカー", category: "tops", brand: "Banto", attributes: { material: "綿" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; category: { slug: string } };
    expect(created).toMatchObject({ category: { slug: "tops" }, brand: "Banto", attributes: { material: "綿" } });
    res = await rest(app, tok, "PATCH", `/products/${created.id}`, { category: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid", message: expect.stringContaining("category_not_found") } });

    res = await rest(app, tok, "POST", `/products/${created.id}/skus`, { code: "HOOD-M", price_jpy: 5000, compare_at_price_jpy: 6000, gtin: "4901234567894", options: { サイズ: "M" } });
    expect(await res.json()).toMatchObject({ skus: [{ code: "HOOD-M", compare_at_price_jpy: 6000, gtin: "4901234567894", options: { サイズ: "M" } }] });

    res = await app.request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = ((await res.json()) as { result: { tools: { name: string; annotations?: { destructiveHint?: boolean }; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
    expect(tools.find((t) => t.name === "categories_list")).toBeDefined();
    expect(tools.find((t) => t.name === "category_save")?.annotations?.destructiveHint).toBe(true);
    expect(Object.keys(tools.find((t) => t.name === "product_update")!.inputSchema.properties)).toEqual(expect.arrayContaining(["category", "brand", "attributes"]));
    expect(Object.keys(tools.find((t) => t.name === "sku_update")!.inputSchema.properties)).toEqual(expect.arrayContaining(["options", "compare_at_price_jpy", "gtin"]));
  });
});
