import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/pages/markdown";
import { pageEditorClient } from "../src/content/editor-client";

/**
 * ページの見たままの編集（0079、docs/pages.md）: 編集の領域（contenteditable）→ 決まった書式。
 * 「書式 → HTML → 書式 → HTML」で HTML が変わらないこと（往復で中身が崩れない）と、ブラウザが作る形を直せることを確かめる。
 * ブラウザの DOM の代わりに、HTML を読んで同じ形の偽物の節を作る
 */
interface FakeNode {
  nodeType: number;
  nodeName: string;
  childNodes: FakeNode[];
  textContent: string | null;
  attrs: Record<string, string>;
  getAttribute(k: string): string | null;
}

const VOID = new Set(["BR", "IMG", "HR", "INPUT", "META"]);
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENT[e]!);

function el(name: string, attrs: Record<string, string> = {}): FakeNode {
  const n: FakeNode = {
    nodeType: 1,
    nodeName: name,
    childNodes: [],
    attrs,
    getAttribute: (k) => attrs[k] ?? null,
    get textContent(): string {
      return n.childNodes.map((c) => c.textContent ?? "").join("");
    },
  } as FakeNode;
  return n;
}

function parse(html: string): FakeNode {
  const root = el("DIV");
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const top = stack[stack.length - 1]!;
    if (m[3] !== undefined) {
      top.childNodes.push({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: decode(m[3]), attrs: {}, getAttribute: () => null });
      continue;
    }
    const name = m[1]!.toUpperCase();
    if (m[0].startsWith("</")) {
      const i = stack.map((x) => x.nodeName).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    const n = el(name, attrs);
    top.childNodes.push(n);
    if (!VOID.has(name)) stack.push(n);
  }
  return root;
}

const { toMarkdown } = pageEditorClient();
const html = (md: string) => markdownToHtml(md, { mediaBase: "https://media.example.jp" });
const back = (h: string) => toMarkdown(parse(h));

