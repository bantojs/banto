import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { SESSION_ABSOLUTE_SECONDS, deviceLabel, ipHash, issueTokens, linkHash, openToken } from "../../members/auth";
import { startLogin, verifyLogin } from "../../members/login";
import { consentCollected, returnOrigins, safeReturnUrl } from "../../commerce/checkout";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { privilegedFor } from "../payment-deps";
import { enabledProviders, loginDeps, memberAddressFrom, membersEnabled, startOAuth } from "../storefront/members";
import { isProvider } from "../../modules/social-login/providers";
import { afterResponse, clientIpFor, migrationStateFor, param, publicBaseUrl, type Ctx } from "../common";
import { migrated } from "../../db/migration-state";
import { randomToken } from "../../util/signed";
import { sendAccountChangeNotice, sendPasswordLoginNotice } from "../../members/notice";
import { memberAccountUrl, shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../../modules/registry";
import { MEMBER_CANCELLABLE, TRYON_MODULE } from "../../modules/store-tryon";
import type { PrivilegedDb } from "../../db/privileged";
import { PASSKEY_ADD_MIGRATION, PASSKEY_MODULE } from "../../modules/passkey";
import { RECEIPT_MODULE, type ReceiptOrder } from "../../modules/receipt/render";
import { receiptAvailable, receiptData } from "../../modules/receipt/data";

/**
 * ヘッドレスの会員（docs/headless.md「会員」、設計は docs/knowledge/10-members-identity.md）。
 * アカウントはショップごと。パスワードなし: メールに届く 6 桁のコードか、ログインのリンクで入る。
 *
 *   GET  /api/shops/:shop/members/config      会員機能が有効か・ログインの方法
 *   POST /api/shops/:shop/members/login       { email, return_to? } → { challenge_id }（登録の有無・回数の上限にかかわらず同じ形）
 *        return_to はリンクの行き先（settings.headless.return_origins のオリジンだけ）。リンクは
 *        `<return_to>?banto_challenge=<id>&banto_token=<token>` になる。無ければ Banto の確認画面
 *   POST /api/shops/:shop/members/verify      { challenge_id, code } か { challenge_id, token } → { access_token, refresh_token, expires_in, member }
 *   POST /api/shops/:shop/members/refresh     { refresh_token } → 新しい組。refresh は 1 回ごとに変わる（前のものは使えない）。
 *        前のものをもう一度使うと、使い回し（盗まれた）と見なしてそのセッションごと取り消す（0045。同時の呼び出しのために、回した直後の 30 秒だけは通す）
 *   GET  /api/shops/:shop/members/me          トークンの会員（名前・既定の住所・案内メールの同意）と、このショップでの注文（注文の住所は返さない）
 *   POST /api/shops/:shop/members/address     既定の住所を保存 / POST …/marketing-consent { consent } 案内メールの同意 /
 *   POST …/withdraw { confirm: true } 退会（会員ページと同じ操作。会員本人の操作として）
 *   GET  /api/shops/:shop/members/orders/:number          その会員の注文 1 件（0066。lookup_order と同じ形）と receipt_available
 *   GET  /api/shops/:shop/members/orders/:number/receipt  領収書のデータ（同梱モジュール receipt。JSON だけで、体裁は連携サイト）
 *   POST /api/shops/:shop/members/logout      この端末をログアウト（Bearer か { refresh_token }。セッションを取り消す、0045）
 *   GET  /api/shops/:shop/members/sessions    ログイン中の端末（0045）
 *   POST /api/shops/:shop/members/sessions/:id/revoke  その端末をログアウト（0045）
 *   POST /api/shops/:shop/members/logout-all  全端末からログアウト（世代を上げる）
 *   GET  /api/shops/:shop/members/tryon       自分のお店で試着の申し込み（同梱モジュール store_tryon、0026）
 *   POST /api/shops/:shop/members/tryon/:number/cancel  申し込みを取り消す（取り置きが終わる前だけ）
 *   POST /api/shops/:shop/members/password-login { email, password } → トークン（店の設定 members_password がオンのとき、0013）
 *   POST /api/shops/:shop/members/password    { password }（Bearer）パスワードを決める・変える → 新しいトークン（ほかの端末はログアウト）
 *   GET  /api/shops/:shop/members/oauth/:provider?return_to=…  LINE・Google へ送り出す（ブラウザで開く。0014）。戻ってきたら
 *        `<return_to>?banto_handoff=<券>` に戻すので、/members/verify に { handoff } で渡す（2 分・1 回限り）
 *   POST /api/shops/:shop/members/passkey/add { return_to }（Bearer、ログインしてから 15 分以内）→ { url }: パスキーを追加する画面へ送る券（0070）
 *   GET  /api/shops/:shop/members/passkey?return_to=…  ショップのドメインのパスキーの画面へ送り出す（同梱モジュール passkey、0046）。
 *        パスキーは RP ID = ショップのドメインなので、連携サイトの上では使わない。戻り方は LINE・Google と同じ引き換え券
 *
 * トークンは署名付きの平文（暗号化していない）なので、メールアドレスは入れない。access は 15 分で、DB では確かめない（取り消しが効くまで最大 15 分）。
 * refresh はログインのたびに作るセッションの行（0045 の member_sessions）と照合する。行の絶対の期限（90 日）を越えて更新はできない。
 * トークンは本文で受け渡す（Cookie を使わない）ので CSRF にはならないが、CORS は `*` ではなく
 * **ショップ設定の `headless.return_origins` のオリジンだけ**に返す（0029。login はメールを送るので、どのサイトからでも
 * 訪問者のブラウザで叩けてはいけない。監査 M10）。同梱テーマ（同一オリジン）には CORS は要らない。
 * カート・チェックアウトの API には `Authorization: Bearer <access_token>` で付ける。
 */
export const membersApi = new Hono<AppEnv>();

/** 会員 API の CORS: return_origins にある Origin だけ許可する。無ければヘッダーを付けない（ブラウザが止める） */
export async function memberCors(c: Ctx, next: () => Promise<void>): Promise<Response | void> {
  const origin = c.req.header("origin");
  // ミドルウェアではルートの :shop が無いので、パスから読む
  const slug = /^\/api\/shops\/([^/]+)\/members(?:\/|$)/.exec(c.req.path)?.[1];
  const allowed = origin && slug ? (await shopFor(c, slug))?.settings : null;
  const ok = Boolean(origin && allowed && returnOrigins(allowed).includes(origin));
  if (c.req.method === "OPTIONS") {
    if (!ok) return c.body(null, 204);
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    });
  }
  await next();
  if (ok) {
    c.res.headers.set("Access-Control-Allow-Origin", origin!);
    c.res.headers.append("Vary", "Origin");
  }
}

