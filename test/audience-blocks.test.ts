import { describe, expect, it } from "vitest";
import { audienceShow, filterAudienceBlocks, hasAudienceBlocks, matchedAudienceNames, stripAudienceBlocks } from "../src/content/audience-blocks";
import { markdownToHtml } from "../src/pages/markdown";
import { pageEditorClient } from "../src/content/editor-client";
import { articleSummary } from "../src/blog";

/** 本文の見せる相手の囲み（0097、src/content/audience-blocks.ts） */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const LIST = [
  { id: A, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } },
  { id: B, name: "ゲスト", condition: { not: { member: true } } },
];
const BODY = [
  "誰でも",
  "",
  `::: audience id=${A} title="ゴールド"`,
  "ゴールドだけ",
  "",
  "::: group bg=subtle",
  "中の囲み",
  ":::",
  ":::",
  "",
  `::: audience id=${B}`,
  "ゲストだけ",
  ":::",
  "",
  "おわり",
].join("\n");

describe("囲みを外す", () => {
  it("合えば中身を残し、合わなければ閉じまで消す（中のレイアウトの閉じを数える）", () => {
    const gold = filterAudienceBlocks(BODY, audienceShow(LIST, { member: true, attrs: { rank: "gold" } }));
    expect(gold.body).toContain("ゴールドだけ");
    expect(gold.body).toContain("::: group bg=subtle\n中の囲み\n:::");
    expect(gold.body).not.toContain("ゲストだけ");
    expect(gold.body).not.toContain("audience");
    expect(gold.key).toBe(A);
    const guest = filterAudienceBlocks(BODY, audienceShow(LIST, { member: false, attrs: {} }));
    expect(guest.body).not.toContain("ゴールドだけ");
    expect(guest.body).not.toContain("中の囲み");
    expect(guest.body).toContain("ゲストだけ");
    expect(guest.body).toContain("おわり");
    expect(guest.key).toBe(B);
    const silver = filterAudienceBlocks(BODY, audienceShow(LIST, { member: true, attrs: { rank: "silver" } }));
    expect(silver.body.replace(/\n+/g, "|")).toBe("誰でも|おわり");
    expect(silver.key).toBe("");
  });

  it("一覧に無い id・形の違う id・閉じの無い囲みは見せない。入れ子の外が合わなければ中も出さない", () => {
    const show = audienceShow(LIST, { member: true, attrs: { rank: "gold" } });
    expect(filterAudienceBlocks("a\n::: audience id=33333333-3333-4333-8333-333333333333\nx\n:::\nb", show).body).toBe("a\nb");
    expect(filterAudienceBlocks("a\n::: audience id=nope\nx\n:::\nb", show).body).toBe("a\nb");
    expect(filterAudienceBlocks(`a\n::: audience id=${A}\nx\n::: audience id=${B}\ny\n:::\nz`, show).body).toBe("a\nx\nz");
    expect(filterAudienceBlocks(`a\n::: audience id=${B}\nx\n::: audience id=${A}\ny\n:::\n:::\nb`, show).body).toBe("a\nb");
    expect(filterAudienceBlocks(`a\n::: audience id=${B}\nずっと`, show).body).toBe("a");
    expect(hasAudienceBlocks("::: group\n:::")).toBe(false);
  });

  it("抜粋（一覧・RSS）には囲みの中身を使わない。合う名前", () => {
    expect(articleSummary({ body: `はじめに\n::: audience id=${A}\n秘密の割引\n:::\nつづき` })).toBe("はじめに つづき");
    expect(stripAudienceBlocks(BODY)).not.toContain("だけ");
    expect(matchedAudienceNames(LIST, { member: true, attrs: { rank: "gold" } })).toEqual(["ゴールド"]);
  });

  it("外さずに描く道に来た囲みは、お客様の画面ではだれにも見せない。編集の画面は枠で描き、見たままの編集から書式に戻る", () => {
    const md = `前\n\n::: audience id=${A} title="ゴールド"\n**中**\n:::\n\n後`;
    const store = markdownToHtml(md, { mediaBase: "" });
    expect(store).not.toContain("中");
    expect(store).toContain("後");
    const editor = markdownToHtml(md, { mediaBase: "", editor: true, audienceLabel: (t) => `見せる相手: ${t}` });
    expect(editor).toContain(`data-banto-block="audience" data-id="${A}" data-title="ゴールド"`);
    expect(editor).toContain("見せる相手: ゴールド");
    expect(editor).toContain("<strong>中</strong>");
    // 見たままの編集（ブラウザの DOM）→ 書式。DOM の代わりに、テストの小さな木を作る
    const { toMarkdown } = pageEditorClient();
    type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string; getAttribute?: (k: string) => string | null; nodeValue?: string };
    const text = (s: string): N => ({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: s, nodeValue: s });
    const el = (name: string, attrs: Record<string, string>, kids: N[]): N => ({ nodeType: 1, nodeName: name, childNodes: kids, textContent: kids.map((k) => k.textContent).join(""), getAttribute: (k) => attrs[k] ?? null });
    const root = el("DIV", {}, [
      el("P", {}, [text("前")]),
      el("DIV", { "data-banto-block": "audience", "data-id": A, "data-title": "ゴールド", class: "banto-audience" }, [el("DIV", { class: "banto-audience__label", contenteditable: "false" }, [text("見せる相手: ゴールド")]), el("DIV", { class: "banto-audience__body" }, [el("P", {}, [el("STRONG", {}, [text("中")])])])]),
      el("P", {}, [text("後")]),
    ]);
    expect(toMarkdown(root as never)).toBe(md);
  });
});
