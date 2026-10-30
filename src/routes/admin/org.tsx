import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { AuthError } from "../../auth/supabase";
import { DbError } from "../../db/client";
import { planLimitOf } from "../../plan/limits";
import { createPrivilegedAuth, createPrivilegedDb, PrivilegedRpcError } from "../../db/privileged";
import { hashApiToken } from "../../api/tokens";
import { createMailer, MailError, sendMail } from "../../mail/send";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { randomToken } from "../../util/signed";
import { AdminLayout, Copyable, PageHead } from "./layout";
import { authClient, dbClient, formFields, owner, param, publicBaseUrl, sessionSecret, type AdminContext } from "./context";
import { adminLoginGuard, requireOwner, setSessionCookie, toSessionData } from "./auth";
import { myOrgs, PERM_TEMPLATES, requireOrgAdmin, SHOP_PERMS, isShopPerm, type OrgRole, type ShopPerm } from "./access";
import { migrated } from "../../db/migration-state";
import { THEMES_MIGRATION } from "../../themes/liquid";
import { PAGES_MIGRATION } from "../../pages";

/**
 * 組織の画面（0024_organizations、docs/knowledge/11-organizations.md）。組織の owner / admin だけ。
 *   GET  /admin/org                         メンバー・招待・組織の名前
 *   POST /admin/org/invite                  招待（Banto がその場でメールを送る。送れなければリンクを画面に一度だけ出す）
 *   GET  /admin/org/members/:userId         役割・ショップごとの項目
 *   POST /admin/org/members/:userId         〃 の保存 / remove=1 で外す
 *   POST /admin/org/invitations/:id/revoke
 *   POST /admin/org/rename
 * 招待の受け入れ（ログイン前でも開ける）:
 *   GET  /admin/invite?token=               招待の確認とパスワード
 *   POST /admin/invite                      初めての人はアカウントを作り、そのままログインして受け入れる
 * 判定の正は DB（org_* の関数）。ここは画面と入口の確認だけ。
 */
export const org = new Hono<AppEnv>();

const PERM_LABEL: Record<ShopPerm, MessageKey> = {
  catalog: "perm.catalog",
  orders: "perm.orders",
  orders_cancel: "perm.orders_cancel",
  customers: "perm.customers",
  marketing: "perm.marketing",
  reports: "perm.reports",
  stores: "perm.stores",
  settings: "perm.settings",
  integrations: "perm.integrations",
  support: "perm.support",
  design: "perm.design",
  content: "perm.content",
};
const ROLE_LABEL: Record<OrgRole, MessageKey> = {
  owner: "org.role.owner",
  admin: "org.role.admin",
  member: "org.role.member",
};
const TEMPLATE_LABEL: Record<string, MessageKey> = {
  shop_admin: "org.template.shop_admin",
  catalog: "org.template.catalog",
  fulfillment: "org.template.fulfillment",
  marketing: "org.template.marketing",
  stores: "org.template.stores",
  support: "org.template.support",
  design: "org.template.design",
  content: "org.template.content",
};
const isRole = (v: unknown): v is OrgRole => v === "owner" || v === "admin" || v === "member";

interface OrgShop {
  id: string;
  name: string;
}
type OrgStoreRef = OrgShop;
const STORE_PERMS = ["tryon", "hours"] as const;
const STORE_PERM_LABEL: Record<(typeof STORE_PERMS)[number], MessageKey> = {
  tryon: "store_perm.tryon",
  hours: "store_perm.hours",
};
const isStorePerm = (v: unknown): v is (typeof STORE_PERMS)[number] => v === "tryon" || v === "hours";
interface MemberRow {
  user_id: string;
  email: string;
  role: OrgRole;
  created_at: string;
  shops: { shop_id: string; perms: string[] }[];
  /** 0025 から */
  stores?: { store_id: string; perms: string[] }[];
}
interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  expires_at: string;
  created_at: string;
}

const ERRORS: Record<string, MessageKey> = {
  owner_only: "org.error.owner_only",
  last_owner: "org.error.last_owner",
  already_member: "org.error.already_member",
  invalid_email: "org.error.invalid_email",
  plan_limit: "plan.limit_mail",
  mfa_self_first: "org.mfa_self_first",
  forbidden: "access.forbidden",
  generic: "error.generic",
};