export interface ApiMember {
  id: string;
  /** セッションの世代（予約に紐づけるときに DB が確かめる） */
  epoch: number;
  /** セッションの行（0045）。それより前に発行したトークンには無い */
  sid?: string;
}

/**
 * リクエストの会員。トークンが無い・会員機能が OFF なら member: null（ゲスト）。
 * トークンが付いているのに確かめられない（期限切れ・改ざん・他店のトークン）なら ok: false。連携側は refresh して呼び直す。
 * 署名と期限だけを確かめる（DB に問い合わせない）。世代は会員の RPC と予約への紐づけで確かめる
 */
export async function memberFromRequest(c: Ctx, shop: PublicShop): Promise<{ ok: true; member: ApiMember | null } | { ok: false }> {
  const header = c.req.header("authorization") ?? "";
  if (!header || !membersEnabled(shop)) return { ok: true, member: null };
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const secret = c.get("sessionSecret");
  if (!token || token === header || !secret) return { ok: false };
  const t = await openToken(secret, shop.id, token, "a");
  return t ? { ok: true, member: { id: t.cid, epoch: t.ep, ...(t.sid ? { sid: t.sid } : {}) } } : { ok: false };
}

/**
 * ログインに成功した会員にトークンを渡す。この端末のセッションの行（0045）を作る。
 * 世代が変わっていた（ログインの途中で全端末からログアウトされた等）なら null
 */
