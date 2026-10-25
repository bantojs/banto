import { Hono } from "hono";
import { csvCell } from "../../util/csv";
import type { AppEnv } from "../../app";
import { t } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "./layout";
import { owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { can } from "./access";
import { DbError } from "../../db/client";
import { tf } from "../../i18n";
import { createMailer, sendMail } from "../../mail/send";
import { migrated } from "../../db/migration-state";
import { moduleEnabled } from "../../modules/registry";
import { PASSKEY_MIGRATION, PASSKEY_MODULE } from "../../modules/passkey";
import { CUSTOMER_ATTRIBUTES_ADMIN_MIGRATION, CUSTOMER_MASTER_MIGRATION, MARKETING_CONSENT_MIGRATION, attributeRows, attributesFromForm, customerFields, externalRef, matchesAttribute, type CustomerField } from "../../customers/fields";

/**
 * 会員一覧・削除（退会依頼への対応）・メールアドレスの変更（メールを失った会員の救済）。/admin/shops/:shopId/customers
 * 会員はパスワードを持たずメールのコードで入るので、アドレスを変えられる運営者の操作は乗っ取りの入り口にもなる。
 * 変更は member_set_email（0012、所有を確かめ、世代を上げて全端末をログアウト）だけで行い、前後のアドレスに知らせる。
 * パスキー（同梱モジュール passkey、0046）は世代では消えないので、乗っ取られた会員の救済には「パスキーを全部消す」も使う。
 */
export const customers = new Hono<AppEnv>();

interface CustomerRow {
  id: string;
  email: string | null;
  name: string | null;
  default_address: Record<string, unknown> | null;
  created_at: string;
  last_login_at?: string | null;
  /** 0047。外部の顧客マスタでの ID と独自項目の値（適用前の DB では選ばない） */
  external_ref?: Record<string, unknown> | null;
  attributes?: Record<string, unknown> | null;
  /** 0050。案内メールの同意（null = 未回答）。適用前の DB では選ばない */
  marketing_consent?: boolean | null;
  marketing_consent_at?: string | null;
  marketing_consent_source?: string | null;
}

/**
 * 一覧と CSV で共通: 最新 500 件を読み、メール・氏名の部分一致（q）と独自項目 1 つの値の部分一致（f / v）で絞る。
 * 独自項目・外部の ID の列は 0047 が当たっているときだけ選ぶ
 */
async function listCustomers(c: AdminContext, shopId: string, settings: Record<string, unknown>) {
  const { db } = owner(c);
  const master = await migrated({ db, cache: c.get("adapters").cache }, CUSTOMER_MASTER_MIGRATION);
  const consentOn = master && (await migrated({ db, cache: c.get("adapters").cache }, MARKETING_CONSENT_MIGRATION));
  const fields: CustomerField[] = master ? customerFields(settings) : [];
  const columns = ["id,email,name,default_address,created_at,last_login_at", ...(master ? ["external_ref,attributes"] : []), ...(consentOn ? ["marketing_consent,marketing_consent_at,marketing_consent_source"] : [])].join(",");
  const all = await db.from<CustomerRow>("customers").select(columns, { eq: { shop_id: shopId }, order: "created_at.desc", limit: 500 });
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const f = (c.req.query("f") ?? "").trim();
  const v = (c.req.query("v") ?? "").trim();
  // 案内メールの同意で絞る（0050）: yes / no / none（未回答）
  const consent = consentOn ? (c.req.query("consent") ?? "").trim() : "";
  const consentMatch = (r: CustomerRow) => (consent === "yes" ? r.marketing_consent === true : consent === "no" ? r.marketing_consent === false : consent === "none" ? r.marketing_consent === null || r.marketing_consent === undefined : true);
  const rows = all.filter((r) => (!q || `${r.email ?? ""} ${r.name ?? ""}`.toLowerCase().includes(q)) && (!f || matchesAttribute(fields, r.attributes, f, v)) && consentMatch(r));
  return { master, consentOn, fields, all, rows, q, f, v, consent };
}

const consentLabel = (v: boolean | null | undefined) => t(v === true ? "customers.consent_yes" : v === false ? "customers.consent_no" : "customers.consent_none");


customers.get("/:shopId/customers", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { master, consentOn, fields, all, rows, q, f, v, consent } = await listCustomers(c, shopId, shop.settings ?? {});
  const editable = master && fields.length > 0 && (await migrated({ db, cache: c.get("adapters").cache }, CUSTOMER_ATTRIBUTES_ADMIN_MIGRATION));
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(f ? { f, v } : {}), ...(consent ? { consent } : {}) }).toString();
  const passkeys = moduleEnabled(shop.settings, PASSKEY_MODULE) && (await migrated({ db, cache: c.get("adapters").cache }, PASSKEY_MIGRATION));
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("customers.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("customers.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "customers" }}>
      <PageHead title={t("customers.title")} />
      {c.req.query("flash") === "deleted" ? <p class="notice">{t("customers.deleted")}</p> : null}
      {c.req.query("flash") === "email_changed" ? <p class="notice">{t("customers.email_changed")}</p> : null}
      {c.req.query("flash") === "passkeys_reset" ? <p class="notice">{t("passkey.admin_reset_done")}</p> : null}
      {c.req.query("flash") === "attributes_saved" ? <p class="notice">{t("customers.attributes_saved")}</p> : null}
      {c.req.query("flash") === "consent_withdrawn" ? <p class="notice">{t("customers.consent_withdrawn")}</p> : null}
      {c.req.query("error") === "attributes_invalid" ? <p class="error">{t("customers.attributes_invalid")}</p> : null}
      {c.req.query("error") === "email_taken" ? <p class="error">{t("customers.email_taken")}</p> : null}
      {c.req.query("error") === "email_invalid" ? <p class="error">{t("customers.email_invalid")}</p> : null}
      {!(shop.settings ?? {})["members_enabled"] ? (
        <div class="notice">
          <p>
            {t("shop.members_where")} <a href={`/admin/shops/${shop.id}#members`}>{t("shop.members_open_settings")}</a>
          </p>
          <p class="muted">{t("shop.members_hint")}</p>
        </div>
      ) : null}
      {all.length === 0 ? (
        <div class="empty">
          <p>{t("customers.none")}</p>
        </div>
      ) : (
        <>
          <form method="get" class="toolbar">
            <input type="search" name="q" value={q} placeholder={t("customers.search_placeholder")} aria-label={t("order.search")} />
            {fields.length > 0 ? (
              <>
                <select name="f" aria-label={t("customers.filter_field")}>
                  <option value="">{t("customers.filter_any")}</option>
                  {fields.map((fd) => (
                    <option value={fd.key} selected={fd.key === f}>
                      {fd.label}
                    </option>
                  ))}
                </select>
                <input type="search" name="v" value={v} placeholder={t("customers.filter_value")} aria-label={t("customers.filter_value")} />
              </>
            ) : null}
            {consentOn ? (
              <select name="consent" aria-label={t("customers.consent_filter")}>
                <option value="">{t("customers.consent_filter")}</option>
                <option value="yes" selected={consent === "yes"}>
                  {t("customers.consent_yes")}
                </option>
                <option value="no" selected={consent === "no"}>
                  {t("customers.consent_no")}
                </option>
                <option value="none" selected={consent === "none"}>
                  {t("customers.consent_none")}
                </option>
              </select>
            ) : null}
            <button type="submit" class="secondary small">
              {t("order.search")}
            </button>
            <span class="count">{tf("product.count", { n: rows.length, total: all.length })}</span>
            <a class="btn secondary small" href={`/admin/shops/${shop.id}/customers.csv${query ? `?${query}` : ""}`}>
              {t("customers.csv")}
            </a>
          </form>
          <p class="muted">{t("customers.change_email_hint")}</p>
          <table>
            <thead>
              <tr>
                <th>{t("login.email")}</th>
                <th>{t("store.address_name")}</th>
                <th>{t("store.address_state")}</th>
                {master ? <th>{t("customers.attributes")}</th> : null}
                {consentOn ? <th>{t("customers.consent")}</th> : null}
                <th>{t("order.date")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>{r.email ?? "-"}</td>
                  <td>{r.name ?? "-"}</td>
                  <td>{typeof r.default_address?.["state"] === "string" ? String(r.default_address["state"]) : "-"}</td>
                  {master ? (
                    <td>
                      {attributeRows(fields, r.attributes).map((a) => (
                        <span class="muted" style="display:block">
                          {a.label}: {a.value}
                        </span>
                      ))}
                      {externalRef(r.external_ref) ? (
                        <span class="muted" style="display:block">
                          {t("customers.external_ref")}: {externalRef(r.external_ref)!.provider} / {externalRef(r.external_ref)!.id}
                        </span>
                      ) : null}
                      {attributeRows(fields, r.attributes).length === 0 && !externalRef(r.external_ref) ? "-" : null}
                    </td>
                  ) : null}
                  {consentOn ? <td>{consentLabel(r.marketing_consent)}</td> : null}
                  <td>{formatDateTime(r.created_at, { dateOnly: true })}</td>
                  <td>
                    <details>
                      <summary>{t("customers.actions")}</summary>
                      {editable ? (
                        <form method="post" action={`/admin/shops/${shop.id}/customers/${r.id}/attributes${query ? `?${query}` : ""}`}>
                          {fields.map((fd) => {
                            const cur = r.attributes && typeof r.attributes === "object" ? r.attributes[fd.key] : undefined;
                            const val = typeof cur === "string" || typeof cur === "number" ? String(cur) : "";
                            return (
                              <label style="display:block">
                                {fd.label}
                                {fd.type === "select" ? (
                                  <select name={`attr_${fd.key}`}>
                                    <option value="">-</option>
                                    {(fd.options ?? []).map((o) => (
                                      <option value={o} selected={o === val}>
                                        {o}
                                      </option>
                                    ))}
                                  </select>
                                ) : fd.type === "textarea" ? (
                                  <textarea name={`attr_${fd.key}`} rows={2}>{val}</textarea>
                                ) : (
                                  <input type={fd.type === "number" ? "number" : fd.type === "url" ? "url" : "text"} step={fd.type === "number" ? "any" : undefined} name={`attr_${fd.key}`} value={val} />
                                )}
                              </label>
                            );
                          })}
                          <p class="muted">{t("customers.attributes_hint")}</p>
                          <button type="submit" class="secondary small">
                            {t("customers.edit_attributes")}
                          </button>
                        </form>
                      ) : null}
                      <form method="post" action={`/admin/shops/${shop.id}/customers/${r.id}/email`} class="toolbar">
                        <input type="email" name="email" required aria-label={t("customers.change_email")} placeholder={t("customers.change_email")} />
                        <button type="submit" class="secondary small">
                          {t("customers.change_email")}
                        </button>
                      </form>
                      {consentOn && r.marketing_consent === true ? (
                        <form method="post" action={`/admin/shops/${shop.id}/customers/${r.id}/consent/withdraw${query ? `?${query}` : ""}`}>
                          <button type="submit" class="secondary small">
                            {t("customers.consent_withdraw")}
                          </button>
                        </form>
                      ) : null}
                      {passkeys && can(c.get("shopAccess"), "admin") ? (
                        <form method="post" action={`/admin/shops/${shop.id}/customers/${r.id}/passkeys/reset`} onsubmit={`return confirm(${JSON.stringify(t("passkey.admin_reset_confirm"))})`}>
                          <button type="submit" class="secondary small">
                            {t("passkey.admin_reset")}
                          </button>
                        </form>
                      ) : null}
                      <form method="post" action={`/admin/shops/${shop.id}/customers/${r.id}/delete`}>
                        <button type="submit" class="small">
                          {t("customers.delete")}
                        </button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </AdminLayout>,
  );
});