function dbErrorCode(e: unknown): string {
  if (!(e instanceof DbError)) throw e;
  const m = e.message;
  for (const k of ["owner_only", "last_owner", "already_member", "invalid_email"]) if (m.includes(k)) return k;
  if (planLimitOf(e)) return "plan_limit";
  return "generic";
}

/** 組織の実店舗 */
const orgStores = (c: AdminContext, orgId: string) => owner(c).db.from<OrgStoreRef>("stores").select("id,name", { eq: { org_id: orgId }, order: "sort_order.asc" });

/** 開いている組織（自分が owner / admin のもの）。?org= で選ぶ。無ければ最初の 1 つ */
async function currentOrg(c: AdminContext, wanted: string | undefined) {
  const orgs = (await myOrgs(c)).filter((o) => o.role === "owner" || o.role === "admin");
  return {
    orgs,
    org: orgs.find((o) => o.org_id === wanted) ?? orgs[0] ?? null,
  };
}

/** ショップごとの項目の入力（perm.<shop_id> の複数値、tpl.<shop_id> のひな形）を [{ shop_id, perms }] にする */
function readShopPerms(
  body: Record<string, string | File | (string | File)[]>,
  shops: OrgShop[],
  stores: OrgStoreRef[] = [],
  allowed: readonly ShopPerm[] = SHOP_PERMS,
): ({ shop_id: string; perms: ShopPerm[] } | { store_id: string; perms: string[] })[] {
  const out: ({ shop_id: string; perms: ShopPerm[] } | { store_id: string; perms: string[] })[] = [];
  for (const st of stores) {
    const raw = body[`sperm.${st.id}`];
    const perms = [...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(isStorePerm))];
    if (perms.length > 0) out.push({ store_id: st.id, perms });
  }
  for (const s of shops) {
    const tpl = body[`tpl.${s.id}`];
    const raw = body[`perm.${s.id}`];
    const picked = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(isShopPerm);
    const perms = (typeof tpl === "string" && PERM_TEMPLATES[tpl] ? [...PERM_TEMPLATES[tpl]!] : picked).filter((p) => allowed.includes(p));
    if (perms.length > 0) out.push({ shop_id: s.id, perms: [...new Set(perms)] });
  }
  return out;
}

/** design（テーマ、0071）・content（ページ、0079）は DB に入るまで出さない（入る前の DB は項目を知らず、0024 の検査で断る） */
async function shopPermsHere(c: AdminContext): Promise<readonly ShopPerm[]> {
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const [themes, pages] = await Promise.all([migrated(deps, THEMES_MIGRATION), migrated(deps, PAGES_MIGRATION)]);
  return SHOP_PERMS.filter((p) => (p !== "design" || themes) && (p !== "content" || pages));
}

