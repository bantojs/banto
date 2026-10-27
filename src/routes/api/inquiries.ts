import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { createMailer } from "../../mail/send";
import { openStatusToken, returnOrigins, safeReturnUrl, withQueryParam } from "../../commerce/checkout";
import { shopHome } from "../../storefront/urls";
import {
  ERROR_MESSAGES,
  INQUIRY_CATEGORIES,
  inquiriesReady,
  categoryLabel,
  checkInquiry,
  checkOrder,
  openInquiry,
  openOrderToken,
  replyAsCustomer,
  resendInquiryLink,
  statusLabel,
  submitInquiry,
  validLinkToken,
  type InquiryBasis,
  type InquiryDeps,
  type InquiryError,
} from "../../modules/inquiries";
import { privilegedFor } from "../payment-deps";
import { memberFromRequest, type ApiMember } from "./members";
import { clientIpFor, param, publicBaseUrl, type Ctx } from "../common";
import type { InquiryView } from "../../db/privileged";
import { t } from "../../i18n";

/**
 * ヘッドレスのお問い合わせ（同梱モジュール inquiries。docs/headless.md「お問い合わせ」、docs/inquiries.md）。認証なし、CORS 許可。
 * 判定は同梱テーマと同じ src/modules/inquiries と DB の関数。Authorization: Bearer に会員トークンがあれば会員として扱う。
 *
 *   GET  /api/shops/:shop/inquiries/config        種類の一覧
 *   POST /api/shops/:shop/inquiries/order-check   { number, email } → { order, order_token }（ゲストの「注文を確かめる」。合わなければ order: null）
 *   POST /api/shops/:shop/inquiries               { category, body, name?, email?, order_number?, order_token?, checkout_token?, return_to? }
 *                                                 → 201 { number, verified, mail_sent }
 *   POST /api/shops/:shop/inquiries/view          { token } か（会員）{ number } → { inquiry }
 *   POST /api/shops/:shop/inquiries/reply         { token | number, body } → { number }
 *   POST /api/shops/:shop/inquiries/resend        { number, email, return_to? } → 202（合ったかどうかは返さない）
 *   GET  /api/shops/:shop/inquiries               （会員）自分の問い合わせの一覧
 * メールのリンクは return_to（settings.headless.return_origins の許可リストのオリジンだけ）に ?banto_inquiry=<token> を付けた URL。
 * 無ければ Banto の画面（/inquiries/open）。連携側はそのトークンで view / reply を呼ぶ。
 */
export const inquiriesApi = new Hono<AppEnv>();

interface Scope {
  shop: PublicShop;
  deps: InquiryDeps;
  member: ApiMember | null;
}

async function scope(c: Ctx): Promise<Scope | Response> {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!url || !anonKey || !secret || !db) return c.json({ error: "not_configured" }, 503);
  const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
  const shop = await sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!(await inquiriesReady(sf, shop))) return c.json({ error: "inquiries_disabled" }, 404);
  const m = await memberFromRequest(c, shop);
  if (!m.ok) return c.json({ error: "invalid_member_token" }, 401);
  return { shop, member: m.member, deps: { db, secret, mailer: createMailer(c.get("adapters"), c.get("deps").fetch), adminBase: publicBaseUrl(c) } };
}

async function body(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const STATUS: Record<InquiryError, 400 | 401 | 404 | 409 | 429 | 503> = {
  disabled: 404,
  unavailable: 503,
  invalid: 400,
  too_many: 429,
  order_not_found: 409,
  invalid_member: 401,
  limit: 429,
  closed: 409,
  not_found: 404,
};
const fail = (c: Ctx, error: InquiryError) => c.json({ error, message: t(ERROR_MESSAGES[error]) }, STATUS[error]);

/** メールのリンク（連携サイトの画面が許可リストにあればそこ、無ければ Banto の画面） */
function linkFor(c: Ctx, shop: PublicShop, returnTo: string) {
  return (token: string) => (returnTo ? withQueryParam(returnTo, "banto_inquiry", token) : `${shopHome(publicBaseUrl(c), shop)}/inquiries/open?t=${token}`);
}

function inquiryJson(v: InquiryView) {
  return { ...v, status_label: statusLabel(v.status), category_label: categoryLabel(v.category), can_reply: v.status !== "closed" };
}

inquiriesApi.get("/shops/:shop/inquiries/config", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  return c.json({ categories: INQUIRY_CATEGORIES.map((v) => ({ value: v, label: categoryLabel(v) })), member: s.member ? { id: s.member.id } : null });
});

inquiriesApi.post("/shops/:shop/inquiries/order-check", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const b = await body(c);
  const number = Number.parseInt(str(b?.["number"]) ?? "", 10);
  const email = (str(b?.["email"]) ?? "").trim().toLowerCase();
  if (!Number.isInteger(number) || number <= 0 || !email) return c.json({ error: "invalid_request" }, 400);
  const r = await checkOrder(s.deps, s.shop.id, number, email, await clientIpFor(c, s.shop));
  if (!r.ok) return fail(c, r.error);
  return c.json({ order: r.order, order_token: r.token });
});

