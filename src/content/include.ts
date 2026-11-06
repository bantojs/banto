/**
 * 本文に別のページの本文を差し込む（`::: include page=<handle>`、0122、メンテナの決定 2026-11-06、docs/pages.md「部品のページ」）。
 *
 * - 差し込むのは公開中のページの本文（匿名の読み取り。会員限定・下書き・予約・ゴミ箱のページは差し込まない）。
 *   ふつうは「部品のページ」（pages.is_part、/pages/<handle> では見せない）を作って使う
 * - 描く前に文字のまま差し込む（見せる相手の囲み・ブロックの数の上限・HTML の覚えは差し込んだ後の本文に効く）
 * - 差し込みは 1 段だけ（部品の中の `::: include` は外す）。1 つの本文で INCLUDES_MAX まで（多い分は外す）
 */
import { parseShopBlock } from "../pages/shop-blocks";
import type { PublicShop, StorefrontData } from "../storefront/data";

export const INCLUDES_MAX = 3;

const MAYBE = /^\s{0,3}:{3}\s*include(\s|$)/m;

/** 本文の中の差し込みの行（行の番号と URL の名前） */
function includeLines(lines: readonly string[]): { index: number; handle: string | null }[] {
  const out: { index: number; handle: string | null }[] = [];
  lines.forEach((line, index) => {
    if (!MAYBE.test(line)) return;
    const b = parseShopBlock(line);
    if (b?.kind === "include") out.push({ index, handle: b.attrs["page"] ?? null });
  });
  return out;
}

export const hasIncludes = (body: string | null | undefined): boolean => Boolean(body) && MAYBE.test(body!);

/** 差し込む部品の URL の名前（文書の順、重ならない、上限まで） */
export function includeHandles(body: string): string[] {
  const out: string[] = [];
  for (const l of includeLines(body.replace(/\r\n?/g, "\n").split("\n"))) {
    if (out.length >= INCLUDES_MAX) break;
    if (l.handle && !out.includes(l.handle)) out.push(l.handle);
  }
  return out;
}

export interface IncludePart {
  id: string;
  handle: string;
  body: string;
  updated_at: string;
}

/** 部品の中の差し込みの行を外す（1 段だけ） */
const withoutIncludes = (body: string): string => {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const drop = new Set(includeLines(lines).map((l) => l.index));
  return lines.filter((_, i) => !drop.has(i)).join("\n");
};

/**
 * 差し込みの行を部品の本文に置き換える（見つからない部品・上限を超えた行は外す）。
 * key は本文の HTML の覚えの区分け（差し込んだ部品の id と更新日時。部品を直せば変わる）
 */
export function expandIncludes(body: string, parts: readonly IncludePart[]): { body: string; key: string } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const found = includeLines(lines);
  if (found.length === 0) return { body, key: "" };
  const byHandle = new Map(parts.map((p) => [p.handle, p]));
  const allowed = new Set(includeHandles(body));
  const used: IncludePart[] = [];
  const at = new Map(found.map((l) => [l.index, l.handle]));
  const out: string[] = [];
  let count = 0;
  lines.forEach((line, i) => {
    if (!at.has(i)) return void out.push(line);
    const handle = at.get(i);
    const part = handle && allowed.has(handle) && count < INCLUDES_MAX ? byHandle.get(handle) : undefined;
    if (!part) return;
    count++;
    if (!used.includes(part)) used.push(part);
    // 前後の段落とつながらないように空の行ではさむ
    out.push("", withoutIncludes(part.body), "");
  });
  return { body: out.join("\n"), key: used.length ? `inc:${used.map((p) => `${p.id}@${p.updated_at}`).join(",")}` : "inc:" };
}

/** お店の画面・ヘッドレスの API・プレビュー: 部品を引いて差し込む（差し込みの行が無ければ何も引かない） */
export async function withIncludes(sf: StorefrontData, shop: PublicShop, body: string): Promise<{ body: string; key: string }> {
  if (!hasIncludes(body)) return { body, key: "" };
  const handles = includeHandles(body);
  const parts = handles.length ? await sf.includeParts(shop, handles).catch((e: unknown) => {
    console.error("[banto] include:", e instanceof Error ? e.message : e);
    return [] as IncludePart[];
  }) : [];
  return expandIncludes(body, parts);
}
