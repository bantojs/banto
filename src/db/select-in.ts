import type { DbClient, Row } from "./client";

/**
 * ショップの中で、列の値が ids のどれかの行だけを読む（in.(…) を 250 個ずつ、並列に）。
 * 「ショップ全体を読んでから探す」をやめるための部品（PostgREST の 1 回 1,000 行で欠けるため。docs/knowledge/02-decisions.md 2026-10-26）
 */
export async function selectIn<T extends Row>(db: DbClient, table: string, columns: string, shopId: string, col: string, ids: readonly string[]): Promise<T[]> {
  const unique = [...new Set(ids)];
  const parts: string[][] = [];
  for (let i = 0; i < unique.length; i += 250) parts.push(unique.slice(i, i + 250));
  return (await Promise.all(parts.map((part) => db.from<T>(table).select(columns, { eq: { shop_id: shopId }, in: { [col]: part } })))).flat();
}
