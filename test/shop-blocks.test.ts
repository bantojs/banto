import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";

/** 本文のお店のブロック（src/pages/shop-blocks.ts、docs/pages.md「お店のブロック」）とグリッド・タブ */

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings: { modules: { pages: true, blog: true }, shipping: { mode: "flat", flat_fee_jpy: 0, free_over_jpy: 0, by_prefecture: {} } } });
  const tops = { id: crypto.randomUUID(), shop_id: shop.id, slug: "tops", name: "トップス", parent_id: null, sort_order: 0 };
  sb.tables.categories.push(tops, { id: crypto.randomUUID(), shop_id: shop.id, slug: "shirts", name: "シャツ", parent_id: tops.id, sort_order: 0 }, { id: crypto.randomUUID(), shop_id: shop.id, slug: "bags", name: "バッグ", parent_id: null, sort_order: 1 });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, tags: ["new"] });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  sb.addArticle(shop.id, blog.id, { handle: "hello", title: "開店しました", body: "本文", excerpt: "ごあいさつ" });
  sb.addPage(shop.id, { handle: "about", title: "店について", body: "x" });
  const body = [
    '::: search placeholder="Tシャツを探す"',
    "",
    "::: categories parent=tops",
    "",
    "::: card article=news/hello",
    "",
    "::: card page=about",
    "",
    "::: product slug=tee show=image,name,price,cart,buy",
    "",
    "::: product slug=nope",
    "",
    ":::: grid cols=3",
    "a",
    "::::",
  ].join("\n");
  sb.addPage(shop.id, { handle: "lp", title: "LP", body });
  return { sb, shop, teeM, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`), new FakeStripe()) };
}

describe("お店のブロック", () => {
  it("検索・カテゴリー（子だけ）・カード・商品（カートに入れる・今すぐ買う）を描く。無い商品は空", async () => {
    const { app, teeM } = setup();
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/lp")).text();
    expect(html).toContain('action="/my-shop/search"');
    expect(html).toContain('placeholder="Tシャツを探す"');
    expect(html).toContain('href="/my-shop?category=shirts">シャツ</a>');
    expect(html).not.toContain(">バッグ</a>");
    expect(html).toContain('href="/my-shop/blogs/news/hello"');
    expect(html).toContain("ごあいさつ");
    expect(html).toContain('href="/my-shop/pages/about"');
    expect(html).toContain('<a class="banto-product__name" href="/my-shop/p/tee">Tシャツ</a>');
    expect(html).toContain(`<input type="hidden" name="sku_id" value="${teeM.id}">`);
    expect(html).toContain('name="buy" value="1"');
    expect(html).toContain("banto-grid banto-grid--3");
    expect(html).not.toContain("<!--banto:shop:");
  });

  it("今すぐ買う: カートに入れて、そのまま配送先の画面へ", async () => {
    const { app, teeM } = setup();
    const b = new Browser(app, BASE);
    const res = await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1", buy: "1" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="postal_code"');
    expect(await (await b.get("/my-shop/cart")).text()).toContain("Tシャツ");
  });

  it("ヘッドレスの html にも中身が入る（リンクはショップの絶対 URL）", async () => {
    const { app } = setup();
    const j = (await (await app.request(`${BASE}/api/shops/my-shop/pages/lp`)).json()) as { page: { html: string } };
    expect(j.page.html).toContain(`action="${BASE}/my-shop/search"`);
    expect(j.page.html).toContain(`href="${BASE}/my-shop/p/tee"`);
  });
});
