import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, memoryAdapters } from "./helpers";
import { registerJobs } from "../src/jobs";
import { SALE_DATES_MIGRATION } from "../src/products/fields";
import { comingSoon, purchaseBlockOf } from "../src/products/sale";
import { productFromSummary } from "../src/themes/liquid/objects";

/** 発売日の前は買えない（Coming Soon、0148、メンテナの決定 2026-11-17）。DB の判定は test/db/product-sale-dates.test.ts */

const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

function setup(released: string | null) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true, released_at: released });
  const sku = sb.addSku(shop.id, product.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  return { sb, shop, product, sku, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

describe("判定（src/products/sale.ts）", () => {
  it("発売日が未来なら coming_soon、会員の条件より先。無い・過去・読めない日付は発売済み", () => {
    expect(comingSoon({ released_at: future() })).toBe(true);
    expect(comingSoon({ released_at: past() })).toBe(false);
    expect(comingSoon({ released_at: null })).toBe(false);
    expect(comingSoon({ released_at: "x" })).toBe(false);
    expect(purchaseBlockOf({ released_at: future() }, false)).toBe("coming_soon");
    expect(purchaseBlockOf({ released_at: past() }, false)).toBe("members_only");
    expect(purchaseBlockOf({ released_at: past() }, true)).toBeNull();
  });
});

describe("お店の画面", () => {
  it("発売前の商品は見えるが、カートの代わりに「発売予定」。カートに入れても入らない", async () => {
    const s = setup(future());
    const b = new Browser(s.app, BASE);
    const html = await (await b.get("/my-shop/products/tee")).text();
    expect(html).toContain("data-coming-soon");
    expect(html).toContain("発売予定です");
    await b.post("/my-shop/cart/add", { sku_id: s.sku.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("TEE-M");
    const js = await b.post("/my-shop/cart/add.js", { id: s.sku.id, quantity: "1" });
    expect(js.status).toBe(422);
    expect(JSON.stringify(await js.json())).toContain("発売前");
  });

  it("発売日を過ぎた商品はふつうに買える", async () => {
    const s = setup(past());
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products/tee")).text();
    expect(html).not.toContain("data-coming-soon");
    expect(html).toContain('type="submit"');
  });
});

describe("ヘッドレス", () => {
  it("詳細と一覧に coming_soon、カートに入れると 403 coming_soon", async () => {
    const s = setup(future());
    const d = (await (await s.app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: Record<string, unknown> };
    expect(d.product["coming_soon"]).toBe(true);
    expect(d.product["purchasable"]).toBe(false);
    const list = (await (await s.app.request(`${BASE}/api/shops/my-shop/products`)).json()) as { products: Record<string, unknown>[] };
    expect(list.products[0]!["coming_soon"]).toBe(true);
    const r = await s.app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: s.sku.id, qty: 1 }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "coming_soon" });
  });
});

describe("テーマ（Liquid）", () => {
  it("一覧のカードの coming_soon", () => {
    const base = { id: "p", slug: "tee", name: "T", tags: [], category_id: null, extra_category_ids: [], brand: null, created_at: past(), updated_at: past() };
    expect(productFromSummary({ shopPath: "", mediaBaseUrl: "" }, { product: { ...base, released_at: future() }, image: null, minPrice: 1, compareAt: null }).coming_soon).toBe(true);
    expect(productFromSummary({ shopPath: "", mediaBaseUrl: "" }, { product: { ...base, released_at: null }, image: null, minPrice: 1, compareAt: null }).coming_soon).toBe(false);
  });
});

describe("Cron（公開日）", () => {
  async function runPublishJob(sb: FakeSupabase) {
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => {} };
    registerJobs(adapters, { fetch: sb.fetch });
    await jobs.get("publish_scheduled_products")!();
  }
  it("公開日を過ぎた非公開の商品を公開する。0148 を当てる前の DB では何もしない（Cron を止めない）", async () => {
    const s = setup(null);
    const p = s.sb.addProduct(s.shop.id, { id: crypto.randomUUID(), slug: "sched", name: "S", published: false, publish_at: "2020-01-01T00:00:00.000Z" });
    const old = new FakeSupabase();
    old.appliedMigrations = old.appliedMigrations.filter((m) => m !== SALE_DATES_MIGRATION);
    const q = old.addProduct(old.addShop(old.addUser("o@example.com", "password-123", { owner: true }).id, { slug: "o", name: "O" }).id, { id: crypto.randomUUID(), slug: "x", name: "X", published: false, publish_at: "2020-01-01T00:00:00.000Z" });
    await runPublishJob(old);
    expect(q["published"]).toBe(false);
    await runPublishJob(s.sb);
    expect(p["published"]).toBe(true);
  });
});
