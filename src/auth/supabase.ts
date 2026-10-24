/**
 * Supabase Auth（GoTrue）の REST API を叩く最小クライアント。owner 認証はメール + パスワードと、
 * 運営者の二段階認証（0054。GoTrue の TOTP: 登録・確認・取り消し）だけに留める
 * （ARCHITECTURE.md「運用ルール」: 移行時の書き直しを最小にするため依存を広げない）。
 */

export interface AuthFactor {
  id: string;
  factor_type: string;
  /** verified（登録済み）/ unverified（登録の途中） */
  status: string;
  friendly_name?: string;
}

export interface AuthUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  /** 二段階認証の登録（GoTrue の /token と /user が返す） */
  factors?: AuthFactor[];
}

/** 認証アプリに読ませる QR（SVG の data URI）と、手で入れる秘密 */
export interface TotpEnrollment {
  id: string;
  qr_code: string;
  secret: string;
  uri: string;
}

/** 登録済みの TOTP（無ければ undefined） */
export function verifiedTotp(user: AuthUser): AuthFactor | undefined {
  return user.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** 秒 */
  expires_in: number;
  user: AuthUser;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthClientOptions {
  url: string;
  anonKey: string;
  fetch?: typeof fetch;
}

export interface AuthClient {
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  /** 今のユーザー（二段階認証の登録を含む） */
  getUser(accessToken: string): Promise<AuthUser>;
  /** TOTP を登録し始める（まだ unverified）。verify が済むと verified になる */
  enrollTotp(accessToken: string, friendlyName: string): Promise<TotpEnrollment>;
  /** 6 桁を確かめる（challenge → verify）。成功すると aal2 のセッションが返る */
  verifyTotp(accessToken: string, factorId: string, code: string): Promise<AuthSession>;
  /** 登録を消す（verified の取り消しは aal2 のセッションでだけ GoTrue が許す） */
  unenroll(accessToken: string, factorId: string): Promise<void>;
}

async function toAuthError(res: Response): Promise<AuthError> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { msg?: string; message?: string; error_description?: string; error?: string; error_code?: string; code?: string | number };
    const msg = j.msg ?? j.message ?? j.error_description ?? j.error ?? text;
    return new AuthError(msg, res.status, j.error_code ?? (typeof j.code === "string" ? j.code : undefined));
  } catch {
    return new AuthError(text || res.statusText, res.status);
  }
}

export function createAuthClient(opts: AuthClientOptions): AuthClient {
  const doFetch = opts.fetch ?? fetch;
  const base = `${opts.url.replace(/\/+$/, "")}/auth/v1`;
  const headers = (token?: string): Record<string, string> => ({
    apikey: opts.anonKey,
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await doFetch(`${base}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
    if (!res.ok) throw await toAuthError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    signInWithPassword: (email, password) => post<AuthSession>("/token?grant_type=password", { email, password }),
    refresh: (refresh_token) => post<AuthSession>("/token?grant_type=refresh_token", { refresh_token }),
    async getUser(accessToken) {
      const res = await doFetch(`${base}/user`, { headers: headers(accessToken) });
      if (!res.ok) throw await toAuthError(res);
      return (await res.json()) as AuthUser;
    },
    async enrollTotp(accessToken, friendlyName) {
      const r = await post<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>("/factors", { factor_type: "totp", friendly_name: friendlyName }, accessToken);
      return { id: r.id, qr_code: r.totp.qr_code, secret: r.totp.secret, uri: r.totp.uri };
    },
    async verifyTotp(accessToken, factorId, code) {
      const id = encodeURIComponent(factorId);
      const challenge = await post<{ id: string }>(`/factors/${id}/challenge`, {}, accessToken);
      return post<AuthSession>(`/factors/${id}/verify`, { challenge_id: challenge.id, code }, accessToken);
    },
    async unenroll(accessToken, factorId) {
      const res = await doFetch(`${base}/factors/${encodeURIComponent(factorId)}`, { method: "DELETE", headers: headers(accessToken) });
      if (!res.ok && res.status !== 404) throw await toAuthError(res);
    },
    async signOut(accessToken) {
      const res = await doFetch(`${base}/logout`, { method: "POST", headers: headers(accessToken) });
      // 失効済みトークンでの 401 等は無視してよい（Cookie 側は呼び出し元が消す）
      if (!res.ok && res.status !== 401 && res.status !== 403 && res.status !== 404) throw await toAuthError(res);
    },
  };
}
