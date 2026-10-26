import type { Filter } from "../../db/client";
import { t } from "../../i18n";
import { UUID_RE, decodeCursor, encodeCursor } from "../../util/cursor";

/**
 * 管理画面の一覧のページ送り（新しい順、キーセット。docs/knowledge/02-decisions.md 2026-10-26）。
 * 件数が何万・何十万になっても、1 画面で読むのは ADMIN_PAGE_SIZE + 1 行だけ。検索・絞り込みも DB で行う。
 */
export const ADMIN_PAGE_SIZE = 50;

export interface PagePosition {
  /** 前のページの最後の行の並べ替えの値（created_at など）と id */
  k: string;
  id: string;
}

/** ?after= を読む。無ければ undefined、形が違えば null */
export function readAfter(text: string | undefined): PagePosition | null | undefined {
  if (!text) return undefined;
  const v = decodeCursor(text);
  if (!v || typeof v["k"] !== "string" || typeof v["id"] !== "string" || !UUID_RE.test(v["id"]) || Number.isNaN(Date.parse(v["k"]))) return null;
  return { k: v["k"], id: v["id"] };
}

/** 新しい順（col desc, id desc）で、pos より後ろの行だけ */
export function olderThan(pos: PagePosition, col = "created_at"): Filter {
  return { or: [{ col, op: "lt", value: pos.k }, { and: [{ col, op: "eq", value: pos.k }, { col: "id", op: "lt", value: pos.id }] }] };
}

/** ADMIN_PAGE_SIZE + 1 行読んだ結果 → 出す行と、次のページの after（最後なら null） */
export function splitPage<T extends { id: string }>(rows: T[], key: (row: T) => string, size = ADMIN_PAGE_SIZE): { rows: T[]; next: string | null } {
  if (rows.length <= size) return { rows, next: null };
  const shown = rows.slice(0, size);
  const last = shown[shown.length - 1]!;
  return { rows: shown, next: encodeCursor({ k: key(last), id: last.id }) };
}

/** 配列を n 個ずつに分ける（in.(…) の URL を長くしすぎないため） */
export function chunks<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** 次のページ・最初のページへのリンク。base は検索条件を含む一覧の URL（after は付けない）。param は位置を載せる名前 */
export function Pager(props: { base: string; next: string | null; paged: boolean; param?: string }) {
  if (!props.next && !props.paged) return null;
  const sep = props.base.includes("?") ? "&" : "?";
  return (
    <nav class="pager" aria-label={t("store.pagination")} style="display:flex;justify-content:space-between;gap:1rem;margin:1rem 0">
      {props.paged ? <a href={props.base}>{t("store.first_page")}</a> : <span />}
      {props.next ? (
        <a href={`${props.base}${sep}${props.param ?? "after"}=${props.next}`} rel="next">
          {t("store.next_page")}
        </a>
      ) : null}
    </nav>
  );
}