/** CSV（一覧と同じ絞り込み）。独自項目は定義の順に 1 列ずつ。外部の ID は provider と id の 2 列 */
customers.get("/:shopId/customers.csv", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { master, consentOn, fields, rows } = await listCustomers(c, shopId, shop.settings ?? {});
  const header = ["id", "email", "name", "phone", "postal_code", "state", "city", "line1", "line2", "created_at", "last_login_at", ...(consentOn ? ["marketing_consent", "marketing_consent_at", "marketing_consent_source"] : []), ...(master ? ["external_provider", "external_id", ...fields.map((f) => f.key)] : [])];
  const lines = rows.map((r) => {
    const a = (r.default_address ?? {}) as Record<string, unknown>;
    const ref = externalRef(r.external_ref);
    const attrs = r.attributes && typeof r.attributes === "object" ? r.attributes : {};
    const consentCols = consentOn ? [r.marketing_consent === true ? "yes" : r.marketing_consent === false ? "no" : "", r.marketing_consent_at ? formatDateTime(r.marketing_consent_at) : "", r.marketing_consent_source ?? ""] : [];
    return [r.id, r.email, r.name, a["phone"], a["postal_code"], a["state"], a["city"], a["line1"], a["line2"], formatDateTime(r.created_at), r.last_login_at ? formatDateTime(r.last_login_at) : "", ...consentCols, ...(master ? [ref?.provider ?? "", ref?.id ?? "", ...fields.map((f) => attrs[f.key] ?? "")] : [])].map(csvCell).join(",");
  });
  const body = "\ufeff" + [header.join(","), ...lines].join("\r\n") + "\r\n";
  return c.body(body, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="customers-${shop.slug}.csv"`, "Cache-Control": "no-store" });
});

/** 独自項目を直す（0048 の customer_set_attributes。定義に無い鍵・型に合わない値は DB が断る） */
customers.post("/:shopId/customers/:customerId/attributes", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const back = `/admin/shops/${shopId}/customers${c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""}`;
  const sep = back.includes("?") ? "&" : "?";
  const body = await c.req.parseBody();
  const form: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(body)) if (typeof val === "string") form[k] = val;
  const values = attributesFromForm(customerFields(shop.settings), form);
  try {
    await db.rpc("customer_set_attributes", { p_shop_id: shopId, p_customer_id: param(c, "customerId"), p_values: values });
  } catch (e) {
    if (e instanceof DbError && /invalid_attribute/.test(e.message)) return c.redirect(`${back}${sep}error=attributes_invalid`);
    if (e instanceof DbError && /customer_not_found/.test(e.message)) return c.redirect(`${back}${sep}flash=deleted`);
    throw e;
  }
  return c.redirect(`${back}${sep}flash=attributes_saved`);
});

/** 案内メールの同意を外す（0050）。付けることはできない（本人の行為） */
customers.post("/:shopId/customers/:customerId/consent/withdraw", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const back = `/admin/shops/${shopId}/customers${c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""}`;
  const sep = back.includes("?") ? "&" : "?";
  await db.rpc("customer_marketing_consent_withdraw", { p_shop_id: shopId, p_customer_id: param(c, "customerId") });
  return c.redirect(`${back}${sep}flash=consent_withdrawn`);
});

customers.post("/:shopId/customers/:customerId/delete", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  if (!(await loadShop(c, shopId, "customers"))) return c.text(t("shop.not_found"), 404);
  await db.from("customers").delete({ shop_id: shopId, id: param(c, "customerId") });
  return c.redirect(`/admin/shops/${shopId}/customers?flash=deleted`);
});

customers.post("/:shopId/customers/:customerId/email", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const body = await c.req.parseBody();
  const email = typeof body["email"] === "string" ? body["email"] : "";
  let changed: { old_email: string | null; new_email: string };
  try {
    changed = await db.rpc("member_set_email", { p_shop_id: shopId, p_customer_id: param(c, "customerId"), p_email: email });
  } catch (e) {
    if (e instanceof DbError && /email_taken/.test(e.message)) return c.redirect(`/admin/shops/${shopId}/customers?error=email_taken`);
    if (e instanceof DbError && /invalid_email/.test(e.message)) return c.redirect(`/admin/shops/${shopId}/customers?error=email_invalid`);
    throw e;
  }
  // 前後のアドレスに知らせる（送れなくても変更は済んでいる。送信元はメール通知プラグインの設定）
  const [mail] = await db
    .from<{ settings: Record<string, unknown> }>("hook_endpoints")
    .select("settings", { eq: { shop_id: shopId, url: "https://banto.invalid/plugins/email_resend", enabled: true }, limit: 1 })
    .catch(() => []);
  const from = typeof mail?.settings["from"] === "string" ? mail.settings["from"].trim() : "";
  const mailer = createMailer(c.get("adapters"), c.get("deps").fetch);
  if (from && mailer) {
    const notice = { from, subject: tf("member.email_changed_subject", { shop: shop.name }), text: tf("member.email_changed_body", { shop: shop.name, new: changed.new_email }) };
    for (const to of new Set([changed.old_email, changed.new_email].filter((x): x is string => Boolean(x)))) {
      await sendMail(mailer, { ...notice, to }).catch(() => undefined);
    }
  }
  return c.redirect(`/admin/shops/${shopId}/customers?flash=email_changed`);
});

/** 会員のパスキーを全部消す（0046 の member_passkeys_reset。0055 からは owner / admin だけ。メールアドレスの変更と同じ線） */
customers.post("/:shopId/customers/:customerId/passkeys/reset", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  if (!(await migrated({ db, cache: c.get("adapters").cache }, PASSKEY_MIGRATION))) return c.redirect(`/admin/shops/${shopId}/customers`);
  await db.rpc("member_passkeys_reset", { p_shop_id: shopId, p_customer_id: param(c, "customerId") });
  return c.redirect(`/admin/shops/${shopId}/customers?flash=passkeys_reset`);
});
