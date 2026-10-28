/**
 * 会員機能（オプトイン: shops.settings.members_enabled = true）。docs/members.md、設計は docs/knowledge/10-members-identity.md。
 * 会員 = ショップごとの customers 行（Supabase Auth ではない）。パスワードなし: メールに届く 6 桁のコードか、ログインのリンクで入る。
 *   /:shop/account             注文履歴・既定の住所
 *   /:shop/account/login       メールアドレスを入れる（初回はそのまま会員登録）
 *   /:shop/account/code        メールのコードを入れる
 *   /:shop/account/verify      メールのリンクの先。GET は確認画面だけ（メールの安全検査がリンクを先に開いても使用済みにしない）、ボタンで POST
 *   /:shop/account/logout      ログアウト / /:shop/account/logout-all 全端末からログアウト（世代を上げる）
 *   /:shop/account/address     既定の住所の保存 / /:shop/account/delete 退会
 *   /:shop/account/password-login パスワードでログイン / /:shop/account/password パスワードを決める・変える（店の設定がオンのとき、0013）
 *   /:shop/account/oauth/:provider  LINE・Google でログイン / …/link 連携 / …/unlink 連携を外す（同梱モジュール line_login・google_login、0014）
 *   /_oauth/:provider/callback  提供元からの戻り先（提供元ごとに 1 つ。どのショップかは Cookie の state で分かる）
 * 独自ドメインのショップ（0015）は、ドメインの上で /account… になり、戻り先も https://<ドメイン>/_oauth/<提供元>/callback になる。
 *   /:shop/account/sessions   ログイン中の端末 / …/:id/revoke その端末をログアウト（0045）
 *   /:shop/account/passkeys   パスキーの一覧・追加・削除 / …/passkey/* パスキーでログイン（同梱モジュール passkey、0046。独自ドメインの上だけ）
 * セッションは署名付き Cookie（Path=/:shop、独自ドメインなら Path=/。HttpOnly、SameSite=Lax、30 日、開くたびに延ばす）。中身は会員 ID と世代と
 * セッションの ID（0045 の member_sessions）。世代は会員の RPC（読み書き・予約への紐づけ）の中で確かめる。セッションの行は
 * SESSION_CHECK_SECONDS ごとに確かめ直す（ログアウト・一覧からの取り消しが効くまで最大その秒数）。
 * 会員のデータは service_role の RPC で読み書きする（RLS の経路ではない）。
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { PREFECTURES, isPrefecture } from "../../commerce/shipping";
import type { PrivilegedDb } from "../../db/privileged";
import { t, tf, type MessageKey } from "../../i18n";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_CHECK_SECONDS,
  SESSION_SECONDS,
  deviceLabel,
  deviceMark,
  passkeyChallengeHash,
  maskEmail,
  openPending,
  openSession,
  sealPending,
  sealSession,
  type MemberSession,
} from "../../members/auth";
import { peekLogin, startLogin, verifyLogin, type LoginDeps } from "../../members/login";
import { openJson, randomToken, readCookie, sealJson } from "../../util/signed";
import { moduleEnabled } from "../../modules/registry";
import { OAuthError, PROVIDERS, authorizeUrl, callbackPath, isProvider, pkce, providerClientId, providerIdentity, providerModule, secretPurpose, type Provider } from "../../modules/social-login/providers";
import { openSecret } from "../../members/secret-box";
import { ipHash, linkHash } from "../../members/auth";
import { privilegedFor } from "../payment-deps";
import { afterResponse, clientIpFor, csrfGuard, formFields, isSecureRequest, publicBaseUrl, yen, type Ctx } from "../common";
import { DEVICE_SECONDS, deviceCookieName, knownDevice, sendAccountChangeNotice, sendPasswordLoginNotice } from "../../members/notice";
import { createMailer } from "../../mail/send";
import { memberAccountUrl, shopHome, shopOrigin } from "../../storefront/urls";
import { domainUrlFor, onShopDomain, storefrontData } from "./domain";
import type { AddressFormValues } from "../../themes/types";
import type { PublicShop } from "../../storefront/data";
import type { Theme } from "../../themes";
import { MEMBER_CANCELLABLE, TRYON_MODULE, dateLabel } from "../../modules/store-tryon";
import { RECEIPT_MODULE, RECEIPT_STATUSES, receiptSettings, renderReceipt, type ReceiptOrder } from "../../modules/receipt/render";
import { PASSKEY_CLIENT_JS, PASSKEY_MODULE, sendPasskeyAddedNotice } from "../../modules/passkey";
import { COSE_ALGS, WebAuthnError, b64urlEncode, newChallenge, readAssertion, sameUserHandle, userHandleOf, verifyAssertion, verifyRegistration, type Expected } from "../../members/webauthn";
import { returnOrigins, safeReturnUrl, consentCollected } from "../../commerce/checkout";

export type { MemberSession };

export interface CustomerRow {
  id: string;
  shop_id: string;
  email: string | null;
  name: string | null;
  default_address: Record<string, unknown> | null;
}

export function membersEnabled(shop: Pick<PublicShop, "settings">): boolean {
  return (shop.settings ?? {})["members_enabled"] === true;
}

export function customerCookieName(shopId: string): string {
  return `banto_member_${shopId.replace(/[^a-zA-Z0-9]/g, "")}`;
}
const pendingCookieName = (shopId: string) => `${customerCookieName(shopId)}_p`;
const PENDING_SECONDS = 20 * 60;
/** ログインした後に開く会員の注文（注文メールのリンクから来た、0066）。中身は注文番号だけ（秘密ではない） */
const orderAfterLoginCookieName = (shopId: string) => `${customerCookieName(shopId)}_o`;