async function grant(c: Ctx, db: PrivilegedDb, secret: string, shopId: string, customerId: string, epoch: number) {
  const sid = await db.memberSessionStart(shopId, customerId, epoch, "api", deviceLabel(c.req.header("user-agent")), SESSION_ABSOLUTE_SECONDS);
  if (!sid) return null;
  return issueTokens(secret, shopId, customerId, epoch, { sid, gen: 0, expiresAt: Math.floor(Date.now() / 1000) + SESSION_ABSOLUTE_SECONDS });
}

async function shopFor(c: Ctx, slug: string = param(c, "shop")): Promise<PublicShop | null> {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
  return sf.shopBySlug(slug);
}

async function body(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const NO_STORE = { "cache-control": "no-store" };

membersApi.get("/shops/:shop/members/config", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop)) return c.json({ enabled: false });
  const login = ["email_code", "email_link", ...((shop.settings ?? {})["members_password"] === true ? ["password"] : []), ...enabledProviders(shop), ...(passkeyOffered(shop) ? ["passkey"] : [])];
  return c.json({ enabled: true, login });
});

membersApi.post("/shops/:shop/members/login", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop)) return c.json({ error: "members_disabled" }, 409);
  const deps = loginDeps(c);
  if (!deps) return c.json({ error: "not_configured" }, 503);
  const b = await body(c);
  const banto = `${shopHome(publicBaseUrl(c), shop)}/account/verify`;
  // 許可リストに無い戻り先は使わない（Banto の確認画面にする。オープンリダイレクトにしない）
  const returnTo = safeReturnUrl(b["return_to"], returnOrigins(shop.settings), "");
  const link = (id: string, token: string) => (returnTo ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}banto_challenge=${id}&banto_token=${token}` : `${banto}?c=${id}&t=${token}`);
  const r = await startLogin(deps, shop, str(b["email"]), { ip: await clientIpFor(c, shop), returnTo: returnTo || null, link });
  if (!r.ok) {
    if (r.error === "invalid_email") return c.json({ error: "invalid_email" }, 400);
    if (r.error === "disabled") return c.json({ error: "members_disabled" }, 409);
    if (r.error === "mail_failed") return c.json({ error: "mail_failed" }, 502);
    if (r.error === "limit") return c.json({ error: "plan_limit_exceeded" }, 429); // 1 日のメールの上限（0053）
    return c.json({ error: "unavailable" }, 503);
  }
  return c.json({ challenge_id: r.challengeId });
});

membersApi.post("/shops/:shop/members/verify", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop)) return c.json({ error: "members_disabled" }, 409);
  const deps = loginDeps(c);
  if (!deps) return c.json({ error: "not_configured" }, 503);
  const b = await body(c);
  // LINE から戻った後の引き換え券（<id>.<token>）
  if (typeof b["handoff"] === "string") {
    const [id = "", token = ""] = b["handoff"].split(".");
    const r = /^[0-9a-f-]{36}$/.test(id) && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? await deps.db.memberHandoffRedeem(shop.id, id, await linkHash(deps.secret, token)) : null;
    if (!r || !r.ok) return c.json({ error: "expired" }, 401);
    const tokens = await grant(c, deps.db, deps.secret, shop.id, r.customer_id, r.session_epoch);
    if (!tokens) return c.json({ error: "expired" }, 401);
    return c.json({ ...tokens, member: { id: r.customer_id, email: r.email, created: false } });
  }
  const input = typeof b["code"] === "string" ? { code: b["code"] } : { token: str(b["token"]) };
  const v = await verifyLogin(deps, shop.id, str(b["challenge_id"]), input);
  // invalid: 間違い（あと何回か試せる）/ expired: 期限切れ・使用済み・間違いが続いた（login からやり直す）
  if (!v.ok && v.reason === "limit") return c.json({ error: "plan_limit_exceeded" }, 409); // 会員数の上限（0052）
  if (!v.ok) return c.json({ error: v.reason === "expired" ? "expired" : "invalid_code" }, 401);
  const tokens = await grant(c, deps.db, deps.secret, shop.id, v.customer_id, v.session_epoch);
  if (!tokens) return c.json({ error: "expired" }, 401);
  return c.json({ ...tokens, member: { id: v.customer_id, email: v.email, created: v.created } });
});

membersApi.post("/shops/:shop/members/refresh", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!membersEnabled(shop)) return c.json({ error: "members_disabled" }, 409);
  if (!secret || !db) return c.json({ error: "not_configured" }, 503);
  const r = await openToken(secret, shop.id, str((await body(c))["refresh_token"]), "r");
  if (!r) return c.json({ error: "invalid_refresh_token" }, 401);
  // セッションの行の無い（0045 より前に発行した）refresh は通さない。ログインし直してもらう
  if (!r.sid || r.gen === undefined) return c.json({ error: "invalid_refresh_token" }, 401);
  const rot = await db.memberSessionRefresh(shop.id, r.cid, r.ep, r.sid, r.gen);
  // reuse: 使い回し。セッションごと取り消した（連携側はログインからやり直す）
  if (!rot.ok) return c.json({ error: rot.reason === "reuse" ? "refresh_token_reused" : "invalid_refresh_token" }, 401);
  return c.json(await issueTokens(secret, shop.id, r.cid, r.ep, { sid: r.sid, gen: rot.gen, expiresAt: Math.floor(Date.parse(rot.expires_at) / 1000) }));
});

/** この端末をログアウト。Bearer の access か、本文の refresh_token のセッションを取り消す */
membersApi.post("/shops/:shop/members/logout", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop)) return c.json({ error: "members_disabled" }, 409);
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!secret || !db) return c.json({ error: "not_configured" }, 503);
  const refresh = str((await body(c))["refresh_token"]);
  const fromRefresh = refresh ? await openToken(secret, shop.id, refresh, "r") : null;
  const fromAccess = fromRefresh ? null : await memberFromRequest(c, shop);
  const t = fromRefresh ? { cid: fromRefresh.cid, ep: fromRefresh.ep, sid: fromRefresh.sid } : fromAccess?.ok && fromAccess.member ? { cid: fromAccess.member.id, ep: fromAccess.member.epoch, sid: fromAccess.member.sid } : null;
  if (!t) return c.json({ error: "invalid_member_token" }, 401);
  // セッションの行の無い古いトークンは、期限が来るまで待つしかない（全端末からログアウトなら止められる）
  if (t.sid) await db.memberSessionRevoke(shop.id, t.cid, t.ep, t.sid, "logout");
  return c.json({ ok: true });
});

membersApi.get("/shops/:shop/members/sessions", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  if (!s.member.sid) return c.json({ error: "invalid_member_token" }, 401);
  const rows = await db.memberSessionsList(s.shop.id, s.member.id, s.member.epoch);
  if (!rows) return c.json({ error: "invalid_member_token" }, 401);
  return c.json({ sessions: rows.map((r) => ({ ...r, current: r.id === s.member.sid })) });
});

membersApi.post("/shops/:shop/members/sessions/:id{[0-9a-f-]{36}}/revoke", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  if (!s.member.sid) return c.json({ error: "invalid_member_token" }, 401);
  const id = c.req.param("id") ?? "";
  const ok = await db.memberSessionRevoke(s.shop.id, s.member.id, s.member.epoch, id, id === s.member.sid ? "logout" : "revoked");
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

async function bearerMember(c: Ctx): Promise<{ shop: PublicShop; member: ApiMember } | Response> {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop)) return c.json({ error: "members_disabled" }, 409);
  const r = await memberFromRequest(c, shop);
  if (!r.ok) return c.json({ error: "invalid_member_token" }, 401);
  if (!r.member) return c.json({ error: "member_token_required" }, 401);
  return { shop, member: r.member };
}

membersApi.get("/shops/:shop/members/me", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const rec = await db.memberGet(s.shop.id, s.member.id, s.member.epoch, true);
  if (!rec) return c.json({ error: "invalid_member_token" }, 401);
  // 注文の住所は返さない（連携側の画面に要るのは注文の状態と金額）。会員本人の既定の住所と案内メールの同意は、マイページのために返す
  const orders = rec.orders.map((o) => ({ number: o["number"], status: o["status"], total_jpy: o["total_jpy"], shipping_jpy: o["shipping_jpy"], discount_jpy: o["discount_jpy"] ?? 0, created_at: o["created_at"], shipped_at: o["shipped_at"] }));
  const consent = consentCollected(s.shop) ? { marketing_consent: rec.customer.marketing_consent ?? null } : {};
  return c.json({ id: rec.customer.id, email: rec.customer.email, name: rec.customer.name, address: rec.customer.default_address, ...consent, orders }, 200, { "cache-control": "no-store" });
});

/** 既定の住所を保存する（会員ページの「住所を保存」と同じ。チェックアウトの欄の初期値になる） */
membersApi.post("/shops/:shop/members/address", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const { name, address } = memberAddressFrom(await body(c));
  const ok = await db.memberSaveAddress(s.shop.id, s.member.id, s.member.epoch, name || null, address);
  return ok ? c.json({ ok: true, name: name || null, address }) : c.json({ error: "invalid_member_token" }, 401);
});

/**
 * 「お得な情報やセールの案内を受け取る」（0050）。会員本人がログインして選ぶので、受け取る（true）も受け取らない（false）も本人の行為
 * （人間の決定 2026-10-28）。ショップがこの欄を使っていなければ 404
 */
membersApi.post("/shops/:shop/members/marketing-consent", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if (!consentCollected(s.shop)) return c.json({ error: "consent_disabled" }, 404);
  const consent = (await body(c))["consent"];
  if (typeof consent !== "boolean") return c.json({ error: "invalid_request", field: "consent" }, 400);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const ok = await db.memberSetMarketingConsent(s.shop.id, s.member.id, s.member.epoch, consent);
  return ok ? c.json({ ok: true, marketing_consent: consent }) : c.json({ error: "invalid_member_token" }, 401);
});

/** 退会（会員ページの「退会する」と同じ: 会員の行を消す。注文は残る）。取り消せないので { confirm: true } が要る */
membersApi.post("/shops/:shop/members/withdraw", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if ((await body(c))["confirm"] !== true) return c.json({ error: "confirm_required" }, 400);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const ok = await db.memberWithdraw(s.shop.id, s.member.id, s.member.epoch);
  return ok ? c.json({ ok: true }) : c.json({ error: "invalid_member_token" }, 401);
});

/** 会員の注文 1 件（0066。注文照会のページで会員の注文を開くとき。住所・アドレスは返さない） */
membersApi.get("/shops/:shop/members/orders/:number{[0-9]{1,9}}", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const order = await db.memberOrder(s.shop.id, s.member.id, s.member.epoch, Number(c.req.param("number")));
  // 世代が違う（全端末からログアウト・退会）か、この会員の注文ではない。どちらかは返さない
  if (!order) return c.json({ error: "not_found" }, 404, NO_STORE);
  return c.json({ order, receipt_available: moduleEnabled(s.shop.settings, RECEIPT_MODULE) && receiptAvailable(order) }, 200, NO_STORE);
});

/** 会員の注文の領収書のデータ（同梱モジュール receipt。体裁は連携サイトが決める） */
membersApi.get("/shops/:shop/members/orders/:number{[0-9]{1,9}}/receipt", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if (!moduleEnabled(s.shop.settings, RECEIPT_MODULE)) return c.json({ error: "receipt_disabled" }, 404);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const order = (await db.memberOrder(s.shop.id, s.member.id, s.member.epoch, Number(c.req.param("number")))) as ReceiptOrder | null;
  if (!order) return c.json({ error: "not_found" }, 404, NO_STORE);
  if (!receiptAvailable(order)) return c.json({ error: "receipt_not_available" }, 409, NO_STORE);
  return c.json({ receipt: receiptData(s.shop, order, new Date()) }, 200, NO_STORE);
});

membersApi.get("/shops/:shop/members/tryon", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if (!moduleEnabled(s.shop.settings, TRYON_MODULE)) return c.json({ error: "tryon_disabled" }, 404);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const rows = await db.memberTryonRequests(s.shop.id, s.member.id, s.member.epoch);
  if (!rows) return c.json({ error: "invalid_member_token" }, 401);
  return c.json({ requests: rows.map((r) => ({ ...r, cancellable: MEMBER_CANCELLABLE.includes(r.status) })) });
});

membersApi.post("/shops/:shop/members/tryon/:number{[0-9]+}/cancel", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if (!moduleEnabled(s.shop.settings, TRYON_MODULE)) return c.json({ error: "tryon_disabled" }, 404);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const r = await db.memberTryonCancel(s.shop.id, s.member.id, s.member.epoch, Number(c.req.param("number")));
  if (r.ok) return c.json({ ok: true });
  if (r.reason === "session") return c.json({ error: "invalid_member_token" }, 401);
  return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
});

membersApi.post("/shops/:shop/members/logout-all", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const ok = await db.memberLogoutAll(s.shop.id, s.member.id, s.member.epoch);
  return ok ? c.json({ ok: true }) : c.json({ error: "invalid_member_token" }, 401);
});

membersApi.post("/shops/:shop/members/password-login", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop) || (shop.settings ?? {})["members_password"] !== true) return c.json({ error: "password_disabled" }, 409);
  const deps = loginDeps(c);
  if (!deps) return c.json({ error: "not_configured" }, 503);
  const b = await body(c);
  const ip = await clientIpFor(c, shop);
  const r = await deps.db.memberPasswordLogin(shop.id, str(b["email"]), str(b["password"]), ip ? await ipHash(deps.secret, ip) : null);
  if (!r.ok) return c.json({ error: r.reason === "locked" ? "locked" : "invalid_password" }, r.reason === "locked" ? 429 : 401);
  // ヘッドレスには端末の印が無いので、毎回知らせる（docs/headless.md）
  if (r.mail_from && r.email) await afterResponse(c, sendPasswordLoginNotice(deps, shop, { from: r.mail_from, to: r.email, accountUrl: memberAccountUrl(publicBaseUrl(c), shop) }));
  const tokens = await grant(c, deps.db, deps.secret, shop.id, r.customer_id, r.session_epoch);
  if (!tokens) return c.json({ error: "invalid_password" }, 401);
  return c.json({ ...tokens, member: { id: r.customer_id, email: r.email, created: false } });
});

membersApi.post("/shops/:shop/members/password", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if ((s.shop.settings ?? {})["members_password"] !== true) return c.json({ error: "password_disabled" }, 409);
  const deps = loginDeps(c);
  if (!deps) return c.json({ error: "not_configured" }, 503);
  const password = str((await body(c))["password"]);
  if (password.length < 8 || password.length > 200) return c.json({ error: "weak_password" }, 400);
  // 0057: ログインしてから 15 分以内のセッションだけ（過ぎていれば 403 reauth。連携側はログインし直させる）
  const r = await deps.db.memberSetPassword(s.shop.id, s.member.id, s.member.epoch, password, s.member.sid);
  if (!r.ok) return r.reason === "reauth" ? c.json({ error: "reauth" }, 403) : c.json({ error: "invalid_member_token" }, 401);
  // ほかの端末はログアウト（世代を上げた）。この端末は新しい世代のトークンで続ける。本人にも知らせる（0057）
  if (r.mail_from && r.email) await afterResponse(c, sendAccountChangeNotice(deps, s.shop, { kind: "password", from: r.mail_from, to: r.email, accountUrl: memberAccountUrl(publicBaseUrl(c), s.shop) }));
  const tokens = await grant(c, deps.db, deps.secret, s.shop.id, s.member.id, r.epoch);
  return tokens ? c.json(tokens) : c.json({ error: "invalid_member_token" }, 401);
});

membersApi.get("/shops/:shop/members/oauth/:provider", async (c: Ctx) => {
  const shop = await shopFor(c);
  const p = c.req.param("provider");
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!isProvider(p) || !membersEnabled(shop) || !enabledProviders(shop).includes(p)) return c.json({ error: "provider_disabled" }, 409);
  // 戻り先は許可リストのオリジンだけ（引き換え券を渡すので、オープンリダイレクトにしない）
  const returnTo = safeReturnUrl(c.req.query("return_to"), returnOrigins(shop.settings), "");
  if (!returnTo) return c.json({ error: "invalid_return_to" }, 400);
  return startOAuth(c, shop, p, "api", { return_to: returnTo });
});

/** ヘッドレスでパスキーを出せるか（モジュールが ON・独自ドメインがある）。画面はショップのドメインの上 */
function passkeyOffered(shop: PublicShop): boolean {
  return moduleEnabled(shop.settings, PASSKEY_MODULE) && Boolean(shop.domain);
}

/**
 * パスキーを追加する画面へ送る券（0070）。会員トークン（ログインしてから 15 分以内のセッション）で受け取り、返る url へ会員のブラウザを送る。
 * ショップのドメインの画面でボタンを押すとその端末のパスキーを追加し、`<return_to>?banto_passkey=added` に戻る（券は 2 分・1 回限り）
 */
membersApi.post("/shops/:shop/members/passkey/add", async (c: Ctx) => {
  const s = await bearerMember(c);
  if (s instanceof Response) return s;
  if (!passkeyOffered(s.shop)) return c.json({ error: "passkey_disabled" }, 409);
  const state = migrationStateFor(c, c.get("adapters").config.get("SUPABASE_URL") ?? "");
  if (!state || !(await migrated(state, PASSKEY_ADD_MIGRATION))) return c.json({ error: "migration_required" }, 409);
  const returnTo = safeReturnUrl(str((await body(c))["return_to"]), returnOrigins(s.shop.settings), "");
  if (!returnTo) return c.json({ error: "invalid_return_to" }, 400);
  // 0045 より前に発行したトークン（セッションの行が無い）は、ログインし直してから
  if (!s.member.sid) return c.json({ error: "reauth" }, 403);
  const db = privilegedFor(c);
  const secret = c.get("sessionSecret");
  if (!db || !secret) return c.json({ error: "not_configured" }, 503);
  const token = randomToken(32);
  const r = await db.memberPasskeyTicketCreate(s.shop.id, s.member.id, s.member.epoch, s.member.sid, await linkHash(secret, token));
  if (!r.ok) {
    if (r.reason === "reauth") return c.json({ error: "reauth" }, 403);
    if (r.reason === "session") return c.json({ error: "invalid_member_token" }, 401);
    if (r.reason === "limited") return c.json({ error: "too_many_requests" }, 429);
    return c.json({ error: "passkey_disabled" }, 409);
  }
  return c.json({ url: `https://${s.shop.domain}/account/passkey/add?t=${r.id}.${token}&return_to=${encodeURIComponent(returnTo)}`, expires_in: 120 }, 200, NO_STORE);
});

membersApi.get("/shops/:shop/members/passkey", async (c: Ctx) => {
  const shop = await shopFor(c);
  if (!shop) return c.json({ error: "not_found" }, 404);
  if (!membersEnabled(shop) || !passkeyOffered(shop)) return c.json({ error: "passkey_disabled" }, 409);
  // 戻り先は許可リストのオリジンだけ（引き換え券を渡すので、オープンリダイレクトにしない）
  const returnTo = safeReturnUrl(c.req.query("return_to"), returnOrigins(shop.settings), "");
  if (!returnTo) return c.json({ error: "invalid_return_to" }, 400);
  return c.redirect(`https://${shop.domain}/account/passkey?return_to=${encodeURIComponent(returnTo)}`);
});
