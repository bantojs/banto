/**
 * お問い合わせ（同梱モジュール inquiries、既定 OFF。docs/inquiries.md、0061_mod_inquiries.sql）の同梱テーマの画面。
 *   GET  /:shop/inquiries            会員なら自分の問い合わせの一覧。ゲストには新しく問い合わせる・リンクを送り直すの案内
 *   GET  /:shop/inquiries/new        フォーム（?s= 購入完了の画面の状態トークン、?order= 会員の注文番号）
 *   POST /:shop/inquiries/new        フォーム（注文照会の結果から: o = 注文トークン。メールアドレスを URL に載せないため POST）・確認画面の「修正する」
 *   POST /:shop/inquiries/confirm    確認画面（結ぶ注文の要約。ゲストの注文番号はここで確かめる）
 *   POST /:shop/inquiries/submit     送る → 受け付けた画面
 *   GET  /:shop/inquiries/open?t=    メールのリンクの先。GET は確認画面だけ（メールの安全検査が先に開いても確認済みにしない）
 *   POST /:shop/inquiries/open       リンクのトークンを Cookie に封じて、やり取りの画面へ
 *   GET  /:shop/inquiries/thread     やり取り（Cookie のリンク、会員は ?n=<受付番号>）
 *   POST /:shop/inquiries/reply      続きを書く
 *   GET|POST /:shop/inquiries/resend リンクを送り直す（受付番号とメールアドレス）
 * どれもお店の画面の使い方（full / checkout / off）に関係なく出す（メールのリンクが指すため。src/storefront/mode.ts）。
 * 判定はすべて src/modules/inquiries と DB の関数。ここは画面の出し分けだけ。
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { StorefrontData, PublicShop } from "../../storefront/data";
import type { ThemeContext, InquiryOrderView, InquiryThreadView } from "../../themes/types";
import type { Theme } from "../../themes";
import { t, tf } from "../../i18n";
import {
  ERROR_MESSAGES,
  INQUIRY_CATEGORIES,
  THREAD_COOKIE_SECONDS,
  categoryLabel,
  checkInquiry,
  checkOrder,
  inquiriesReady,
  openInquiry,
  openOrderToken,
  openThread,
  replyAsCustomer,
  resendInquiryLink,
  sealThread,
  statusLabel,
  submitInquiry,
  threadCookieName,
  validLinkToken,
  type InquiryBasis,
  type InquiryDeps,
  type InquiryInput,
} from "../../modules/inquiries";
import { inquiryLinkHash } from "../../members/auth";
import { ATTACHMENT_ACCEPT, attachmentResponse, filesOf } from "../../modules/inquiries/attachments";
import type { InquiryAccess } from "../../db/privileged";

/** 画面の開く手段を DB に渡す形にする（リンクのトークンは HMAC に） */
async function accessOf(s: Ready, a: { token: string } | { customerId: string; epoch: number; number: number }): Promise<InquiryAccess> {
  return "token" in a ? { link_hash: await inquiryLinkHash(s.deps.secret, a.token) } : { customer_id: a.customerId, epoch: a.epoch, number: a.number };
}
import { createMailer } from "../../mail/send";
import { openStatusToken } from "../../commerce/checkout";
import { shopHome } from "../../storefront/urls";
import { readCookie } from "../../util/signed";
import { privilegedFor } from "../payment-deps";
import { clientIpFor, csrfGuard, formFields, isSecureRequest, publicBaseUrl, yen, type Ctx } from "../common";
import { customerSession, type MemberSession } from "./members";
import type { InquiryView } from "../../db/privileged";

interface Scope {
  shop: PublicShop;
  sf: StorefrontData;
  ctx: ThemeContext;
  theme: Theme;
}

export type InquiryScopeResolver = (c: Ctx) => Promise<Scope | null>;
let resolveScope: InquiryScopeResolver | null = null;
export function bindInquiryScope(fn: InquiryScopeResolver): void {
  resolveScope = fn;
}

interface Ready extends Scope {
  page: NonNullable<Theme["InquiryPage"]>;
  deps: InquiryDeps;
  member: MemberSession | null;
}

