import { describe, expect, it } from "vitest";
import { pageEditorClient } from "../src/content/editor-client";
import { markdownToHtml } from "../src/pages/markdown";

/** 見たままの編集の画像のリンク（画像を押して「リンク」）。ブラウザでの操作は手で確かめた（Chromium）。ここは書式との往復 */
describe("画像のリンク", () => {
  type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string; getAttribute?: (k: string) => string | null };
  const el = (name: string, attrs: Record<string, string>, kids: N[] = []): N => ({ nodeType: 1, nodeName: name, childNodes: kids, textContent: "", getAttribute: (k) => attrs[k] ?? null });
  const text = (s: string): N => ({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: s });

  it("<a> の中の画像は [![説明](画像)](リンク先) に戻り、選んだ印（data-picked）は書式に残らない", () => {
    const { toMarkdown } = pageEditorClient();
    const img = el("IMG", { src: "https://m.example/pages/s/a.webp", alt: "バナー", "data-picked": "1" });
    const root = el("DIV", {}, [el("P", {}, [text("前"), el("A", { href: "/products/tee" }, [img]), text("後")])]);
    expect(toMarkdown(root as never)).toBe("前[![バナー](https://m.example/pages/s/a.webp)](/products/tee)後");
  });

  it("書式 → HTML でもリンクの付いた画像（お店の中のパスと https）", () => {
    const html = markdownToHtml("[![バナー](https://m.example/pages/s/a.webp)](/products/tee)", { mediaBase: "https://m.example" });
    expect(html).toContain('<a href="/products/tee"><img src="https://m.example/pages/s/a.webp" alt="バナー"');
    expect(markdownToHtml("[![b](https://m.example/pages/s/a.webp)](https://example.jp/)", { mediaBase: "https://m.example" })).toContain('<a href="https://example.jp/" rel="noopener"><img');
  });
});