function cookieHeader(name: string, value: string, path: string, secure: boolean, maxAge: number): string {
  return [`${name}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
}

/**
 * 注文メールのリンク（?banto_order=&banto_member=1）から来た、ログインしていない会員。ログインしたら /account がこの注文へ戻す。
 * どのログインの方法（コード・リンク・パスワード・LINE・Google・パスキー）も成功したら /account へ戻るので、戻す場所は 1 か所
 */
export function rememberOrderAfterLogin(c: Ctx, s: { shop: { id: string }; shopPath: string }, number: number): void {
  c.header("Set-Cookie", cookieHeader(orderAfterLoginCookieName(s.shop.id), String(number), s.shopPath || "/", isSecureRequest(c), PENDING_SECONDS), { append: true });
}

/** Cookie はショップのパス（独自ドメインの上ではドメイン全体）に置く */
async function writeSession(c: Ctx, s: { shop: { id: string }; shopPath: string }, session: MemberSession | null): Promise<void> {
  const secret = c.get("sessionSecret");
  if (!secret) return;
  const name = customerCookieName(s.shop.id);
  const path = s.shopPath || "/";
  c.header("Set-Cookie", session ? cookieHeader(name, await sealSession(secret, s.shop.id, session), path, isSecureRequest(c), SESSION_SECONDS) : cookieHeader(name, "", path, isSecureRequest(c), 0), { append: true });
}

const cookiePath = (c: Ctx, shop: { slug: string; domain?: string | null }) => (onShopDomain(c, shop) ? "" : `/${shop.slug}`);

/** 1 つのリクエストの中では 1 回だけ確かめる（ページの部品ごとに呼ばれるため） */
const verifiedSessions = new WeakMap<Request, Promise<MemberSession | null>>();

/**
 * ログイン中の会員。無ければ null。Cookie の署名と期限を確かめ、SESSION_CHECK_SECONDS を過ぎていればセッションの行（0045）も確かめる
 * （取り消されていれば Cookie を消す）。世代は会員の RPC が確かめる
 */
export function customerSession(c: Ctx, s: { shop: { id: string; slug: string; domain?: string | null; settings?: Record<string, unknown> } }): Promise<MemberSession | null> {
  const secret = c.get("sessionSecret");
  if (!secret || (s.shop.settings ?? {})["members_enabled"] !== true) return Promise.resolve(null);
  const hit = verifiedSessions.get(c.req.raw);
  if (hit) return hit;
  const p = verifySession(c, s.shop, secret);
  verifiedSessions.set(c.req.raw, p);
  return p;
}

async function verifySession(c: Ctx, shop: { id: string; slug: string; domain?: string | null }, secret: string): Promise<MemberSession | null> {
  const v = await openSession(secret, shop.id, readCookie(c.req.header("cookie"), customerCookieName(shop.id)));
  if (!v) return null;
  const target = { shop, shopPath: cookiePath(c, shop) };
  if (!v.sid) {
    // 0045 より前の Cookie は通さない（ログインし直してもらう。行の無いセッションは取り消せないため）
    await writeSession(c, target, null);
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (v.chk !== undefined && v.chk <= now && now - v.chk < SESSION_CHECK_SECONDS) return v;
  const db = privilegedFor(c);
  if (!db) return null;
  const ok = await db.memberSessionCheck(shop.id, v.cid, v.ep, v.sid).catch(() => null);
  // 確かめられなかった（DB の一時的な失敗）: このリクエストはゲスト扱いにして、Cookie は残す
  if (ok === null) return null;
  if (!ok) {
    await writeSession(c, target, null);
    return null;
  }
  const next = { ...v, chk: now, exp: now + SESSION_SECONDS };
  await writeSession(c, target, next);
  return next;
}

/** 会員の既定住所でチェックアウトのフォームを埋める */
export async function customerPrefill(c: Ctx, s: { shop: { id: string; slug: string; settings?: Record<string, unknown> } }): Promise<AddressFormValues> {
  const session = await customerSession(c, s);
  const db = privilegedFor(c);
  if (!session || !db) return {};
  const rec = await db.memberGet(s.shop.id, session.cid, session.ep, false).catch(() => null);
  const row = rec?.customer ?? null;
  const a = (row?.default_address ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    customer_name: str(row?.name) ?? str(a["name"]),
    customer_email: str(row?.email) ?? (session.email || undefined),
    phone: str(a["phone"]),
    postal_code: str(a["postal_code"]),
    state: str(a["state"]),
    city: str(a["city"]),
    line1: str(a["line1"]),
    line2: str(a["line2"]),
  };
}

/** ログインのメールの送り手（テーマの画面とヘッドレス API で共通） */
export function loginDeps(c: Ctx): LoginDeps | null {
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!secret || !db) return null;
  const doFetch = c.get("deps").fetch;
  return { db, secret, fetch: doFetch, mailer: createMailer(c.get("adapters"), doFetch) };
}

// ---------- ルート ----------
export const members = new Hono<AppEnv>();
members.use("*", csrfGuard);

interface Scope {
  shop: PublicShop;
  theme: Theme;
  shopPath: string;
  session: MemberSession | null;
  /** お問い合わせ（同梱モジュール inquiries）のリンクを出す */
  inquiries?: boolean;
}

/** storefront/index.tsx の scope() を再利用せず、会員ルートに必要な最小限だけ組む */
export type ScopeResolver = (c: Ctx) => Promise<Scope | null>;
let resolveScope: ScopeResolver | null = null;
export function bindScope(fn: ScopeResolver): void {
  resolveScope = fn;
}

async function scope(c: Ctx): Promise<Scope | null> {
  if (!resolveScope) return null;
  const s = await resolveScope(c);
  if (!s || !membersEnabled(s.shop)) return null;
  return s;
}

const notFound = (c: Ctx) => c.text(t("store.not_found"), 404);
/** ログイン画面に出す方法（パスワード・LINE・Google） */
async function loginOptions(c: Ctx, shop: PublicShop): Promise<{ password: boolean; providers: Provider[]; passkey: boolean }> {
  return { password: (shop.settings ?? {})["members_password"] === true, providers: enabledProviders(shop), passkey: passkeyReady(c, shop) };
}
/** ショップで使える外部のログイン（モジュールが ON で、提供元の設定があるもの）。キャッシュ済みのショップ行だけで判定する */
export function enabledProviders(shop: PublicShop): Provider[] {
  return PROVIDERS.filter((p) => moduleEnabled(shop.settings, providerModule(p)) && providerClientId(shop.settings, p) !== null);
}

const ctxOf = (s: Scope, member?: { email: string }) => ({ shop: s.shop, shopPath: s.shopPath, mediaBaseUrl: "", cartCount: 0, ...(member ? { member } : {}), ...(s.inquiries ? { inquiries: true } : {}) });
/**
 * ログインの画面はキャッシュさせず、リンクのトークンを Referer で外のサイトに出さない。
 * no-referrer にはしない: 本物のブラウザは no-referrer のページのフォームの POST に `Origin: null` を付け、csrfGuard がそれを拒む
 * （2026-10-23 に Chromium で見つけた。same-origin なら外には何も送らず、同じオリジンへの POST には Origin が付く）
 */
function privatePage(c: Ctx): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "same-origin");
}

const ACCOUNT_ERRORS: Record<string, MessageKey> = {
  weak: "member.password_weak",
  oauth: "member.oauth_failed",
  reauth: "member.reauth_required",
  already_linked: "member.oauth_already_linked",
  other_linked: "member.oauth_other_linked",
  last_method: "member.oauth_last_method",
  tryon_not_cancellable: "member.tryon_not_cancellable",
};

const LOGIN_ERRORS: Record<string, MessageKey> = {
  password: "member.password_invalid",
  locked: "member.password_locked",
  oauth: "member.oauth_failed",
  reauth: "member.reauth_required",
  invalid_email: "member.invalid_email",
  unavailable: "member.unavailable",
  mail_failed: "member.mail_failed",
  expired: "member.code_expired",
  link: "member.link_failed",
  limit: "member.login_limit",
  mail_limit: "member.mail_limit",
};

members.get("/:shop/account", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  if (!s.session) return c.redirect(`${s.shopPath}/account/login`);
  const afterLogin = readCookie(c.req.header("cookie"), orderAfterLoginCookieName(s.shop.id));
  if (afterLogin) {
    c.header("Set-Cookie", cookieHeader(orderAfterLoginCookieName(s.shop.id), "", s.shopPath || "/", isSecureRequest(c), 0), { append: true });
    if (/^[0-9]{1,9}$/.test(afterLogin)) return c.redirect(`${s.shopPath}/orders/lookup?banto_order=${afterLogin}&banto_member=1`);
  }
  const db = privilegedFor(c);
  // マイクーポン（同梱モジュール coupons、0019）。モジュールが OFF なら DB に問い合わせない
  const withCoupons = Boolean(db) && moduleEnabled(s.shop.settings, "coupons");
  // お店で試着の申し込み（同梱モジュール store_tryon、0026）。モジュールが OFF なら DB に問い合わせない
  const withTryon = Boolean(db) && moduleEnabled(s.shop.settings, TRYON_MODULE);
  const [rec, coupons, tryon] = db
    ? await Promise.all([
        db.memberGet(s.shop.id, s.session.cid, s.session.ep, true),
        withCoupons ? db.memberCoupons(s.shop.id, s.session.cid, s.session.ep).catch(() => null) : Promise.resolve(null),
        withTryon ? db.memberTryonRequests(s.shop.id, s.session.cid, s.session.ep).catch(() => null) : Promise.resolve(null),
      ])
    : [null, null, null];
  if (!rec) {
    // 退会済み・全端末からログアウトした後の古いセッション
    await writeSession(c, s, null);
    return c.redirect(`${s.shopPath}/account/login`);
  }
  // 開くたびに期限を延ばす
  await writeSession(c, s, { ...s.session, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
  privatePage(c);
  const opts = await loginOptions(c, s.shop);
  const linked = rec.customer.providers ?? [];
  const security = { password: opts.password, hasPassword: rec.customer.has_password === true, providers: opts.providers.map((id) => ({ id, linked: linked.includes(id) })) };
  const errorKey = ACCOUNT_ERRORS[c.req.query("error") ?? ""];
  return c.html(
    s.theme.AccountPage({
      ctx: ctxOf(s, { email: rec.customer.email ?? s.session.email }),
      customer: rec.customer,
      orders: rec.orders,
      prefectures: PREFECTURES,
      flash: c.req.query("flash"),
      security,
      error: errorKey ? t(errorKey) : undefined,
      sessions: Boolean(s.session.sid && s.theme.MemberSessionsPage),
      passkeys: opts.passkey && Boolean(s.theme.MemberPasskeysPage),
      receipt: moduleEnabled(s.shop.settings, RECEIPT_MODULE),
      consent: consentCollected(s.shop),
      coupons: withCoupons ? (coupons ?? []) : null,
      tryon: withTryon
        ? (tryon ?? []).map((r) => ({
            number: r.number,
            status: r.status,
            store_name: r.store_name,
            visit_label: r.visit_date ? dateLabel(r.visit_date) : null,
            hold_label: r.hold_until ? dateLabel(r.hold_until) : null,
            created_at: r.created_at,
            items: r.items,
            cancellable: MEMBER_CANCELLABLE.includes(r.status),
          }))
        : null,
    }),
  );
});

/** お店で試着の申し込みを取り消す（会員本人。取り置きが終わる前だけ、0026） */
members.post("/:shop/account/tryon/:number{[0-9]+}/cancel", async (c: Ctx) => {
  const s = await scope(c);
  const db = privilegedFor(c);
  if (!s || !db || !moduleEnabled(s.shop.settings, TRYON_MODULE)) return notFound(c);
  if (!s.session) return c.redirect(`${s.shopPath}/account/login`);
  const r = await db.memberTryonCancel(s.shop.id, s.session.cid, s.session.ep, Number(c.req.param("number")));
  if (r.ok) return c.redirect(`${s.shopPath}/account?flash=tryon_cancelled`);
  if (r.reason === "session") return c.redirect(`${s.shopPath}/account/login`);
  return c.redirect(`${s.shopPath}/account?error=tryon_not_cancellable`);
});

// ---------- 先着のクーポン（同梱モジュール coupons、0020） ----------

const CLAIM_ERRORS: Record<string, MessageKey> = { already: "claim.already", exhausted: "claim.exhausted", unavailable: "claim.closed" };

members.get("/:shop/coupons/:campaign{[0-9a-f-]{36}}", async (c: Ctx) => {
  const s = await scope(c);
  const sf = storefrontData(c);
  if (!s || !sf || !moduleEnabled(s.shop.settings, "coupons") || !s.theme.CouponClaimPage) return notFound(c);
  const info = await sf.couponClaimInfo(s.shop, c.req.param("campaign") ?? "").catch(() => null);
  if (!info) return notFound(c);
  const label = info.kind === "percent" ? tf("claim.label_percent", { n: info.value }) : info.kind === "fixed" ? tf("claim.label_fixed", { amount: yen(info.value) }) : t("store.coupon_free_shipping");
  const err = CLAIM_ERRORS[c.req.query("error") ?? ""];
  privatePage(c);
  return c.html(
    s.theme.CouponClaimPage({
      ctx: ctxOf(s, s.session ? { email: s.session.email } : undefined),
      coupon: { id: info.id, name: info.name, label, ends_at: info.ends_at, min_subtotal_jpy: typeof info.conditions?.min_subtotal_jpy === "number" ? info.conditions.min_subtotal_jpy : null, remaining: info.remaining, live: info.live },
      loggedIn: Boolean(s.session),
      error: err ? t(err) : undefined,
    }),
  );
});

members.post("/:shop/coupons/:campaign{[0-9a-f-]{36}}/claim", async (c: Ctx) => {
  const s = await scope(c);
  const db = privilegedFor(c);
  if (!s || !db || !moduleEnabled(s.shop.settings, "coupons")) return notFound(c);
  const page = `${s.shopPath}/coupons/${c.req.param("campaign")}`;
  if (!s.session) return c.redirect(page);
  const r = await db.memberClaimCoupon(s.shop.id, s.session.cid, s.session.ep, c.req.param("campaign") ?? "");
  if (r.ok) return c.redirect(`${s.shopPath}/account?flash=coupon_claimed`);
  if (r.reason === "session") return c.redirect(`${s.shopPath}/account/login`);
  return c.redirect(`${page}?error=${r.reason}`);
});

/** 会員の注文の領収書（同梱モジュール receipt、0017 の member_order）。宛名の既定は会員の名前 */
members.get("/:shop/account/orders/:number{[0-9]+}/receipt", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !moduleEnabled(s.shop.settings, RECEIPT_MODULE)) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session || !db) return c.redirect(`${s.shopPath}/account/login`);
  const number = Number(c.req.param("number"));
  const order = (await db.memberOrder(s.shop.id, s.session.cid, s.session.ep, number).catch(() => null)) as ReceiptOrder | null;
  if (!order || !RECEIPT_STATUSES.includes(order.status)) return c.text(t("receipt.not_available"), 404);
  privatePage(c);
  const name = (c.req.query("name") ?? "").trim().slice(0, 100);
  return c.html(renderReceipt({ shopName: s.shop.name, settings: receiptSettings(s.shop), shopSettings: s.shop.settings, order, addressee: name, issuedAt: new Date(), nameForm: { action: `${s.shopPath}/account/orders/${number}/receipt`, method: "get", hidden: {} } }));
});

members.get("/:shop/account/login", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  if (s.session) return c.redirect(`${s.shopPath}/account`);
  const key = LOGIN_ERRORS[c.req.query("error") ?? ""];
  privatePage(c);
  return c.html(
    s.theme.MemberAuthPage({
      ctx: ctxOf(s),
      mode: "login",
      options: await loginOptions(c, s.shop),
      email: (c.req.query("email") ?? "").slice(0, 254),
      error: key ? t(key) : undefined,
      info: c.req.query("info") === "logged_out_all" ? t("member.logged_out_all") : undefined,
    }),
  );
});

members.post("/:shop/account/login", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const deps = loginDeps(c);
  if (!deps) return c.redirect(`${s.shopPath}/account/login?error=unavailable`);
  const fields = await formFields(c);
  const email = fields.email ?? "";
  const base = `${shopHome(publicBaseUrl(c), s.shop)}/account/verify`;
  const r = await startLogin(deps, s.shop, email, { ip: await clientIpFor(c, s.shop), returnTo: null, link: (id, token) => `${base}?c=${id}&t=${token}` });
  if (!r.ok) {
    if (r.error === "disabled") return notFound(c);
    return c.redirect(`${s.shopPath}/account/login?error=${r.error === "limit" ? "mail_limit" : r.error}`);
  }
  const pending = await sealPending(deps.secret, s.shop.id, { id: r.challengeId, email: r.email, exp: Math.floor(Date.now() / 1000) + PENDING_SECONDS, ...(fields.next === "passkeys" ? { next: "passkeys" as const } : {}) });
  c.header("Set-Cookie", cookieHeader(pendingCookieName(s.shop.id), pending, s.shopPath || "/", isSecureRequest(c), PENDING_SECONDS), { append: true });
  return c.redirect(`${s.shopPath}/account/code`);
});

async function pendingOf(c: Ctx, s: Scope) {
  const secret = c.get("sessionSecret");
  return secret ? openPending(secret, s.shop.id, readCookie(c.req.header("cookie"), pendingCookieName(s.shop.id))) : null;
}

function clearPending(c: Ctx, s: Scope): void {
  c.header("Set-Cookie", cookieHeader(pendingCookieName(s.shop.id), "", s.shopPath || "/", isSecureRequest(c), 0), { append: true });
}

async function signIn(c: Ctx, s: Scope, v: { customer_id: string; session_epoch: number; email: string }): Promise<boolean> {
  // この端末でログインし直した: 前のセッションは取り消す（一覧に残さない）
  const db = privilegedFor(c);
  if (s.session?.sid && db) await db.memberSessionRevoke(s.shop.id, s.session.cid, s.session.ep, s.session.sid, "logout").catch(() => false);
  if (!(await startWebSession(c, s, v))) return false;
  await markDevice(c, s, v.customer_id);
  clearPending(c, s);
  return true;
}

/**
 * ログインした端末のセッションを始める（行を作り、その ID を Cookie に入れる）。
 * 世代が変わっていた（ログインの途中で全端末からログアウトされた等）なら false
 */
async function startWebSession(c: Ctx, s: { shop: { id: string }; shopPath: string }, v: { customer_id: string; session_epoch: number; email: string }): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const db = privilegedFor(c);
  const sid = db ? await db.memberSessionStart(s.shop.id, v.customer_id, v.session_epoch, "web", deviceLabel(c.req.header("user-agent")), SESSION_ABSOLUTE_SECONDS) : null;
  if (!sid) return false;
  await writeSession(c, s, { cid: v.customer_id, ep: v.session_epoch, email: v.email, exp: now + SESSION_SECONDS, iat: now, sid, chk: now });
  return true;
}

/** この端末でこの会員がログインした印（次からパスワードでのログインを知らせない。src/members/notice.ts） */
async function markDevice(c: Ctx, s: { shop: { id: string }; shopPath: string }, customerId: string): Promise<void> {
  const secret = c.get("sessionSecret");
  if (!secret) return;
  c.header("Set-Cookie", cookieHeader(deviceCookieName(s.shop.id), await deviceMark(secret, s.shop.id, customerId), s.shopPath || "/", isSecureRequest(c), DEVICE_SECONDS), { append: true });
}

members.get("/:shop/account/code", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const pending = await pendingOf(c, s);
  if (!pending) return c.redirect(`${s.shopPath}/account/login`);
  privatePage(c);
  return c.html(s.theme.MemberAuthPage({ ctx: ctxOf(s), mode: "code", email: pending.email, error: c.req.query("error") === "failed" ? t("member.code_failed") : undefined }));
});

members.post("/:shop/account/code", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const deps = loginDeps(c);
  const pending = await pendingOf(c, s);
  if (!deps || !pending) return c.redirect(`${s.shopPath}/account/login`);
  const v = await verifyLogin(deps, s.shop.id, pending.id, { code: (await formFields(c)).code ?? "" });
  if (!v.ok) {
    if (v.reason === "expired" || v.reason === "limit") {
      clearPending(c, s);
      return c.redirect(`${s.shopPath}/account/login?error=${v.reason}`);
    }
    return c.redirect(`${s.shopPath}/account/code?error=failed`);
  }
  if (!(await signIn(c, s, v))) return c.redirect(`${s.shopPath}/account/login?error=expired`);
  return c.redirect(`${s.shopPath}/account${pending.next === "passkeys" ? "/passkeys" : ""}`);
});

members.get("/:shop/account/verify", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const deps = loginDeps(c);
  const challenge = c.req.query("c") ?? "";
  const token = c.req.query("t") ?? "";
  const email = deps ? await peekLogin(deps, s.shop.id, challenge, token) : null;
  if (!email) return c.redirect(`${s.shopPath}/account/login?error=link`);
  privatePage(c);
  return c.html(s.theme.MemberAuthPage({ ctx: ctxOf(s), mode: "verify", email: maskEmail(email), challenge, token }));
});

members.post("/:shop/account/verify", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const deps = loginDeps(c);
  if (!deps) return c.redirect(`${s.shopPath}/account/login?error=unavailable`);
  const f = await formFields(c);
  const v = await verifyLogin(deps, s.shop.id, f.c ?? "", { token: f.t ?? "" });
  if (!v.ok) return c.redirect(`${s.shopPath}/account/login?error=${v.reason === "limit" ? "limit" : "link"}`);
  if (!(await signIn(c, s, v))) return c.redirect(`${s.shopPath}/account/login?error=link`);
  return c.redirect(`${s.shopPath}/account`);
});

members.post("/:shop/account/logout", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // この端末のセッションをサーバー側でも取り消す（Cookie が盗まれていても、ログアウトした後は使えない）
  const db = privilegedFor(c);
  if (s.session?.sid && db) await db.memberSessionRevoke(s.shop.id, s.session.cid, s.session.ep, s.session.sid, "logout");
  await writeSession(c, s, null);
  return c.redirect(s.shopPath || "/");
});

members.post("/:shop/account/logout-all", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const db = privilegedFor(c);
  if (s.session && db) await db.memberLogoutAll(s.shop.id, s.session.cid, s.session.ep);
  await writeSession(c, s, null);
  return c.redirect(`${s.shopPath}/account/login?info=logged_out_all`);
});

/** ログイン中の会員の書き込み。世代が合わなければ（古いセッション）ログアウトしてログインへ */
async function withMember(c: Ctx, s: Scope, fn: (db: PrivilegedDb, session: MemberSession) => Promise<boolean>): Promise<boolean> {
  const db = privilegedFor(c);
  if (!s.session || !db) return false;
  const ok = await fn(db, s.session);
  if (!ok) await writeSession(c, s, null);
  return ok;
}

members.post("/:shop/account/address", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  const name = (f.customer_name ?? "").trim().slice(0, 200);
  const state = (f.state ?? "").trim();
  const address = {
    name,
    phone: (f.phone ?? "").trim().slice(0, 50),
    postal_code: (f.postal_code ?? "").trim().slice(0, 20),
    country: "JP",
    state: isPrefecture(state) ? state : null,
    city: (f.city ?? "").trim().slice(0, 200),
    line1: (f.line1 ?? "").trim().slice(0, 200),
    line2: (f.line2 ?? "").trim().slice(0, 200) || null,
  };
  const ok = await withMember(c, s, (db, m) => db.memberSaveAddress(s.shop.id, m.cid, m.ep, name || null, address));
  return c.redirect(ok ? `${s.shopPath}/account?flash=saved` : `${s.shopPath}/account/login`);
});

/** 「お得な情報やセールの案内を受け取る」（0050）。本人の行為なので会員ページからだけ付けられる。外すのもここから */
members.post("/:shop/account/consent", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  if (!consentCollected(s.shop)) return notFound(c);
  const f = await formFields(c);
  const ok = await withMember(c, s, (db, m) => db.memberSetMarketingConsent(s.shop.id, m.cid, m.ep, f.marketing_consent === "1"));
  return c.redirect(ok ? `${s.shopPath}/account?flash=saved` : `${s.shopPath}/account/login`);
});

/** 退会: customers 行を消す（注文は残る。注文の個人情報は運営者のマスク運用に従う） */
members.post("/:shop/account/delete", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  await withMember(c, s, (db, m) => db.memberWithdraw(s.shop.id, m.cid, m.ep));
  await writeSession(c, s, null);
  return c.redirect(s.shopPath || "/");
});

// ---------- ログイン中の端末（0045） ----------

members.get("/:shop/account/sessions", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !s.theme.MemberSessionsPage) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session?.sid || !db) return c.redirect(`${s.shopPath}/account/login`);
  const rows = await db.memberSessionsList(s.shop.id, s.session.cid, s.session.ep);
  if (!rows) {
    await writeSession(c, s, null);
    return c.redirect(`${s.shopPath}/account/login`);
  }
  privatePage(c);
  const current = s.session.sid;
  return c.html(
    s.theme.MemberSessionsPage({
      ctx: ctxOf(s, { email: s.session.email }),
      sessions: rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, created_at: r.created_at, last_seen_at: r.last_seen_at, current: r.id === current })),
      flash: c.req.query("flash") === "revoked" ? t("member.session_revoked") : undefined,
    }),
  );
});

members.post("/:shop/account/sessions/:id{[0-9a-f-]{36}}/revoke", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session?.sid || !db) return c.redirect(`${s.shopPath}/account/login`);
  const id = c.req.param("id") ?? "";
  const ok = await db.memberSessionRevoke(s.shop.id, s.session.cid, s.session.ep, id, id === s.session.sid ? "logout" : "revoked");
  // この端末を選んだ: ログアウトと同じ
  if (id === s.session.sid) {
    await writeSession(c, s, null);
    return c.redirect(s.shopPath || "/");
  }
  return c.redirect(`${s.shopPath}/account/sessions${ok ? "?flash=revoked" : ""}`);
});

// ---------- パスキー（同梱モジュール passkey、0046） ----------

/**
 * パスキーが使えるか: 会員機能とモジュールが ON・ショップに独自ドメインがあり、そのドメインの上で開いている。
 * RP ID はショップのドメイン（人間の決定 2026-10-23）。Banto の URL にパスで同居するショップには出さない
 */
export function passkeyReady(c: Ctx, shop: PublicShop): boolean {
  return membersEnabled(shop) && moduleEnabled(shop.settings, PASSKEY_MODULE) && Boolean(shop.domain) && onShopDomain(c, shop);
}

const passkeyExpected = (shop: PublicShop): Expected => ({ origin: `https://${shop.domain}`, rpId: shop.domain ?? "" });
/** パスキーの操作が「ログインしたばかり」と見なせる秒数（DB の判定は 15 分。画面の出し分けだけ） */
const PASSKEY_FRESH_SECONDS = 14 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  if (Number(c.req.header("content-length") ?? 0) > 64 * 1024) return {};
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** パスキーの API（JSON）の入口。使えなければ null */
async function passkeyScope(c: Ctx): Promise<{ s: Scope; deps: LoginDeps } | null> {
  const s = await scope(c);
  const deps = loginDeps(c);
  if (!s || !deps || !passkeyReady(c, s.shop)) return null;
  c.header("Cache-Control", "no-store");
  return { s, deps };
}

members.get("/:shop/account/passkey.js", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !passkeyReady(c, s.shop)) return notFound(c);
  return c.body(PASSKEY_CLIENT_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
});

/** ヘッドレスの連携サイトから来た、パスキーだけの画面（GET /api/shops/:shop/members/passkey から転送される） */
members.get("/:shop/account/passkey", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !passkeyReady(c, s.shop)) return notFound(c);
  const returnTo = safeReturnUrl(c.req.query("return_to"), returnOrigins(s.shop.settings), "");
  if (!returnTo) return c.text(t("member.oauth_failed"), 400);
  privatePage(c);
  return c.html(s.theme.MemberAuthPage({ ctx: ctxOf(s), mode: "passkey", options: { passkey: true }, returnTo }));
});

