import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { fillDateBlocks, parseShopBlock, shopBlocksOf } from "../src/pages/shop-blocks";
import { markdownToHtml } from "../src/pages/markdown";
import { setTimeZone } from "../src/i18n/time";

/** 日時のブロック（`::: date`、docs/pages.md「お店のブロック」）: 投稿日時・最終更新日時・今の日時を、描くたびに店の時間帯で入れる */

afterEach(() => setTimeZone("Asia/Tokyo"));

describe("日時のブロック", () => {
  it("決まった値だけを受け、既定は投稿日時の日付だけ。データを引くブロックに数えない", () => {
    expect(parseShopBlock("::: date")).toEqual({ kind: "date", attrs: { of: "published", format: "date" } });
    expect(parseShopBlock('::: date of=now format=datetime label="今日"')!.attrs).toEqual({ of: "now", format: "datetime", label: "今日" });
    expect(parseShopBlock("::: date of=tomorrow format=year")!.attrs).toEqual({ of: "published", format: "date" });
    expect(shopBlocksOf("::: date\n\n::: date of=now")).toEqual([]);
  });

  it("本文の HTML には印だけ。fillDateBlocks が店の時間帯で入れる（ラベルはエスケープ）", () => {
    const raw = markdownToHtml('::: date label="<b>投稿</b>"\n\n::: date of=updated format=datetime\n\n::: date of=now', { mediaBase: "https://m.example.jp" });
    expect(raw).toContain('<time data-banto-date="published|date"></time>');
    expect(raw).toContain("&lt;b&gt;投稿&lt;/b&gt;");
    setTimeZone("Asia/Tokyo");
    const html = fillDateBlocks(raw, { published: "2026-03-31T16:30:00Z", updated: "2026-04-01T03:05:00Z", now: new Date("2026-11-03T00:00:00Z") });
    expect(html).toContain('<time class="banto-date" datetime="2026-03-31T16:30:00.000Z">2026/04/01</time>');
    expect(html).toContain('<time class="banto-date" datetime="2026-04-01T03:05:00.000Z">2026/04/01 12:05</time>');
    expect(html).toContain('datetime="2026-11-03T00:00:00.000Z">2026/11/03</time>');
    expect(html).not.toContain("data-banto-date");
    // 材料が無い日時は空
    expect(fillDateBlocks(raw, {})).not.toContain("2026/04/01");
  });

  it("お店の画面のページと記事に入る（最終更新日時は行の updated_at）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true, blog: true } } });
    sb.addPage(shop.id, { handle: "about", title: "店", body: '::: date of=updated label="更新日"', updated_at: "2026-05-05T01:00:00Z" });
    const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
    sb.addArticle(shop.id, blog.id, { handle: "hello", title: "こんにちは", body: "::: date format=datetime", published_at: "2026-06-01T00:00:00Z" });
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const page = await (await new Browser(app, BASE).get("/my-shop/pages/about")).text();
    expect(page).toContain('<span class="banto-date__label">更新日</span> <time class="banto-date" datetime="2026-05-05T01:00:00.000Z">2026/05/05</time>');
    const art = await (await new Browser(app, BASE).get("/my-shop/blogs/news/hello")).text();
    expect(art).toContain(">2026/06/01 09:00</time>");
    const api = (await (await app.request(`${BASE}/api/shops/my-shop/pages/about`)).json()) as { page: { html: string } };
    expect(api.page.html).toContain(">2026/05/05</time>");
  });
});
