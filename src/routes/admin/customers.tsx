import { Hono } from "hono";
import { csvCell } from "../../util/csv";
import type { AppEnv } from "../../app";
import { t } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";

/** CSV に入れる行の上限（一覧と同じ条件の新しい順）。それより多いときは条件で絞る。全件のバックアップは docs/backup.md */
const CSV_MAX_ROWS = 5000;
import { loadShop } from "./shops";
import { can } from "./access";
import { DbError, type Filter } from "../../db/client";
import { ADMIN_PAGE_SIZE, Pager, olderThan, readAfter, searchRows, splitPage, type PagePosition } from "./paging";
import { tf } from "../../i18n";
import { createMailer, sendMail } from "../../mail/send";
import { moduleEnabled } from "../../modules/registry";
import { PASSKEY_MODULE } from "../../modules/passkey";
import { FAVORITES_MODULE } from "../../modules/favorites";
import { attributeRows, attributesFromForm, customerFields, externalRef, type CustomerField } from "../../customers/fields";
import { SearchBar, readSort, searchChips, searchHref, type SearchParams } from "./search";
import { migrated } from "../../db/migration-state";
import { UUID_RE } from "../../util/cursor";
import { yen } from "../common";
import type { MessageKey } from "../../i18n";
import { VIEWS_MIGRATION, ViewTabs, viewsOf } from "./views";
import { CsvExportPanel, csvBody, csvHeaders, readCsvChoice, stripConditions, type CsvColumn, type CsvPreset } from "./csv-export";

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
  /** 0047。外部の顧客マスタでの ID と独自項目の値 */
  external_ref?: Record<string, unknown> | null;
  attributes?: Record<string, unknown> | null;
  /** 0050。案内メールの同意（null = 未回答） */
  marketing_consent?: boolean | null;
  marketing_consent_at?: string | null;
  marketing_consent_source?: string | null;
  /** 0133。購入の集計（支払い済み・発送済みの注文）と社内メモ */
  orders_count?: number;
  total_spent_jpy?: number | string;
  last_order_at?: string | null;
  note?: string | null;
}