members.post("/:shop/account/passkey/login/options", async (c: Ctx) => {
  const p = await passkeyScope(c);
  if (!p) return c.json({ error: "not_found" }, 404);
  const challenge = newChallenge();
  const ip = await clientIpFor(c, p.s.shop);
  const r = await p.deps.db.memberPasskeyBegin(p.s.shop.id, "login", await passkeyChallengeHash(p.deps.secret, challenge), ip ? await ipHash(p.deps.secret, ip) : null);
  if (!r.ok) return c.json({ error: r.reason }, r.reason === "limited" ? 429 : 409);
  // 端末に入っているこのショップのパスキーから選んでもらう（allowCredentials を空にして、メールアドレスを先に聞かない）
  return c.json({ challenge_id: r.challenge_id, publicKey: { challenge, rpId: r.rp_id, timeout: 120_000, userVerification: "required", allowCredentials: [] } });
});

members.post("/:shop/account/passkey/login", async (c: Ctx) => {
  const p = await passkeyScope(c);
  if (!p) return c.json({ error: "not_found" }, 404);
  const { s, deps } = p;
  const b = await jsonBody(c);
  const challengeId = typeof b["challenge_id"] === "string" && UUID.test(b["challenge_id"]) ? b["challenge_id"] : null;
  const expected = passkeyExpected(s.shop);
  let a;
  try {
    a = readAssertion(b["credential"], expected);
  } catch (e) {
    if (e instanceof WebAuthnError) return c.json({ error: "failed" }, 400);
    throw e;
  }
  if (!challengeId) return c.json({ error: "failed" }, 400);
  const stored = await deps.db.memberPasskeyLookup(s.shop.id, a.credentialId);
  // 認証器が返した利用者の ID は、そのパスキーの会員と同じでなければならない
  if (!stored || (a.userHandle && !sameUserHandle(a.userHandle, stored.customer_id))) return c.json({ error: "failed" }, 401);
  let v;
  try {
    v = await verifyAssertion(a, { publicKey: stored.public_key }, expected);
  } catch (e) {
    if (e instanceof WebAuthnError) return c.json({ error: "failed" }, 401);
    throw e;
  }
  const r = await deps.db.memberPasskeyLogin(s.shop.id, challengeId, await passkeyChallengeHash(deps.secret, a.challenge), stored.id, v.signCount, v.backedUp);
  if (!r.ok) return c.json({ error: r.reason === "expired" ? "expired" : "failed" }, 401);
  // ヘッドレス: 1 回限り・2 分の引き換え券を付けて連携サイトへ戻す（会員のトークンを URL に載せない。LINE・Google と同じ）
  const returnTo = safeReturnUrl(b["return_to"], returnOrigins(s.shop.settings), "");
  if (returnTo) {
    const token = randomToken(32);
    const id = await deps.db.memberHandoffCreate(s.shop.id, r.customer_id, r.session_epoch, await linkHash(deps.secret, token));
    return c.json({ redirect: `${returnTo}${returnTo.includes("?") ? "&" : "?"}banto_handoff=${id}.${token}` });
  }
  if (!(await signIn(c, s, { customer_id: r.customer_id, session_epoch: r.session_epoch, email: r.email ?? "" }))) return c.json({ error: "failed" }, 401);
  return c.json({ redirect: `${s.shopPath}/account` });
});

