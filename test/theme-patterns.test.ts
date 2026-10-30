import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { bantoPatterns, parseBlockStyles, parsePatterns, PATTERNS_FILE, STYLES_FILE } from "../src/content/theme-blocks";
import { markdownToHtml } from "../src/pages/markdown";
import { articleBlocksOf, parseArticlesLine, parseButtonLine } from "../src/pages/blocks";
import { pageEditorClient } from "../src/content/editor-client";

/** テーマのパターンとブロックのスタイル、記事を並べるブロック（メンテナの決定 2026-10-30、docs/themes.md・docs/pages.md） */
const VERSION = "11111111-2222-4333-8444-555555555555";
const patterns = {
  patterns: [
    { name: "lookbook", title: { ja: "ルックブック", en: "Lookbook" }, description: "画像を大きく", body: ":::: cover height=l\n## 秋の装い\n::::" },
    { name: "notice", title: "お知らせの帯", body: "::: group bg=accent style=ribbon\n今週は送料無料\n:::" },
  ],
};
const styles = { group: [{ name: "ribbon", label: "帯" }, { name: "card", label: { ja: "カード", en: "Card" } }], button: [{ name: "outline", label: "線だけ" }] };
const baseFiles = { "layout/theme.liquid": "<html><body>{{ content_for_layout }}</body></html>", "templates/index.liquid": "top" };

describe("テーマのパターンとスタイルの検査", () => {
  it("形の合うものだけ読み、言語ごとの文言を選ぶ", () => {
    const p = parsePatterns(JSON.stringify(patterns), "en");
    expect(p.errors).toEqual([]);
    expect(p.patterns.map((x) => [x.name, x.title, x.source])).toEqual([
      ["lookbook", "Lookbook", "theme"],
      ["notice", "お知らせの帯", "theme"],
    ]);
    const s = parseBlockStyles(JSON.stringify(styles), "ja");
    expect(s.errors).toEqual([]);
    expect(s.styles.group).toEqual([
      { name: "ribbon", label: "帯" },
      { name: "card", label: "カード" },
    ]);
  });

  it("誤りはファイルと場所を名指しし、テーマを取り込まない", () => {
    const bad = parsePatterns(JSON.stringify({ patterns: [{ name: "Bad Name", title: "x", body: "a" }, { name: "ok", title: "", body: "a" }, { name: "dup", title: "a", body: "b" }, { name: "dup", title: "a", body: "b" }] }));
    expect(bad.errors.join("\n")).toMatch(/patterns\[0\]\.name/);
    expect(bad.errors.join("\n")).toMatch(/patterns\[1\]\.title/);
    expect(bad.errors.join("\n")).toMatch(/duplicated "dup"/);
    expect(parseBlockStyles(JSON.stringify({ hero: [], group: [{ name: "x y", label: "a" }] })).errors.join("\n")).toMatch(/unknown block "hero"[\s\S]*group\[0\]\.name/);
    const r = checkThemeBundle({ format: 1, files: { ...baseFiles, [PATTERNS_FILE]: JSON.stringify({ patterns: [{ name: "a", title: "t", body: "" }] }) }, assets: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain(`${PATTERNS_FILE}: patterns[0].body`);
    expect(checkThemeBundle({ format: 1, files: { ...baseFiles, [PATTERNS_FILE]: JSON.stringify(patterns), [STYLES_FILE]: JSON.stringify(styles) }, assets: [] }).ok).toBe(true);
  });

  it("Banto の既定のパターンは今のブロックだけで書け、そのまま描ける", () => {
    for (const p of bantoPatterns()) {
      expect(p.name.startsWith("banto-")).toBe(true);
      const html = markdownToHtml(p.body, {});
      expect(html, p.name).not.toMatch(/<p>:::/);
      expect(html).toContain("data-banto-block");
    }
  });
});

describe("スタイルと記事を並べるブロックの書式", () => {
  const { toMarkdown } = pageEditorClient();
  const VOID = new Set(["BR", "IMG", "HR"]);
  // pages-editor.test.ts と同じ最小の DOM（属性・子・文字だけ）
  function parse(html: string) {
    type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string | null; getAttribute(k: string): string | null };
    const mk = (name: string, attrs: Record<string, string>): N => {
      const n: N = { nodeType: 1, nodeName: name, childNodes: [], getAttribute: (k) => attrs[k] ?? null, get textContent() { return n.childNodes.map((c) => c.textContent ?? "").join(""); } } as N;
      return n;
    };
    const root = mk("DIV", {});
    const stack = [root];
    for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
      const top = stack[stack.length - 1]!;
      if (m[3] !== undefined) {
        top.childNodes.push({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: m[3].replace(/&amp;/g, "&").replace(/&quot;/g, '"'), getAttribute: () => null });
        continue;
      }
      const name = m[1]!.toUpperCase();
      if (m[0].startsWith("</")) {
        const i = stack.map((x) => x.nodeName).lastIndexOf(name);
        if (i > 0) stack.length = i;
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of m[2]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
      const n = mk(name, attrs);
      top.childNodes.push(n);
      if (!VOID.has(name)) stack.push(n);
    }
    return root;
  }

  it("style=<名前> は class banto-style-<名前> で描き、編集の形から同じ書式に戻る", () => {
    const md = [
      "::: group bg=accent style=ribbon",
      "今週は送料無料",
      ":::",
      "",
      "::: button style=outline [見る](/products)",
      "",
      "::: products tag=NEW limit=4 layout=grid sort=new style=tiles",
      "",
      "::: articles blog=news tag=セール limit=2 layout=list style=cards",
    ].join("\n");
    const html = markdownToHtml(md, {});
    expect(html).toContain('class="banto-group banto-bg-accent banto-pad-m banto-style-ribbon"');
    expect(html).toContain('<p class="banto-button banto-style-outline" data-style="outline">');
    expect(html).toContain("banto-products banto-products--grid banto-style-tiles");
    expect(html).toContain('<div class="banto-articles banto-articles--list banto-style-cards" data-banto-block="articles" data-blog="news" data-tag="セール" data-limit="2" data-layout="list" data-style="cards"><!--banto:articles:0--></div>');
    const editor = markdownToHtml(md, { editor: true, productsLabel: () => "商品", articlesLabel: () => "記事" });
    const back = toMarkdown(parse(editor) as never);
    expect(markdownToHtml(back, {})).toBe(html);
    // 決まった形でない名前は描かない（本文に CSS や別の class を入れさせない）
    expect(markdownToHtml("::: group style=Bad;x\na\n:::", {})).not.toContain("banto-style");
    expect(parseButtonLine('::: button style=x" [a](/b)')).toBeNull();
  });

  it("記事を並べる: 値は決まった形だけ・1 ページに 2 つまで", () => {
    expect(parseArticlesLine("::: articles blog=news")).toEqual({ blog: "news", tag: null, limit: 3, layout: "grid", style: null });
    expect(parseArticlesLine("::: articles blog=News")).toBeNull();
    expect(parseArticlesLine("::: articles blog=news limit=13")).toBeNull();
    expect(articleBlocksOf("::: articles blog=a\n::: articles blog=b\n::: articles blog=c").map((b) => b.blog)).toEqual(["a", "b"]);
    const html = markdownToHtml("::: articles blog=a\n\n::: articles blog=b\n\n::: articles blog=c", {});
    expect(html).toContain("<!--banto:articles:1-->");
    expect(html).not.toContain("<!--banto:articles:2-->");
  });
});

function setup(withTheme: boolean) {
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true, blog: true } } });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (withTheme) {
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    sb.tables.theme_versions.push({ id: VERSION, shop_id: shop.id, name: "版", storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, size_bytes: 10, file_count: 3, manifest: {}, settings: {}, complete: true, created_at: "2026-10-30T00:00:00Z" });
    row["theme_version_id"] = VERSION;
    const bundle = { format: 1, files: { ...baseFiles, [PATTERNS_FILE]: JSON.stringify(patterns), [STYLES_FILE]: JSON.stringify(styles) }, assets: [] };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify(bundle)).buffer as ArrayBuffer, "application/json");
  }
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  sb.addArticle(shop.id, blog.id, { handle: "a1", title: "記事ひとつめ", body: "本文 1" });
  sb.addArticle(shop.id, blog.id, { handle: "a2", title: "記事ふたつめ", body: "本文 2", tags: ["セール"] });
  const app = appWith(sb, {}, storage);
  return { sb, shop, app, base: `/admin/shops/${shop.id}/modules/pages` };
}

