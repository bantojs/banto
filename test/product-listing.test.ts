import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";

/**
 * 商品の一覧のページ送り（0058、docs/headless.md）。お店の画面は 48 件ずつ「次のページ」、公開 API は cursor / offset。
 * 0058 より前の DB では全件を読んでメモリで（同じ応答の形）。
 */
function setup(opts: { count?: number; legacy?: boolean } = {}) {
  const sb = new FakeSupabase();
  if (opts.legacy) sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0058_product_listing");
  const owner = sb.addUser("o@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const top = sb.addCategory(shop.id, { slug: "wear", name: "ウェア" });
  const sub = sb.addCategory(shop.id, { slug: "tops", name: "トップス", parent_id: top.id });
  for (let i = 0; i < (opts.count ?? 60); i++) {
    const p = sb.addProduct(shop.id, { slug: `p-${i}`, name: `商品${String(i).padStart(3, "0")}`, published: true, tags: i % 2 ? ["奇数"] : ["偶数"], category_id: i % 3 === 0 ? sub.id : null });
    sb.addSku(shop.id, p.id, { code: `S${i}`, price_jpy: 1000 + (i % 7) * 100, available: 1 });
  }
  return { sb, app: appWith(sb, {}) };
}

type ApiPage = { products: { slug: string }[]; total: number; total_capped: boolean; next_cursor: string | null; next_offset: number | null; tags: { tag: string; count: number }[] };
const get = async (app: ReturnType<typeof appWith>, path: string) => {
  const res = await app.request(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as ApiPage & { error?: string; field?: string } };
};

for (const legacy of [false, true]) {
  describe(`商品の一覧のページ送り（${legacy ? "0058 より前の DB" : "0058"}）`, () => {
    it("お店の画面: 48 件ずつ。次のページは cursor の URL、2 ページ目は検索エンジンに載せない", async () => {
      const { app } = setup({ legacy });
      const b = new Browser(app);
      const first = await (await b.get("/my-shop")).text();
      expect(first.match(/class="card"/g)).toHaveLength(48);
      const next = /<a href="([^"]+)" rel="next">/.exec(first)?.[1]?.replace(/&amp;/g, "&");
      expect(next).toMatch(/^\/my-shop\?after=/);
      expect(first).not.toContain('name="robots"');
      const second = await (await b.get(next!)).text();
      expect(second.match(/class="card"/g)).toHaveLength(12);
      expect(second).not.toContain('rel="next"');
      expect(second).toContain('<meta name="robots" content="noindex"');
      expect(second).toContain("最初のページ");
      // 壊れた cursor は 404
      expect((await b.get("/my-shop?after=xyz")).status).toBe(404);
    });

    it("お店の画面: タグ・カテゴリーの絞り込みでもページ送りの URL に条件が残る。件数はショップ全体", async () => {
      const { app } = setup({ legacy, count: 120 });
      const b = new Browser(app);
      const html = await (await b.get("/my-shop?tag=" + encodeURIComponent("奇数"))).text();
      expect(html.match(/class="card"/g)).toHaveLength(48);
      expect(html).toContain("偶数 <span class=\"muted\">(60)</span>");
      const next = /<a href="([^"]+)" rel="next">/.exec(html)?.[1]?.replace(/&amp;/g, "&");
      expect(next).toContain("tag=%E5%A5%87%E6%95%B0");
      const cat = await (await b.get("/my-shop?category=wear")).text();
      expect(cat.match(/class="card"/g)).toHaveLength(40);
    });

    it("公開 API: cursor で全件を重複なく辿れる。offset と total も使える", async () => {
      const { app } = setup({ legacy });
      for (const sort of ["new", "price_asc", "price_desc", "name", "updated"]) {
        const seen: string[] = [];
        let path = `/api/shops/my-shop/products?limit=25&sort=${sort}`;
        for (let guard = 0; guard < 10; guard++) {
          const { status, body } = await get(app, path);
          expect(status).toBe(200);
          expect(body.total).toBe(60);
          seen.push(...body.products.map((p) => p.slug));
          if (!body.next_cursor) break;
          path = `/api/shops/my-shop/products?limit=25&sort=${sort}&cursor=${body.next_cursor}`;
        }
        expect(seen, sort).toHaveLength(60);
        expect(new Set(seen).size, sort).toBe(60);
      }
      const byOffset = await get(app, "/api/shops/my-shop/products?limit=25&offset=50");
      expect(byOffset.body.products).toHaveLength(10);
      expect(byOffset.body.next_offset).toBeNull();
      expect((await get(app, "/api/shops/my-shop/products?limit=25")).body.next_offset).toBe(25);
      expect((await get(app, "/api/shops/my-shop/products?category=wear")).body.total).toBe(20);
      expect((await get(app, "/api/shops/my-shop/products")).body.tags).toEqual([{ tag: "偶数", count: 30 }, { tag: "奇数", count: 30 }]);
    });

    it("公開 API: 壊れた cursor・並べ替えを変えて使い回した cursor・10,000 を超える offset は 400", async () => {
      const { app } = setup({ legacy });
      const first = await get(app, "/api/shops/my-shop/products?limit=10&sort=new");
      expect((await get(app, `/api/shops/my-shop/products?sort=name&cursor=${first.body.next_cursor}`)).body).toMatchObject({ error: "invalid_request", field: "cursor" });
      expect((await get(app, "/api/shops/my-shop/products?cursor=%%%")).status).toBe(400);
      expect((await get(app, "/api/shops/my-shop/products?offset=10001")).body).toMatchObject({ error: "invalid_request", field: "offset" });
    });

    it("公開 API: カテゴリーの木の件数（子孫を含む）", async () => {
      const { app } = setup({ legacy });
      const res = (await (await app.request(`${BASE}/api/shops/my-shop/categories`)).json()) as { categories: { slug: string; count: number; children: { slug: string; count: number }[] }[] };
      expect(res.categories).toEqual([{ slug: "wear", name: "ウェア", count: 20, children: [{ slug: "tops", name: "トップス", count: 20, children: [] }] }]);
    });
  });
}
