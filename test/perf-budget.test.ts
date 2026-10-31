import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberLogin, memberMail } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";

/**
 * 速度の予算（docs/ARCHITECTURE.md「速度の予算」、CLAUDE.md §7）。
 * 主要ページが Supabase に何回問い合わせるかを固定する。同梱モジュールや拡張点を足しても、OFF・未使用なら回数は増えない。
 * 増やす必要があるときは、理由を docs/knowledge/02-decisions.md に書いてからこの数字を変える。
 */
const BUDGET = {
  // 初回（キャッシュなし）: ショップ行 1 + カテゴリー 1 + 一覧の 1 ページ 1 とタグ・カテゴリーの件数 1（並列。0058 で全件 3 回 → 2 回、2026-10-26 02-decisions.md）。
  // v0.2.0 までは適用済みの版 1（banto_setup_state）も要ったが、v0.3.0 で土台が 0061 に進み、一覧のページは土台より後の版を判定しなくなった
  cold: { "/my-shop": 4, "/api/shops/my-shop/products": 4 },
  // 2 回目以降（isolate のキャッシュが効いている）
  warm: {
    "/my-shop": 0,
    "/my-shop?tag=x": 0,
    "/api/shops/my-shop/products": 0,
    "/api/shops/my-shop/products?tag=x&sort=price_asc&limit=10": 0,
    // 商品行 → 画像・SKU（並列）→ 在庫（その商品の SKU だけ）。在庫は常に最新を読む
    "/my-shop/p/tee": 4,
    "/api/shops/my-shop/products/tee": 4,
    // 空のカート: 決済手段だけ
    "/my-shop/cart": 1,
  },
  // カートに商品があるとき: SKU・在庫・商品・決済手段（並列）
  cartWithItems: 4,
  // クーポンのコードが入ったカート: 上の 4 + coupon_lookup 1（カテゴリーはキャッシュ済み）。クーポンが何件あっても同じ
  // （0010_coupons、2026-10-16 02-decisions.md。モジュールが OFF・コードが無ければ増えない）
  cartWithCoupon: 5,
  // 会員（0012、店ごとのアカウント）: ログイン中のページは Cookie の署名だけを確かめ、会員ページだけ member_get 1 回
  memberAccount: 1,
  // ショップのページ（同梱モジュール pages、0079）: 初回はショップ行 1 + ページ 1 + カテゴリー 1（並列）。2 回目以降は 0。
  // メニューの一覧はショップ行（pages_nav）に乗るので、ほかのページは増えない
  pages: { cold: 3, warm: 0 },
  // 本文に「商品を並べる」が 3 つ（4 つ目は描かない）: ブロックごとに一覧の問い合わせ 1 回（並列、一覧と同じキャッシュ）
  pagesWithProducts: { cold: 6, warm: 0 },
  // ブログ（同梱モジュール blog、0081）: ショップ行 1 + ブログ 1 + カテゴリー 1（並列）+ 記事の一覧（か記事）1。2 回目からは 0
  blog: { cold: 4, warm: 0 },
  article: { cold: 4, warm: 0 },
} as const;

function setup(opts: { coupons?: boolean; campaigns?: number } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("o@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_x", settings: opts.coupons ? { modules: { coupons: true } } : {} });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true, tags: ["x"] });
  const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
  for (let i = 0; i < (opts.campaigns ?? 0); i++)
    sb.tables.coupon_campaigns.push({ id: `c${i}`, shop_id: shop.id, name: `c${i}`, code: `CODE${i}`, kind: "fixed", value: 100, usage_limit: null, per_customer_limit: null, combinable: false, audience: "public", conditions: {}, active: true });
  return { sb, sku, b: new Browser(appWith(sb, {}, undefined, new FakeStripe())) };
}

async function calls(sb: FakeSupabase, run: () => Promise<unknown>): Promise<string[]> {
  sb.calls.length = 0;
  await run();
  return [...sb.calls];
}

