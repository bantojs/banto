import type { Filter } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { selectIn } from "../../db/select-in";
import { owner, type AdminContext } from "./context";
import { t } from "../../i18n";
import { ISO_TIMESTAMP, UUID_RE, decodeCursor, encodeCursor } from "../../util/cursor";

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
  if (!v || typeof v["k"] !== "string" || typeof v["id"] !== "string" || !UUID_RE.test(v["id"]) || !ISO_TIMESTAMP.test(v["k"])) return null;
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

/** 次のページ・最初のページへのリンク。base は検索条件を含む一覧の URL（after は付けない）。param は位置を載せる名前 */
export function Pager(props: { base: string; next: string | null; paged: boolean; param?: string }) {
  if (!props.next && !props.paged) return null;
  const sep = props.base.includes("?") ? "&" : "?";
  return (
    <nav class="pager" aria-label={t("admin.pagination")}>
      {props.paged ? <a href={props.base}>{t("admin.first_page")}</a> : <span />}
      {props.next ? (
        <a href={`${props.base}${sep}${props.param ?? "after"}=${props.next}`} rel="next">
          {t("admin.next_page")}
        </a>
      ) : null}
    </nav>
  );
}

/** 部分一致の検索を RLS の外で行う関数（admin_search_ids）と、発行したクーポンの数（coupon_grant_counts）の版 */
export const ADMIN_SEARCH_MIGRATION = "0059_admin_lists";

/**
 * 部分一致の検索（名前・メールなど）のあるときの 1 ページ: admin_search_ids で id を探し（権限は関数が 1 回確かめる、
 * pg_trgm のインデックスが効く）、行そのものは RLS 越しに読む。0059 より前の DB なら null（呼び出し側が PostgREST の ilike で読む）。
 * RLS の掛かった表では ilike がインデックスを使えず全件を見るため（docs/knowledge/02-decisions.md 2026-10-26）
 */
export async function searchRows<T extends { id: string; created_at: string }>(
  c: AdminContext,
  opts: { kind: "products" | "orders" | "customers"; shopId: string; q: string; filters: Record<string, string>; after?: PagePosition; limit: number; columns: string },
): Promise<T[] | null> {
  const { db } = owner(c);
  if (!(await migrated({ db, cache: c.get("adapters").cache }, ADMIN_SEARCH_MIGRATION))) return null;
  const rows: T[] = [];
  for (let after = opts.after; rows.length < opts.limit; ) {
    const n = Math.min(1000, opts.limit - rows.length);
    const ids = await db.rpc<string[]>("admin_search_ids", { p_shop_id: opts.shopId, p_kind: opts.kind, p_q: opts.q, p_filters: opts.filters, p_after_k: after?.k ?? null, p_after_id: after?.id ?? null, p_limit: n });
    if (ids.length === 0) break;
    const page = await selectIn<T>(db, opts.kind, opts.columns, opts.shopId, "id", ids);
    const order = new Map(ids.map((id, i) => [id, i]));
    page.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    rows.push(...page);
    if (ids.length < n) break;
    const last = page[page.length - 1];
    if (!last) break;
    after = { k: last.created_at, id: last.id };
  }
  return rows;
}