members.post("/:shop/account/passkey/register/options", async (c: Ctx) => {
  const p = await passkeyScope(c);
  if (!p) return c.json({ error: "not_found" }, 404);
  const { s, deps } = p;
  if (!s.session?.sid) return c.json({ error: "session" }, 401);
  const challenge = newChallenge();
  const ip = await clientIpFor(c, s.shop);
  const r = await deps.db.memberPasskeyBegin(s.shop.id, "register", await passkeyChallengeHash(deps.secret, challenge), ip ? await ipHash(deps.secret, ip) : null, {
    customerId: s.session.cid,
    epoch: s.session.ep,
    sessionId: s.session.sid,
  });
  if (!r.ok) return c.json({ error: r.reason }, r.reason === "reauth" ? 403 : r.reason === "session" ? 401 : 409);
  const name = r.user?.email ?? s.shop.name;
  return c.json({
    challenge_id: r.challenge_id,
    publicKey: {
      rp: { id: r.rp_id, name: s.shop.name },
      // user.id は会員 ID の 16 バイト（メールアドレスなどの個人情報は入れない）
      user: { id: b64urlEncode(userHandleOf(s.session.cid)), name, displayName: r.user?.name || name },
      challenge,
      pubKeyCredParams: COSE_ALGS.map((alg) => ({ type: "public-key", alg })),
      timeout: 120_000,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: (r.exclude ?? []).map((id) => ({ type: "public-key", id })),
    },
  });
});

