/**
 * 同梱モジュール「お問い合わせ」（inquiries、既定 OFF。docs/inquiries.md、設計は docs/knowledge/14-inquiries.md、0061_mod_inquiries.sql）。
 * お客様のお問い合わせをチケットにし、運営者とのやり取りを Banto の中で続ける。同梱テーマとヘッドレス API の両方がここを通る。
 *
 * - メールはお知らせとチケットへのリンクだけ（本文は載せない。メールへの返信は受けない）
 * - 照合・回数の制限・注文と会員への結びつけは DB の関数。ここはリンクのトークンを作って HMAC にし、メールを送るだけ
 * - 注文から問い合わせるときの「注文トークン」は、注文照会で番号とメールアドレスが合った組をショップごとに署名したもの
 */
import { inquiryEmailHash, inquiryLinkHash, ipHash } from "../../members/auth";
import { PrivilegedRpcError, type InquiryAccess, type InquiryOrderSummary, type InquiryView, type PrivilegedDb } from "../../db/privileged";
import { MailError, sendMail, type Mailer } from "../../mail/send";
import { planLimitOf } from "../../plan/limits";
import { t, type MessageKey } from "../../i18n";
import { openJson, randomToken, sealJson } from "../../util/signed";
import { openOrderToken, sealOrderToken } from "../../orders/lookup";
import { buildCustomerMail, buildShopNotice, type InquiryMailShop } from "./mail";
import { removeAttachments, storeAttachments, type StoredAttachment } from "./attachments";
import type { StorageAdapter } from "../../adapters/types";
import { moduleEnabled } from "../registry";
import type { PublicShop } from "../../storefront/data";
import type { Theme } from "../../themes/types";

export const INQUIRIES_MODULE = "inquiries";
/** 担当者（0068） */
export const INQUIRY_ASSIGNEE_MIGRATION = "0068_mod_inquiries_assignee";