/** 書き出しの列（メンテナの決定 2026-11-09）。独自項目はショップの定義から、集計とメモは 0133 が当たっていれば */
function customerCsvColumns(fields: CustomerField[], stats: boolean): CsvColumn<CustomerRow>[] {
  const addr = (r: CustomerRow, k: string) => (r.default_address ?? {})[k];
  const cols: CsvColumn<CustomerRow>[] = [
    { key: "id", label: "id", group: "csvx.g_member", value: (r) => r.id },
    { key: "created_at", label: "登録日時", group: "csvx.g_member", value: (r) => formatDateTime(r.created_at) },
    { key: "last_login_at", label: "最後のログイン", group: "csvx.g_member", value: (r) => (r.last_login_at ? formatDateTime(r.last_login_at) : "") },
    { key: "email", label: "メール", group: "csvx.g_contact", pii: true, value: (r) => r.email },
    { key: "name", label: "氏名", group: "csvx.g_contact", pii: true, value: (r) => r.name },
    { key: "phone", label: "電話", group: "csvx.g_contact", pii: true, value: (r) => addr(r, "phone") },
    { key: "postal_code", label: "郵便番号", group: "csvx.g_address", pii: true, value: (r) => addr(r, "postal_code") },
    { key: "state", label: "都道府県", group: "csvx.g_address", pii: true, value: (r) => addr(r, "state") },
    { key: "city", label: "市区町村", group: "csvx.g_address", pii: true, value: (r) => addr(r, "city") },
    { key: "line1", label: "番地", group: "csvx.g_address", pii: true, value: (r) => addr(r, "line1") },
    { key: "line2", label: "建物", group: "csvx.g_address", pii: true, value: (r) => addr(r, "line2") },
    { key: "marketing_consent", label: "案内メールの同意", group: "csvx.g_consent", value: (r) => (r.marketing_consent === true ? "yes" : r.marketing_consent === false ? "no" : "") },
    { key: "marketing_consent_at", label: "同意の日時", group: "csvx.g_consent", value: (r) => (r.marketing_consent_at ? formatDateTime(r.marketing_consent_at) : "") },
    ...fields.map((f): CsvColumn<CustomerRow> => ({ key: `attr_${f.key}`, label: f.label, group: "csvx.g_attributes", value: (r) => (r.attributes && typeof r.attributes === "object" ? (r.attributes[f.key] ?? "") : "") })),
    { key: "external_provider", label: "外部の連携先", group: "csvx.g_external", value: (r) => externalRef(r.external_ref)?.provider ?? "" },
    { key: "external_id", label: "外部の ID", group: "csvx.g_external", value: (r) => externalRef(r.external_ref)?.id ?? "" },
  ];
  if (stats) {
    cols.push(
      { key: "orders_count", label: "購入回数", group: "csvx.g_stats", value: (r) => r.orders_count ?? 0 },
      { key: "total_spent_jpy", label: "累計の購入額", group: "csvx.g_stats", value: (r) => r.total_spent_jpy ?? 0 },
      { key: "last_order_at", label: "最後に買った日", group: "csvx.g_stats", value: (r) => (r.last_order_at ? formatDateTime(r.last_order_at) : "") },
      { key: "note", label: "社内メモ", group: "csvx.g_notes", pii: true, value: (r) => r.note ?? "" },
    );
  }
  return cols;
}
const customerCsvPresets = (fields: CustomerField[]): Record<string, CsvPreset> => ({
  // 案内メールの宛先は、同意した会員だけに必ず絞る（特定電子メール法のオプトイン。書き出しの側で consent=yes を外せない）
  mail: { label: "csvx.p_mail", cols: ["email", "name", "marketing_consent", "marketing_consent_at"] },
  crm: { label: "csvx.p_crm", cols: ["id", "email", "name", "phone", "postal_code", "state", "city", "line1", "line2", ...fields.map((f) => `attr_${f.key}`), "external_provider", "external_id"] },
});
const CUSTOMER_CONDITIONS = ["q", "f", "v", "consent", "sort"] as const;

/** 読む列（0133 の前の DB では集計とメモを選ばない） */
const customerColumns = (stats: boolean) =>
  `id,email,name,default_address,created_at,last_login_at,external_ref,attributes,marketing_consent,marketing_consent_at,marketing_consent_source${stats ? ",orders_count,total_spent_jpy,last_order_at,note" : ""}`;

/**
 * 一覧と CSV で共通: メール・氏名の部分一致（q）、独自項目 1 つの値の部分一致（f / v）、案内メールの同意で DB で絞り、
 * limit 件（after より後ろ）を読む。並びは新しい順、0132 からは古い順も
 */