describe("速度の予算: Supabase への問い合わせ回数", () => {
  it("初回（キャッシュなし）", async () => {
    for (const [path, n] of Object.entries(BUDGET.cold)) {
      const { sb, b } = setup();
      expect(await calls(sb, () => b.get(path)), path).toHaveLength(n);
    }
  });

  it("2 回目以降（キャッシュが効いている）", async () => {
    const { sb, b } = setup();
    for (const path of Object.keys(BUDGET.warm)) await b.get(path);
    for (const [path, n] of Object.entries(BUDGET.warm)) expect(await calls(sb, () => b.get(path)), path).toHaveLength(n);
  });

  it("カートに商品があるとき", async () => {
    const { sb, sku, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.get("/my-shop/cart");
    expect(await calls(sb, () => b.get("/my-shop/cart"))).toHaveLength(BUDGET.cartWithItems);
  });

  it("クーポンのモジュールが ON でも、商品のページとコードの無いカートは回数が変わらない", async () => {
    const { sb, sku, b } = setup({ coupons: true, campaigns: 3 });
    for (const path of Object.keys(BUDGET.warm)) await b.get(path);
    for (const [path, n] of Object.entries(BUDGET.warm)) expect(await calls(sb, () => b.get(path)), path).toHaveLength(n);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await calls(sb, () => b.get("/my-shop/cart"))).toHaveLength(BUDGET.cartWithItems);
  });

  it("クーポンのコードが入ったカート・確認画面は、クーポンが 1 件でも 2,000 件でも回数が同じ（全件を読まない）", async () => {
    const counts: number[] = [];
    for (const n of [1, 2000]) {
      const { sb, sku, b } = setup({ coupons: true, campaigns: n });
      await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
      await b.post("/my-shop/cart/coupon", { code: "CODE0" });
      await b.get("/my-shop/cart");
      const cart = await calls(sb, () => b.get("/my-shop/cart"));
      expect(cart).toHaveLength(BUDGET.cartWithCoupon);
      const review = await calls(sb, () => b.post("/my-shop/checkout/stripe", { customer_name: "A", customer_email: "a@example.com", phone: "03", postal_code: "100", state: "東京都", city: "千代田区", line1: "1" }));
      counts.push(review.length);
    }
    expect(counts[0]).toBe(counts[1]);
  });

  it("ショップのページ（モジュール pages）: ページは往復 3 回で、2 回目からは 0。ON でもほかのページの回数は変わらない", async () => {
    const { sb, b } = setup();
    const shop = sb.tables.shops[0]!;
    shop["settings"] = { modules: { pages: true } };
    sb.addPage(String(shop["id"]), { handle: "about", title: "About", body: "# a", nav: "header" });
    expect(await calls(sb, () => b.get("/my-shop/pages/about"))).toHaveLength(BUDGET.pages.cold);
    expect(await calls(sb, () => b.get("/my-shop/pages/about"))).toHaveLength(BUDGET.pages.warm);
    for (const path of Object.keys(BUDGET.warm)) await b.get(path);
    for (const [path, n] of Object.entries(BUDGET.warm)) expect(await calls(sb, () => b.get(path)), path).toHaveLength(n);
  });

  it("ページの「商品を並べる」はブロックごとに 1 回（3 つまで）。2 回目からは 0", async () => {
    const { sb, b } = setup();
    const shop = sb.tables.shops[0]!;
    shop["settings"] = { modules: { pages: true } };
    sb.addPage(String(shop["id"]), { handle: "picks", title: "Picks", body: ["::: products tag=a", "::: products tag=b", "::: products tag=c", "::: products tag=d"].join("\n") });
    expect(await calls(sb, () => b.get("/my-shop/pages/picks"))).toHaveLength(BUDGET.pagesWithProducts.cold);
    expect(await calls(sb, () => b.get("/my-shop/pages/picks"))).toHaveLength(BUDGET.pagesWithProducts.warm);
  });

  it("ブログの一覧と記事は往復 4 回で、2 回目からは 0", async () => {
    const { sb, b } = setup();
    const shop = sb.tables.shops[0]!;
    shop["settings"] = { modules: { blog: true } };
    const blog = sb.addBlog(String(shop["id"]), { handle: "news" });
    for (let i = 0; i < 20; i++) sb.addArticle(String(shop["id"]), blog.id, { handle: `a-${i}`, body: "本文" });
    expect(await calls(sb, () => b.get("/my-shop/blogs/news"))).toHaveLength(BUDGET.blog.cold);
    expect(await calls(sb, () => b.get("/my-shop/blogs/news"))).toHaveLength(BUDGET.blog.warm);
    // ショップ行・ブログ・カテゴリーは一覧で覚えたので、記事は 1 回だけ
    expect(await calls(sb, () => b.get("/my-shop/blogs/news/a-3"))).toHaveLength(BUDGET.article.cold - 3);
    expect(await calls(sb, () => b.get("/my-shop/blogs/news/a-3"))).toHaveLength(BUDGET.article.warm);
  });

  it("商品のページの在庫は、その商品の SKU だけを引く（ショップ全体の在庫を読まない）", async () => {
    const { sb, b } = setup();
    const shopId = String(sb.tables.shops[0]!["id"]);
    for (let i = 0; i < 50; i++) {
      const other = sb.addProduct(shopId, { slug: `other-${i}`, name: `O${i}`, published: true });
      sb.addSku(shopId, other.id, { code: `O${i}`, price_jpy: 500, available: 1 });
    }
    await b.get("/my-shop/p/tee");
    const inventory = (await calls(sb, () => b.get("/my-shop/p/tee"))).filter((x) => x.includes("/rest/v1/inventory"));
    expect(inventory).toHaveLength(1);
    expect(decodeURIComponent(inventory[0]!)).toContain("sku_id=in.(");
  });

  it("会員: ログイン中でも商品のページの回数は変わらない。会員ページは 1 回", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true, tags: ["x"] });
    sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
    const mail = memberMail(sb, shop.id);
    try {
      const b = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, new FakeStripe()));
      await memberLogin(b, mail, "/my-shop", "m@example.com");
      for (const path of ["/my-shop", "/my-shop/p/tee", "/my-shop/account"]) await b.get(path);
      expect(await calls(sb, () => b.get("/my-shop"))).toHaveLength(BUDGET.warm["/my-shop"]);
      expect(await calls(sb, () => b.get("/my-shop/p/tee"))).toHaveLength(BUDGET.warm["/my-shop/p/tee"]);
      expect(await calls(sb, () => b.get("/my-shop/account"))).toHaveLength(BUDGET.memberAccount);
    } finally {
      mail.dispose();
    }
  });

  it("Liquid のテーマ（0071）: 初回はプランの確認が増えるだけ（テーマは置き場から読み、DB は引かない）。2 回目からは TSX と同じ", async () => {
    forgetThemes();
    const sb = new FakeSupabase();
    sb.sitePlan = "paid";
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true, tags: ["x"] });
    sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
    const v = "11111111-2222-4333-8444-555555555555";
    const row = sb.tables.shops[0]!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: v, storage_key: `themes/${shop.id}/${v}/bundle.json`, settings: {} };
    const storage = new MemoryStorage(`${BASE}/media`);
    const files = { "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>", "templates/index.liquid": "{% for p in collection.products %}{{ p.title }}{% endfor %}", "templates/product.liquid": "{{ product.title }}" };
    await storage.put(`themes/${shop.id}/${v}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
    const b = new Browser(appWith(sb, {}, storage), "https://shop.example.jp");
    const cold = await calls(sb, () => b.get("/"));
    expect(cold.filter((x) => x.includes("banto_site_liquid"))).toHaveLength(1);
    expect(cold.filter((x) => x.includes("banto_setup_state"))).toHaveLength(0);
    expect(cold).toHaveLength(BUDGET.cold["/my-shop"] + 1);
    for (const path of ["/", "/p/tee"]) await b.get(path);
    expect(await calls(sb, () => b.get("/"))).toHaveLength(BUDGET.warm["/my-shop"]);
    expect(await calls(sb, () => b.get("/p/tee"))).toHaveLength(BUDGET.warm["/my-shop/p/tee"]);
  });
});