async function scope(c: Ctx): Promise<Ready | null> {
  if (!resolveScope) return null;
  const s = await resolveScope(c);
  if (!s || !s.theme.InquiryPage || !(await inquiriesReady(s.sf, s.shop, s.theme))) return null;
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!secret || !db) return null;
  const doFetch = c.get("deps").fetch;
  const member = s.ctx.membersEnabled ? await customerSession(c, { shop: s.shop }) : null;
  const privateStorage = c.get("adapters").privateStorage ?? null;
  return { ...s, page: s.theme.InquiryPage.bind(s.theme), deps: { db, secret, mailer: createMailer(c.get("adapters"), doFetch), adminBase: publicBaseUrl(c), privateStorage }, member };
}

export const inquiries = new Hono<AppEnv>();
inquiries.use("*", csrfGuard);

const notFound = (c: Ctx) => c.text(t("store.not_found"), 404);
const CATEGORIES = () => INQUIRY_CATEGORIES.map((v) => ({ value: v, label: categoryLabel(v) }));

/** リンクのトークンを Referer で外に出さず、キャッシュさせない（members.ts の privatePage と同じ理由で same-origin） */
function privatePage(c: Ctx): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "same-origin");
}

type PageProps = Omit<Parameters<Ready["page"]>[0], "ctx" | "categories">;
function render(c: Ctx, s: Ready, props: PageProps, status: 200 | 400 | 404 | 409 | 429 = 200) {
  privatePage(c);
  return c.html(s.page({ ctx: s.ctx, categories: CATEGORIES(), ...props }), status);
}

const linkFor = (c: Ctx, s: Ready) => (token: string) => `${shopHome(publicBaseUrl(c), s.shop)}/inquiries/open?t=${token}`;
const ORDER_FIELDS = ["s", "o"] as const;

/** 注文から開いたときの注文（s = 購入完了の画面の状態トークン、o = 注文照会の結果の注文トークン、会員の注文番号） */
async function fixedOrder(s: Ready, f: Record<string, string | undefined>): Promise<{ order: InquiryOrderView & { order_id: string }; basis: InquiryBasis; hidden: Record<string, string> } | null> {
  const st = f["s"] ? await openStatusToken(s.deps.secret, f["s"], s.shop.id) : null;
  if (st) {
    const order = await s.deps.db.inquiryOrderRef(s.shop.id, { quote_id: st.quoteId });
    return order ? { order, basis: { kind: "checkout", quoteId: st.quoteId }, hidden: { s: f["s"]! } } : null;
  }
  const ot = f["o"] ? await openOrderToken(s.deps.secret, s.shop.id, f["o"]) : null;
  if (ot) {
    const order = await s.deps.db.inquiryOrderRef(s.shop.id, { number: ot.number, email: ot.email });
    return order ? { order, basis: { kind: "order", orderId: order.order_id }, hidden: { o: f["o"]! } } : null;
  }
  return null;
}

const hiddenOf = (f: Record<string, string | undefined>) => Object.fromEntries(ORDER_FIELDS.filter((k) => f[k]).map((k) => [k, f[k]!]));

async function memberOrders(s: Ready): Promise<{ number: number; label: string }[] | null> {
  if (!s.member) return null;
  const rec = await s.deps.db.memberGet(s.shop.id, s.member.cid, s.member.ep, true).catch(() => null);
  return (rec?.orders ?? []).map((o) => ({ number: Number(o["number"]), label: `${o["number"]}（${String(o["created_at"]).slice(0, 10)}・${yen(Number(o["total_jpy"] ?? 0))}）` }));
}

async function formPage(c: Ctx, s: Ready, f: Record<string, string | undefined>, error?: string, status: 200 | 400 | 404 | 409 | 429 = 200) {
  const fixed = await fixedOrder(s, f);
  const values = { category: f["category"] ?? (fixed ? "order" : ""), body: f["body"] ?? "", name: f["name"] ?? "", email: f["email"] ?? "", order_number: f["order_number"] ?? "" };
  return render(c, s, { step: "form", values, hidden: fixed?.hidden ?? {}, askEmail: !s.member && !fixed, order: fixed?.order ?? null, orders: fixed ? null : await memberOrders(s), ...(error ? { error } : {}) }, status);
}

inquiries.get("/:shop/inquiries", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  if (!s.member) return render(c, s, { step: "list", values: {}, list: [] });
  const rows = (await s.deps.db.inquiryMemberList(s.shop.id, s.member.cid, s.member.ep)) ?? [];
  return render(c, s, { step: "list", values: {}, list: rows.map((r) => ({ ...r, statusLabel: statusLabel(r.status), categoryLabel: categoryLabel(r.category) })) });
});

