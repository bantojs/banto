import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { migrated } from "../../db/migration-state";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, type Crumb, type ShopTabs, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, publicBaseUrl, sessionSecret, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { can } from "../../routes/admin/access";
import { loadShop } from "../../routes/admin/shops";
import { inquiryLinkHash } from "../../members/auth";
import { createMailer } from "../../mail/send";
import { randomToken } from "../../util/signed";
import { returnOrigins, safeReturnUrl, withQueryParam } from "../../commerce/checkout";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { yen } from "../../routes/common";
import { ATTACHMENT_ACCEPT, attachmentResponse, filesOf, removeAttachments } from "./attachments";
import { BODY_MAX, INQUIRIES_MIGRATION, INQUIRIES_MODULE, INQUIRY_ASSIGNEE_MIGRATION, sendAssignNotice, INQUIRY_STATUSES, MAX_TEMPLATES, TEMPLATE_BODY_MAX, TEMPLATE_TITLE_MAX, categoryLabel, fillTemplate, inquirySettings, inquiryTemplates, sendReplyNotice, statusLabel, storeFor } from "./index";

/**
 * 同梱モジュール「お問い合わせ」の運営側の画面（docs/inquiries.md）。ショップの support の項目を持つ人（組織の owner / admin を含む）。
 *   GET  /admin/shops/:shopId/modules/inquiries            一覧（返事待ち・お客様の返事待ち・完了）と設定
 *   POST .../settings                                       お知らせの宛先（settings の項目も要る）
 *   GET  .../:id                                            1 件（やり取り・結んだ注文・アドレスの確認）
 *   POST .../:id/reply, .../:id/status, .../:id/delete      返事を書く（お客様にはリンクだけのメール）・完了 / 開き直す・削除
 *   POST .../:id/assign                                     担当者を決める・外す（0068。担当になった人にリンクだけのメール）
 * 読むのは RLS（inquiries_select）と inquiry_admin_get、書くのは inquiry_reply / inquiry_set_status / inquiry_delete（0061）・inquiry_assign（0068）。
 */
