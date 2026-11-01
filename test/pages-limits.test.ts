import { describe, expect, it } from "vitest";
import { BODY_HTML_MAX, TABLE_COLS_MAX, TABLE_ROWS_MAX, markdownToHtml } from "../src/pages/markdown";
import { PAGE_LIMITS, pageBodyHtml } from "../src/pages";
import { articleSummary } from "../src/blog";
import { LAYOUT_DEPTH_MAX } from "../src/pages/layout";

/**
 * 書いた物の重さの上限: 本文（50,000 字まで）から、見る人全員の Worker を止めるほど大きい HTML・長い計算を作らせない。
 * 表は列 30・行 500、HTML は 1MB、囲みの入れ子は深さを超えたら平らに、一覧の紹介文の正規表現は長さで縛る
 */
const timed = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("本文の重さの上限", () => {
  it("表: 超えた列は捨て、超えた行は打ち切る（打ち切った行は段落にもしない）", () => {
    const cols = TABLE_COLS_MAX + 5;
    const head = Array.from({ length: cols }, (_, i) => `c${i}`).join("|");
    const sep = Array.from({ length: cols }, () => "---").join("|");
    const rows = Array.from({ length: TABLE_ROWS_MAX + 20 }, (_, r) => Array.from({ length: cols }, (_, i) => `r${r}c${i}`).join("|")).join("\n");
    const html = markdownToHtml(`${head}\n${sep}\n${rows}\n\n後ろの段落`);
    expect(html).toContain(`<th>c${TABLE_COLS_MAX - 1}</th>`);
    expect(html).not.toContain(`<th>c${TABLE_COLS_MAX}</th>`);
    expect(html).toContain(`<td>r${TABLE_ROWS_MAX - 1}c0</td>`);
    expect(html).not.toContain(`r${TABLE_ROWS_MAX}c0`);
    expect((html.match(/<tr>/g) ?? []).length).toBe(TABLE_ROWS_MAX + 1);
    expect(html).toContain("<p>後ろの段落</p>");
  });

  it("上限いっぱいの表（見出し 2,000 列 + | だけの行）でも出力は 1MB 以下で、時間もかからない", () => {
    for (const cells of [200, 2000]) {
      let body = "|a".repeat(cells) + "|\n" + "|---".repeat(cells) + "|\n";
      while (body.length + 2 <= PAGE_LIMITS.body) body += "|\n";
      let html = "";
      const ms = timed(() => {
        html = markdownToHtml(body, { mediaBase: "https://m.example/media" });
      });
      expect(html.length, `${cells} 列`).toBeLessThanOrEqual(BODY_HTML_MAX);
      expect(ms, `${cells} 列 took ${ms}ms`).toBeLessThan(2000);
    }
  });

  it("HTML が 1MB を超える本文は「本文が大きすぎます」の段落だけにする", () => {
    // 1 つの表は列 30 × 行 500 まで。表を並べて上限を超えさせる
    const table = "|a".repeat(TABLE_COLS_MAX) + "|\n" + "|---".repeat(TABLE_COLS_MAX) + "|\n" + "|\n".repeat(TABLE_ROWS_MAX);
    let body = "";
    while (body.length + table.length + 1 <= PAGE_LIMITS.body) body += `${table}\n`;
    const html = markdownToHtml(body);
    expect(html).toBe('<p class="banto-too-large">本文が大きすぎます。</p>');
    // 普通の大きさはそのまま
    expect(markdownToHtml("# 見出し\n\n本文")).toBe("<h2>見出し</h2>\n<p>本文</p>");
  });

  it("囲みの入れ子は深さを超えたら再帰せず平らにする（4,500 段でも落ちず、2 秒以下）", () => {
    const max = PAGE_LIMITS.body;
    const cases: Record<string, string> = {
      nested_open: ":::: group\n".repeat(Math.floor(max / 11)),
      nested_open_close: Array.from({ length: Math.floor(max / 20) }, () => ":::: group\n").join("") + ":::\n".repeat(Math.floor(max / 20)),
      accordion_nest: ':::: accordion title="x"\n'.repeat(Math.floor(max / 26)),
    };
    for (const [name, src] of Object.entries(cases)) {
      let html = "";
      const ms = timed(() => {
        html = markdownToHtml(src.slice(0, max), { mediaBase: "https://m.example/media" });
      });
      expect(ms, `${name} took ${ms}ms`).toBeLessThan(2000);
      expect(html.length).toBeLessThanOrEqual(BODY_HTML_MAX);
    }
    // 深さの上限までは囲みになり、それより深い囲みは行を外して中身だけ
    const deep = `${":::: group\n".repeat(LAYOUT_DEPTH_MAX + 2)}中身\n${"::::\n".repeat(LAYOUT_DEPTH_MAX + 2)}`;
    const html = markdownToHtml(deep);
    expect((html.match(/data-banto-block="group"/g) ?? []).length).toBe(LAYOUT_DEPTH_MAX);
    expect(html).toContain("<p>中身</p>");
    expect(html).not.toContain("::::");
  });

  it("一覧の紹介文: 閉じの無い [ の羅列でも二乗にならない（5 万字で 100ms 以下）", () => {
    for (const body of ["[".repeat(50000), "[a](".repeat(12500), "![".repeat(25000), "[a](b".repeat(10000)]) {
      const ms = timed(() => articleSummary({ body }));
      expect(ms, `took ${ms}ms`).toBeLessThan(100);
    }
    // 普通のリンク・画像は今までどおり
    expect(articleSummary({ body: "**太字**と[リンク](/x)。![画像](/media/a.webp)" })).toBe("太字とリンク。");
  });

  it("ページの HTML のキャッシュ: 大きな本文を続けて描いても、同じ版は覚えたものを返す", () => {
    const table = "|a".repeat(TABLE_COLS_MAX) + "|\n" + "|---".repeat(TABLE_COLS_MAX) + "|\n" + "|x\n".repeat(TABLE_ROWS_MAX);
    const pages = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, updated_at: "2026-01-01T00:00:00Z", body: `# ${i}\n\n${table}` }));
    const first = pages.map((p) => pageBodyHtml(p, "https://m.example/media"));
    expect(first[0]).toContain("<h2>0</h2>");
    expect(first[39]).toContain("<h2>39</h2>");
    // もう一度（覚えていても、覚え直しても同じ結果）
    expect(pageBodyHtml(pages[0]!, "https://m.example/media")).toBe(first[0]);
    expect(pageBodyHtml(pages[39]!, "https://m.example/media")).toBe(first[39]);
  });
});
