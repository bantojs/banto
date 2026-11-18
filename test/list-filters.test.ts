import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { LIST_FILTERS_MIGRATION, listFilterOf, listTagsOf, priceParamOf } from "../src/storefront/list-filter";
import { categoryUrl, productsUrl } from "../src/storefront/urls";
import { priceRangeFilter } from "../src/themes/liquid/objects";

/** 一覧の絞り込みの段 1（複数のタグ・価格の上下限、0150）。DB の判定は test/db/product-list-filters.test.ts */

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const add = (slug: string, tags: string[], price: number) => {
    const p = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug, name: slug.toUpperCase(), published: true, tags });
    sb.addSku(shop.id, p.id, { code: `${slug}-1`, price_jpy: price, available: 5 });
  };
  add("red-s", ["red", "sale"], 1000);
  add("red", ["red"], 3000);
  add("blue-s", ["blue", "sale"], 8000);
  return { sb, shop, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}
const api = async (app: ReturnType<typeof setup>["app"], qs: string) => {
  const r = await app.request(`${BASE}/api/shops/my-shop/products${qs}`);
  return { status: r.status, body: (await r.json()) as { products?: { slug: string }[]; price_max?: number | null; error?: string; field?: string } };
};
const slugs = (b: { products?: { slug: string }[] }) => (b.products ?? []).map((p) => p.slug).sort();