const REGISTER_ERRORS: Record<string, MessageKey> = { too_many: "passkey.too_many", duplicate: "passkey.duplicate", reauth: "passkey.reauth" };

members.post("/:shop/account/passkey/register", async (c: Ctx) => {
  const p = await passkeyScope(c);
  if (!p) return c.json({ error: "not_found" }, 404);
  const { s, deps } = p;
  if (!s.session?.sid) return c.json({ error: "session" }, 401);
  const b = await jsonBody(c);
  const challengeId = typeof b["challenge_id"] === "string" && UUID.test(b["challenge_id"]) ? b["challenge_id"] : null;
  const expected = passkeyExpected(s.shop);
  let reg;
  try {
    reg = await verifyRegistration(b["credential"], expected);
  } catch (e) {
    if (e instanceof WebAuthnError) return c.json({ error: "failed" }, 400);
    throw e;
  }
  if (!challengeId) return c.json({ error: "failed" }, 400);
  const r = await deps.db.memberPasskeyRegister(
    s.shop.id,
    challengeId,
    await passkeyChallengeHash(deps.secret, reg.challenge),
    { customerId: s.session.cid, epoch: s.session.ep, sessionId: s.session.sid },
    { credentialId: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg, signCount: reg.signCount, rpId: expected.rpId, backedUp: reg.backedUp, label: deviceLabel(c.req.header("user-agent")) },
  );
  if (!r.ok) {
    const key = REGISTER_ERRORS[r.reason];
    return c.json({ error: r.reason === "reauth" ? "reauth" : "failed", ...(key ? { redirect: `${s.shopPath}/account/passkeys?error=${r.reason}` } : {}) }, r.reason === "reauth" ? 403 : 409);
  }
  // 盗まれたセッションで足されたときに本人が気づけるように、知らせる
  if (r.mail_from && r.email) await afterResponse(c, sendPasskeyAddedNotice(deps, s.shop, { from: r.mail_from, to: r.email, accountUrl: `${shopHome(publicBaseUrl(c), s.shop)}/account/passkeys` }));
  return c.json({ redirect: `${s.shopPath}/account/passkeys?flash=added` });
});