function ShopPermsFields(props: { shops: OrgShop[]; stores?: OrgStoreRef[]; current?: { shop_id: string; perms: string[] }[]; currentStores?: { store_id: string; perms: string[] }[]; perms: readonly ShopPerm[] }) {
  return (
    <>
      {props.shops.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("nav.shops")}</th>
              <th>{t("org.template")}</th>
              <th>{t("org.perms")}</th>
            </tr>
          </thead>
          <tbody>
            {props.shops.map((s) => {
              const have = new Set(props.current?.find((x) => x.shop_id === s.id)?.perms ?? []);
              return (
                <tr>
                  <td>{s.name}</td>
                  <td>
                    <select name={`tpl.${s.id}`}>
                      <option value="">{t("org.template.custom")}</option>
                      {Object.keys(PERM_TEMPLATES).filter((k) => PERM_TEMPLATES[k]!.every((p) => props.perms.includes(p))).map((k) => (
                        <option value={k}>{t(TEMPLATE_LABEL[k]!)}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {props.perms.map((p) => (
                      <label style="display:inline-block;margin:0 .75rem 0 0">
                        <input type="checkbox" name={`perm.${s.id}`} value={p} checked={have.has(p)} /> {t(PERM_LABEL[p])}
                      </label>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {props.stores && props.stores.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("org.stores")}</th>
              <th>{t("org.perms")}</th>
            </tr>
          </thead>
          <tbody>
            {props.stores.map((st) => {
              const have = new Set(props.currentStores?.find((x) => x.store_id === st.id)?.perms ?? []);
              return (
                <tr>
                  <td>{st.name}</td>
                  <td>
                    {STORE_PERMS.map((p) => (
                      <label style="display:inline-block;margin:0 .75rem 0 0">
                        <input type="checkbox" name={`sperm.${st.id}`} value={p} checked={have.has(p)} /> {t(STORE_PERM_LABEL[p])}
                      </label>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function RoleSelect(props: { value: OrgRole; canOwner: boolean }) {
  return (
    <select name="role" id="role">
      {(["member", "admin", "owner"] as const)
        .filter((r) => r !== "owner" || props.canOwner || props.value === "owner")
        .map((r) => (
          <option value={r} selected={props.value === r}>
            {t(ROLE_LABEL[r])}
          </option>
        ))}
    </select>
  );
}

org.get("/org", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { orgs, org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const [members, invitations, shops, stores] = await Promise.all([
    db.rpc<MemberRow[]>("org_members_list", { p_org_id: o.org_id }),
    db.from<InvitationRow>("org_invitations").select("id,email,role,expires_at,created_at", {
      eq: { org_id: o.org_id, accepted_at: null },
      order: "created_at.desc",
    }),
    db.from<OrgShop>("shops").select("id,name", { eq: { org_id: o.org_id }, order: "created_at.asc" }),
    orgStores(c, o.org_id),
  ]);
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  // 運営者の二段階認証（0054）: 組織が必須か・メンバーごとの登録の有無
  const [mfaOrg, mfaRows] = await Promise.all([
    db.from<{ require_mfa: boolean }>("organizations").selectOne("require_mfa", { eq: { id: o.org_id } }),
    db.rpc<{ user_id: string; has_mfa: boolean }[]>("org_members_mfa", { p_org_id: o.org_id }),
  ]);
  const hasMfa = new Map(mfaRows.map((r) => [r.user_id, r.has_mfa]));
  const me = c.get("session")?.user_id;
  const flash = c.req.query("flash");
  const q = `?org=${o.org_id}`;
  return c.html(
    <AdminLayout title={t("org.title")} nav crumbs={[{ label: t("org.title") }]}>
      <h1>
        {t("org.title")}: {o.name}
      </h1>
      {orgs.length > 1 ? (
        <p>
          {orgs.map((x, i) => (
            <>
              {i > 0 ? " · " : ""}
              {x.org_id === o.org_id ? <strong>{x.name}</strong> : <a href={`/admin/org?org=${x.org_id}`}>{x.name}</a>}
            </>
          ))}
        </p>
      ) : null}
      <p>{t("org.intro")}</p>
      <p>
        <a href={`/admin/org/audit${q}`}>{t("audit.title")}</a>
      </p>
      {flash === "invited" ? <p class="notice">{t("org.invited")}</p> : null}
      {flash === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      {flash === "removed" ? <p class="notice">{t("org.removed")}</p> : null}
      {flash === "mfa_saved" ? <p class="notice">{t("org.mfa_saved")}</p> : null}
      {flash === "mfa_reset" ? <p class="notice">{t("org.mfa_reset_done")}</p> : null}
      {flash && ERRORS[flash] ? <p class="error">{t(ERRORS[flash]!)}</p> : null}

      <h2>{t("org.members")}</h2>
      <table>
        <thead>
          <tr>
            <th>{t("login.email")}</th>
            <th>{t("org.role")}</th>
            <th>{t("nav.shops")}</th>
            <th>{t("org.mfa")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr>
              <td>{m.email}</td>
              <td>{t(ROLE_LABEL[m.role])}</td>
              <td>
                {m.role === "member"
                  ? [
                      ...m.shops.map(
                        (s) =>
                          `${shopName.get(s.shop_id) ?? ""}（${s.perms
                            .filter(isShopPerm)
                            .map((p) => t(PERM_LABEL[p]))
                            .join("・")}）`,
                      ),
                      ...(m.stores ?? []).map(
                        (s) =>
                          `${storeName.get(s.store_id) ?? ""}（${s.perms
                            .filter(isStorePerm)
                            .map((p) => t(STORE_PERM_LABEL[p]))
                            .join("・")}）`,
                      ),
                    ].join(" / ") || "-"
                  : t("org.all_shops")}
              </td>
              <td>
                {hasMfa.get(m.user_id) ? <span class="badge ok">{t("mfa.on")}</span> : "-"}
                {hasMfa.get(m.user_id) && m.user_id !== me && (m.role !== "owner" || o.role === "owner") ? (
                  <form method="post" action={`/admin/org/members/${m.user_id}/mfa-reset${q}`}>
                    <button type="submit">{t("org.mfa_reset")}</button>
                  </form>
                ) : null}
              </td>
              <td>
                <a href={`/admin/org/members/${m.user_id}${q}`}>{t("org.edit")}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t("org.mfa")}</h2>
      <p>{t("org.mfa_intro")}</p>
      <p>{mfaOrg?.require_mfa ? t("org.mfa_required") : t("org.mfa_optional")}</p>
      {o.role === "owner" ? (
        <form method="post" action={`/admin/org/mfa${q}`}>
          <input type="hidden" name="required" value={mfaOrg?.require_mfa ? "0" : "1"} />
          <button type="submit">{mfaOrg?.require_mfa ? t("org.mfa_require_off") : t("org.mfa_require_on")}</button>
        </form>
      ) : null}

      <h2>{t("org.invitations")}</h2>
      {invitations.length === 0 ? <p>{t("org.no_invitations")}</p> : null}
      {invitations.length > 0 ? (
        <table>
          <tbody>
            {invitations.map((i) => (
              <tr>
                <td>{i.email}</td>
                <td>{t(ROLE_LABEL[i.role])}</td>
                <td>
                  {t("tokens.expires")}: {formatDateTime(i.expires_at)}
                  {Date.parse(i.expires_at) < Date.now() ? <span class="badge ng">{t("org.expired")}</span> : null}
                </td>
                <td>
                  <form method="post" action={`/admin/org/invitations/${i.id}/revoke${q}`}>
                    <button type="submit">{t("org.revoke")}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h2>{t("org.invite")}</h2>
      <p>{t("org.invite_intro")}</p>
      <form method="post" action={`/admin/org/invite${q}`}>
        <label for="email">{t("login.email")}</label>
        <input id="email" type="email" name="email" required maxlength={254} />
        <label for="role">{t("org.role")}</label>
        <RoleSelect value="member" canOwner={o.role === "owner"} />
        <p>{t("org.role_help")}</p>
        <ShopPermsFields shops={shops} stores={stores} perms={await shopPermsHere(c)} />
        <p>
          <button type="submit">{t("org.invite_submit")}</button>
        </p>
      </form>

      <h2>{t("org.name")}</h2>
      <form method="post" action={`/admin/org/rename${q}`}>
        <input type="text" name="name" value={o.name} required maxlength={100} />
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
    </AdminLayout>,
  );
});

org.post("/org/invite", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db, session } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const back = `/admin/org?org=${o.org_id}`;
  const body = await c.req.parseBody({ all: true });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = isRole(body.role) ? body.role : "member";
  const [shops, stores] = await Promise.all([db.from<OrgShop>("shops").select("id,name", { eq: { org_id: o.org_id } }), orgStores(c, o.org_id)]);
  const token = randomToken(32);
  let mailFrom: string | null;
  try {
    const r = await db.rpc<{ id: string; mail_from: string | null }>("org_invite", {
      p_org_id: o.org_id,
      p_email: email,
      p_role: role,
      p_shops: role === "member" ? readShopPerms(body, shops, stores, await shopPermsHere(c)) : [],
      p_token_hash: await hashApiToken(token),
    });
    mailFrom = r.mail_from;
  } catch (e) {
    return c.redirect(`${back}&flash=${dbErrorCode(e)}`);
  }
  const link = `${publicBaseUrl(c)}/admin/invite?token=${encodeURIComponent(token)}`;
  const mailer = createMailer(c.get("adapters"), c.get("deps").fetch);
  if (mailFrom && mailer) {
    try {
      await sendMail(mailer, {
        from: mailFrom,
        to: email,
        subject: tf("org.mail.subject", { org: o.name }),
        text: tf("org.mail.body", {
          org: o.name,
          inviter: session.email ?? "",
          role: t(ROLE_LABEL[role]),
          link,
        }),
      });
      return c.redirect(`${back}&flash=invited`);
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
    }
  }
  // 送れないとき: 招待した人にリンクを一度だけ見せる（本人に別の手段で渡す。URL や履歴に残さない）
  return c.html(
    <AdminLayout title={t("org.invite")} nav>
      <PageHead title={t("org.invite")} />
      <p class="notice">{t("org.invited_nomail")}</p>
      <Copyable value={link} />
      <p>
        <a href={back}>{t("org.title")}</a>
      </p>
    </AdminLayout>,
  );
});

org.get("/org/members/:userId", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const userId = param(c, "userId");
  const [members, shops, stores] = await Promise.all([
    db.rpc<MemberRow[]>("org_members_list", { p_org_id: o.org_id }),
    db.from<OrgShop>("shops").select("id,name", {
      eq: { org_id: o.org_id },
      order: "created_at.asc",
    }),
    orgStores(c, o.org_id),
  ]);
  const m = members.find((x) => x.user_id === userId);
  if (!m) return c.text(t("shop.not_found"), 404);
  const q = `?org=${o.org_id}`;
  return c.html(
    <AdminLayout title={`${m.email} · ${t("org.title")}`} nav crumbs={[{ label: t("org.title"), href: `/admin/org${q}` }, { label: m.email }]}>
      <PageHead title={m.email} />
      <form method="post" action={`/admin/org/members/${m.user_id}${q}`}>
        <label for="role">{t("org.role")}</label>
        <RoleSelect value={m.role} canOwner={o.role === "owner"} />
        <p>{t("org.role_help")}</p>
        <ShopPermsFields shops={shops} stores={stores} current={m.shops} currentStores={m.stores} perms={await shopPermsHere(c)} />
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      <h2>{t("org.remove")}</h2>
      <form method="post" action={`/admin/org/members/${m.user_id}${q}`}>
        <input type="hidden" name="remove" value="1" />
        <button type="submit">{t("org.remove")}</button>
      </form>
    </AdminLayout>,
  );
});

org.post("/org/members/:userId", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const back = `/admin/org?org=${o.org_id}`;
  const userId = param(c, "userId");
  const body = await c.req.parseBody({ all: true });
  try {
    if (body.remove === "1") {
      await db.rpc("org_member_remove", {
        p_org_id: o.org_id,
        p_user_id: userId,
      });
      return c.redirect(`${back}&flash=removed`);
    }
    const role = isRole(body.role) ? body.role : "member";
    const [shops, stores] = await Promise.all([db.from<OrgShop>("shops").select("id,name", { eq: { org_id: o.org_id } }), orgStores(c, o.org_id)]);
    await db.rpc("org_member_set", {
      p_org_id: o.org_id,
      p_user_id: userId,
      p_role: role,
      p_shops: role === "member" ? readShopPerms(body, shops, stores, await shopPermsHere(c)) : [],
    });
    return c.redirect(`${back}&flash=saved`);
  } catch (e) {
    return c.redirect(`${back}&flash=${dbErrorCode(e)}`);
  }
});

// 運営者の二段階認証（0054）: 全員必須にする / やめる（owner。必須にするのは自分が 6 桁を済ませたセッションだけ = DB が確かめる）
org.post("/org/mfa", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o || o.role !== "owner") return c.redirect("/admin?flash=forbidden");
  const required = (await formFields(c)).required === "1";
  try {
    await db.rpc("org_set_require_mfa", { p_org_id: o.org_id, p_required: required });
  } catch (e) {
    if (e instanceof DbError && e.message.includes("mfa_self_first")) return c.redirect(`/admin/org?org=${o.org_id}&flash=mfa_self_first`);
    return c.redirect(`/admin/org?org=${o.org_id}&flash=${dbErrorCode(e)}`);
  }
  return c.redirect(`/admin/org?org=${o.org_id}&flash=mfa_saved`);
});

// 認証アプリをなくしたメンバーの登録を外す: DB で許可を確かめて監査ログに書き（org_member_mfa_reset_authorize）、GoTrue の Admin API で消す
org.post("/org/members/:userId/mfa-reset", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const userId = param(c, "userId");
  try {
    await db.rpc("org_member_mfa_reset_authorize", { p_user_id: userId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/org?org=${o.org_id}&flash=forbidden`);
    throw e;
  }
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.redirect(`/admin/org?org=${o.org_id}&flash=generic`);
  await createPrivilegedAuth({ url, serviceRoleKey, fetch: c.get("deps").fetch }).deleteAllFactors(userId);
  return c.redirect(`/admin/org?org=${o.org_id}&flash=mfa_reset`);
});

org.post("/org/invitations/:id/revoke", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const back = `/admin/org?org=${o.org_id}`;
  try {
    await db.rpc("org_invitation_revoke", {
      p_org_id: o.org_id,
      p_invitation_id: param(c, "id"),
    });
  } catch (e) {
    return c.redirect(`${back}&flash=${dbErrorCode(e)}`);
  }
  return c.redirect(`${back}&flash=saved`);
});

org.post("/org/rename", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const { org: o } = await currentOrg(c, c.req.query("org"));
  if (!o) return c.redirect("/admin?flash=forbidden");
  const name = ((await formFields(c)).name ?? "").trim();
  const back = `/admin/org?org=${o.org_id}`;
  if (!name || name.length > 100) return c.redirect(`${back}&flash=generic`);
  await db.from("organizations").update({ name }, { id: o.org_id });
  return c.redirect(`${back}&flash=saved`);
});

// ---------- 招待の受け入れ ----------

interface Peek {
  email: string;
  org_name: string;
  role: string;
  valid: boolean;
  user_exists: boolean;
}

async function peek(c: AdminContext, token: string): Promise<Peek | null> {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey || !token || token.length > 100) return null;
  try {
    return await createPrivilegedDb({
      url,
      serviceRoleKey,
      fetch: c.get("deps").fetch,
    }).orgInvitationPeek(await hashApiToken(token));
  } catch (e) {
    if (e instanceof PrivilegedRpcError) return null;
    throw e;
  }
}

function InvitePage(props: { token: string; p: Peek | null; error?: MessageKey }) {
  const p = props.p;
  return (
    <AdminLayout title={t("org.accept_title")}>
      <PageHead title={t("org.accept_title")} />
      {!p || !p.valid ? (
        <p class="error">{t("org.invitation_invalid")}</p>
      ) : (
        <>
          <p>{tf("org.accept_intro", { org: p.org_name, email: p.email })}</p>
          {props.error ? <p class="error">{t(props.error)}</p> : null}
          <form method="post" action="/admin/invite">
            <input type="hidden" name="token" value={props.token} />
            <label for="password">{p.user_exists ? t("login.password") : t("org.accept_new_password")}</label>
            <input id="password" type="password" name="password" required minlength={p.user_exists ? undefined : 8} autocomplete={p.user_exists ? "current-password" : "new-password"} />
            <p>
              <button type="submit">{t("org.accept_submit")}</button>
            </p>
          </form>
        </>
      )}
    </AdminLayout>
  );
}

org.get("/invite", async (c: AdminContext) => {
  const token = c.req.query("token") ?? "";
  return c.html(<InvitePage token={token} p={await peek(c, token)} />);
});

org.post("/invite", async (c: AdminContext) => {
  const f = await formFields(c);
  const token = f.token ?? "";
  const password = f.password ?? "";
  const p = await peek(c, token);
  if (!p || !p.valid) return c.html(<InvitePage token={token} p={p} />, 400);
  const auth = authClient(c);
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!auth || !url || !serviceRoleKey || !sessionSecret(c)) return c.html(<InvitePage token={token} p={p} error="error.generic" />, 500);
  if (!p.user_exists) {
    if (password.length < 8) return c.html(<InvitePage token={token} p={p} error="org.error.password_short" />, 400);
    try {
      // 招待のリンクはそのアドレスに届いたもの = アドレスの確認の代わり。確認済みのユーザーとして作る
      await createPrivilegedAuth({
        url,
        serviceRoleKey,
        fetch: c.get("deps").fetch,
      }).createConfirmedUser(p.email, password);
    } catch (e) {
      if (!(e instanceof AuthError && e.code === "email_exists")) throw e;
    }
  }
  const guard = await adminLoginGuard(c, p.email);
  if (!guard.allowed) return c.html(<InvitePage token={token} p={p} error="login.locked" />, 429);
  let session;
  try {
    session = toSessionData(await auth.signInWithPassword(p.email, password));
    await guard.record(true);
  } catch (e) {
    if (e instanceof AuthError) {
      await guard.record(false);
      return c.html(<InvitePage token={token} p={p} error="login.failed" />, 400);
    }
    throw e;
  }
  const db = dbClient(c, session.access_token);
  if (!db) return c.html(<InvitePage token={token} p={p} error="error.generic" />, 500);
  try {
    await db.rpc("org_invitation_accept", {
      p_token_hash: await hashApiToken(token),
    });
  } catch (e) {
    if (e instanceof DbError && planLimitOf(e)) return c.html(<InvitePage token={token} p={p} error="plan.limit_members" />, 409);
    if (e instanceof DbError) return c.html(<InvitePage token={token} p={null} />, 400);
    throw e;
  }
  await setSessionCookie(c, session);
  return c.redirect("/admin");
});
