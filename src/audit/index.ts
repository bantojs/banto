/**
 * 監査ログ（0051_audit_log、docs/knowledge/02-decisions.md 2026-10-23）。
 * 書くのは DB のトリガーだけ。Worker は「誰がやったか」を名乗る（特権経路）か、読む（管理画面）だけ。
 */

export const AUDIT_LOG_MIGRATION = "0051_audit_log";

/** 保持日数の既定（Cron の prune_audit_log。環境変数 AUDIT_LOG_KEEP_DAYS で変更、30 日より短くはならない） */
export const DEFAULT_AUDIT_KEEP_DAYS = 365;

export type AuditActorKind = "user" | "api_token" | "system";

export const AUDIT_ACTIONS = [
  "customer.email_changed",
  "customer.deleted",
  "order.status_changed",
  "org_member.added",
  "org_member.role_changed",
  "org_member.removed",
  "org_member.shop_perms",
  "org_member.store_perms",
  "api_token.issued",
  "api_token.revoked",
  "shop.domain_changed",
  "shop.stripe_account_changed",
  "shop.published_changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditRow {
  id: number;
  org_id: string;
  shop_id: string | null;
  actor_kind: AuditActorKind;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/**
 * Worker が service_role で動くときに名乗る値（PostgREST の request.headers 経由で banto_audit_actor() が読む）。
 * 利用者の JWT のリクエストでは DB 側が読まないので、管理画面の通常の操作には要らない。
 * 管理画面のキャンセル（返金 → cancel_order）のように、運営者の操作が特権経路を通るときだけ付ける。
 */
export const ACTOR_HEADER = "X-Banto-Actor";
export function actorHeader(kind: "user" | "api_token", id: string): string {
  return `${kind}:${id}`;
}

/** 環境変数の保持日数（数字でなければ既定） */
export function auditKeepDays(raw: string | undefined): number {
  return raw && /^\d{1,5}$/.test(raw) ? Number(raw) : DEFAULT_AUDIT_KEEP_DAYS;
}