async function listCustomers(c: AdminContext, shopId: string, settings: Record<string, unknown>, opts: { limit: number; after?: PagePosition; stats: boolean; sortable: boolean }) {
  const { db } = owner(c);
  const fields: CustomerField[] = customerFields(settings);
  const columns = customerColumns(opts.stats);
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const f0 = (c.req.query("f") ?? "").trim();
  const v0 = (c.req.query("v") ?? "").trim().slice(0, 100);
  // 案内メールの同意で絞る（0050）: yes / no / none（未回答）
  const consent = ["yes", "no", "none"].includes(c.req.query("consent") ?? "") ? c.req.query("consent")! : "";
  const attr = Boolean(f0 && v0 && fields.some((x) => x.key === f0));
  const sort = opts.sortable && readSort(c.req.query("sort")) === "old" ? "old" : "";
  const params: SearchParams = { q, f: attr ? f0 : "", v: attr ? v0 : "", consent, sort };
  const filtered = Boolean(q || attr || consent || sort || opts.after);
  // 部分一致（氏名・メール・独自項目）と古い順は RLS の外の検索の関数で（0059 / 0132。インデックスが効く）
  if (q || attr || sort) {
    const rows = await searchRows<CustomerRow>(c, { kind: "customers", shopId, q, filters: { ...(attr ? { field: f0, value: v0 } : {}), ...(consent ? { consent } : {}), ...(sort ? { sort } : {}) }, ...(opts.after ? { after: opts.after } : {}), limit: opts.limit, columns });
    return { fields, rows, params, filtered };
  }
  const where: Filter[] = [];
  if (consent) where.push(consent === "none" ? { col: "marketing_consent", op: "is", value: null } : { col: "marketing_consent", op: "is", value: consent === "yes" });
  const rows: CustomerRow[] = [];
  // PostgREST は 1 回 1,000 行まで。CSV のときだけ何回かに分けて読む
  for (let after = opts.after; rows.length < opts.limit; ) {
    const n = Math.min(1000, opts.limit - rows.length);
    const page = await db.from<CustomerRow>("customers").select(columns, { eq: { shop_id: shopId }, where: after ? [...where, olderThan(after)] : where, order: "created_at.desc,id.desc", limit: n });
    rows.push(...page);
    if (page.length < n) break;
    const last = page[page.length - 1]!;
    after = { k: last.created_at, id: last.id };
  }
  return { fields, rows, params, filtered };
}

/** 会員の購入の集計の列と社内メモ（0133） */
const STATS_MIGRATION = "0133_customer_stats_note";
/** 一覧の並び（0132） */
const SEARCH_MIGRATION = "0132_admin_search";
const consentLabel = (v: boolean | null | undefined) => t(v === true ? "customers.consent_yes" : v === false ? "customers.consent_no" : "customers.consent_none");
const customerPath = (shopId: string, id: string) => `/admin/shops/${shopId}/customers/${id}`;

/** 会員の詳細の画面の知らせ（flash / error の値 → 文言と種類） */
const DETAIL_FLASH: Record<string, [MessageKey, "notice" | "error"]> = {
  email_changed: ["customers.email_changed", "notice"],
  passkeys_reset: ["passkey.admin_reset_done", "notice"],
  attributes_saved: ["customers.attributes_saved", "notice"],
  consent_withdrawn: ["customers.consent_withdrawn", "notice"],
  note_saved: ["customers.note_saved", "notice"],
  attributes_invalid: ["customers.attributes_invalid", "error"],
  email_taken: ["customers.email_taken", "error"],
  email_invalid: ["customers.email_invalid", "error"],
  note_too_long: ["customers.note_too_long", "error"],
};

