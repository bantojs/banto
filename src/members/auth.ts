/**
 * 会員のログインの部品（docs/knowledge/10-members-identity.md）。WebCrypto だけを使い、ランタイムに依存しない。
 *
 * - コード（6 桁）とリンクのトークン（32 バイト）は、ここで作ってメールで送り、DB には HMAC の値だけを渡す。
 *   照合・回数の制限・失効は DB の関数（0012_member_auth.sql）が行う。ここでは比べない。
 * - HMAC の鍵はサイトの秘密（sessionSecret）から用途ごとに分けて作る。DB だけが漏れても、6 桁のコードを逆算できない。
 * - セッション（Cookie）とヘッドレスのトークンは署名付き JSON（util/signed）。中身は会員 ID と世代（session_epoch）とセッションの ID と期限。
 *   世代を上げると（全端末からログアウト・運営者によるメールアドレスの変更）、それより前のセッションは会員の RPC で弾かれる。
 *   端末ごとの取り消しはセッションの行（0045）で行う。
 */
import { openJson, randomToken, sealJson } from "../util/signed";

const enc = new TextEncoder();

/** 6 桁のコード。剰余の偏りが出ないように、端数の範囲の乱数は捨てて引き直す */
export function generateCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, "0");
  }
}

export function generateLinkToken(): string {
  return randomToken(32);
}

