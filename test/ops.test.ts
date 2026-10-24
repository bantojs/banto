import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memoryAdapters } from "./helpers";
import { fakeAdapters } from "../src/app.test";
import { registerJobs } from "../src/jobs";

describe("運用: /health とバックアップ書き出し", () => {
  it("/health は DB に届けば 200、未設定なら not_configured、落ちていれば 503（結果は 30 秒キャッシュ）", async () => {
    const sb = new FakeSupabase();
    const app = appWith(sb);
    const res = await app.request(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; checks: { db: string }; version: string; time: string };
    expect(body).toMatchObject({ ok: true, checks: { db: "ok" } });
    expect(body.time).toMatch(/^\d{4}-/);

    const unconfigured = createApp(() => fakeAdapters());
    expect(await (await unconfigured.request("/health")).json()).toMatchObject({ ok: true, checks: { db: "not_configured" } });

    // Supabase が落ちている（PostgREST が 5xx）→ 503。秘密や URL は出さない
    const down = appWith(sb);
    sb.failNextRequests = 1;
    const bad = await down.request(`${BASE}/health`);
    expect(bad.status).toBe(503);
    const text = await bad.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, checks: { db: "error" } });
    expect(text).not.toContain("supabase");
    // キャッシュ中は DB を叩かない（fail を使い切っていても error のまま）
    expect((await down.request(`${BASE}/health`)).status).toBe(503);
  });

  it("export.json は自分のショップの全テーブルを 1,000 行ページングで書き出し、他人のショップは 404", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    for (let i = 0; i < 1203; i++) sb.addProduct(shop.id, { slug: `p${i}`, name: `P${i}`, published: i % 2 === 0 });
    const p = sb.tables.products[0]!;
    sb.addSku(shop.id, p["id"] as string, { code: "A", price_jpy: 100, available: 3 });
    const other = sb.addUser("x@example.com", "password-456", { owner: true });
    const otherShop = sb.addShop(other.id, { slug: "x", name: "X", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.addProduct(otherShop.id, { slug: "theirs", name: "Theirs", published: true });

    const app = appWith(sb);
    const b = await Browser.loggedIn(app, "o@example.com", "password-123");
    const res = await b.get(`/admin/shops/${shop.id}/export.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="banto-s-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = (await res.json()) as { banto_export: number; shop: { id: string }; tables: Record<string, Record<string, unknown>[]>; counts: Record<string, number> };
    expect(body.banto_export).toBe(1);
    expect(body.shop.id).toBe(shop.id);
    expect(body.counts["products"]).toBe(1203);
    expect(body.tables["products"]).toHaveLength(1203);
    expect(body.tables["skus"]).toHaveLength(1);
    expect(body.tables["inventory"]).toHaveLength(1);
    expect(body.tables["products"]!.some((r) => r["slug"] === "theirs")).toBe(false);
    expect(Object.keys(body.tables).sort()).toEqual(["categories", "coupon_campaigns", "coupon_grants", "coupon_slots", "customers", "hook_endpoints", "inventory", "order_items", "orders", "product_images", "products", "skus"]);

    // 他人のショップ（公開中でも）は 404。未ログインはログインへ
    expect((await b.get(`/admin/shops/${otherShop.id}/export.json`)).status).toBe(404);
    const anon = await app.request(`${BASE}/admin/shops/${shop.id}/export.json`);
    expect(anon.status).toBe(302);
    // 設定画面にリンクがある
    expect(await (await b.get(`/admin/shops/${shop.id}`)).text()).toContain(`/admin/shops/${shop.id}/export.json`);
  });
});

describe("運用: Cron ハートビートと復元", () => {
  it("/health は Cron の最終実行が 15 分以内なら ok、古ければ stale（503）、未記録なら unknown", async () => {
    const sb = new FakeSupabase();
    const fresh = appWith(sb);
    expect(await (await fresh.request(`${BASE}/health`)).json()).toMatchObject({ ok: true, checks: { db: "ok", cron: "unknown" } });

    // Cron を 1 回回すと heartbeat が記録される（他のジョブの後に動く）
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => { for (const j of jobs.values()) await j(); } };
    registerJobs(adapters, { fetch: sb.fetch });
    expect([...jobs.keys()].at(-1)).toBe("heartbeat");
    await adapters.scheduler.runAll();
    expect(sb.heartbeats.has("cron")).toBe(true);
    const okApp = appWith(sb);
    expect(await (await okApp.request(`${BASE}/health`)).json()).toMatchObject({ ok: true, checks: { db: "ok", cron: "ok" } });

    sb.heartbeats.set("cron", Date.now() - 16 * 60_000);
    const staleApp = appWith(sb);
    const res = await staleApp.request(`${BASE}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, checks: { db: "ok", cron: "stale" } });
  });

  it("JSON を空のショップに復元できる。ID は振り直され、注文番号と在庫は保たれる。空でないショップには入れない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const src = sb.addShop(owner.id, { slug: "src", name: "Src", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const p = sb.addProduct(src.id, { slug: "tee", name: "Tee", published: true, tags: ["Tシャツ", "夏物"] });
    const sku = sb.addSku(src.id, p.id, { code: "TEE-M", price_jpy: 3000, available: 7 });
    sb.tables.product_images.push({ id: "img-1", shop_id: src.id, product_id: p.id, storage_key: "shops/src/a.webp", thumb_key: "shops/src/a.thumb.webp", width: 1600, height: 1200, sort_order: 0, created_at: "" });
    sb.tables.orders.push({ id: "order-9", shop_id: src.id, number: 1042, status: "paid", total_jpy: 3000, shipping_jpy: 0, customer_email: "a@example.com", customer_name: "A", shipping_address: {}, payment_provider: "stripe", payment_ref: "pi_1", shipped_at: null, created_at: "2026-01-01T00:00:00Z", customer_id: "user-ghost", reservation_id: "res-1" });
    sb.tables.order_items.push({ id: "item-1", shop_id: src.id, order_id: "order-9", sku_id: sku.id, qty: 1, unit_price_jpy: 3000 });
    sb.tables.order_items.push({ id: "item-2", shop_id: src.id, order_id: "order-9", sku_id: "sku-deleted", qty: 1, unit_price_jpy: 100 });
    sb.tables.customers.push({ id: "user-ghost", shop_id: src.id, email: "ghost@example.com", name: "G", default_address: null, created_at: "" });
    sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: src.id, name: "crm", url: "https://crm.example/hook", events: ["order.paid"], enabled: true, manifest: null, settings: { to: "x" }, created_at: "" });

    const app = appWith(sb);
    const b = await Browser.loggedIn(app, "o@example.com", "password-123");
    const exported = await (await b.get(`/admin/shops/${src.id}/export.json`)).text();

    // 復元先: 空の新しいショップ
    const dst = sb.addShop(owner.id, { slug: "dst", name: "Dst", published: false, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    let res = await b.postMultipart(`/admin/shops/${dst.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(new RegExp(`^/admin/shops/${dst.id}\\?flash=restored&detail=`));
    const detail = decodeURIComponent(loc.split("detail=")[1]!);
    expect(detail).toContain("products: 1");
    expect(detail).toContain("orders: 1");
    expect(detail).toContain("order_items: 1");
    expect(detail).toContain("order_items_skipped: 1");
    // 会員は Supabase Auth と関係なく戻る（0012）
    expect(detail).toContain("customers: 1");
    expect(detail).toContain("customers_skipped: 0");
    expect(detail).toContain("hook_endpoints: 1");
    expect(await (await b.get(loc)).text()).toContain("復元しました。件数: products: 1");

    const newProduct = sb.tables.products.find((x) => x["shop_id"] === dst.id)!;
    expect(newProduct["id"]).not.toBe(p.id);
    // タグは restore_product_tags で戻る（0007）
    expect(newProduct["tags"]).toEqual(["Tシャツ", "夏物"]);
    expect(newProduct["slug"]).toBe("tee");
    const newSku = sb.tables.skus.find((x) => x["shop_id"] === dst.id)!;
    expect(sb.tables.inventory.find((i) => i["sku_id"] === newSku["id"])!["available"]).toBe(7);
    const newOrder = sb.tables.orders.find((x) => x["shop_id"] === dst.id)!;
    expect(newOrder).toMatchObject({ number: 1042, reservation_id: null, customer_id: "user-ghost", customer_email: "a@example.com" });
    expect(sb.tables.shops.find((s) => s["id"] === dst.id)!["order_seq"]).toBe(1042);
    expect(sb.tables.product_images.find((x) => x["shop_id"] === dst.id)).toMatchObject({ storage_key: "shops/src/a.webp", thumb_key: "shops/src/a.thumb.webp" });
    // 元のショップは無傷
    expect(sb.tables.products.filter((x) => x["shop_id"] === src.id)).toHaveLength(1);

    // 二度目は空でないので拒否。壊れた JSON と banto_export 無しも拒否
    res = await b.postMultipart(`/admin/shops/${dst.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    expect(res.headers.get("location")).toBe(`/admin/shops/${dst.id}?flash=restore_not_empty`);
    const empty = sb.addShop(owner.id, { slug: "empty", name: "E", published: false, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    res = await b.postMultipart(`/admin/shops/${empty.id}/restore`, { file: new File(["{not json"], "x.json", { type: "application/json" }) });
    expect(res.headers.get("location")).toBe(`/admin/shops/${empty.id}?flash=restore_invalid`);
    res = await b.postMultipart(`/admin/shops/${empty.id}/restore`, { file: new File([JSON.stringify({ tables: {} })], "x.json", { type: "application/json" }) });
    expect(res.headers.get("location")).toBe(`/admin/shops/${empty.id}?flash=restore_invalid`);
    // 他人のショップには復元できない
    const other = sb.addUser("x@example.com", "password-456", { owner: true });
    const theirs = sb.addShop(other.id, { slug: "theirs", name: "T", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    res = await b.postMultipart(`/admin/shops/${theirs.id}/restore`, { file: new File([exported], "backup.json", { type: "application/json" }) });
    expect(res.status).toBe(404);
    expect(sb.tables.products.filter((x) => x["shop_id"] === theirs.id)).toHaveLength(0);
  });
});