describe("見たままの編集 → 決まった書式", () => {
  it("書式 → HTML → 書式 → HTML で HTML が変わらない", () => {
    const samples = [
      "## お店について\n\n**手しごと**の店です。\n2 行目\n\n### 小見出し\n\n*斜体* と `code` と [送料](/shipping) と [外](https://example.com/a?b=1&c=2)",
      "- りんご\n- **みかん**\n\n1. 一\n2. 二\n\n> 引用の 1 行目\n> 2 行目\n\n---\n\n![店の外観](https://media.example.jp/pages/s/a.webp)",
      "| 品 | 値段 |\n| --- | --- |\n| A | ¥1,000 |\n| B \\| C | **¥2** |",
      "記号のまま: \\*星\\* と \\_下線\\_ と \\[角\\] と 1\\. 番号ではない\n\n\\# 見出しではない\n\n\\- 箇条書きではない\n\nsnake_case_name と C# と 5*3",
      "#### 小さい見出し\n\n段落の中の <b>HTML</b> は文字",
    ];
    for (const md of samples) {
      const h = html(md);
      expect(html(back(h)), md).toBe(h);
    }
  });

  it("ブラウザの編集が作る形（div と br・b・span・入れ子の箇条書き・h1・空の段落）を書式に直す", () => {
    const md = back(
      '<h1><b>大見出し</b></h1><div>1 行目<br>2 行目</div><div><br></div><div><b>太</b><span style="color:red">赤</span> <i> 斜 </i></div>' +
        "<ul><li>上<ul><li>下</li></ul></li><li>次</li></ul><p><font>古い</font>タグ</p><h5>深い</h5>",
    );
    expect(md).toBe("## 大見出し\n\n1 行目\n2 行目\n\n**太**赤 *斜*\n\n- 上\n- 下\n- 次\n\n古いタグ\n\n#### 深い");
  });

  it("書式で表せない要素は中の文字だけ。危ない URL のリンク・画像は文字か空に（サーバーも出さない）", () => {
    const md = back('<p><script>alert(1)</script><a href="javascript:alert(1) x">押す</a><img src="x onerror=1" alt="a"><iframe>枠</iframe></p>');
    expect(md).not.toMatch(/<|javascript:\S*\)/);
    expect(html(md)).not.toMatch(/<(script|iframe|img)|href=/);
  });

  it("見出し・番号に見える文字は、行の頭の記号を逃がす", () => {
    expect(back("<p># ではない<br>- ではない<br>1. ではない<br>&gt; ではない</p>")).toBe("\\# ではない\n\\- ではない\n1\\. ではない\n\\> ではない");
    expect(html(back("<p># ではない</p>"))).toBe("<p># ではない</p>");
  });

  it("商品を並べる・ボタンのブロックは同じ 1 行に戻し、「:::」で始まる文字は逃がす", () => {
    const body = '::: products category=tops tag="冬 物" limit=12 layout=scroll sort=price_asc\n\n::: button [見る](/p/x)\n\n\\::: products は文字';
    const h = markdownToHtml(body, { productsLabel: () => "商品" });
    expect(h).toContain('contenteditable="false">商品</div>');
    expect(h).toContain("<p>::: products は文字</p>");
    expect(back(h)).toBe(body);
    // ブラウザで箱の値を直したもの（値は決まった形だけに絞る）
    expect(back('<div data-banto-block="products" data-category="Bad Slug" data-tag="a&quot;b" data-limit="99" data-layout="x" data-sort="random">x</div>')).toBe("::: products tag=ab limit=8 layout=grid sort=new");
  });
  it("レイアウトの囲み（入れ子）: 編集の形 → 書式 → お店の HTML が元と同じ。外側ほど : が多い", () => {
    const md = [
      "::::: group bg=subtle pad=l",
      ":::: columns ratio=1-2 valign=center",
      "::: column",
      "## 左",
      "",
      "**太字**の文",
      ":::",
      "::: column",
      "::: products tag=NEW limit=4 layout=grid sort=new",
      ":::",
      "::::",
      ":::::",
      "",
      ":::: cover image=https://media.example.jp/pages/s/a.webp height=l overlay=light align=left",
      "## ようこそ",
      "",
      "::: accordion icon=plus open=1 title=\"送料は？\"",
      "全国一律です。",
      ":::",
      "::::",
      "",
      "::: media side=right image=https://media.example.jp/pages/s/b.webp alt=\"店の外観\"",
      "文",
      ":::",
      "",
      "::: gallery cols=4",
      "![一](https://media.example.jp/pages/s/1.webp)",
      "![二](https://media.example.jp/pages/s/2.webp)",
      ":::",
      "",
      "::: spacer size=xl",
    ].join("\n");
    const store = html(md);
    const editor = markdownToHtml(md, { mediaBase: "https://media.example.jp", editor: true, productsLabel: () => "商品" });
    expect(editor).not.toContain("<details");
    expect(editor).toContain('data-slot="cols"');
    const again = back(editor);
    expect(html(again)).toBe(store);
    expect(again.split("\n")[0]).toBe("::::: group bg=subtle pad=l");
    expect(again).toContain(":::: columns ratio=1-2 valign=center");
    expect(again).toContain('::: accordion icon=plus open=1 title="送料は？"');
    // 値は決まった形だけ（ブラウザで書き換えられても、囲みの行に余計なものは入らない）
    expect(back('<div data-banto-block="group" data-bg="red;x" data-pad="m" data-evil="1"><p>a</p></div>')).toBe("::: group pad=m\na\n:::");
  });

  it("レイアウトの囲み: 入れ子は 4 段まで（深い囲みは中身だけ）・画像は置き場のものだけ・閉じの無い囲みは最後まで", () => {
    const deep = "::: group\n".repeat(6) + "x\n" + ":::\n".repeat(6);
    expect((html(deep).match(/class="banto-group/g) ?? []).length).toBe(4);
    const cover = html("::: cover image=https://evil.example/a.png\n## a\n:::");
    expect(cover).not.toContain("evil.example");
    expect(cover).toContain('<div class="banto-cover__inner"><h2>a</h2></div>');
    expect(html("::: group\n文")).toContain('<p>文</p></div>');
    // CSS はレイアウトのブロックがあるときだけ、1 回
    expect(html("ただの文")).not.toContain("<style>");
    expect((html("::: spacer\n\n::: group\na\n:::").match(/<style>/g) ?? []).length).toBe(1);
  });
});