members.get("/:shop/account/passkeys", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !s.theme.MemberPasskeysPage || !passkeyReady(c, s.shop)) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session?.sid || !db) return c.redirect(`${s.shopPath}/account/login`);
  const rows = await db.memberPasskeysList(s.shop.id, s.session.cid, s.session.ep);
  if (!rows) {
    await writeSession(c, s, null);
    return c.redirect(`${s.shopPath}/account/login`);
  }
  privatePage(c);
  const now = Math.floor(Date.now() / 1000);
  const flash = c.req.query("flash");
  const errorKey = REGISTER_ERRORS[c.req.query("error") ?? ""];
  return c.html(
    s.theme.MemberPasskeysPage({
      ctx: ctxOf(s, { email: s.session.email }),
      passkeys: rows,
      canAdd: s.session.iat !== undefined && now - s.session.iat < PASSKEY_FRESH_SECONDS,
      email: s.session.email || null,
      flash: flash === "added" ? t("passkey.added") : flash === "deleted" ? t("passkey.deleted") : undefined,
      error: errorKey ? t(errorKey) : undefined,
    }),
  );
});

members.post("/:shop/account/passkeys/:id{[0-9a-f-]{36}}/delete", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !passkeyReady(c, s.shop)) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session || !db) return c.redirect(`${s.shopPath}/account/login`);
  // false は「無い・他人のもの」か「古いセッション」。古いセッションなら一覧の画面がログインへ送る
  const ok = await db.memberPasskeyDelete(s.shop.id, s.session.cid, s.session.ep, c.req.param("id") ?? "");
  return c.redirect(ok ? `${s.shopPath}/account/passkeys?flash=deleted` : `${s.shopPath}/account/passkeys`);
});

