import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { putThemeAsset, sealThemeAssets, themeBundleKey, unsealThemeAssets } from "../src/themes/liquid/versions";
import { main } from "../cli/banto-theme.mjs";

/** テーマの段階 2・3 の見直しの続き（検索・AJAX のカート・資産の締め切り・CLI） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/search.liquid": `<p class="s">{{ search.performed }}/{{ search.too_short }}/{{ search.terms }}</p>`,
};

function setup(opts: { liquid?: boolean } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "続きのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings: { modules: { coupons: true } } });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  // 既定のテーマで確かめるときは独自ドメインを外す（Banto の URL で開く）
  if (opts.liquid === false) delete row["domain"];
  if (opts.liquid !== false) row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const tee = sb.addSku(shop.id, p.id, { code: "TEE-S", name: "S", price_jpy: 1000, available: 2 });
  const q = sb.addProduct(shop.id, { slug: "mug", name: "マグ", published: true });
  const mug = sb.addSku(shop.id, q.id, { code: "MUG", name: null, price_jpy: 500, available: 5 });
  sb.tables.coupon_campaigns.push({ id: "camp-1", shop_id: shop.id, name: "10%", code: "OFF10", kind: "percent", value: 10, starts_at: null, ends_at: null, usage_limit: null, per_customer_limit: null, combinable: false, audience: "public", conditions: {}, active: true, created_at: new Date().toISOString() });
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, shop, tee, mug, b: new Browser(app, DOMAIN), app };
}

describe("検索の短すぎる語", () => {
  beforeEach(forgetThemes);

  it("既定のテーマは「3 文字以上」の案内、見つからなければその旨。Liquid は performed: false と too_short", async () => {
    const { app } = setup({ liquid: false });
    const b = new Browser(app);
    expect(await (await b.get("/s/search?q=%E8%B2%A1%E5%B8%83")).text()).toContain("3 文字以上で探してください。");
    expect(await (await b.get("/s/search?q=zzzz")).text()).toContain("「zzzz」に合う商品は見つかりませんでした。");
    const liquid = setup();
    expect(await (await liquid.b.get("/search?q=%E8%B2%A1%E5%B8%83")).text()).toContain('<p class="s">false/true/財布</p>');
    expect(await (await liquid.b.get("/search?q=zzzz")).text()).toContain('<p class="s">true/false/zzzz</p>');
  });
});

describe("AJAX のカート（Shopify と同じ応え方）", () => {
  beforeEach(forgetThemes);

  it("/cart.js の合計にクーポンの値引きが入る", async () => {
    const { b, tee } = setup();
    await b.post("/cart/add", { id: tee.id, quantity: "2" });
    await b.post("/cart/coupon", { code: "OFF10" });
    const cart = (await (await b.get("/cart.js")).json()) as { total_price: number; total_discount: number; items_subtotal_price: number };
    expect(cart.items_subtotal_price).toBe(200000);
    expect(cart.total_discount).toBe(20000);
    expect(cart.total_price).toBe(180000);
  });

  it("update.js はカートに無い品を足す（公開中の SKU だけ）。change.js はカートに無い id を 400。add.js は在庫を超えると 422 で入れない", async () => {
    const { b, tee, mug } = setup();
    await b.post("/cart/add", { id: tee.id, quantity: "1" });
    const up = (await (await b.postJson("/cart/update.js", { updates: { [mug.id]: 2, "no-such-sku": 1 } })).json()) as { items: { sku: string; quantity: number }[] };
    expect(up.items.map((i) => `${i.sku}x${i.quantity}`).sort()).toEqual(["MUGx2", "TEE-Sx1"]);
    expect((await b.postJson("/cart/change.js", { id: "no-such-sku", quantity: 1 })).status).toBe(400);
    const over = await b.postJson("/cart/add.js", { id: tee.id, quantity: 5 });
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ status: 422, description: "「Tシャツ」は在庫が足りません。" });
    expect(((await (await b.get("/cart.js")).json()) as { items: { sku: string; quantity: number }[] }).items.find((i) => i.sku === "TEE-S")?.quantity).toBe(1);
  });
});

describe("資産の受け付けの締め切り", () => {
  it("締めた版には置けない。確かめた後・書いている途中に締められたら、書いた資産を消す", async () => {
    const storage = new MemoryStorage(`${BASE}/media`);
    const shop = "shop-1";
    await storage.put(themeBundleKey(shop, VERSION), new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: ["theme.css"] })).buffer as ArrayBuffer, "application/json");
    const css = new TextEncoder().encode("body{}").buffer as ArrayBuffer;
    expect(await putThemeAsset(storage, shop, VERSION, "theme.css", css)).toEqual({ ok: true });
    await sealThemeAssets(storage, shop, VERSION);
    expect(await putThemeAsset(storage, shop, VERSION, "theme.css", css)).toEqual({ ok: false, reason: "sealed" });
    await unsealThemeAssets(storage, shop, VERSION);
    // 書いている途中に締められた（置き終える処理が割り込んだ）
    const put = storage.put.bind(storage);
    storage.put = async (key, body, type) => {
      const r = await put(key, body, type);
      if (key.endsWith("/assets/theme.css")) await sealThemeAssets(storage, shop, VERSION);
      return r;
    };
    expect(await putThemeAsset(storage, shop, VERSION, "theme.css", new TextEncoder().encode("body{color:red}").buffer as ArrayBuffer)).toEqual({ ok: false, reason: "sealed" });
    expect(await storage.get(`themes/${shop}/${VERSION}/assets/theme.css`)).toBeNull();
  });
});

describe("CLI", () => {
  const run = async (env: Record<string, string>, argv: string[], fetchImpl: typeof fetch) => {
    const errs: string[] = [];
    const out: string[] = [];
    const code = await main(argv, { env, fetch: fetchImpl, log: (s: string) => out.push(s), error: (s: string) => errs.push(s), once: true });
    return { code, errs, out };
  };
  const TOKEN = "banto_test";

  it("http の BANTO_URL は localhost だけ", async () => {
    const never = (() => Promise.reject(new Error("must not be called"))) as unknown as typeof fetch;
    const r = await run({ BANTO_URL: "http://banto.example.com", BANTO_TOKEN: TOKEN }, ["list"], never);
    expect(r.code).not.toBe(0);
    expect(r.errs.join("\n")).toMatch(/https:\/\/ にしてください/);
  });

  it("POST は 5xx・繋がらないときにやり直さない（版が二重にできないように）。GET はやり直す", async () => {
    let posts = 0;
    let gets = 0;
    const f = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      else gets++;
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    await run({ BANTO_URL: "https://banto.example.com", BANTO_TOKEN: TOKEN }, ["publish", VERSION], f);
    expect(posts).toBe(1);
    await run({ BANTO_URL: "https://banto.example.com", BANTO_TOKEN: TOKEN }, ["list"], f);
    expect(gets).toBe(3);
  });

  it("prune は取り込みの途中の新しい版を消さない", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const items = [
      { id: "a", name: "途中", complete: false, published: false, created_at: now },
      { id: "b", name: "置き終えた", complete: true, published: false, created_at: now },
      { id: "c", name: "放置された途中", complete: false, published: false, created_at: old },
    ];
    const deleted: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").pop()!);
        return new Response('{"ok":true}');
      }
      return new Response(JSON.stringify({ items }));
    }) as unknown as typeof fetch;
    await run({ BANTO_URL: "https://banto.example.com", BANTO_TOKEN: TOKEN }, ["prune", "--keep", "0"], f);
    expect(deleted).toEqual(["b", "c"]);
  });
});