export const inquiriesAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "support");
  if (!shop || !moduleEnabled(shop.settings, INQUIRIES_MODULE)) return null;
  return (await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, INQUIRIES_MIGRATION)) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/inquiries`;
const tabs = (c: AdminContext, shop: ShopRow): ShopTabs => ({ shop, access: c.get("shopAccess"), active: "inquiries" });

function crumbs(shop: ShopRow, here?: string): Crumb[] {
  return [{ label: shop.name, href: `/admin/shops/${shop.id}` }, here ? { label: t("mod.inquiries.name"), href: base(shop) } : { label: t("mod.inquiries.name") }, ...(here ? [{ label: here }] : [])];
}

const FLASH: Record<string, MessageKey> = {
  saved: "inq.admin_saved",
  sent: "inq.admin_reply_sent",
  sent_no_mail: "inq.admin_reply_no_mail",
  status: "inq.admin_status_saved",
  assigned: "inq.admin_assigned",
  assigned_no_mail: "inq.admin_assigned_no_mail",
  deleted: "inq.admin_deleted",
  empty: "inq.error_body",
  attachments_unavailable: "inq.error_attachments_unavailable",
  attachment_too_many: "inq.error_attachment_too_many",
  attachment_too_large: "inq.error_attachment_too_large",
  attachment_type: "inq.error_attachment_type",
  generic: "inq.admin_error",
};

function Flash({ code }: { code?: string | undefined }) {
  const key = code ? FLASH[code] : undefined;
  if (!key) return null;
  return <p class={code === "empty" || code === "generic" || code === "sent_no_mail" || code === "assigned_no_mail" || !!code?.startsWith("attachment") ? "error" : "notice"}>{t(key)}</p>;
}

interface Row {
  id: string;
  number: number;
  status: string;
  category: string;
  contact_email: string | null;
  contact_name: string | null;
  email_verified_at: string | null;
  order_id: string | null;
  claimed_order_number: number | null;
  last_message_at: string;
  created_at: string;
  /** 0068 */
  assignee_id?: string | null;
}

const FILTERS = ["open", "waiting_shop", "waiting_customer", "closed", "unverified", "all"] as const;
/** 担当者の絞り込み（0068）: all / mine（自分）/ none（未割り当て） */
const ASSIGNEE_FILTERS = ["all", "mine", "none"] as const;

interface Assignee {
  user_id: string;
  email: string;
}

/** 担当者にできる人（0068 が当たっていなければ null = 担当者の欄を出さない） */
async function assigneesFor(c: AdminContext, shop: ShopRow): Promise<Assignee[] | null> {
  if (!(await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, INQUIRY_ASSIGNEE_MIGRATION))) return null;
  return (await owner(c).db.rpc<Assignee[] | null>("inquiry_assignees", { p_shop_id: shop.id })) ?? [];
}

inquiriesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const filter = (FILTERS as readonly string[]).includes(c.req.query("status") ?? "") ? c.req.query("status")! : "open";
  const assignees = await assigneesFor(c, shop);
  const who = assignees && (ASSIGNEE_FILTERS as readonly string[]).includes(c.req.query("assignee") ?? "") ? c.req.query("assignee")! : "all";
  const eq: Record<string, string | null> = { shop_id: shop.id, ...((INQUIRY_STATUSES as readonly string[]).includes(filter) ? { status: filter } : {}), ...(who === "mine" ? { assignee_id: owner(c).session.user_id } : who === "none" ? { assignee_id: null } : {}) };
  const rows = await owner(c).db.from<Row>("inquiries").select(`id,number,status,category,contact_email,contact_name,email_verified_at,order_id,claimed_order_number,last_message_at,created_at${assignees ? ",assignee_id" : ""}`, {
    eq,
    ...(filter === "open" ? { in: { status: ["waiting_shop", "waiting_customer"] } } : {}),
    order: "last_message_at.desc",
    limit: 200,
  });
  const list = filter === "unverified" ? rows.filter((r) => !r.email_verified_at) : rows;
  const emailOf = new Map((assignees ?? []).map((a) => [a.user_id, a.email]));
  const s = inquirySettings(shop.settings);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.inquiries.name")}`} nav crumbs={crumbs(shop)} shopTabs={tabs(c, shop)}>
      <PageHead title={t("mod.inquiries.name")} sub={t("inq.admin_intro")} />
      <Flash code={c.req.query("flash")} />
      <form method="get" action={base(shop)}>
        <select name="status">
          {FILTERS.map((f) => (
            <option value={f} selected={f === filter}>
              {t(`inq.filter_${f}` as MessageKey)}
            </option>
          ))}
        </select>{" "}
        {assignees ? (
          <>
            <select name="assignee" aria-label={t("inq.assignee")}>
              {ASSIGNEE_FILTERS.map((f) => (
                <option value={f} selected={f === who}>
                  {t(`inq.assignee_filter_${f}` as MessageKey)}
                </option>
              ))}
            </select>{" "}
          </>
        ) : null}
        <button type="submit" class="secondary small">
          {t("inq.filter")}
        </button>
      </form>
      {list.length === 0 ? (
        <p class="muted">{t("inq.admin_empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("inq.number")}</th>
              <th>{t("inq.status")}</th>
              <th>{t("inq.category")}</th>
              <th>{t("inq.contact")}</th>
              <th>{t("inq.order")}</th>
              {assignees ? <th>{t("inq.assignee")}</th> : null}
              <th>{t("inq.last_message_at")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr>
                <td>
                  <a href={`${base(shop)}/${r.id}`}>#{r.number}</a>
                </td>
                <td>
                  {statusLabel(r.status)}
                  {!r.email_verified_at ? <span class="status off"> {t("inq.unverified")}</span> : null}
                </td>
                <td>{categoryLabel(r.category)}</td>
                <td>{[r.contact_name, r.contact_email].filter(Boolean).join(" / ")}</td>
                <td>{r.order_id ? t("inq.order_linked") : r.claimed_order_number ? tf("inq.order_claimed", { number: r.claimed_order_number }) : ""}</td>
                {assignees ? <td>{r.assignee_id ? (emailOf.get(r.assignee_id) ?? t("inq.assignee_unknown")) : <span class="muted">{t("inq.assignee_none")}</span>}</td> : null}
                <td>{formatDateTime(r.last_message_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(c.get("shopAccess"), "settings") ? (
        <>
          <h2>{t("inq.settings")}</h2>
          <form method="post" action={`${base(shop)}/settings`}>
            <label for="notify_email">{t("inq.notify_email")}</label>
            <input id="notify_email" type="email" name="notify_email" value={s.notify_email ?? ""} maxlength={254} />
            <p class="muted">{t("inq.notify_email_help")}</p>
            <h3>{t("inq.templates")}</h3>
            <p class="muted">{t("inq.templates_help")}</p>
            {Array.from({ length: Math.min(MAX_TEMPLATES, s.templates.length + 2) }, (_, i) => (
              <fieldset>
                <label for={`tpl_title_${i}`}>{tf("inq.template_title", { n: i + 1 })}</label>
                <input id={`tpl_title_${i}`} name={`tpl_title_${i}`} value={s.templates[i]?.title ?? ""} maxlength={TEMPLATE_TITLE_MAX} />
                <label for={`tpl_body_${i}`}>{t("inq.template_body")}</label>
                <textarea id={`tpl_body_${i}`} name={`tpl_body_${i}`} rows={4} maxlength={TEMPLATE_BODY_MAX}>
                  {s.templates[i]?.body ?? ""}
                </textarea>
              </fieldset>
            ))}
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </>
      ) : null}
    </AdminLayout>,
  );
});

inquiriesAdmin.post("/settings", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop || !can(c.get("shopAccess"), "settings")) return c.notFound();
  const f = await formFields(c);
  const templates = inquiryTemplates(Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ title: f[`tpl_title_${i}`] ?? "", body: f[`tpl_body_${i}`] ?? "" })));
  const inquiries = { ...((shop.settings ?? {})["inquiries"] as Record<string, unknown> | undefined), notify_email: (f.notify_email ?? "").trim() || null };
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), inquiries: { ...inquiries, notify_email: inquirySettings({ inquiries }).notify_email, templates } } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(shop)}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
});