// ---------- パスワード（0013。店の設定 members_password がオンのとき） ----------

members.post("/:shop/account/password-login", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || (s.shop.settings ?? {})["members_password"] !== true) return notFound(c);
  const deps = loginDeps(c);
  if (!deps) return c.redirect(`${s.shopPath}/account/login?error=unavailable`);
  const f = await formFields(c);
  const email = (f.email ?? "").trim().toLowerCase();
  const ip = await clientIpFor(c, s.shop);
  const r = await deps.db.memberPasswordLogin(s.shop.id, email, f.password ?? "", ip ? await ipHash(deps.secret, ip) : null);
  if (!r.ok) {
    const error = r.reason === "locked" ? "locked" : "password";
    return c.redirect(`${s.shopPath}/account/login?error=${error}&email=${encodeURIComponent(email)}`);
  }
  // 初めての端末なら本人に知らせる（使い回しのパスワードで入られたときに気づけるように）
  if (r.mail_from && r.email && !(await knownDevice(deps.secret, s.shop.id, r.customer_id, c.req.header("cookie")))) {
    await afterResponse(c, sendPasswordLoginNotice(deps, s.shop, { from: r.mail_from, to: r.email, accountUrl: memberAccountUrl(publicBaseUrl(c), s.shop) }));
  }
  if (!(await signIn(c, s, { customer_id: r.customer_id, session_epoch: r.session_epoch, email: r.email ?? "" }))) return c.redirect(`${s.shopPath}/account/login?error=unavailable`);
  return c.redirect(`${s.shopPath}/account`);
});

members.post("/:shop/account/password", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || (s.shop.settings ?? {})["members_password"] !== true) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session || !db) return c.redirect(`${s.shopPath}/account/login`);
  const password = (await formFields(c)).password ?? "";
  if (password.length < 8 || password.length > 200) return c.redirect(`${s.shopPath}/account?error=weak`);
  // 0057: ログインしてから 15 分以内のセッションだけ（盗まれた Cookie からパスワードを足されないように）。過ぎていれば入り直す
  const r = await db.memberSetPassword(s.shop.id, s.session.cid, s.session.ep, password, s.session.sid);
  if (!r.ok) {
    // 15 分を過ぎている: この端末のセッションを終えて入り直してもらう（入り直した直後のセッションなら設定できる）
    await writeSession(c, s, null);
    return c.redirect(`${s.shopPath}/account/login${r.reason === "reauth" ? "?error=reauth" : ""}`);
  }
  // ほかの端末はログアウト（世代を上げた）。この端末は同じセッションの行のまま新しい世代で続ける（0057）。0045 より前の Cookie（sid 無し）は行を作り直す
  if (s.session.sid) {
    const now = Math.floor(Date.now() / 1000);
    await writeSession(c, s, { ...s.session, ep: r.epoch, chk: now });
  } else if (!(await startWebSession(c, s, { customer_id: s.session.cid, session_epoch: r.epoch, email: s.session.email }))) {
    await writeSession(c, s, null);
    return c.redirect(`${s.shopPath}/account/login`);
  }
  // 本人に知らせる（盗まれたセッションから足されても気づけるように。送信元が無ければ送らない）
  const ld = loginDeps(c);
  if (ld) await afterResponse(c, sendAccountChangeNotice(ld, s.shop, { kind: "password", from: r.mail_from, to: r.email ?? s.session.email, accountUrl: memberAccountUrl(publicBaseUrl(c), s.shop) }));
  return c.redirect(`${s.shopPath}/account?flash=password_saved`);
});

// ---------- LINE・Google でログイン（0014、同梱モジュール line_login・google_login） ----------

const OAUTH_COOKIE = "banto_oauth";
const OAUTH_SECONDS = 10 * 60;

interface OAuthState {
  provider: Provider;
  state: string;
  nonce: string;
  verifier: string;
  shop: string;
  /** 始めたときのショップの origin（redirect_uri）とパス（独自ドメインの上なら ""） */
  origin: string;
  path: string;
  mode: "login" | "link" | "api";
  cid?: string;
  ep?: number;
  /** 連携（link）のとき: 始めたセッションの行（0045）。連携はログインしてから 15 分以内のセッションだけ（0057） */
  sid?: string;
  /** 知らせのメールに出すショップ名（0057） */
  shop_name?: string;
  return_to?: string;
  exp: number;
}

const oauthSecret = (secret: string) => `${secret}|member-oauth`;
/** 提供元に登録する戻り先。ショップに独自ドメインがあればそのドメイン（管理画面の設定画面と同じ組み方） */
const redirectUri = (origin: string, p: Provider) => `${origin}${callbackPath(p)}`;