inquiries.get("/:shop/inquiries/new", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const q = { s: c.req.query("s"), category: c.req.query("category"), order_number: c.req.query("order") };
  if (q.order_number && !/^[0-9]{1,9}$/.test(q.order_number)) q.order_number = undefined;
  if (q.order_number && !q.category) q.category = "order";
  return formPage(c, s, q);
});

inquiries.post("/:shop/inquiries/new", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  return formPage(c, s, await formFields(c));
});

inquiries.post("/:shop/inquiries/confirm", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  const fixed = await fixedOrder(s, f);
  const r = checkInquiry(f, { needEmail: !s.member && !fixed });
  if (r.error) return formPage(c, s, f, t(r.error), 400);
  const hidden = { ...hiddenOf(f), ...flat(r.input) };
  if (fixed) return render(c, s, { step: "confirm", values: r.input, hidden, order: fixed.order });
  if (!r.input.order_number) return render(c, s, { step: "confirm", values: r.input, hidden, askEmail: !s.member });
  const number = Number(r.input.order_number);
  if (s.member) {
    const order = await s.deps.db.inquiryOrderRef(s.shop.id, { customer_id: s.member.cid, epoch: s.member.ep, number });
    return render(c, s, { step: "confirm", values: r.input, hidden, order, orderUnmatched: !order });
  }
  const checked = await checkOrder(s.deps, s.shop.id, number, r.input.email, await clientIpFor(c, s.shop));
  if (!checked.ok) return formPage(c, s, f, t(ERROR_MESSAGES[checked.error]), checked.error === "too_many" ? 429 : 409);
  return render(c, s, { step: "confirm", values: r.input, hidden, order: checked.order, orderUnmatched: !checked.order, askEmail: true });
});

const flat = (i: InquiryInput): Record<string, string> => ({ category: i.category, body: i.body, name: i.name, email: i.email, order_number: i.order_number });

inquiries.post("/:shop/inquiries/submit", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  const fixed = await fixedOrder(s, f);
  if ((f["s"] || f["o"]) && !fixed) return formPage(c, s, { ...f, s: undefined, o: undefined }, t("inq.error_order"), 409);
  const r = checkInquiry(f, { needEmail: !s.member && !fixed });
  if (r.error) return formPage(c, s, f, t(r.error), 400);
  const basis: InquiryBasis = fixed ? fixed.basis : s.member ? { kind: "member", customerId: s.member.cid, epoch: s.member.ep } : { kind: "form" };
  const res = await submitInquiry(s.deps, s.shop, r.input, basis, { ip: await clientIpFor(c, s.shop), link: linkFor(c, s), returnTo: null });
  if (!res.ok) return formPage(c, s, f, t(ERROR_MESSAGES[res.error]), res.error === "too_many" || res.error === "limit" ? 429 : 409);
  return render(c, s, { step: "sent", values: {}, sent: { number: res.number, verified: res.verified, mailSent: res.mailSent } });
});

inquiries.get("/:shop/inquiries/open", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const token = c.req.query("t");
  const peek = validLinkToken(token) ? await s.deps.db.inquiryPeek(s.shop.id, await inquiryLinkHash(s.deps.secret, token)) : null;
  if (!peek || !validLinkToken(token)) return render(c, s, { step: "resend", values: {}, error: t("inq.link_expired") }, 404);
  return render(c, s, { step: "open", values: {}, token, sent: { number: peek.number, verified: true, mailSent: true } });
});

inquiries.post("/:shop/inquiries/open", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const token = (await formFields(c))["t"];
  if (!validLinkToken(token)) return render(c, s, { step: "resend", values: {}, error: t("inq.link_expired") }, 404);
  const name = threadCookieName(s.shop.id);
  const path = s.ctx.shopPath || "/";
  c.header("Set-Cookie", [`${name}=${await sealThread(s.deps.secret, s.shop.id, token)}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${THREAD_COOKIE_SECONDS}`, ...(isSecureRequest(c) ? ["Secure"] : [])].join("; "), { append: true });
  return c.redirect(`${s.ctx.shopPath}/inquiries/thread`, 303);
});

/** やり取りの画面で開く手段（会員の受付番号が先。無ければこの端末の Cookie のリンク） */
async function accessFor(c: Ctx, s: Ready, n: string | undefined): Promise<{ token: string } | { customerId: string; epoch: number; number: number } | null> {
  if (s.member && n && /^[0-9]{1,9}$/.test(n)) return { customerId: s.member.cid, epoch: s.member.ep, number: Number(n) };
  const token = await openThread(s.deps.secret, s.shop.id, readCookie(c.req.header("cookie"), threadCookieName(s.shop.id)));
  return token ? { token } : null;
}