describe("編集の画面のパターン・スタイル・記事のブロック", () => {
  it("公開中のテーマのパターンとスタイルが一覧に出て、パターンの本文は編集の形で受け取る", async () => {
    const { app, base } = setup(true);
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await owner.get(`${base}/new`)).text();
    const attr = (name: string) => JSON.parse(new RegExp(`${name}="([^"]*)"`).exec(html)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as unknown;
    const list = attr("data-patterns") as { name: string; source: string; title: string }[];
    expect(list.filter((p) => p.source === "theme").map((p) => p.name)).toEqual(["lookbook", "notice"]);
    expect(list.some((p) => p.name === "banto-hero" && p.source === "banto")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("秋の装い"); // 一覧に本文は載せない
    expect((attr("data-styles") as Record<string, unknown>)["group"]).toEqual([
      { name: "ribbon", label: "帯" },
      { name: "card", label: "カード" },
    ]);
    // 記事を並べるブロックのダイアログ（ブログがあるとき）
    expect(html).toContain('<option value="news">お知らせ（news）</option>');
    const p = (await (await owner.get(`${base}/pattern?name=lookbook`)).json()) as { html: string };
    expect(p.html).toContain('data-banto-block="cover"');
    expect(p.html).toContain("data-slot");
    expect(((await (await owner.get(`${base}/pattern?name=banto-faq`)).json()) as { html: string }).html).toContain('data-banto-block="accordion"');
    expect((await owner.get(`${base}/pattern?name=nope`)).status).toBe(404);
  });

  it("テーマが無ければ Banto の既定のパターンだけ。スタイルは無い", async () => {
    const { app, base } = setup(false);
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await owner.get(`${base}/new`)).text();
    expect(html).toContain('data-styles="{}"');
    expect(html).not.toContain("lookbook");
    expect(html).toContain("banto-features");
  });

  it("お店の画面: 記事を並べるブロックに公開中の記事が新しい順に並ぶ。ブログのモジュールが OFF なら何も出ない", async () => {
    const { sb, shop, app } = setup(false);
    sb.addPage(shop.id, { handle: "top", title: "トップ", body: "はじめに\n\n::: articles blog=news limit=5\n\n::: articles blog=news tag=セール layout=list", published: true });
    const r = await app.request(`${BASE}/my-shop/pages/top`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect((html.match(/class="card banto-articles__item"/g) ?? []).length).toBe(3);
    expect(html).toContain("記事ふたつめ");
    expect(html).toContain(`href="/my-shop/blogs/news/a1"`);
    sb.tables.shops[0]!["settings"] = { modules: { pages: true } };
    const off = await (await appWith(sb).request(`${BASE}/my-shop/pages/top`)).text();
    expect(off).not.toContain("banto-articles__item");
  });
});
