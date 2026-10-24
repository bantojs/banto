import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { AUDIT_LOG_MIGRATION, auditKeepDays, type AuditRow } from "../../audit";
import { migrated } from "../../db/migration-state";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout } from "./layout";
import { owner, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { myOrgs, requireOrgAdmin } from "./access";

/**
 * 監査ログ（0051_audit_log、docs/knowledge/02-decisions.md 2026-10-23）。
 *   GET /admin/org/audit?org=&page=   組織の owner / admin だけ。読み取り専用、100 件ずつ
 * 書くのは DB のトリガーだけ。この画面は読むだけで、消す・直す操作は無い（保持は Cron の prune_audit_log）。
 */
export const audit = new Hono<AppEnv>();

const PAGE = 100;

const ACTION_LABEL: Record<string, MessageKey> = {
  "customer.email_changed": "audit.action.customer.email_changed",
  "customer.deleted": "audit.action.customer.deleted",
  "order.status_changed": "audit.action.order.status_changed",
  "org_member.added": "audit.action.org_member.added",
  "org_member.role_changed": "audit.action.org_member.role_changed",
  "org_member.removed": "audit.action.org_member.removed",
  "org_member.shop_perms": "audit.action.org_member.shop_perms",
  "org_member.store_perms": "audit.action.org_member.store_perms",
  "api_token.issued": "audit.action.api_token.issued",
  "api_token.revoked": "audit.action.api_token.revoked",
  "shop.domain_changed": "audit.action.shop.domain_changed",
  "shop.stripe_account_changed": "audit.action.shop.stripe_account_changed",
  "shop.published_changed": "audit.action.shop.published_changed",
};

const STATUS_LABEL: Record<string, MessageKey> = {
  paid: "order.status.paid",
  shipped: "order.status.shipped",
  cancelled: "order.status.cancelled",
  refunded: "order.status.refunded",
};

interface MemberRef {
  user_id: string;
  email: string;
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "");
const str = (v: unknown) => (v == null ? t("audit.none") : typeof v === "string" ? v : Array.isArray(v) ? (v.length ? v.map(String).join("・") : t("audit.none")) : String(v));
const status = (v: unknown) => (typeof v === "string" && STATUS_LABEL[v] ? t(STATUS_LABEL[v]) : str(v));

/** 出来事の 1 行の説明（個人情報は detail に入っていないので、そのまま出せる） */
function describe(r: AuditRow): string {
  const d = r.detail ?? {};
  const label = ACTION_LABEL[r.action] ? t(ACTION_LABEL[r.action]!) : r.action;
  switch (r.action) {
    case "customer.email_changed":
      return `${label}（${short(String(d["old_email_hash"] ?? "")) || t("audit.none")} → ${short(String(d["new_email_hash"] ?? "")) || t("audit.none")}）`;
    case "order.status_changed":
      return `${label}: ${status(d["from"])} → ${status(d["to"])}`;
    case "org_member.added":
    case "org_member.removed":
      return `${label}（${str(d["role"])}）`;
    case "org_member.role_changed":
    case "org_member.shop_perms":
    case "shop.domain_changed":
    case "shop.stripe_account_changed":
      return `${label}: ${str(d["from"])} → ${str(d["to"])}`;
    case "org_member.store_perms":
      return `${label}（${short(String(d["store_id"] ?? ""))}）: ${str(d["from"])} → ${str(d["to"])}`;
    case "api_token.issued":
      return `${label}: ${str(d["name"])}（${str(d["prefix"])}…、${str(d["scopes"])}）`;
    case "api_token.revoked":
      return `${label}: ${str(d["name"])}`;
    case "shop.published_changed":
      return `${label}: ${d["published"] === true ? t("audit.published.on") : t("audit.published.off")}`;
    case "customer.deleted":
      return label;
    default:
      return `${label} ${JSON.stringify(d)}`;
  }
}

function target(r: AuditRow, members: Map<string, string>, shops: Map<string, string>): string {
  switch (r.target_type) {
    case "order":
      return `#${str(r.detail?.["number"])}`;
    case "user":
      return members.get(r.target_id ?? "") ?? `${t("audit.actor.user_gone")} ${short(r.target_id)}`;
    case "shop":
      return shops.get(r.target_id ?? "") ?? short(r.target_id);
    case "api_token":
      return str(r.detail?.["name"]);
    default:
      return short(r.target_id);
  }
}

function actor(r: AuditRow, members: Map<string, string>): string {
  if (r.actor_kind === "user") return members.get(r.actor_id ?? "") ?? `${t("audit.actor.user_gone")} ${short(r.actor_id)}`;
  if (r.actor_kind === "api_token") return `${t("audit.actor.api_token")} ${short(r.actor_id)}`;
  return t("audit.actor.system");
}

audit.get("/org/audit", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const orgs = (await myOrgs(c)).filter((o) => o.role === "owner" || o.role === "admin");
  const wanted = c.req.query("org");
  const o = orgs.find((x) => x.org_id === wanted) ?? orgs[0] ?? null;
  if (!o) return c.redirect("/admin?flash=forbidden");
  const ready = await migrated({ db, cache: c.get("adapters").cache }, AUDIT_LOG_MIGRATION);
  const pageRaw = c.req.query("page");
  const page = pageRaw && /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1;
  const q = `?org=${o.org_id}`;
  const keepDays = auditKeepDays(c.get("adapters").config.get("AUDIT_LOG_KEEP_DAYS"));

  const [rows, memberRows, shopRows] = ready
    ? await Promise.all([
        db.from<AuditRow>("audit_log").select("id,org_id,shop_id,actor_kind,actor_id,action,target_type,target_id,detail,created_at", {
          eq: { org_id: o.org_id },
          order: "id.desc",
          limit: PAGE,
          offset: (page - 1) * PAGE,
        }),
        db.rpc<MemberRef[]>("org_members_list", { p_org_id: o.org_id }),
        db.from<{ id: string; name: string }>("shops").select("id,name", { eq: { org_id: o.org_id } }),
      ])
    : [[], [], []];
  const members = new Map((memberRows ?? []).map((m) => [m.user_id, m.email]));
  const shops = new Map(shopRows.map((s) => [s.id, s.name]));

  return c.html(
    <AdminLayout title={t("audit.title")} nav crumbs={[{ label: t("org.title"), href: `/admin/org${q}` }, { label: t("audit.title") }]}>
      <h1>
        {t("audit.title")}: {o.name}
      </h1>
      <p>{t("audit.intro")}</p>
      {!ready ? (
        <p class="notice">
          {t("audit.needs_update")} <a href="/admin/update">{t("update.title")}</a>
        </p>
      ) : (
        <>
          <p>{tf("audit.keep", { days: keepDays })}</p>
          {rows.length === 0 ? <p>{t("audit.empty")}</p> : null}
          {rows.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>{t("audit.when")}</th>
                  <th>{t("audit.who")}</th>
                  <th>{t("audit.what")}</th>
                  <th>{t("audit.target")}</th>
                  <th>{t("audit.shop")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>{formatDateTime(r.created_at)}</td>
                    <td>{actor(r, members)}</td>
                    <td>{describe(r)}</td>
                    <td>{target(r, members, shops)}</td>
                    <td>{r.shop_id ? (shops.get(r.shop_id) ?? short(r.shop_id)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p>
            {page > 1 ? <a href={`/admin/org/audit${q}&page=${page - 1}`}>{t("audit.newer")}</a> : null}
            {page > 1 && rows.length === PAGE ? " · " : ""}
            {rows.length === PAGE ? <a href={`/admin/org/audit${q}&page=${page + 1}`}>{t("audit.older")}</a> : null}
          </p>
        </>
      )}
    </AdminLayout>,
  );
});