describe("読み取りと URL（src/storefront/list-filter.ts・urls.ts）", () => {
  it("タグは空白を除き、重なりを除いて 5 つまで。価格はカンマと小数を受けて切り捨て、読めない値は絞らない", () => {
    expect(listTagsOf([" a ", "a", "", "b", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(priceParamOf("1,000")).toBe(1000);
    expect(priceParamOf("999.9")).toBe(999);
    expect(priceParamOf("-1")).toBeUndefined();
    expect(priceParamOf("abc")).toBeUndefined();
    expect(listFilterOf({ tag: ["x", "y"], "filter.v.price.gte": ["100"] })).toEqual({ tags: ["x", "y"], priceMin: 100 });
    // 選択肢（0153）: 読めない鍵は捨て、値の重なりを除く
    expect(listFilterOf({ "filter.v.option.color": ["red", " red ", "blue"], "filter.v.option.Bad!": ["x"] })).toEqual({ tags: [], options: { color: ["red", "blue"] } });
  });
  it("URL はタグをくり返し、価格は Shopify の名前。tags があれば tag より先", () => {
    expect(productsUrl("/s", { tags: ["a", "b"], priceMin: 100, priceMax: 2000, sort: "price_asc" })).toBe("/s/products?tag=a&tag=b&filter.v.price.gte=100&filter.v.price.lte=2000&sort=price_asc");
    expect(categoryUrl("/s", "tops", { tag: "a", tags: [] })).toBe("/s/categories/tops?tag=a");
    expect(productsUrl("/s", { tags: ["a"], tag: "b" })).toBe("/s/products?tag=a");
  });
});

describe("お店の画面", () => {
  it("タグをくり返すとすべてを持つ商品、価格の上下限。ページ送り・並べ替えのリンクも絞り込みを保つ。組み合わせは検索エンジンに載せない", async () => {
    const s = setup();
    const b = new Browser(s.app, BASE);
    const html = await (await b.get("/my-shop/products?tag=red&tag=sale")).text();
    expect(html).toContain("RED-S");
    expect(html).not.toContain(">RED<");
    expect(html).not.toContain("BLUE-S");
    expect(html).toContain("noindex");
    const priced = await (await b.get("/my-shop/products?filter.v.price.gte=2000&filter.v.price.lte=9000")).text();
    expect(priced).toContain("BLUE-S");
    expect(priced).toContain(">RED<");
    expect(priced).not.toContain("RED-S");
    // 価格の欄（上限はいちばん高い一覧の価格）
    expect(priced).toContain('name="filter.v.price.gte"');
    expect(priced).toContain('placeholder="8000"');
    expect(priced).toContain('href="/my-shop/products?filter.v.price.gte=2000&amp;filter.v.price.lte=9000&amp;sort=price_asc"');
  });

  it("タグの札: 選んでいる札は外すリンク、ほかの札はそのタグだけ（価格はそのまま）", async () => {
    const s = setup();
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products?tag=red&tag=sale&filter.v.price.lte=5000")).text();
    // red を外すと sale だけ（価格は保つ）
    expect(html).toMatch(/href="\/my-shop\/products\?tag=sale&amp;filter\.v\.price\.lte=5000"[^>]*class="active"/);
    // blue はそのタグだけ
    expect(html).toContain('href="/my-shop/products?tag=blue&amp;filter.v.price.lte=5000"');
  });

  it("検索の結果の価格の欄は検索の語を保つ", async () => {
    const s = setup();
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products?q=red")).text();
    expect(html).toContain('<input type="hidden" name="q" value="red"/>');
  });

  it("0150 を当てる前は最初のタグだけで絞り、価格の欄を出さない（お店の画面は止めない）", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== LIST_FILTERS_MIGRATION);
    const res = await new Browser(s.app, BASE).get("/my-shop/products?tag=red&tag=sale&filter.v.price.gte=2000");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("RED-S");
    expect(html).toContain(">RED<");
    expect(html).not.toContain('name="filter.v.price.gte"');
  });
});

describe("公開 API", () => {
  it("tag のくり返し・価格の上下限・price_max。形の違いは 400、6 つ目のタグも 400", async () => {
    const s = setup();
    expect(slugs((await api(s.app, "?tag=red&tag=sale")).body)).toEqual(["red-s"]);
    const r = await api(s.app, "?filter.v.price.lte=3000");
    expect(slugs(r.body)).toEqual(["red", "red-s"]);
    expect(r.body.price_max).toBe(8000);
    expect(await api(s.app, "?filter.v.price.gte=abc")).toMatchObject({ status: 400, body: { field: "filter.v.price.gte" } });
    expect(await api(s.app, "?tag=a&tag=b&tag=c&tag=d&tag=e&tag=f")).toMatchObject({ status: 400, body: { field: "tag" } });
  });

  it("0150 を当てる前はタグ 2 つ以上・価格を 409 migration_required（黙って絞らずに返さない）。タグ 1 つは今までどおり", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== LIST_FILTERS_MIGRATION);
    expect(await api(s.app, "?tag=red&tag=sale")).toMatchObject({ status: 409, body: { error: "migration_required" } });
    expect(await api(s.app, "?filter.v.price.gte=1")).toMatchObject({ status: 409 });
    const one = await api(s.app, "?tag=sale");
    expect(slugs(one.body)).toEqual(["blue-s", "red-s"]);
    expect(one.body.price_max).toBeUndefined();
  });

  it("0150 の前: 絞り込みを求めた一覧と最初のタグだけの一覧でキャッシュを分ける（どちらの順でも）", async () => {
    const a = setup();
    a.sb.appliedMigrations = a.sb.appliedMigrations.filter((m) => m !== LIST_FILTERS_MIGRATION);
    expect((await api(a.app, "?tag=red&tag=sale")).status).toBe(409);
    expect((await api(a.app, "?tag=red")).status).toBe(200);
    const b = setup();
    b.sb.appliedMigrations = b.sb.appliedMigrations.filter((m) => m !== LIST_FILTERS_MIGRATION);
    expect((await api(b.app, "?tag=red")).status).toBe(200);
    expect((await api(b.app, "?tag=red&filter.v.price.lte=1500")).status).toBe(409);
  });
});

describe("テーマ（Liquid）", () => {
  it("collection.filters の price_range は Shopify と同じ名前（値はほかの金額と同じく 100 倍、URL は円）", () => {
    const f = priceRangeFilter({ min: 1000, max: undefined, rangeMax: 8000, urlToRemove: "/s/products?tag=a" });
    expect(f).toMatchObject({ type: "price_range", param_name: "filter.v.price", range_max: 800000, active: true, url_to_remove: "/s/products?tag=a" });
    expect(f.min_value).toMatchObject({ param_name: "filter.v.price.gte", value: 100000, active: true });
    expect(f.max_value).toMatchObject({ param_name: "filter.v.price.lte", value: null, active: false });
  });
});