customers.get("/:shopId/customers", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const after = readAfter(c.req.query("after"));
  if (after === null) return c.text(t("error.generic"), 400);
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const [stats, sortable, viewsOn] = await Promise.all([migrated(deps, STATS_MIGRATION), migrated(deps, SEARCH_MIGRATION), migrated(deps, VIEWS_MIGRATION)]);
  const list = await listCustomers(c, shopId, shop.settings ?? {}, { limit: ADMIN_PAGE_SIZE + 1, stats, sortable, ...(after ? { after } : {}) });
  const { fields, params, filtered } = list;
  const page = splitPage(list.rows, (r) => r.created_at);
  const rows = page.rows;
  const base = `/admin/shops/${shop.id}/customers`;
  const listHref = searchHref(base, params);
  const chips = searchChips(base, params, (name, value) => {
    if (name === "consent") return `${t("customers.consent")}: ${consentLabel(value === "yes" ? true : value === "no" ? false : null)}`;
    if (name === "sort") return t("search.sort_old");
    return null;
  });
  // 独自項目の値は、項目と値の 2 つで 1 つの条件（外すときは両方）
  if (params["f"] && params["v"]) chips.unshift({ label: `${fields.find((x) => x.key === params["f"])?.label ?? params["f"]}: ${params["v"]}`, href: searchHref(base, { ...params, f: "", v: "" }) });
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("customers.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("customers.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "customers" }}>
      <PageHead title={t("customers.title")}>
        {rows.length > 0 || filtered ? (
          <a class="btn secondary" href={`/admin/shops/${shop.id}/customers.csv${listHref.slice(base.length)}`}>
            {chips.length > 0 || params["q"] ? t("search.csv_filtered") : t("customers.csv")}
          </a>
        ) : null}
      </PageHead>
      {c.req.query("flash") === "deleted" ? <p class="notice">{t("customers.deleted")}</p> : null}
      {!(shop.settings ?? {})["members_enabled"] ? (
        <div class="notice">
          <p>
            {t("shop.members_where")} <a href={`/admin/shops/${shop.id}/settings/members`}>{t("shop.members_open_settings")}</a>
          </p>
          <p class="muted">{t("shop.members_hint")}</p>
        </div>
      ) : null}
      {rows.length === 0 && !filtered ? (
        <div class="empty">
          <p>{t("customers.none")}</p>
        </div>
      ) : (
        <>
          <ViewTabs shopId={shop.id} screen="customers" views={viewsOf(shop.settings, "customers")} current={params} enabled={viewsOn} error={c.req.query("view_error")} />
          <SearchBar action={base} q={params["q"] ?? ""} placeholder={t("customers.search_placeholder")} sortable={sortable} sort={readSort(params["sort"])} chips={chips} clearHref={base}>
            {fields.length > 0 ? (
              <>
                <label>
                  {t("customers.filter_field")}
                  <select name="f">
                    <option value="">{t("customers.filter_any")}</option>
                    {fields.map((fd) => (
                      <option value={fd.key} selected={fd.key === params["f"]}>
                        {fd.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("customers.filter_value")}
                  <input type="text" name="v" value={params["v"] ?? ""} maxlength={100} />
                </label>
              </>
            ) : null}
            <label>
              {t("customers.consent")}
              <select name="consent">
                <option value="">{t("search.any")}</option>
                <option value="yes" selected={params["consent"] === "yes"}>
                  {t("customers.consent_yes")}
                </option>
                <option value="no" selected={params["consent"] === "no"}>
                  {t("customers.consent_no")}
                </option>
                <option value="none" selected={params["consent"] === "none"}>
                  {t("customers.consent_none")}
                </option>
              </select>
            </label>
          </SearchBar>
          {rows.length === 0 ? (
            <p>{t("customers.no_match")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("store.address_name")}</th>
                  <th>{t("login.email")}</th>
                  <th>{t("store.address_state")}</th>
                  {stats ? <th class="num">{t("customers.orders_count")}</th> : null}
                  {stats ? <th class="num">{t("customers.total_spent")}</th> : null}
                  {stats ? <th>{t("customers.last_order_at")}</th> : null}
                  {fields.length > 0 ? <th>{t("customers.attributes_short")}</th> : null}
                  <th>{t("customers.consent")}</th>
                  <th>{t("customers.registered_at")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={customerPath(shop.id, r.id)}>{r.name || r.email || r.id.slice(0, 8)}</a>
                    </td>
                    <td>{r.email ?? "-"}</td>
                    <td>{typeof r.default_address?.["state"] === "string" ? String(r.default_address["state"]) : "-"}</td>
                    {stats ? <td class="num">{r.orders_count ?? 0}</td> : null}
                    {stats ? <td class="num">{yen(Number(r.total_spent_jpy ?? 0))}</td> : null}
                    {stats ? <td>{r.last_order_at ? formatDateTime(r.last_order_at, { dateOnly: true }) : "-"}</td> : null}
                    {fields.length > 0 ? (
                      <td>
                        {attributeRows(fields, r.attributes).map((a) => (
                          <span class="muted" style="display:block">
                            {a.label}: {a.value}
                          </span>
                        ))}
                        {attributeRows(fields, r.attributes).length === 0 ? "-" : null}
                      </td>
                    ) : null}
                    <td>{consentLabel(r.marketing_consent)}</td>
                    <td>{formatDateTime(r.created_at, { dateOnly: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <Pager base={listHref} next={page.next} paged={Boolean(after)} />
      {rows.length > 0 || filtered ? <CsvExportPanel kind="customers" action={`/admin/shops/${shop.id}/customers.csv`} params={params} columns={customerCsvColumns(fields, stats)} presets={customerCsvPresets(fields)} note={t("csvx.mail_note")} /> : null}
    </AdminLayout>,
  );
});

interface MemberOrderRow {
  id: string;
  number: number;
  status: string;
  total_jpy: number;
  created_at: string;
}
interface MemberInquiryRow {
  id: string;
  number: number;
  created_at: string;
}

/**
 * 会員の詳細（メンテナの決定 2026-11-08「会員の詳細の画面を作る」）: 購入の集計・注文・お問い合わせ・独自項目・社内メモ・
 * 案内メールの同意・アカウントの操作を 1 画面に。注文とお問い合わせは新しいほうから 20 件（権限の項目がある人だけ）
 */
customers.get("/:shopId/customers/:customerId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const customerId = param(c, "customerId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop || !UUID_RE.test(customerId)) return c.text(t("shop.not_found"), 404);
  const access = c.get("shopAccess");
  const stats = await migrated({ db, cache: c.get("adapters").cache }, STATS_MIGRATION);
  const r = await db.from<CustomerRow>("customers").selectOne(customerColumns(stats), { eq: { shop_id: shopId, id: customerId } });
  if (!r) return c.text(t("customers.not_found"), 404);
  const inquiriesOn = moduleEnabled(shop.settings, "inquiries") && can(access, "support");
  const [orders, inquiries] = await Promise.all([
    can(access, "orders") ? db.from<MemberOrderRow>("orders").select("id,number,status,total_jpy,created_at", { eq: { shop_id: shopId, customer_id: customerId }, order: "created_at.desc,id.desc", limit: 20 }) : Promise.resolve(null),
    inquiriesOn ? db.from<MemberInquiryRow>("inquiries").select("id,number,created_at", { eq: { shop_id: shopId, customer_id: customerId }, order: "created_at.desc", limit: 20 }) : Promise.resolve(null),
  ]);
  const fields = customerFields(shop.settings);
  const ref = externalRef(r.external_ref);
  const code = c.req.query("flash") ?? c.req.query("error") ?? "";
  const msg = DETAIL_FLASH[code];
  const self = customerPath(shopId, customerId);
  const title = r.name || r.email || t("customers.title");
  return c.html(
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("customers.title"), href: `/admin/shops/${shop.id}/customers` }, { label: title }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access, active: "customers" }}>
      <PageHead title={title} sub={r.email ?? undefined} />
      {msg ? <p class={msg[1]}>{t(msg[0])}</p> : null}
      <div class="split">
        <div>
          {stats ? (
            <section class="card">
              <dl class="sum">
                <dt>{t("customers.orders_count")}</dt>
                <dd>{r.orders_count ?? 0}</dd>
                <dt>{t("customers.total_spent")}</dt>
                <dd>{yen(Number(r.total_spent_jpy ?? 0))}</dd>
                <dt>{t("customers.last_order_at")}</dt>
                <dd>{r.last_order_at ? formatDateTime(r.last_order_at) : "-"}</dd>
              </dl>
              <p class="muted">{t("customers.stats_hint")}</p>
            </section>
          ) : null}
          {orders ? (
            <section class="card">
              <h2>{t("order.list")}</h2>
              {orders.length === 0 ? (
                <p class="muted">{t("customers.no_orders")}</p>
              ) : (
                <table>
                  <tbody>
                    {orders.map((o) => (
                      <tr>
                        <td>
                          <a href={`/admin/shops/${shop.id}/orders/${o.id}`}>#{o.number}</a>
                        </td>
                        <td>{formatDateTime(o.created_at, { dateOnly: true })}</td>
                        <td class="num">{yen(o.total_jpy)}</td>
                        <td>{t(`order.status.${o.status}` as MessageKey)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ) : null}
          {inquiries ? (
            <section class="card">
              <h2>{t("mod.inquiries.name")}</h2>
              {inquiries.length === 0 ? (
                <p class="muted">{t("customers.no_inquiries")}</p>
              ) : (
                <ul>
                  {inquiries.map((q) => (
                    <li>
                      <a href={`/admin/shops/${shop.id}/modules/inquiries/${q.id}`}>#{q.number}</a>{" "}
                      <span class="muted">{formatDateTime(q.created_at, { dateOnly: true })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {stats ? (
            <form method="post" action={`${self}/note`} class="card">
              <h2>{t("customers.note")}</h2>
              <textarea name="note" rows={4} maxlength={2000} style="width:100%">
                {r.note ?? ""}
              </textarea>
              <p class="muted">{t("customers.note_hint")}</p>
              <p>
                <button type="submit" class="secondary small">
                  {t("shop.save")}
                </button>
              </p>
            </form>
          ) : null}
          {fields.length > 0 ? (
            <form method="post" action={`${self}/attributes`} class="card">
              <h2>{t("customers.attributes")}</h2>
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
                      <textarea name={`attr_${fd.key}`} rows={2}>
                        {val}
                      </textarea>
                    ) : (
                      <input type={fd.type === "number" ? "number" : fd.type === "url" ? "url" : "text"} step={fd.type === "number" ? "any" : undefined} name={`attr_${fd.key}`} value={val} />
                    )}
                  </label>
                );
              })}
              <p class="muted">{t("customers.attributes_hint")}</p>
              <p>
                <button type="submit" class="secondary small">
                  {t("customers.edit_attributes")}
                </button>
              </p>
            </form>
          ) : null}
        </div>
        <aside>
          <section class="card">
            <dl class="sum">
              <dt>{t("customers.registered_at")}</dt>
              <dd>{formatDateTime(r.created_at, { dateOnly: true })}</dd>
              <dt>{t("customers.last_login_at")}</dt>
              <dd>{r.last_login_at ? formatDateTime(r.last_login_at) : "-"}</dd>
              <dt>{t("store.address_state")}</dt>
              <dd>{typeof r.default_address?.["state"] === "string" ? String(r.default_address["state"]) : "-"}</dd>
              {ref ? (
                <>
                  <dt>{t("customers.external_ref")}</dt>
                  <dd>
                    {ref.provider} / {ref.id}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
          <section class="card">
            <h2>{t("customers.consent")}</h2>
            <p>{consentLabel(r.marketing_consent)}</p>
            {r.marketing_consent === true ? (
              <form method="post" action={`${self}/consent/withdraw`}>
                <button type="submit" class="secondary small">
                  {t("customers.consent_withdraw")}
                </button>
              </form>
            ) : null}
          </section>
          <section class="card">
            <h2>{t("customers.account")}</h2>
            <form method="post" action={`${self}/email`}>
              <label>
                {t("customers.change_email")}
                <input type="email" name="email" required />
              </label>
              <p class="muted">{t("customers.change_email_hint")}</p>
              <button type="submit" class="secondary small">
                {t("customers.change_email")}
              </button>
            </form>
            {moduleEnabled(shop.settings, PASSKEY_MODULE) && can(access, "admin") ? (
              <form method="post" action={`${self}/passkeys/reset`} onsubmit={`return confirm(${JSON.stringify(t("passkey.admin_reset_confirm"))})`}>
                <p>
                  <button type="submit" class="secondary small">
                    {t("passkey.admin_reset")}
                  </button>
                </p>
              </form>
            ) : null}
            {moduleEnabled(shop.settings, FAVORITES_MODULE) ? (
              <p>
                <a href={`${self}/favorites`}>{t("customers.favorites")}</a>
              </p>
            ) : null}
            <form method="post" action={`${self}/delete`} onsubmit={`return confirm(${JSON.stringify(t("customers.delete_confirm"))})`}>
              <p>
                <button type="submit" class="danger">
                  {t("customers.delete")}
                </button>
              </p>
            </form>
          </section>
        </aside>
      </div>
    </AdminLayout>,
  );
});

/** 社内メモ（0133 の customer_set_note。項目 customers） */
customers.post("/:shopId/customers/:customerId/note", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const customerId = param(c, "customerId");
  if (!(await loadShop(c, shopId, "customers")) || !UUID_RE.test(customerId)) return c.text(t("shop.not_found"), 404);
  const note = (await formFields(c)).note ?? "";
  const self = customerPath(shopId, customerId);
  try {
    await db.rpc("customer_set_note", { p_shop_id: shopId, p_customer_id: customerId, p_note: note });
  } catch (e) {
    if (e instanceof DbError && /note_too_long/.test(e.message)) return c.redirect(`${self}?error=note_too_long`);
    if (e instanceof DbError && /customer_not_found/.test(e.message)) return c.redirect(`/admin/shops/${shopId}/customers?flash=deleted`);
    throw e;
  }
  return c.redirect(`${self}?flash=note_saved`);
});

/** 会員のお気に入り（同梱モジュール favorites、0123）。読めるのは項目 customers（RLS）。新しい順 */
customers.get("/:shopId/customers/:customerId/favorites", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop || !moduleEnabled(shop.settings, FAVORITES_MODULE)) return c.text(t("shop.not_found"), 404);
  const customerId = param(c, "customerId");
  if (!/^[0-9a-f-]{36}$/.test(customerId)) return c.text(t("shop.not_found"), 404);
  const db = owner(c).db;
  const customer = await db.from<{ id: string; email: string | null; name: string | null }>("customers").selectOne("id,email,name", { eq: { shop_id: shopId, id: customerId } });
  if (!customer) return c.text(t("shop.not_found"), 404);
  const favs = await db.from<{ product_id: string; created_at: string }>("customer_favorites").select("product_id,created_at", { eq: { shop_id: shopId, customer_id: customerId }, order: "created_at.desc", limit: 200 });
  const products = favs.length
    ? await db.from<{ id: string; name: string; slug: string; published: boolean }>("products").select("id,name,slug,published", { eq: { shop_id: shopId }, in: { id: favs.map((x) => x.product_id) } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const who = customer.name ? `${customer.name}（${customer.email ?? "-"}）` : (customer.email ?? "-");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("customers.favorites")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("customers.title"), href: `/admin/shops/${shop.id}/customers` }, { label: t("customers.favorites") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "customers" }}>
      <PageHead title={t("customers.favorites")} sub={who} />
      {favs.length === 0 ? <p>{t("customers.favorites_none")}</p> : null}
      {favs.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("product.name")}</th>
              <th>{t("customers.favorite_added")}</th>
            </tr>
          </thead>
          <tbody>
            {favs.map((x) => {
              const p = byId.get(x.product_id);
              return (
                <tr>
                  <td>
                    {p ? <a href={`/admin/shops/${shop.id}/products/${p.id}`}>{p.name}</a> : "-"}
                    {p && !p.published ? <span class="muted"> （{t("dashboard.unpublished")}）</span> : null}
                  </td>
                  <td>{formatDateTime(x.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </AdminLayout>,
  );
});

/** CSV（一覧と同じ絞り込み）。独自項目は定義の順に 1 列ずつ。外部の ID は provider と id の 2 列 */
customers.get("/:shopId/customers.csv", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const [stats, sortable] = await Promise.all([migrated(deps, STATS_MIGRATION), migrated(deps, SEARCH_MIGRATION)]);
  const base = `/admin/shops/${shopId}/customers.csv`;
  const allFields = customerFields(shop.settings ?? {});
  const choice = readCsvChoice(c, customerCsvColumns(allFields, stats), ["member"], customerCsvPresets(allFields));
  // 案内メールの宛先は、同意した会員だけ（範囲「すべて」でもこの条件は外さない）
  if (choice?.preset === "mail" && c.req.query("consent") !== "yes") {
    const url = new URL(c.req.url);
    for (const k of CUSTOMER_CONDITIONS) if (c.req.query("range") === "all") url.searchParams.delete(k);
    url.searchParams.delete("range");
    url.searchParams.set("consent", "yes");
    return c.redirect(`${base}${url.search}`);
  }
  const all = stripConditions(c, base, CUSTOMER_CONDITIONS);
  if (all) return c.redirect(all);
  const { fields, rows } = await listCustomers(c, shopId, shop.settings ?? {}, { limit: CSV_MAX_ROWS, stats, sortable });
  if (choice) return c.body(csvBody(choice.cols, rows, choice.format), 200, csvHeaders(`customers-${shop.slug}${choice.preset ? `-${choice.preset}` : ""}`));
  const header = ["id", "email", "name", "phone", "postal_code", "state", "city", "line1", "line2", "created_at", "last_login_at", "marketing_consent", "marketing_consent_at", "marketing_consent_source", "external_provider", "external_id", ...fields.map((f) => f.key), ...(stats ? ["orders_count", "total_spent_jpy", "last_order_at", "note"] : [])];
  const lines = rows.map((r) => {
    const a = (r.default_address ?? {}) as Record<string, unknown>;
    const ref = externalRef(r.external_ref);
    const attrs = r.attributes && typeof r.attributes === "object" ? r.attributes : {};
    const consentCols = [r.marketing_consent === true ? "yes" : r.marketing_consent === false ? "no" : "", r.marketing_consent_at ? formatDateTime(r.marketing_consent_at) : "", r.marketing_consent_source ?? ""];
    const statCols = stats ? [r.orders_count ?? 0, r.total_spent_jpy ?? 0, r.last_order_at ? formatDateTime(r.last_order_at) : "", r.note ?? ""] : [];
    return [r.id, r.email, r.name, a["phone"], a["postal_code"], a["state"], a["city"], a["line1"], a["line2"], formatDateTime(r.created_at), r.last_login_at ? formatDateTime(r.last_login_at) : "", ...consentCols, ref?.provider ?? "", ref?.id ?? "", ...fields.map((f) => attrs[f.key] ?? ""), ...statCols].map(csvCell).join(",");
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
  const back = customerPath(shopId, param(c, "customerId"));
  const sep = "?";
  const body = await c.req.parseBody();
  const form: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(body)) if (typeof val === "string") form[k] = val;
  const values = attributesFromForm(customerFields(shop.settings), form);
  try {
    await db.rpc("customer_set_attributes", { p_shop_id: shopId, p_customer_id: param(c, "customerId"), p_values: values });
  } catch (e) {
    if (e instanceof DbError && /invalid_attribute/.test(e.message)) return c.redirect(`${back}${sep}error=attributes_invalid`);
    if (e instanceof DbError && /customer_not_found/.test(e.message)) return c.redirect(`/admin/shops/${shopId}/customers?flash=deleted`);
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
  const back = customerPath(shopId, param(c, "customerId"));
  const sep = "?";
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
    if (e instanceof DbError && /email_taken/.test(e.message)) return c.redirect(`${customerPath(shopId, param(c, "customerId"))}?error=email_taken`);
    if (e instanceof DbError && /invalid_email/.test(e.message)) return c.redirect(`${customerPath(shopId, param(c, "customerId"))}?error=email_invalid`);
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
  return c.redirect(`${customerPath(shopId, param(c, "customerId"))}?flash=email_changed`);
});

/** 会員のパスキーを全部消す（0046 の member_passkeys_reset。0055 からは owner / admin だけ。メールアドレスの変更と同じ線） */
customers.post("/:shopId/customers/:customerId/passkeys/reset", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  await db.rpc("member_passkeys_reset", { p_shop_id: shopId, p_customer_id: param(c, "customerId") });
  return c.redirect(`${customerPath(shopId, param(c, "customerId"))}?flash=passkeys_reset`);
});
