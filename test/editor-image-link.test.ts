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

/** 小さな偽の DOM（見たままの画面の節の形だけ） */
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attrs: Record<string, string> = {};
  constructor(
    public nodeName: string,
    public nodeType = 1,
    public textContent: string | null = "",
  ) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  appendChild(n: FakeNode) { n.parentNode?.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n: FakeNode, ref: FakeNode | null) { n.parentNode?.removeChild(n); n.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); }
  removeChild(n: FakeNode) { this.childNodes = this.childNodes.filter((c) => c !== n); n.parentNode = null; }
  contains(n: FakeNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  /** "a" と "[data-banto-block],[contenteditable=false]" だけ */
  closest(sel: string): FakeNode | null {
    for (let x: FakeNode | null = this; x; x = x.parentNode) {
      if (sel === "a" ? x.nodeName === "A" : x.attrs["data-banto-block"] !== undefined || x.attrs["contenteditable"] === "false") return x;
    }
    return null;
  }
}
const node = (name: string, attrs: Record<string, string> = {}, kids: FakeNode[] = []) => {
  const n = new FakeNode(name);
  n.attrs = { ...attrs };
  for (const k of kids) n.appendChild(k);
  return n;
};
const txt = (s: string) => new FakeNode("#text", 3, s);
const fakeDoc = { createElement: (tag: string) => node(tag.toUpperCase()) };

describe("画像のリンクの付け外し（setImageLink・imagePickable）", () => {
  const { setImageLink, imagePickable, toMarkdown } = pageEditorClient();
  const md = (root: FakeNode) => toMarkdown(root as never);

  it("付ける → 変える → 外す。書式は [![..](..)](..) と ![..](..) を行き来する", () => {
    const img = node("IMG", { src: "https://m.example/pages/s/a.webp", alt: "バナー" });
    const root = node("DIV", {}, [node("P", {}, [txt("前"), img, txt("後")])]);
    expect(setImageLink(fakeDoc as never, img as never, "/products/tee")).toBe("added");
    expect(md(root)).toBe("前[![バナー](https://m.example/pages/s/a.webp)](/products/tee)後");
    expect(setImageLink(fakeDoc as never, img as never, "https://example.jp/")).toBe("updated");
    expect(md(root)).toBe("前[![バナー](https://m.example/pages/s/a.webp)](https://example.jp/)後");
    expect(setImageLink(fakeDoc as never, img as never, "")).toBe("removed");
    expect(md(root)).toBe("前![バナー](https://m.example/pages/s/a.webp)後");
    expect(setImageLink(fakeDoc as never, img as never, "")).toBe("none");
  });

  it("選べる画像: 段落の画像・画像だけのリンクの画像。選ばない: ブロックの中・文字も入ったリンク・書式の中のリンクの画像", () => {
    const plain = node("IMG", { src: "x" });
    node("P", {}, [plain]);
    expect(imagePickable(plain as never)).toBe(true);
    const linked = node("IMG", { src: "x" });
    node("A", { href: "/a" }, [txt(" "), linked]);
    expect(imagePickable(linked as never)).toBe(true);
    const inCover = node("IMG", { src: "x", class: "banto-cover__img" });
    node("DIV", { "data-banto-block": "layout" }, [inCover]);
    expect(imagePickable(inCover as never)).toBe(false);
    const inFigure = node("IMG", { src: "x" });
    node("DIV", {}, [node("FIGURE", { contenteditable: "false" }, [inFigure])]);
    expect(imagePickable(inFigure as never)).toBe(false);
    const withText = node("IMG", { src: "x" });
    node("A", { href: "/a" }, [txt("文字"), withText]);
    expect(imagePickable(withText as never)).toBe(false);
    const nested = node("IMG", { src: "x" });
    node("A", { href: "/a" }, [node("STRONG", {}, [nested])]);
    expect(imagePickable(nested as never)).toBe(false);
    expect(imagePickable(node("P") as never)).toBe(false);
  });
});
