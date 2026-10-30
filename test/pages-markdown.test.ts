import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/pages/markdown";

/** ショップのページの本文（決まった書式）→ HTML（0079、docs/pages.md）。生の HTML は書けず、リンクと画像は決まった先だけ */
const md = (s: string) => markdownToHtml(s, { mediaBase: "https://media.example.jp" });

describe("ページの本文の書式", () => {
  it("見出し（# と ## は h2）・段落と改行・太字・斜体・コード・区切り線", () => {
    expect(md("# お店について\n\n1 行目\n2 行目\n\n---\n\n**太字** と *斜体* と _斜体_ と `code`")).toBe(
      "<h2>お店について</h2>\n<p>1 行目<br>2 行目</p>\n<hr>\n<p><strong>太字</strong> と <em>斜体</em> と <em>斜体</em> と <code>code</code></p>",
    );
    expect(md("## 見出し")).toBe("<h2>見出し</h2>");
    expect(md("### 小見出し ###")).toBe("<h3>小見出し</h3>");
    expect(md("##### 小さい")).toBe("<h4>小さい</h4>");
    expect(md("## C#")).toBe("<h2>C#</h2>");
    expect(md("snake_case_name")).toBe("<p>snake_case_name</p>");
  });

  it("箇条書き・番号付き（字下げした続きの行）・引用・表", () => {
    expect(md("- りんご\n- みかん\n  （小）\n\n1. 一\n2. 二")).toBe("<ul><li>りんご</li><li>みかん<br>（小）</li></ul>\n<ol><li>一</li><li>二</li></ol>");
    expect(md("> 引用の 1 行目\n> 2 行目")).toBe("<blockquote><p>引用の 1 行目<br>2 行目</p></blockquote>");
    expect(md("| 品 | 値段 |\n| --- | ---: |\n| A | ¥1,000 |\n| B \\| C | ¥2 |")).toBe(
      '<div class="banto-table"><table><thead><tr><th>品</th><th>値段</th></tr></thead><tbody><tr><td>A</td><td>¥1,000</td></tr><tr><td>B | C</td><td>¥2</td></tr></tbody></table></div>',
    );
  });

  it("リンクは決まった先だけ。外へのリンクには rel=noopener", () => {
    expect(md("[会社](https://example.com/a?b=1&c=2) [送料](/shipping) [上へ](#top) [メール](mailto:a@example.com) [電話](tel:03-1234-5678)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener">会社</a> <a href="/shipping">送料</a> <a href="#top">上へ</a> <a href="mailto:a@example.com">メール</a> <a href="tel:03-1234-5678">電話</a></p>',
    );
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "vbscript:x", "https://a\"onmouseover=\"x"]) {
      const html = md(`[x](${bad})`);
      expect(html, bad).not.toContain("<a ");
    }
    expect(md("[**太字の**リンク](/a)")).toBe('<p><a href="/a"><strong>太字の</strong>リンク</a></p>');
  });

  it("太字の斜体（***、見たままの編集で太字と斜体を重ねた形）", () => {
    expect(md("***両方***")).toBe("<p><strong><em>両方</em></strong></p>");
    expect(md("***a*** と ***b***")).toBe("<p><strong><em>a</em></strong> と <strong><em>b</em></strong></p>");
    expect(md("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
  });

  it("画像はショップの画像の置き場だけ。ほかは説明の文字になる", () => {
    expect(md("![店の外観](https://media.example.jp/pages/s/a.webp)")).toBe('<p><img src="https://media.example.jp/pages/s/a.webp" alt="店の外観" loading="lazy" decoding="async"></p>');
    expect(md("![a](/media/pages/s/a.webp)")).toContain('<img src="/media/pages/s/a.webp"');
    for (const bad of ["https://evil.example/x.png", "https://media.example.jp.evil/x.png", "/media/../admin", "javascript:x"]) {
      expect(md(`![外](${bad})`), bad).toBe("<p>外</p>");
    }
  });

  it("生の HTML は書けない（すべて文字になる）", () => {
    const html = md('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n# <b>見出し</b>\n\n[<svg onload=x>](/a)\n\n| <i>x</i> |\n| --- |');
    expect(html).not.toMatch(/<(script|img|b|svg|i)[\s>]/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md('![x" onerror="alert(1)](/media/a.webp)')).toContain('alt="x&quot; onerror=&quot;alert(1)"');
    expect(md("\\*そのまま\\*")).toBe("<p>*そのまま*</p>");
  });

  it("閉じの無い記号が大量にあっても速い（後戻りや探し直しで二乗にならない）", () => {
    const inputs = ["*".repeat(50000), "[a](".repeat(12000), "`a".repeat(25000), "#" + " ".repeat(49000) + "x", "_a".repeat(25000), "[".repeat(50000), "- ".repeat(25000)];
    for (const s of inputs) {
      const t = performance.now();
      markdownToHtml(s);
      expect(performance.now() - t, s.slice(0, 10)).toBeLessThan(200);
    }
  });
});