inquiriesApi.post("/shops/:shop/inquiries", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const b = await body(c);
  if (!b) return c.json({ error: "invalid_request" }, 400);
  const secret = s.deps.secret;
  // 注文の根拠: 購入完了の状態トークン（checkout_token）か、order-check の注文トークン（order_token）
  let basis: InquiryBasis | null = null;
  const st = str(b["checkout_token"]) ? await openStatusToken(secret, str(b["checkout_token"]), s.shop.id) : null;
  if (str(b["checkout_token"]) && !st) return c.json({ error: "invalid_checkout_token" }, 400);
  if (st) basis = { kind: "checkout", quoteId: st.quoteId };
  if (!basis && str(b["order_token"])) {
    const ot = await openOrderToken(secret, s.shop.id, str(b["order_token"]));
    const order = ot ? await s.deps.db.inquiryOrderRef(s.shop.id, { number: ot.number, email: ot.email }) : null;
    if (!order) return c.json({ error: "invalid_order_token" }, 400);
    basis = { kind: "order", orderId: order.order_id };
  }
  if (!basis) basis = s.member ? { kind: "member", customerId: s.member.id, epoch: s.member.epoch } : { kind: "form" };
  const form: Record<string, string | undefined> = {};
  for (const k of ["category", "body", "name", "email", "order_number"]) form[k] = str(b[k]);
  const r = checkInquiry(form, { needEmail: basis.kind === "form" });
  if (r.error) return c.json({ error: "invalid_request", field: r.error.replace(/^inq\.error_/, "") }, 400);
  const returnTo = safeReturnUrl(b["return_to"], returnOrigins(s.shop.settings), "");
  const res = await submitInquiry(s.deps, s.shop, r.input, basis, { ip: await clientIpFor(c, s.shop), link: linkFor(c, s.shop, returnTo), returnTo: returnTo || null });
  if (!res.ok) return fail(c, res.error);
  return c.json({ number: res.number, verified: res.verified, mail_sent: res.mailSent }, 201);
});

/** 開く手段: リンクのトークン（token）か、会員トークンと受付番号（number） */
function accessOf(s: Scope, b: Record<string, unknown> | null): { token: string } | { customerId: string; epoch: number; number: number } | null {
  const token = str(b?.["token"]);
  if (validLinkToken(token)) return { token };
  const n = Number.parseInt(str(b?.["number"]) ?? "", 10);
  if (s.member && Number.isInteger(n) && n > 0) return { customerId: s.member.id, epoch: s.member.epoch, number: n };
  return null;
}

inquiriesApi.post("/shops/:shop/inquiries/view", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const access = accessOf(s, await body(c));
  const v = access ? await openInquiry(s.deps, s.shop, access) : null;
  if (!v) return c.json({ error: "not_found" }, 404);
  return c.json({ inquiry: inquiryJson(v) }, 200, { "cache-control": "no-store" });
});

inquiriesApi.post("/shops/:shop/inquiries/reply", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const b = await body(c);
  const access = accessOf(s, b);
  if (!access) return c.json({ error: "not_found" }, 404);
  const r = await replyAsCustomer(s.deps, s.shop, access, str(b?.["body"]) ?? "", await clientIpFor(c, s.shop));
  if (!r.ok) return fail(c, r.error);
  return c.json({ number: r.number });
});

inquiriesApi.post("/shops/:shop/inquiries/resend", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const b = await body(c);
  const number = Number.parseInt(str(b?.["number"]) ?? "", 10);
  const email = (str(b?.["email"]) ?? "").trim().toLowerCase();
  if (!Number.isInteger(number) || number <= 0 || !email) return c.json({ error: "invalid_request" }, 400);
  const returnTo = safeReturnUrl(b?.["return_to"], returnOrigins(s.shop.settings), "");
  const r = await resendInquiryLink(s.deps, s.shop, number, email, { ip: await clientIpFor(c, s.shop), link: linkFor(c, s.shop, returnTo) });
  if (!r.ok) return fail(c, r.error);
  return c.body(null, 202);
});

inquiriesApi.get("/shops/:shop/inquiries", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  if (!s.member) return c.json({ error: "member_required" }, 401);
  const rows = await s.deps.db.inquiryMemberList(s.shop.id, s.member.id, s.member.epoch);
  if (!rows) return c.json({ error: "invalid_member_token" }, 401);
  return c.json({ inquiries: rows.map((r) => ({ ...r, status_label: statusLabel(r.status), category_label: categoryLabel(r.category) })) }, 200, { "cache-control": "no-store" });
});