/** 提供元へ送り出す（state などを Cookie に持つ）。client_id はキャッシュ済みのショップ行から */
export async function startOAuth(c: Ctx, shop: PublicShop, p: Provider, mode: OAuthState["mode"], extra: { cid?: string; ep?: number; sid?: string; return_to?: string } = {}): Promise<Response> {
  const clientId = providerClientId(shop.settings, p);
  const secret = c.get("sessionSecret");
  if (!clientId || !secret || !enabledProviders(shop).includes(p)) return c.text(t("store.not_found"), 404);
  // 独自ドメインのショップは、そのドメインの上で始める（state の Cookie と戻り先を同じドメインにそろえる）
  if (shop.domain && !onShopDomain(c, shop)) return c.req.method === "GET" ? c.redirect(domainUrlFor(c, shop)!) : c.redirect(`https://${shop.domain}/account`, 303);
  const { verifier, challenge } = await pkce();
  const origin = shopOrigin(publicBaseUrl(c), shop);
  const st: OAuthState = {
    provider: p,
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    shop: shop.id,
    shop_name: shop.name,
    origin,
    path: shop.domain ? "" : `/${shop.slug}`,
    mode,
    ...extra,
    exp: Math.floor(Date.now() / 1000) + OAUTH_SECONDS,
  };
  c.header("Set-Cookie", cookieHeader(OAUTH_COOKIE, await sealJson(oauthSecret(secret), st), "/_oauth", isSecureRequest(c), OAUTH_SECONDS), { append: true });
  const bot = ((shop.settings ?? {})["oauth"] as Record<string, Record<string, unknown>> | undefined)?.["line"]?.["bot_prompt"];
  return c.redirect(authorizeUrl(p, clientId, { redirectUri: redirectUri(origin, p), state: st.state, nonce: st.nonce, challenge, botPrompt: bot === "normal" || bot === "aggressive" ? bot : null }));
}

function providerOf(c: Ctx): Provider | null {
  const p = c.req.param("provider");
  return isProvider(p) ? p : null;
}

members.get("/:shop/account/oauth/:provider", async (c: Ctx) => {
  const s = await scope(c);
  const p = providerOf(c);
  if (!s || !p) return notFound(c);
  if (s.session) return c.redirect(`${s.shopPath}/account`);
  return startOAuth(c, s.shop, p, "login");
});

members.post("/:shop/account/oauth/:provider/link", async (c: Ctx) => {
  const s = await scope(c);
  const p = providerOf(c);
  if (!s || !p) return notFound(c);
  if (!s.session) return c.redirect(`${s.shopPath}/account/login`);
  return startOAuth(c, s.shop, p, "link", { cid: s.session.cid, ep: s.session.ep, ...(s.session.sid ? { sid: s.session.sid } : {}) });
});

members.post("/:shop/account/oauth/:provider/unlink", async (c: Ctx) => {
  const s = await scope(c);
  const p = providerOf(c);
  if (!s || !p) return notFound(c);
  const db = privilegedFor(c);
  if (!s.session || !db) return c.redirect(`${s.shopPath}/account/login`);
  try {
    const ok = await db.memberUnlinkIdentity(s.shop.id, s.session.cid, s.session.ep, p);
    return c.redirect(ok ? `${s.shopPath}/account?flash=oauth_unlinked` : `${s.shopPath}/account`);
  } catch (e) {
    if (e instanceof Error && /last_login_method/.test(e.message)) return c.redirect(`${s.shopPath}/account?error=last_method`);
    throw e;
  }
});

members.get("/_oauth/:provider/callback", async (c: Ctx) => {
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  const p = providerOf(c);
  const raw = readCookie(c.req.header("cookie"), OAUTH_COOKIE);
  c.header("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", "/_oauth", isSecureRequest(c), 0), { append: true });
  const st = secret ? ((await openJson(oauthSecret(secret), raw)) as OAuthState | null) : null;
  // state が合わない = この端末で始めたログインではない（他人の戻り URL を踏まされた等）。何もしない
  if (!st || !p || st.provider !== p || !db || !secret || st.exp < Math.floor(Date.now() / 1000) || c.req.query("state") !== st.state) return c.text(t("member.oauth_failed"), 400);
  const shopPath = st.path;
  const fail = (reason: string) =>
    st.mode === "api" && st.return_to
      ? c.redirect(`${st.return_to}${st.return_to.includes("?") ? "&" : "?"}banto_error=${reason}`)
      : c.redirect(st.mode === "link" ? `${shopPath}/account?error=${reason}` : `${shopPath}/account/login?error=oauth`);
  const code = c.req.query("code");
  if (!code) return fail("oauth");
  // ショップの提供元の設定（シークレットは暗号文。サイトの秘密で開く）
  const client = await db.shopOauthClient(st.shop, p);
  const clientSecret = client ? await openSecret(secret, st.shop, secretPurpose(p), client.secret_box) : null;
  if (!client || !clientSecret) return fail("oauth");
  let identity;
  try {
    identity = await providerIdentity(p, c.get("deps").fetch, { clientId: client.client_id, clientSecret }, { code, redirectUri: redirectUri(st.origin, p), verifier: st.verifier, nonce: st.nonce });
  } catch (e) {
    if (e instanceof OAuthError) return fail("oauth");
    throw e;
  }
  const r = await db.memberOauthLogin(st.shop, p, identity.sub, identity.email, identity.emailVerified, st.mode === "link" && st.cid ? { customerId: st.cid, epoch: st.ep ?? -1, ...(st.sid ? { sessionId: st.sid } : {}) } : null);
  if (!r.ok) return fail(r.reason === "already_linked" || r.reason === "other_linked" || r.reason === "reauth" ? r.reason : "oauth");
  if (st.mode === "link") {
    // 本人に知らせる（0057。盗まれたセッションから連携されても気づけるように）
    const ld = loginDeps(c);
    if (ld && r.linked && r.mail_from && r.email) {
      await afterResponse(c, sendAccountChangeNotice(ld, { name: st.shop_name ?? "" }, { kind: "oauth", provider: p, from: r.mail_from, to: r.email, accountUrl: `${st.origin}${shopPath}/account` }));
    }
    return c.redirect(`${shopPath}/account?flash=oauth_linked`);
  }
  if (st.mode === "api" && st.return_to) {
    // ヘッドレス: 1 回限り・2 分の引き換え券を渡す（会員のトークンを URL に載せない）
    const token = randomToken(32);
    const id = await db.memberHandoffCreate(st.shop, r.customer_id, r.session_epoch, await linkHash(secret, token));
    return c.redirect(`${st.return_to}${st.return_to.includes("?") ? "&" : "?"}banto_handoff=${id}.${token}`);
  }
  const target = { shop: { id: st.shop }, shopPath };
  if (!(await startWebSession(c, target, { customer_id: r.customer_id, session_epoch: r.session_epoch, email: r.email ?? "" }))) return fail("oauth");
  await markDevice(c, target, r.customer_id);
  return c.redirect(`${shopPath}/account`);
});