interface Detail {
  id: string;
  shop_id: string;
  number: number;
  status: string;
  category: string;
  origin: string;
  contact_email: string | null;
  contact_name: string | null;
  verified: boolean;
  customer_id: string | null;
  claimed_order_number: number | null;
  created_at: string;
  closed_at: string | null;
  masked: boolean;
  member_match: boolean;
  /** 0068 */
  assignee_id?: string | null;
  order: { order_id: string; number: number; status: string; created_at: string; total_jpy: number; items: { name: string | null; qty: number }[] } | null;
  messages: { author: "customer" | "shop"; body: string; created_at: string; attachments?: { id: string; filename: string; content_type: string; size: number }[] }[];
}

async function detail(c: AdminContext): Promise<{ shop: ShopRow; d: Detail } | null> {
  const shop = await scope(c);
  if (!shop) return null;
  let d: Detail | null = null;
  try {
    d = await owner(c).db.rpc<Detail | null>("inquiry_admin_get", { p_inquiry_id: param(c, "id") });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null; // id の形が違う
    throw e;
  }
  return d && d.shop_id === shop.id ? { shop, d } : null;
}

/** 本文はテキストとして出す（改行だけ活かす） */
const Body = ({ text }: { text: string }) => <div style="white-space:pre-wrap;overflow-wrap:anywhere">{text}</div>;