function threadView(s: Ready, v: InquiryView, replyHidden: Record<string, string>): InquiryThreadView {
  const q = replyHidden["n"] ? `?n=${replyHidden["n"]}` : "";
  return {
    number: v.number,
    status: v.status,
    statusLabel: statusLabel(v.status),
    categoryLabel: categoryLabel(v.category),
    created_at: v.created_at,
    order: v.order ? { number: v.order.number } : null,
    claimed_order_number: v.claimed_order_number,
    messages: v.messages.map((m) => ({ ...m, attachments: (m.attachments ?? []).map((a) => ({ href: `${s.ctx.shopPath}/inquiries/attachments/${a.id}${q}`, filename: a.filename, content_type: a.content_type, size: a.size })) })),
    canReply: v.status !== "closed",
    canAttach: !!s.deps.privateStorage,
    attachAccept: ATTACHMENT_ACCEPT,
    replyHidden,
  };
}

async function threadPage(c: Ctx, s: Ready, n: string | undefined, extra: { error?: string; info?: string } = {}, status: 200 | 400 | 409 | 429 = 200) {
  const access = await accessFor(c, s, n);
  const v = access ? await openInquiry(s.deps, s.shop, access) : null;
  if (!v) return render(c, s, { step: "resend", values: {}, error: t("inq.link_expired") }, 404);
  return render(c, s, { step: "thread", values: {}, inquiry: threadView(s, v, access && "customerId" in access ? { n: String(v.number) } : {}), ...extra }, status);
}

inquiries.get("/:shop/inquiries/thread", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const flash = c.req.query("flash");
  return threadPage(c, s, c.req.query("n"), flash === "sent" ? { info: t("inq.reply_sent") } : {});
});

inquiries.post("/:shop/inquiries/reply", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const raw = await c.req.parseBody({ all: true });
  const field = (k: string) => {
    const v = raw[k];
    const one = Array.isArray(v) ? v[0] : v;
    return typeof one === "string" ? one : undefined;
  };
  const access = await accessFor(c, s, field("n"));
  if (!access) return render(c, s, { step: "resend", values: {}, error: t("inq.link_expired") }, 404);
  const r = await replyAsCustomer(s.deps, s.shop, access, field("body") ?? "", await clientIpFor(c, s.shop), filesOf(raw));
  if (!r.ok) return threadPage(c, s, field("n"), { error: t(ERROR_MESSAGES[r.error]) }, r.error === "too_many" ? 429 : r.error.startsWith("attachment") ? 400 : 409);
  return c.redirect(`${s.ctx.shopPath}/inquiries/thread?${"customerId" in access ? `n=${r.number}&` : ""}flash=sent`, 303);
});

/** 添付を配る（そのチケットを開ける人だけ。会員は ?n=<受付番号>、それ以外はこの端末の Cookie のリンク） */
inquiries.get("/:shop/inquiries/attachments/:id{[0-9a-f-]{36}}", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !s.deps.privateStorage) return notFound(c);
  const access = await accessFor(c, s, c.req.query("n"));
  const a = access ? await accessOf(s, access) : null;
  const meta = a ? await s.deps.db.inquiryAttachmentGet(s.shop.id, a, c.req.param("id") ?? "") : null;
  const res = meta ? await attachmentResponse(s.deps.privateStorage, meta) : null;
  return res ?? notFound(c);
});

inquiries.get("/:shop/inquiries/resend", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  return render(c, s, { step: "resend", values: {} });
});

inquiries.post("/:shop/inquiries/resend", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  const number = Number.parseInt((f["number"] ?? "").replace(/[^0-9]/g, ""), 10);
  const email = (f["email"] ?? "").trim().toLowerCase();
  if (!Number.isInteger(number) || number <= 0 || !email) return render(c, s, { step: "resend", values: { email }, error: t("inq.error_resend") }, 400);
  const r = await resendInquiryLink(s.deps, s.shop, number, email, { ip: await clientIpFor(c, s.shop), link: linkFor(c, s) });
  if (!r.ok) return render(c, s, { step: "resend", values: { email }, error: t(ERROR_MESSAGES[r.error]) }, r.error === "too_many" ? 429 : 409);
  // 合ったかどうかは言わない（受付番号とアドレスの組を探られないように）
  return render(c, s, { step: "resend", values: {}, info: tf("inq.resend_done", { email }) });
});

