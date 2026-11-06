import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, followPreview } from "./helpers";
import { INCLUDES_MAX, expandIncludes, includeHandles } from "../src/content/include";
import { markdownToHtml } from "../src/pages/markdown";

/** 部品のページと `::: include page=<handle>`（0122、メンテナの決定 2026-11-06、docs/pages.md「部品のページ」） */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
  sb.addPage(shop.id, { handle: "notice", title: "お知らせの部品", body: "**年末年始はお休み**です。\n\n::: include page=about", is_part: true });
  sb.addPage(shop.id, { handle: "secret", title: "下書きの部品", body: "まだ出さない", is_part: true, published: false });
  sb.addPage(shop.id, { handle: "about", title: "私たちについて", body: "## 店のこと\n\n::: include page=notice\n\n::: include page=secret\n\n::: include page=nothing\n\n手しごとの店です。", nav: "header" });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  return { sb, shop, app, b: new Browser(app, BASE), base: `/admin/shops/${shop.id}/modules/pages` };
}

describe("差し込みの組み立て（src/content/include.ts）", () => {
  it("行を部品の本文に置き換える。部品の中の差し込みは外す（1 段）。無い部品は外す。上限を超えた分は外す", () => {
    const parts = [
      { id: "a", handle: "a", body: "A の本文\n::: include page=b", updated_at: "1" },
      { id: "b", handle: "b", body: "B の本文", updated_at: "2" },
    ];
    const out = expandIncludes("前\n::: include page=a\n::: include page=zz\n後", parts);
    expect(out.body).toBe("前\n\nA の本文\n\n後");
    expect(out.key).toBe("inc:a@1");
    const many = Array.from({ length: INCLUDES_MAX + 2 }, (_, i) => `::: include page=p${i}`).join("\n");
    expect(includeHandles(many)).toHaveLength(INCLUDES_MAX);
    const all = Array.from({ length: INCLUDES_MAX + 2 }, (_, i) => ({ id: `p${i}`, handle: `p${i}`, body: `本文${i}`, updated_at: "1" }));
    const big = expandIncludes(many, all).body;
    expect(big).toContain(`本文${INCLUDES_MAX - 1}`);
    expect(big).not.toContain(`本文${INCLUDES_MAX}`);
  });

  it("差し込まない使い方（ここまで来た行）は何も描かない。形の違う行は文字のまま", () => {
    expect(markdownToHtml("前\n\n::: include page=a\n\n後", { mediaBase: "" })).toBe("<p>前</p>\n<p>後</p>");
    expect(markdownToHtml("::: include", { mediaBase: "" })).toContain("::: include");
  });
});

describe("お店の画面とヘッドレス", () => {
  it("公開中の部品だけ差し込む。部品のページは単独では 404・メニューとサイトマップに出さない", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/pages/about")).text();
    expect(html).toContain("<strong>年末年始はお休み</strong>です。");
    expect(html).not.toContain("まだ出さない");
    expect(html).not.toContain("::: include");
    expect(html).toContain("手しごとの店です。");
    expect((await b.get("/my-shop/pages/notice")).status).toBe(404);
    const map = await (await b.get("/sitemap-pages.xml")).text();
    expect(map).toContain("/my-shop/pages/about");
    expect(map).not.toContain("/pages/notice");
  });

  it("部品を直すと差し込んだ本文も変わる（本文の HTML の覚えの鍵に部品の更新日時）", async () => {
    const { sb, app, b } = setup();
    expect(await (await b.get("/my-shop/pages/about")).text()).toContain("年末年始はお休み");
    const part = sb.tables.pages.find((p) => p["handle"] === "notice")!;
    part["body"] = "夏季休業のお知らせ";
    part["updated_at"] = "2099-01-01T00:00:00.000Z";
    // 部品の読み取りは短時間キャッシュするので、新しい isolate として読む
    const fresh = new Browser(appWith(sb, {}, new MemoryStorage(`${BASE}/media`)), BASE);
    expect(await (await fresh.get("/my-shop/pages/about")).text()).toContain("夏季休業のお知らせ");
    void app;
  });

  it("ヘッドレスの API: 一覧と 1 つに部品のページは出さない。本文には差し込んだもの", async () => {
    const { app } = setup();
    const list = (await (await app.request(`${BASE}/api/shops/my-shop/pages`)).json()) as { pages: { handle: string }[] };
    expect(list.pages.map((p) => p.handle)).toEqual(["about"]);
    expect((await app.request(`${BASE}/api/shops/my-shop/pages/notice`)).status).toBe(404);
    const one = (await (await app.request(`${BASE}/api/shops/my-shop/pages/about`)).json()) as { page: { body: string; html: string } };
    expect(one.page.body).toContain("**年末年始はお休み**です。");
    expect(one.page.html).toContain("<strong>年末年始はお休み</strong>");
  });
});

describe("管理画面", () => {
  it("「部品として使う」で保存するとメニューに出さず、一覧に「部品」。プレビューにも差し込む", async () => {
    const { sb, app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const edit = await (await owner.get(`${base}/new`)).text();
    expect(edit).toContain('name="is_part_present" value="1"');
    const res = await owner.post(base, { title: "送料の部品", handle: "ship-note", body: "送料は全国一律です。", nav: "header", sort_order: "0", published: "on", is_part_present: "1", is_part: "on", action: "save" });
    expect(res.status).toBe(302);
    const row = sb.tables.pages.find((p) => p["handle"] === "ship-note")!;
    expect(row).toMatchObject({ is_part: true, nav: "none" });
    expect(await (await owner.get(base)).text()).toContain('<span class="badge">部品</span>');
    const handoff = await owner.post(base, { title: "見本", handle: "sample", body: "::: include page=ship-note", nav: "none", sort_order: "0", action: "preview" });
    expect(await (await followPreview(app, handoff)).text()).toContain("送料は全国一律です。");
  });
});