async function hmacHex(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`${secret}|member-auth|${purpose}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** コード・トークン・IP の HMAC（用途ごとに鍵を分ける） */
export const codeHash = (secret: string, code: string) => hmacHex(secret, "code", code);
export const linkHash = (secret: string, token: string) => hmacHex(secret, "link", token);
export const ipHash = (secret: string, ip: string) => hmacHex(secret, "ip", ip);
/** 在庫予約・試着の「同じ人」（会員 ID かメールアドレス）の HMAC（0029） */
export const subjectHash = (secret: string, who: string) => hmacHex(secret, "subject", who);
/** パスキーの challenge の HMAC（0046。DB には生の値を置かない） */
export const passkeyChallengeHash = (secret: string, challenge: string) => hmacHex(secret, "passkey", challenge);
/** お問い合わせのチケットを開くリンクのトークンと、試行の回数を数えるメールアドレスの HMAC（0061。DB には生の値を置かない） */
export const inquiryLinkHash = (secret: string, token: string) => hmacHex(secret, "inquiry-link", token);
export const inquiryEmailHash = (secret: string, email: string) => hmacHex(secret, "inquiry-email", email.trim().toLowerCase());
/** この端末でこの会員がログインしたことがある印（知らせのメールを送るかの判定、src/members/notice.ts） */
export const deviceMark = (secret: string, shopId: string, customerId: string) => hmacHex(secret, "device", `${shopId}|${customerId}`);

export function normalizeEmail(s: string | undefined | null): string {
  return (s ?? "").trim().toLowerCase();
}

export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

/** 画面に出すときに伏せる（t***@gmail.com） */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

// ---------- セッション ----------
/**
 * 端末ごとのセッション（0045_member_sessions、監査 M9）。ログインのたびに DB に 1 行作り、Cookie とトークンにその ID（sid）を入れる。
 * ログアウト・一覧からの取り消し・refresh の使い回しの検知で、その端末だけを止められる。
 * 0045 が当たるまでは sid なしの今までの形で動く（docs/upgrade.md「適用するまでのあいだ」）。当たった後は sid の無い Cookie・トークンを通さない。
 */
export const MEMBER_SESSIONS_MIGRATION = "0045_member_sessions";

export interface MemberSession {
  /** 会員 ID（customers.id） */
  cid: string;
  /** customers.session_epoch */
  ep: number;
  /** Cookie の期限（UNIX 秒。開くたびに延ばす） */
  exp: number;
  /** 表示用（照合には使わない） */
  email: string;
  /** member_sessions.id（0045 から） */
  sid?: string;
  /** 最後に DB で行を確かめた時刻（UNIX 秒）。SESSION_CHECK_SECONDS を過ぎたら確かめ直す */
  chk?: number;
  /** ログインした時刻（UNIX 秒）。画面の出し分けだけに使う（パスキーの追加が今できるか。判定は DB） */
  iat?: number;
}

/** Cookie の期限（開くたびに延ばす） */
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
/** セッションの行の絶対の期限。延ばさない。過ぎたらログインし直す */
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;
/** Cookie のセッションを DB で確かめ直す間隔。取り消しが効くまで最大この秒数かかる（毎回は問い合わせない。速度の予算） */
export const SESSION_CHECK_SECONDS = 5 * 60;

const sessionSecret = (secret: string, shopId: string) => `${secret}|member-session|${shopId}`;

export function sealSession(secret: string, shopId: string, s: MemberSession): Promise<string> {
  return sealJson(sessionSecret(secret, shopId), s);
}

export async function openSession(secret: string, shopId: string, raw: string | undefined, now = Math.floor(Date.now() / 1000)): Promise<MemberSession | null> {
  const v = (await openJson(sessionSecret(secret, shopId), raw)) as Partial<MemberSession> | null;
  if (!v || typeof v.cid !== "string" || typeof v.ep !== "number" || typeof v.exp !== "number" || v.exp <= now) return null;
  return {
    cid: v.cid,
    ep: v.ep,
    exp: v.exp,
    email: typeof v.email === "string" ? v.email : "",
    ...(typeof v.sid === "string" ? { sid: v.sid } : {}),
    ...(typeof v.chk === "number" ? { chk: v.chk } : {}),
    ...(typeof v.iat === "number" ? { iat: v.iat } : {}),
  };
}

/** 一覧に出す端末の目安。ブラウザと OS の名前だけにする（User-Agent そのものは置かない） */
export function deviceLabel(ua: string | undefined | null): string | null {
  const u = ua ?? "";
  if (!u) return null;
  const browser = /\bLine\//.test(u)
    ? "LINE"
    : /\bEdg(?:e|A|iOS)?\//.test(u)
      ? "Edge"
      : /\b(?:OPR|Opera)\//.test(u)
        ? "Opera"
        : /\b(?:Firefox|FxiOS)\//.test(u)
          ? "Firefox"
          : /\b(?:Chrome|CriOS)\//.test(u)
            ? "Chrome"
            : /\bSafari\//.test(u)
              ? "Safari"
              : null;
  const os = /\b(?:iPhone|iPad|iPod)\b/.test(u) ? "iOS" : /\bAndroid\b/.test(u) ? "Android" : /\bWindows\b/.test(u) ? "Windows" : /\bMac OS X\b|\bMacintosh\b/.test(u) ? "macOS" : /\bCrOS\b/.test(u) ? "ChromeOS" : /\bLinux\b/.test(u) ? "Linux" : null;
  const label = [browser, os].filter(Boolean).join(" / ");
  return label || null;
}

// ---------- ヘッドレスのトークン ----------
/** 中身は署名付きの平文（暗号化していない）なので、メールアドレスなどの個人情報は入れない（監査 M9） */
export interface MemberToken {
  /** 種類: access（15 分）/ refresh（30 日。セッションの絶対の期限を越えない） */
  typ: "a" | "r";
  shop: string;
  cid: string;
  ep: number;
  exp: number;
  /** member_sessions.id（0045 から） */
  sid?: string;
  /** refresh の世代（0045 から。refresh だけ） */
  gen?: number;
}

/** access は DB で確かめない（署名と期限と世代だけ）。取り消しが効くまで最大この秒数かかる */
export const ACCESS_SECONDS = 15 * 60;
export const REFRESH_SECONDS = SESSION_SECONDS;

const tokenSecret = (secret: string) => `${secret}|member-token`;

export async function issueTokens(
  secret: string,
  shopId: string,
  cid: string,
  ep: number,
  session: { sid: string; gen: number; expiresAt: number } | null,
  now = Math.floor(Date.now() / 1000),
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const base = { shop: shopId, cid, ep, ...(session ? { sid: session.sid } : {}) };
  const refreshExp = session ? Math.min(now + REFRESH_SECONDS, session.expiresAt) : now + REFRESH_SECONDS;
  return {
    access_token: `bm1.${await sealJson(tokenSecret(secret), { ...base, typ: "a", exp: Math.min(now + ACCESS_SECONDS, refreshExp) })}`,
    refresh_token: `bm1.${await sealJson(tokenSecret(secret), { ...base, typ: "r", exp: refreshExp, ...(session ? { gen: session.gen } : {}) })}`,
    expires_in: Math.min(ACCESS_SECONDS, refreshExp - now),
  };
}

/** 署名・種類・ショップ・期限を確かめる。世代は確かめない（会員の RPC が確かめる） */
export async function openToken(secret: string, shopId: string, token: string, typ: "a" | "r", now = Math.floor(Date.now() / 1000)): Promise<MemberToken | null> {
  if (!token.startsWith("bm1.")) return null;
  const v = (await openJson(tokenSecret(secret), token.slice(4))) as Partial<MemberToken> | null;
  if (!v || v.typ !== typ || v.shop !== shopId || typeof v.cid !== "string" || typeof v.ep !== "number" || typeof v.exp !== "number" || v.exp <= now) return null;
  return { typ, shop: v.shop, cid: v.cid, ep: v.ep, exp: v.exp, ...(typeof v.sid === "string" ? { sid: v.sid } : {}), ...(typeof v.gen === "number" ? { gen: v.gen } : {}) };
}

// ---------- 照合中のチャレンジ（コードを入れる画面まで持ち回る） ----------
export interface PendingLogin {
  id: string;
  email: string;
  exp: number;
  /** ログインした後に開く画面（パスキーを追加する前の確かめ） */
  next?: "passkeys";
}

const pendingSecret = (secret: string, shopId: string) => `${secret}|member-pending|${shopId}`;

export function sealPending(secret: string, shopId: string, p: PendingLogin): Promise<string> {
  return sealJson(pendingSecret(secret, shopId), p);
}

export async function openPending(secret: string, shopId: string, raw: string | undefined, now = Math.floor(Date.now() / 1000)): Promise<PendingLogin | null> {
  const v = (await openJson(pendingSecret(secret, shopId), raw)) as Partial<PendingLogin> | null;
  if (!v || typeof v.id !== "string" || typeof v.email !== "string" || typeof v.exp !== "number" || v.exp <= now) return null;
  return { id: v.id, email: v.email, exp: v.exp, ...(v.next === "passkeys" ? { next: v.next } : {}) };
}