inquiriesAdmin.get("/:id", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  if (!x) return c.notFound();
  const { shop, d } = x;
  const access = c.get("shopAccess");
  // 定型文を差し込む（?template=<番号>。JavaScript を使わず、返事の欄に入れた状態で開き直す）
  const templates = inquirySettings(shop.settings).templates;
  const picked = templates[Number(c.req.query("template") ?? "-1")];
  const assignees = await assigneesFor(c, shop);
  const draft = picked ? fillTemplate(picked.body, { name: d.contact_name, number: d.number, shop: shop.name }) : "";
  return c.html(
    <AdminLayout title={`#${d.number} · ${t("mod.inquiries.name")}`} nav crumbs={crumbs(shop, `#${d.number}`)} shopTabs={tabs(c, shop)}>
      <PageHead title={tf("inq.admin_title", { number: d.number })} sub={`${categoryLabel(d.category)} · ${statusLabel(d.status)} · ${t(`inq.origin_${d.origin}` as MessageKey)}`} />
      <Flash code={c.req.query("flash")} />
      <table>
        <tbody>
          <tr>
            <th>{t("inq.contact")}</th>
            <td>
              {d.masked ? t("inq.masked") : [d.contact_name, d.contact_email].filter(Boolean).join(" / ")}
              {d.verified ? <span class="status on"> {t("inq.verified")}</span> : <span class="status off"> {t("inq.unverified")}</span>}
            </td>
          </tr>
          <tr>
            <th>{t("inq.member")}</th>
            <td>
              {d.customer_id ? (
                can(access, "customers") && d.contact_email ? <a href={`/admin/shops/${shop.id}/customers?q=${encodeURIComponent(d.contact_email)}`}>{t("inq.member_linked")}</a> : t("inq.member_linked")
              ) : d.member_match ? (
                t("inq.member_match_unverified")
              ) : (
                t("inq.member_none")
              )}
            </td>
          </tr>
          <tr>
            <th>{t("inq.order")}</th>
            <td>
              {d.order ? (
                <>
                  {can(access, "orders") ? <a href={`/admin/shops/${shop.id}/orders/${d.order.order_id}`}>#{d.order.number}</a> : `#${d.order.number}`}
                  {` · ${t(`order.status.${d.order.status}` as MessageKey)} · ${yen(d.order.total_jpy)} · `}
                  {d.order.items.map((i) => `${i.name ?? ""} ×${i.qty}`).join("、")}
                </>
              ) : d.claimed_order_number ? (
                tf("inq.order_claimed_detail", { number: d.claimed_order_number })
              ) : (
                t("inq.order_none")
              )}
            </td>
          </tr>
          <tr>
            <th>{t("inq.created_at")}</th>
            <td>{formatDateTime(d.created_at)}</td>
          </tr>
          {assignees ? (
            <tr>
              <th>{t("inq.assignee")}</th>
              <td>
                <form method="post" action={`${base(shop)}/${d.id}/assign`}>
                  <select name="assignee" aria-label={t("inq.assignee")}>
                    <option value="" selected={!d.assignee_id}>
                      {t("inq.assignee_none")}
                    </option>
                    {d.assignee_id && !assignees.some((a) => a.user_id === d.assignee_id) ? (
                      <option value={d.assignee_id} selected>
                        {t("inq.assignee_unknown")}
                      </option>
                    ) : null}
                    {assignees.map((a) => (
                      <option value={a.user_id} selected={a.user_id === d.assignee_id}>
                        {a.email}
                        {a.user_id === owner(c).session.user_id ? ` ${t("inq.assignee_me")}` : ""}
                      </option>
                    ))}
                  </select>{" "}
                  <button type="submit" class="secondary small">
                    {t("inq.assign")}
                  </button>
                </form>
                <p class="muted">{t("inq.assignee_help")}</p>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {d.category === "account" ? <p class="notice">{t("inq.account_warning")}</p> : null}

      <h2>{t("inq.messages")}</h2>
      {d.messages.map((m) => (
        <section class="card" style={m.author === "shop" ? "margin-left:2rem" : "margin-right:2rem"}>
          <p class="muted">
            {m.author === "shop" ? t("inq.from_shop") : t("inq.from_customer")} · {formatDateTime(m.created_at)}
          </p>
          <Body text={m.body} />
          {(m.attachments ?? []).length > 0 ? (
            <ul>
              {(m.attachments ?? []).map((a) => (
                <li>
                  <a href={`${base(shop)}/${d.id}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">
                    {a.filename}
                  </a>{" "}
                  <span class="muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      {!d.masked ? (
        <>
          <h2>{t("inq.reply")}</h2>
          {!d.verified ? <p class="error">{t("inq.unverified_warning")}</p> : null}
          {templates.length > 0 ? (
            <form method="get" action={`${base(shop)}/${d.id}`}>
              <select name="template" aria-label={t("inq.templates")}>
                {templates.map((tp, i) => (
                  <option value={String(i)} selected={picked === tp}>
                    {tp.title}
                  </option>
                ))}
              </select>{" "}
              <button type="submit" class="secondary small">
                {t("inq.template_insert")}
              </button>
            </form>
          ) : null}
          <form method="post" action={`${base(shop)}/${d.id}/reply`} enctype={c.get("adapters").privateStorage ? "multipart/form-data" : undefined}>
            <textarea name="body" rows={8} maxlength={BODY_MAX} required>
              {draft}
            </textarea>
            {c.get("adapters").privateStorage ? (
              <>
                <label for="files">{t("inq.attach")}</label>
                <input id="files" type="file" name="files" multiple accept={ATTACHMENT_ACCEPT} />
                <p class="muted">{t("inq.attach_help")}</p>
              </>
            ) : null}
            <p class="muted">{t("inq.reply_help")}</p>
            <p>
              <button type="submit">{t("inq.reply_submit")}</button>
            </p>
          </form>
        </>
      ) : null}

      <h2>{t("inq.status")}</h2>
      <form method="post" action={`${base(shop)}/${d.id}/status`}>
        <input type="hidden" name="status" value={d.status === "closed" ? "waiting_shop" : "closed"} />
        <button type="submit" class="secondary">
          {d.status === "closed" ? t("inq.reopen") : t("inq.close")}
        </button>
      </form>
      <form method="post" action={`${base(shop)}/${d.id}/delete`} style="margin-top:1rem">
        <button type="submit" class="secondary small" onclick={`return confirm(${JSON.stringify(t("inq.delete_confirm"))})`}>
          {t("inq.delete")}
        </button>
      </form>
    </AdminLayout>,
  );
});

/** お客様のリンクの行き先（ヘッドレスの連携サイトは今の許可リストで確かめ直す。外れていれば Banto の画面） */
function linkFor(c: AdminContext, shop: ShopRow, returnTo: string | null, token: string): string {
  const banto = `${shopHome(publicBaseUrl(c), shop)}/inquiries/open?t=${token}`;
  const target = returnTo ? safeReturnUrl(returnTo, returnOrigins(shop.settings), "") : "";
  return target ? withQueryParam(target, "banto_inquiry", token) : banto;
}

inquiriesAdmin.post("/:id/reply", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  if (!x) return c.notFound();
  const back = `${base(x.shop)}/${x.d.id}`;
  const raw = await c.req.parseBody({ all: true });
  const rawBody = Array.isArray(raw["body"]) ? raw["body"][0] : raw["body"];
  const body = (typeof rawBody === "string" ? rawBody : "").replace(/\r\n?/g, "\n").trim().slice(0, BODY_MAX);
  if (!body) return c.redirect(`${back}?flash=empty`);
  const secret = sessionSecret(c);
  if (!secret) return c.redirect(`${back}?flash=generic`);
  const privateStorage = c.get("adapters").privateStorage ?? null;
  const stored = await storeFor({ privateStorage }, x.shop.id, filesOf(raw));
  if (!stored.ok) return c.redirect(`${back}?flash=${stored.error}`);
  const token = randomToken(32);
  let r: { number: number; send: boolean; to: string | null; mail_from: string | null; return_to: string | null };
  try {
    r = await owner(c).db.rpc("inquiry_reply", { p_inquiry_id: x.d.id, p_body: body, p_link_hash: await inquiryLinkHash(secret, token), p_attachments: stored.stored });
  } catch (e) {
    if (privateStorage && stored.stored.length > 0) await removeAttachments(privateStorage, stored.stored.map((a) => a.key));
    if (e instanceof DbError) return c.redirect(`${back}?flash=${/too_many_attachments/.test(e.message) ? "attachment_too_many" : "generic"}`);
    throw e;
  }
  const sent = await sendReplyNotice({ mailer: createMailer(c.get("adapters"), c.get("deps").fetch) }, x.shop, r, linkFor(c, x.shop, r.return_to, token));
  return c.redirect(`${back}?flash=${sent ? "sent" : "sent_no_mail"}`);
});

/** 添付を配る（support の項目。inquiry_attachment_admin_get が確かめる） */
inquiriesAdmin.get("/:id/attachments/:aid", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  const storage = c.get("adapters").privateStorage;
  if (!x || !storage) return c.notFound();
  let meta: { storage_key: string; content_type: string; filename: string; inquiry_id: string } | null = null;
  try {
    meta = await owner(c).db.rpc("inquiry_attachment_admin_get", { p_attachment_id: param(c, "aid") });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return c.notFound();
    throw e;
  }
  if (!meta || meta.inquiry_id !== x.d.id) return c.notFound();
  return (await attachmentResponse(storage, meta)) ?? c.notFound();
});

inquiriesAdmin.post("/:id/status", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  if (!x) return c.notFound();
  const status = (await formFields(c)).status ?? "";
  if (!(INQUIRY_STATUSES as readonly string[]).includes(status)) return c.redirect(`${base(x.shop)}/${x.d.id}?flash=generic`);
  try {
    await owner(c).db.rpc("inquiry_set_status", { p_inquiry_id: x.d.id, p_status: status });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(x.shop)}/${x.d.id}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(x.shop)}/${x.d.id}?flash=status`);
});

/** 担当者を決める・外す（0068。担当になった人には、自分で自分に割り当てたのでなければリンクだけのメール） */
inquiriesAdmin.post("/:id/assign", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  if (!x || !(await assigneesFor(c, x.shop))) return c.notFound();
  const back = `${base(x.shop)}/${x.d.id}`;
  const to = ((await formFields(c)).assignee ?? "").trim();
  let r: { inquiry_id: string; number: number; send: boolean; to: string | null; mail_from: string | null };
  try {
    r = await owner(c).db.rpc("inquiry_assign", { p_inquiry_id: x.d.id, p_user: to || null });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=generic`);
    throw e;
  }
  // 知らせる相手がいた（自分以外に割り当てた）のに送れなかったときだけ、そのことを出す
  const notified = r.to ? await sendAssignNotice({ mailer: createMailer(c.get("adapters"), c.get("deps").fetch), adminBase: publicBaseUrl(c) }, x.shop, r) : true;
  return c.redirect(`${back}?flash=${notified ? "assigned" : "assigned_no_mail"}`);
});

inquiriesAdmin.post("/:id/delete", requireOwner, async (c: AdminContext) => {
  const x = await detail(c);
  if (!x) return c.notFound();
  try {
    await owner(c).db.rpc("inquiry_delete", { p_inquiry_id: x.d.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(x.shop)}/${x.d.id}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(x.shop)}?flash=deleted`);
});
