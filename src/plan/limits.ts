/**
 * プランの上限（0052_plan_limits、docs/knowledge/02-decisions.md 2026-10-23）。
 * 判定は DB（文単位の AFTER INSERT トリガー）。Worker は「超えた」の印（例外 'plan_limit_exceeded:<種類>:<上限>'）を
 * 文言と API のエラーに直すだけ。上限は service_role か直接の SQL でしか書けないので、ここに書き込みは無い。
 */

/** mail_per_day（0053）: 会員のログインのコードと組織への招待の 1 日（UTC）の数。送り手を共有する構成で評判を守るふた */
/** theme_versions（0073）: Liquid のテーマの版の数（この Banto 全体。0 なら Liquid のテーマを取り込めない） */
/** pages（0079）: ショップのページ（同梱モジュール pages）の数（この Banto 全体） */
export const PLAN_LIMIT_KINDS = ["shops", "products", "customers", "members", "mail_per_day", "theme_versions", "pages"] as const;
export type PlanLimitKind = (typeof PLAN_LIMIT_KINDS)[number];

export interface PlanLimitHit {
  kind: PlanLimitKind;
  limit: number;
}

export interface PlanUsage {
  limits: Partial<Record<PlanLimitKind, number>>;
  usage: Record<PlanLimitKind, number>;
}

const RE = /plan_limit_exceeded:(shops|products|customers|members|mail_per_day|theme_versions|pages):(\d+)/;

/** DB のエラーメッセージから「どの上限に当たったか」。当たっていなければ null */
export function planLimitHit(message: string | undefined | null): PlanLimitHit | null {
  const m = message ? RE.exec(message) : null;
  if (!m) return null;
  return { kind: m[1] as PlanLimitKind, limit: Number(m[2]) };
}

/** エラーらしきものから message を取り出して判定する（DbError / PrivilegedRpcError / Error のどれでも） */
export function planLimitOf(e: unknown): PlanLimitHit | null {
  if (!e || typeof e !== "object") return null;
  const o = e as { dbMessage?: unknown; message?: unknown };
  return planLimitHit(typeof o.dbMessage === "string" ? o.dbMessage : typeof o.message === "string" ? o.message : null);
}