export const INQUIRY_CATEGORIES = ["product", "order", "account", "other"] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];
export const INQUIRY_STATUSES = ["waiting_shop", "waiting_customer", "closed"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
export const BODY_MAX = 5000;
export { ORDER_TOKEN_SECONDS } from "../../orders/lookup";
/** チケットを開いた端末に置く Cookie の期限（リンクのトークンの期限と同じ 30 日。DB が期限を確かめる） */
export const THREAD_COOKIE_SECONDS = 30 * 24 * 60 * 60;

export const isCategory = (v: unknown): v is InquiryCategory => typeof v === "string" && (INQUIRY_CATEGORIES as readonly string[]).includes(v);
export const categoryLabel = (c: string) => (isCategory(c) ? t(`inq.category_${c}` as MessageKey) : c);
export const statusLabel = (s: string) => ((INQUIRY_STATUSES as readonly string[]).includes(s) ? t(`inq.status_${s}` as MessageKey) : s);

/** そのショップで使えるか（モジュールが ON・テーマに画面がある）。キャッシュ済みのショップ行だけで判定 */
export function inquiriesReady(shop: Pick<PublicShop, "settings">, theme?: Pick<Theme, "InquiryPage">): boolean {
  return moduleEnabled(shop.settings, INQUIRIES_MODULE) && !(theme && !theme.InquiryPage);
}

export interface InquiryTemplate {
  title: string;
  body: string;
}

export interface InquirySettings {
  /** 運営者へのお知らせの宛先（無ければショップの問い合わせ先 settings.contact_email） */
  notify_email: string | null;
  /** 返事の定型文（運営者の画面で差し込む。{name}・{number}・{shop} を置き換える） */
  templates: InquiryTemplate[];
}

export const MAX_TEMPLATES = 10;
export const TEMPLATE_TITLE_MAX = 50;
export const TEMPLATE_BODY_MAX = 2000;

export function inquirySettings(settings: Record<string, unknown> | null | undefined): InquirySettings {
  const raw = (settings ?? {})["inquiries"];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const v = typeof o["notify_email"] === "string" ? o["notify_email"].trim() : "";
  return { notify_email: v && isEmailLike(v) ? v : null, templates: inquiryTemplates(o["templates"]) };
}

/** 定型文（題と本文の両方があるものだけ、MAX_TEMPLATES 個まで） */
export function inquiryTemplates(v: unknown): InquiryTemplate[] {
  if (!Array.isArray(v)) return [];
  const out: InquiryTemplate[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const title = typeof r["title"] === "string" ? r["title"].replace(/[\r\n]+/g, " ").trim().slice(0, TEMPLATE_TITLE_MAX) : "";
    const body = typeof r["body"] === "string" ? r["body"].replace(/\r\n?/g, "\n").trim().slice(0, TEMPLATE_BODY_MAX) : "";
    if (title && body) out.push({ title, body });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** 定型文の {name}（お客様のお名前。無ければ「お客様」）・{number}（受付番号）・{shop}（ショップ名）を置き換える */
export function fillTemplate(body: string, vars: { name: string | null; number: number; shop: string }): string {
  return body.replace(/\{(name|number|shop)\}/g, (_, k: string) => (k === "name" ? vars.name || t("inq.template_default_name") : k === "number" ? String(vars.number) : vars.shop));
}

const isEmailLike = (s: string) => s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export interface InquiryInput {
  category: InquiryCategory | "";
  body: string;
  name: string;
  email: string;
  /** 申告された注文番号（数字だけ。空なら無し） */
  order_number: string;
}

/** フォームの値を整え、確かめる。needEmail はゲスト（会員・注文からはアドレスを入れさせない） */
export function checkInquiry(form: Record<string, string | undefined>, opts: { needEmail: boolean }): { input: InquiryInput; error: MessageKey | null } {
  const one = (v: string | undefined, max: number) => (v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  const category = one(form["category"], 20);
  const input: InquiryInput = {
    category: isCategory(category) ? category : "",
    body: (form["body"] ?? "").replace(/\r\n?/g, "\n").trim().slice(0, BODY_MAX),
    name: one(form["name"], 100),
    email: one(form["email"], 254).toLowerCase(),
    order_number: one(form["order_number"], 12).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, ""),
  };
  if (!input.category) return { input, error: "inq.error_category" };
  if (!input.body) return { input, error: "inq.error_body" };
  if (opts.needEmail && !isEmailLike(input.email)) return { input, error: "inq.error_email" };
  return { input, error: null };
}

// ---------- 注文トークン（src/orders/lookup.ts。注文照会・領収書と同じもの） ----------
export { openOrderToken, sealOrderToken };

// ---------- チケットを開いた端末の Cookie（リンクのトークンを封じて持つ） ----------
const threadSecret = (secret: string, shopId: string) => `${secret}|inquiry-thread|${shopId}`;
export const threadCookieName = (shopId: string) => `banto_inq_${shopId.replace(/[^a-zA-Z0-9]/g, "")}`;

export function sealThread(secret: string, shopId: string, token: string): Promise<string> {
  return sealJson(threadSecret(secret, shopId), { t: token, exp: Math.floor(Date.now() / 1000) + THREAD_COOKIE_SECONDS });
}

export async function openThread(secret: string, shopId: string, raw: string | undefined): Promise<string | null> {
  const v = (await openJson(threadSecret(secret, shopId), raw)) as { t?: unknown; exp?: unknown } | null;
  return v && typeof v.t === "string" && typeof v.exp === "number" && v.exp * 1000 > Date.now() ? v.t : null;
}

export const validLinkToken = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(token);

// ---------- 流れ ----------
export interface InquiryDeps {
  db: PrivilegedDb;
  secret: string;
  mailer: Mailer | null;
  /** 管理画面の URL（PUBLIC_BASE_URL）。運営者へのお知らせのリンクに使う */
  adminBase: string;
  /** 添付の置き場（公開しないバケット）。無ければ添付を受け付けない */
  privateStorage?: StorageAdapter | null;
}

export type InquiryBasis = { kind: "form" } | { kind: "member"; customerId: string; epoch: number } | { kind: "order"; orderId: string } | { kind: "checkout"; quoteId: string };

export type InquiryError =
  | "disabled"
  | "unavailable"
  | "invalid"
  | "too_many"
  | "order_not_found"
  | "invalid_member"
  | "limit"
  | "closed"
  | "not_found"
  | "attachments_unavailable"
  | "attachment_too_many"
  | "attachment_too_large"
  | "attachment_type";

function rpcError(e: unknown): InquiryError | null {
  if (planLimitOf(e)) return "limit"; // 1 日のメールの上限（0053、plan_limits.mail_per_day）
  if (!(e instanceof PrivilegedRpcError)) return null;
  if (e.is("inquiries_disabled")) return "disabled";
  if (e.is("mail_not_configured")) return "unavailable";
  if (e.is("too_many_requests")) return "too_many";
  if (e.is("order_not_found") || e.is("order_unavailable")) return "order_not_found";
  if (e.is("invalid_member")) return "invalid_member";
  if (e.is("inquiry_closed")) return "closed";
  if (e.is("inquiry_not_found")) return "not_found";
  if (e.is("too_many_attachments")) return "attachment_too_many";
  if (e.is("invalid_attachment")) return "attachment_type";
  if (e.is("invalid_category") || e.is("invalid_body") || e.is("invalid_email") || e.is("invalid_basis")) return "invalid";
  return null;
}

async function ipHashOf(secret: string, ip: string | null): Promise<string | null> {
  return ip ? ipHash(secret, ip) : null;
}

/** 送れなかったら false（チケットはできている。お客様には「リンクを送り直す」を案内する） */
async function trySend(mailer: Mailer | null, mail: Parameters<typeof sendMail>[1]): Promise<boolean> {
  try {
    await sendMail(mailer, mail);
    return true;
  } catch (e) {
    if (e instanceof MailError) {
      console.error("[banto] inquiries: mail failed:", e.status, e.message);
      return false;
    }
    throw e;
  }
}

/** 運営者へのお知らせ（DB が「送ってよい」と決めたときだけ。失敗しても問い合わせは止めない） */
async function notifyShop(deps: InquiryDeps, shop: InquiryMailShop, notify: { send: boolean; to: string | null } | null, from: string | null, kind: "new" | "reply", inquiry: { id: string; number: number; category?: string }) {
  if (!notify?.send || !notify.to || !from) return;
  await trySend(deps.mailer, { from, to: notify.to, ...buildShopNotice(kind, shop, inquiry, `${deps.adminBase}/admin/shops/${shop.id}/modules/inquiries/${inquiry.id}`) });
}

/** 担当になった人へのお知らせ（0068。DB が「送ってよい」と決めたときだけ。管理画面のチケットへのリンクだけで、本文は載せない） */
export async function sendAssignNotice(deps: { mailer: Mailer | null; adminBase: string }, shop: InquiryMailShop, r: { inquiry_id: string; number: number; send: boolean; to: string | null; mail_from: string | null }): Promise<boolean> {
  if (!r.send || !r.to || !r.mail_from) return false;
  return trySend(deps.mailer, { from: r.mail_from, to: r.to, ...buildShopNotice("assign", shop, { number: r.number }, `${deps.adminBase}/admin/shops/${shop.id}/modules/inquiries/${r.inquiry_id}`) });
}

export type SubmitResult = { ok: true; number: number; verified: boolean; mailSent: boolean } | { ok: false; error: InquiryError };

/**
 * 送る。link(token) がメールのリンクの URL（同梱テーマなら /inquiries/open?t=…、ヘッドレスなら連携サイトの画面）。
 * returnTo はヘッドレスの連携サイトの画面（許可リストで確かめたもの）。運営者が返事を書いたときのリンクもそこへ向ける
 */
export async function submitInquiry(
  deps: InquiryDeps,
  shop: InquiryMailShop,
  input: InquiryInput,
  basis: InquiryBasis,
  opts: { ip: string | null; link: (token: string) => string; returnTo: string | null },
): Promise<SubmitResult> {
  const token = randomToken(32);
  const payload: Record<string, unknown> = { basis: basis.kind, category: input.category, body: input.body, name: input.name || null, order_number: input.order_number || null, return_to: opts.returnTo };
  if (basis.kind === "form") payload["email"] = input.email;
  if (basis.kind === "member") Object.assign(payload, { customer_id: basis.customerId, epoch: basis.epoch });
  if (basis.kind === "order") payload["order_id"] = basis.orderId;
  if (basis.kind === "checkout") payload["quote_id"] = basis.quoteId;
  let r;
  try {
    r = await deps.db.inquiryCreate(shop.id, payload, await inquiryLinkHash(deps.secret, token), await ipHashOf(deps.secret, opts.ip));
  } catch (e) {
    const err = rpcError(e);
    if (err) return { ok: false, error: err };
    throw e;
  }
  const mailSent = r.send ? await trySend(deps.mailer, { from: r.mail_from, to: r.to, ...buildCustomerMail(r.kind, shop, r.number, opts.link(token)) }) : false;
  await notifyShop(deps, shop, r.notify, r.mail_from, "new", { id: r.id, number: r.number, category: input.category });
  return { ok: true, number: r.number, verified: r.verified, mailSent };
}

/** チケットを開く（リンクで初めて開いたら確認済みになり、運営者に知らせる）。合わなければ null */
export async function openInquiry(deps: InquiryDeps, shop: InquiryMailShop, access: { token: string } | { customerId: string; epoch: number; number: number }): Promise<InquiryView | null> {
  const a = await accessOf(deps, access);
  if (!a) return null;
  const r = await deps.db.inquiryGet(shop.id, a);
  if (!r) return null;
  await notifyShop(deps, shop, r.notify, r.mail_from, "new", { id: r.inquiry.id, number: r.inquiry.number, category: r.inquiry.category });
  return r.inquiry;
}

async function accessOf(deps: InquiryDeps, access: { token: string } | { customerId: string; epoch: number; number: number }): Promise<InquiryAccess | null> {
  if ("token" in access) return validLinkToken(access.token) ? { link_hash: await inquiryLinkHash(deps.secret, access.token) } : null;
  return { customer_id: access.customerId, epoch: access.epoch, number: access.number };
}

/** お客様が続きを書く */
export async function replyAsCustomer(
  deps: InquiryDeps,
  shop: InquiryMailShop,
  access: { token: string } | { customerId: string; epoch: number; number: number },
  body: string,
  ip: string | null,
  files: File[] = [],
): Promise<{ ok: true; number: number } | { ok: false; error: InquiryError }> {
  const text = body.replace(/\r\n?/g, "\n").trim().slice(0, BODY_MAX);
  if (!text) return { ok: false, error: "invalid" };
  const a = await accessOf(deps, access);
  if (!a) return { ok: false, error: "not_found" };
  const stored = await storeFor(deps, shop.id, files);
  if (!stored.ok) return stored;
  let r;
  try {
    r = await deps.db.inquiryCustomerReply(shop.id, a, text, await ipHashOf(deps.secret, ip), stored.stored);
  } catch (e) {
    if (deps.privateStorage && stored.stored.length > 0) await removeAttachments(deps.privateStorage, stored.stored.map((x) => x.key));
    const err = rpcError(e);
    if (err) return { ok: false, error: err };
    throw e;
  }
  await notifyShop(deps, shop, r.notify, r.mail_from, "reply", { id: r.id, number: r.number });
  return { ok: true, number: r.number };
}

/** 添付を置き場に置く（無ければ空。置き場が無いのに添付があれば断る） */
export async function storeFor(deps: Pick<InquiryDeps, "privateStorage">, shopId: string, files: File[]): Promise<{ ok: true; stored: StoredAttachment[] } | { ok: false; error: InquiryError }> {
  if (files.length === 0) return { ok: true, stored: [] };
  if (!deps.privateStorage) return { ok: false, error: "attachments_unavailable" };
  const r = await storeAttachments(deps.privateStorage, shopId, files);
  if (!r.ok) return { ok: false, error: r.error === "too_many" ? "attachment_too_many" : r.error === "too_large" ? "attachment_too_large" : "attachment_type" };
  return r;
}

/** リンクを送り直す（受付番号とメールアドレス）。合わなくても ok（送ったかどうかは返さない） */
export async function resendInquiryLink(
  deps: InquiryDeps,
  shop: InquiryMailShop,
  number: number,
  email: string,
  opts: { ip: string | null; link: (token: string) => string },
): Promise<{ ok: true } | { ok: false; error: InquiryError }> {
  const token = randomToken(32);
  let r;
  try {
    r = await deps.db.inquiryResendLink(shop.id, number, email, await inquiryLinkHash(deps.secret, token), await ipHashOf(deps.secret, opts.ip), await inquiryEmailHash(deps.secret, email));
  } catch (e) {
    const err = rpcError(e);
    if (err) return { ok: false, error: err };
    throw e;
  }
  if (r.send && r.to && r.number !== null) await trySend(deps.mailer, { from: r.mail_from, to: r.to, ...buildCustomerMail("link", shop, r.number, opts.link(token)) });
  return { ok: true };
}

/** 注文を確かめる（ゲスト。番号とメールアドレス）。合えば要約と注文トークン */
export async function checkOrder(
  deps: InquiryDeps,
  shopId: string,
  number: number,
  email: string,
  ip: string | null,
): Promise<{ ok: true; order: InquiryOrderSummary | null; token: string | null } | { ok: false; error: InquiryError }> {
  try {
    const order = await deps.db.inquiryOrderCheck(shopId, number, email, await ipHashOf(deps.secret, ip), await inquiryEmailHash(deps.secret, email));
    return { ok: true, order, token: order ? await sealOrderToken(deps.secret, shopId, number, email) : null };
  } catch (e) {
    const err = rpcError(e);
    if (err) return { ok: false, error: err };
    throw e;
  }
}

/** 運営者が返事を書いた後のお知らせ（管理画面から。DB が送ってよいと決めたときだけ） */
export async function sendReplyNotice(deps: Pick<InquiryDeps, "mailer">, shop: InquiryMailShop, r: { send: boolean; to: string | null; mail_from: string | null; number: number }, link: string): Promise<boolean> {
  if (!r.send || !r.to || !r.mail_from) return false;
  return trySend(deps.mailer, { from: r.mail_from, to: r.to, ...buildCustomerMail("reply", shop, r.number, link) });
}

/** お客様の画面の文言（エラーの種類 → 文言のキー） */
export const ERROR_MESSAGES: Record<InquiryError, MessageKey> = {
  disabled: "inq.error_unavailable",
  unavailable: "inq.error_unavailable",
  invalid: "inq.error_body",
  too_many: "inq.error_too_many",
  order_not_found: "inq.error_order",
  invalid_member: "inq.error_session",
  limit: "inq.error_limit",
  closed: "inq.error_closed",
  not_found: "inq.error_not_found",
  attachments_unavailable: "inq.error_attachments_unavailable",
  attachment_too_many: "inq.error_attachment_too_many",
  attachment_too_large: "inq.error_attachment_too_large",
  attachment_type: "inq.error_attachment_type",
};
