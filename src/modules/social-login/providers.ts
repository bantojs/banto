/**
 * 外部のアカウントでのログイン（OpenID Connect）。同梱モジュール line_login / google_login。SDK は使わず fetch と WebCrypto だけ。
 * 設計は docs/knowledge/10-members-identity.md §14、運営者の手順は docs/members.md「LINE・Google でログイン」。
 *
 * - 認可コード + PKCE（S256）+ state + nonce。途中の値は署名付き Cookie（Path=/_oauth、10 分）に持つ（src/routes/storefront/members.ts）。
 * - 提供元の設定（client_id とシークレット）は **ショップごと**。client_id は shops.settings.oauth.<provider>.client_id（ボタンと
 *   認可の URL に使う。公開してよい値）、シークレットは暗号化して shop_oauth_clients（src/members/secret-box.ts）。
 * - 戻り先は提供元ごとに 1 つ（`<PUBLIC_BASE_URL>/_oauth/<provider>/callback`）。どのショップかは Cookie の中身で分かる。
 * - ID トークン: LINE は検証 API（/oauth2/v2.1/verify）で確かめる。Google はトークンのエンドポイントから HTTPS で直接受け取り、
 *   クライアントシークレットで認証しているので、署名の検証は省いてよい（OpenID Connect Core 3.1.3.7、Google の案内）。
 *   どちらも iss・aud・nonce・期限は自分でも見る。
 */
import { b64url, fromB64url, randomToken } from "../../util/signed";

export type Provider = "line" | "google";
export const PROVIDERS: readonly Provider[] = ["line", "google"];

export const PROVIDER_NAMES: Record<Provider, string> = { line: "LINE", google: "Google" };
/** 同梱モジュールの ID */
export const providerModule = (p: Provider) => `${p}_login`;
export const callbackPath = (p: Provider) => `/_oauth/${p}/callback`;
export const isProvider = (s: string | undefined): s is Provider => s === "line" || s === "google";

/** 提供元の秘密を暗号化するときの用途（secret-box の追加認証データ） */
export const secretPurpose = (p: Provider) => `oauth:${p}`;

/** ショップの設定から client_id（無ければ null） */
export function providerClientId(settings: Record<string, unknown> | null | undefined, p: Provider): string | null {
  const oauth = (settings ?? {})["oauth"];
  const entry = oauth && typeof oauth === "object" ? (oauth as Record<string, unknown>)[p] : null;
  const id = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["client_id"] : null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export const ENDPOINTS = {
  line: { authorize: "https://access.line.me/oauth2/v2.1/authorize", token: "https://api.line.me/oauth2/v2.1/token", verify: "https://api.line.me/oauth2/v2.1/verify" },
  google: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" },
} as const;

/** PKCE の verifier と challenge（S256） */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function authorizeUrl(p: Provider, clientId: string, o: { redirectUri: string; state: string; nonce: string; challenge: string; botPrompt?: "normal" | "aggressive" | null }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: o.redirectUri,
    state: o.state,
    // LINE の email はチャネルでメールアドレスの取得権限を申請したときだけ返る
    scope: p === "line" ? "openid profile email" : "openid email profile",
    nonce: o.nonce,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    ...(p === "google" ? { prompt: "select_account" } : {}),
    // LINE: ログインの画面で公式アカウントの友だち追加を促す（購入者に LINE で知らせるため。0021、docs/line.md）
    ...(p === "line" && o.botPrompt ? { bot_prompt: o.botPrompt } : {}),
  });
  return `${ENDPOINTS[p].authorize}?${q}`;
}

export class OAuthError extends Error {
  constructor(
    readonly step: "token" | "verify",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface ProviderIdentity {
  sub: string;
  email: string | null;
  /** 提供元がメールアドレスを確かめているか（確かめていなければ既存の会員と結びつけない） */
  emailVerified: boolean;
}

const form = (data: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });

/** 認可コードを ID トークンに替え、確かめて利用者 ID（とメールアドレス）を返す */
export async function providerIdentity(
  p: Provider,
  doFetch: typeof fetch,
  client: { clientId: string; clientSecret: string },
  o: { code: string; redirectUri: string; verifier: string; nonce: string },
  now = Math.floor(Date.now() / 1000),
): Promise<ProviderIdentity> {
  const tokenRes = await doFetch(ENDPOINTS[p].token, form({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: o.verifier }));
  if (!tokenRes.ok) throw new OAuthError("token", `HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { id_token?: unknown };
  if (typeof token.id_token !== "string") throw new OAuthError("token", "no id_token");

  let claims: { iss?: unknown; sub?: unknown; aud?: unknown; nonce?: unknown; exp?: unknown; email?: unknown; email_verified?: unknown };
  if (p === "line") {
    const verifyRes = await doFetch(ENDPOINTS.line.verify, form({ id_token: token.id_token, client_id: client.clientId, nonce: o.nonce }));
    if (!verifyRes.ok) throw new OAuthError("verify", `HTTP ${verifyRes.status}`);
    claims = (await verifyRes.json()) as typeof claims;
  } else {
    const part = token.id_token.split(".")[1];
    try {
      claims = JSON.parse(new TextDecoder().decode(fromB64url(part ?? ""))) as typeof claims;
    } catch {
      throw new OAuthError("verify", "bad id_token");
    }
  }
  const issOk = p === "line" ? claims.iss === "https://access.line.me" : claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const expOk = p === "line" || (typeof claims.exp === "number" && claims.exp > now);
  if (!issOk || !expOk || claims.aud !== client.clientId || claims.nonce !== o.nonce || typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new OAuthError("verify", "claims mismatch");
  }
  const email = typeof claims.email === "string" && claims.email.includes("@") ? claims.email : null;
  // LINE は登録時にアドレスを確かめている（返ってくれば確認済みとして扱う）。Google は email_verified を見る
  const emailVerified = email !== null && (p === "line" || claims.email_verified === true);
  return { sub: claims.sub, email, emailVerified };
}
