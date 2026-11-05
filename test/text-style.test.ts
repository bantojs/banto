import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/pages/markdown";
import { parseBlockStyles } from "../src/content/theme-blocks";
import { pageEditorClient } from "../src/content/editor-client";
import { parseLayoutOpen } from "../src/pages/layout";

/** 文字のスタイル（::: text style=…、メンテナの決定 2026-11-05、A2。docs/pages.md「レイアウトのブロック」） */
describe("::: text", () => {
  const md = ["::: text style=lead", "春の新作が届きました。", "", "## 小見出し", "", "- ひとつめ", "- ふたつめ", ":::", "", "囲みの外"].join("\n");

  it("お店の画面: 中の段落・見出し・リストをそのまま描き、class だけ足す（余白・背景は足さない）", () => {
    const html = markdownToHtml(md, {});
    expect(html).toContain('<div class="banto-text banto-style-lead" data-banto-block="text" data-style="lead">');
    expect(html).toMatch(/<div class="banto-text banto-style-lead"[^>]*>\s*<p>春の新作が届きました。<\/p>\s*<h2[^>]*>小見出し<\/h2>\s*<ul>/);
    expect(html).toMatch(/<\/ul>\s*<\/div>\s*<p>囲みの外<\/p>/);
    expect(html).not.toMatch(/class="banto-text[^"]*banto-pad/);
    // 文字のスタイルだけのページには、並べ方の CSS を付けない
    expect(html).not.toContain("<style>");
    // スタイルの無い囲み・形の違う名前は class を足さない
    expect(markdownToHtml("::: text\nあ\n:::", {})).toContain('<div class="banto-text" data-banto-block="text">');
    expect(parseLayoutOpen("::: text style=Lead!")?.style).toBeNull();
  });

  it("グループの中にも置け、入れ子の上限は今までどおり", () => {
    const html = markdownToHtml(":::: group bg=subtle\n::: text style=eyebrow\nNEW ARRIVAL\n:::\n## 見出し\n::::", {});
    expect(html).toMatch(/<div class="banto-group[^"]*"[^>]*>\s*<div class="banto-text banto-style-eyebrow"[^>]*>\s*<p>NEW ARRIVAL<\/p>\s*<\/div>/);
  });

  it("見たままの編集 → 書式に戻る（編集の形の HTML を小さな木にして）", () => {
    const { toMarkdown } = pageEditorClient();
    type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string; getAttribute?: (k: string) => string | null; nodeValue?: string };
    const text = (s: string): N => ({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: s, nodeValue: s });
    const el = (name: string, attrs: Record<string, string>, kids: N[]): N => ({ nodeType: 1, nodeName: name, childNodes: kids, textContent: kids.map((k) => k.textContent).join(""), getAttribute: (k) => attrs[k] ?? null });
    const root = el("DIV", {}, [
      el("DIV", { "data-banto-block": "text", "data-style": "lead", class: "banto-text banto-style-lead", "data-slot": "" }, [el("P", {}, [text("春の新作が届きました。")]), el("H2", {}, [text("小見出し")])]),
      el("P", {}, [text("囲みの外")]),
    ]);
    expect(toMarkdown(root as never)).toBe(["::: text style=lead", "春の新作が届きました。", "", "## 小見出し", ":::", "", "囲みの外"].join("\n"));
    // 編集の画面の HTML にも同じ印が付く
    const ed = markdownToHtml(md, { editor: true });
    expect(ed).toContain('data-banto-block="text" data-style="lead" data-slot');
  });

  it("テーマの banto_block_styles.json に text の種類を書ける", () => {
    const r = parseBlockStyles(JSON.stringify({ text: [{ name: "lead", label: "リード文" }, { name: "eyebrow", label: { ja: "小見出し", en: "Eyebrow" } }] }), "en");
    expect(r.errors).toEqual([]);
    expect(r.styles.text).toEqual([
      { name: "lead", label: "リード文" },
      { name: "eyebrow", label: "Eyebrow" },
    ]);
  });
});
