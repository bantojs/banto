import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { parseShopBlock, shopBlockLine } from "../src/pages/shop-blocks";

/** 実店舗に記事を添える（`::: stores articles=<ブログ>[:<キー>] limit=N`、メンテナの決定 2026-11-07）。記事の「実店舗」の項目（0117）で店舗を指す */
function setup(fields: Record<string, unknown>[] = [{ key: "store", label: "店舗", type: "store" }]) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true, pages: true } } });
  const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
  const stores = ["渋谷店", "新宿店", "池袋店"].map((name, i) => {
    const id = crypto.randomUUID();
    sb.tables.stores.push({ id, org_id: org, name, hours: {}, special_days: [], note: null, active: true, sort_order: i });
    sb.tables.shop_stores.push({ shop_id: shop.id, store_id: id, tryon: false, sort_order: i });
    return id;
  });
  const events = sb.addBlog(shop.id, { id: crypto.randomUUID(), handle: "events", title: "イベント", article_fields: fields });
  const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
  sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle: "a1", title: "渋谷の冬フェア", published_at: day(1), fields: { store: stores[0] } });
  sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle: "a2", title: "渋谷の採寸会", published_at: day(2), fields: { store: stores[0] } });
  sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle: "a3", title: "渋谷の古着市", published_at: day(3), fields: { store: stores[0] } });
  sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle: "b1", title: "新宿の試着会", published_at: day(4), fields: { store: stores[1] } });
  sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle: "x1", title: "店舗なし", published_at: day(5), fields: {} });
  return { sb, shop, stores, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

let n = 0;
const page = async (sb: FakeSupabase, shopId: string, app: ReturnType<typeof appWith>, body: string) => {
  const handle = `stores-${++n}`;
  sb.addPage(shopId, { id: crypto.randomUUID(), handle, title: "店舗", body });
  return (await new Browser(app, BASE).get(`/my-shop/pages/${handle}`)).text();
};
/** 店舗の段ごとの記事の題 */
const byStore = (html: string) =>
  Object.fromEntries([...html.matchAll(/<li class="banto-store"><p class="banto-store__name">([^<]+)<\/p>(.*?)<\/li><\/ul><\/div><\/li>|<li class="banto-store"><p class="banto-store__name">([^<]+)<\/p>/g)].map((m) => [m[1] ?? m[3], [...(m[2] ?? "").matchAll(/font-weight:600">([^<]+)</g)].map((x) => x[1])]));

describe("::: stores articles=", () => {
  it("記事の実店舗の項目で店舗ごとに添える。新しい順で limit 本まで。記事の無い店舗は店舗だけ", async () => {
    const { sb, shop, app } = setup();
    const html = await page(sb, shop.id, app, "::: stores articles=events limit=2");
    expect(byStore(html)).toEqual({ 渋谷店: ["渋谷の古着市", "渋谷の採寸会"], 新宿店: ["新宿の試着会"], 池袋店: [] });
    expect(html).toContain('<div class="banto-store__articles"><ul class="banto-articles__list"');
    expect(html).toContain('href="/my-shop/blogs/events/b1"');
    expect(html).not.toContain("店舗なし");
  });

  it("実店舗の項目が 2 つあるブログはキーが要る。無い・違うブログ・モジュールが OFF なら店舗だけ", async () => {
    const two = setup([{ key: "store", label: "店舗", type: "store" }, { key: "venue", label: "会場", type: "store" }]);
    expect(await page(two.sb, two.shop.id, two.app, "::: stores articles=events")).not.toContain("banto-store__articles");
    expect(await page(two.sb, two.shop.id, two.app, "::: stores articles=events:store")).toContain("渋谷の古着市");
    const none = setup();
    expect(await page(none.sb, none.shop.id, none.app, "::: stores articles=nothing")).not.toContain("banto-store__articles");
    // ショップ行はキャッシュされるので、ブログの OFF は新しいアプリで読む
    (none.sb.tables.shops[0]!["settings"] as Record<string, unknown>)["modules"] = { pages: true };
    const off = await page(none.sb, none.shop.id, appWith(none.sb, {}, new MemoryStorage(`${BASE}/media`)), "::: stores articles=events");
    expect(off).toContain("渋谷店");
    expect(off).not.toContain("banto-store__articles");
  });

  it("書き方: 形の違う値は捨て、既定の limit（3）は書き戻さない", () => {
    expect(parseShopBlock("::: stores articles=events:store limit=2")?.attrs).toMatchObject({ articles: "events:store", limit: "2" });
    expect(parseShopBlock("::: stores articles=Events! limit=9")?.attrs).toMatchObject({ limit: "3" });
    expect(parseShopBlock("::: stores articles=Events!")?.attrs["articles"]).toBeUndefined();
    expect(shopBlockLine(parseShopBlock("::: stores articles=events")!)).toBe("::: stores articles=events");
  });
});
