import { describe, expect, it } from "vitest";
import { promoteLeadImage } from "../src/pages/lead-image";
import { markdownToHtml } from "../src/pages/markdown";

const lazy = (src: string) => `<img src="${src}" alt="" loading="lazy" decoding="async">`;

describe("promoteLeadImage（本文の最初の画像をすぐ読む）", () => {
  it("最初の lazy の画像だけを eager・fetchpriority=high にする", () => {
    const out = promoteLeadImage(`<p>a</p>${lazy("/media/1.webp")}${lazy("/media/2.webp")}`);
    expect(out).toContain('<img src="/media/1.webp" alt="" loading="eager" fetchpriority="high" decoding="async">');
    expect(out).toContain(lazy("/media/2.webp"));
    expect(out.match(/fetchpriority/g)).toHaveLength(1);
  });

  it("カバーのブロックの画像（本文の Markdown から描いたもの）も上げる", () => {
    const html = markdownToHtml("::: cover image=/media/hero.webp\n# 見出し\n:::\n\n![写真](/media/2.webp)");
    const out = promoteLeadImage(html);
    expect(out).toMatch(/<img class="banto-cover__img" src="\/media\/hero\.webp" alt="" loading="eager" fetchpriority="high"/);
    expect(out).toContain('src="/media/2.webp" alt="写真" loading="lazy"');
  });

  it("最初の画像がもともとすぐ読む画像（アイキャッチの部品・商品の画像）なら何もしない", () => {
    const html = `<img class="banto-current-image" src="/media/e.webp" alt="" decoding="async">${lazy("/media/1.webp")}`;
    expect(promoteLeadImage(html)).toBe(html);
  });

  it("テーマが fetchpriority を決めた画像は変えない", () => {
    const html = `<img src="/media/1.webp" loading="lazy" fetchpriority="low">${lazy("/media/2.webp")}`;
    expect(promoteLeadImage(html)).toBe(html);
  });

  it("script・template・閉じたアコーディオンの中は数えない（開いたアコーディオンは数える）", () => {
    const hidden = `<script>var s='<img src=x loading="lazy">';</script><template>${lazy("/media/t.webp")}</template><details class="banto-accordion"><summary>Q</summary>${lazy("/media/d.webp")}</details>`;
    const out = promoteLeadImage(`${hidden}${lazy("/media/1.webp")}`);
    expect(out.startsWith(hidden)).toBe(true);
    expect(out).toContain('src="/media/1.webp" alt="" loading="eager" fetchpriority="high"');
    const open = `<details class="banto-accordion" open><summary>Q</summary>${lazy("/media/d.webp")}</details>`;
    expect(promoteLeadImage(open)).toContain('src="/media/d.webp" alt="" loading="eager" fetchpriority="high"');
  });

  it("画像が無ければそのまま", () => {
    expect(promoteLeadImage("<p>text</p>")).toBe("<p>text</p>");
  });
});
