/**
 * Cookie の名前と見出し（`__Host-` の接頭辞、docs/knowledge/02-decisions.md 2026-11-13）。
 *
 * HTTPS で `Path=/` に置く Cookie は `__Host-<名前>` にする。ブラウザは `__Host-` の Cookie を、Secure・Path=/・Domain なしで
 * そのホストが置いたものしか受け付けないので、同じ登録ドメインの別のサブドメイン（同じドメインで動かしているブログなど）から
 * `Domain=` で Cookie を差し込まれない。http のとき（手元の確認）と、Banto の URL の `/<スラッグ>` に置く Cookie は今までの名前のまま
 * （`__Host-` は Path=/ が必須のため）。
 *
 * 読むときは、接頭辞の付く場面では `__Host-` の名前だけを読む（古い名前は、差し込まれたものかもしれないので信じない）。
 * 同じ名前が 2 つ届いたら、無いものとして扱う。
 */

export const HOST_PREFIX = "__Host-";

export interface CookieScope {
  /** 置くパス（`/` のときだけ接頭辞を付けられる） */
  path: string;
  /** HTTPS で届いたか（src/routes/common.ts の isSecureRequest） */
  secure: boolean;
}

/** 接頭辞を付ける場面か */
export function hostPrefixed(scope: CookieScope): boolean {
  return scope.secure && scope.path === "/";
}

/** この場面で使う Cookie の名前 */
export function scopedCookieName(base: string, scope: CookieScope): string {
  return hostPrefixed(scope) ? `${HOST_PREFIX}${base}` : base;
}

/** Set-Cookie の値（HttpOnly・SameSite=Lax。HTTPS なら Secure） */
export function serializeCookie(name: string, value: string, opts: { path: string; secure: boolean; maxAge: number }): string {
  return [`${name}=${value}`, `Path=${opts.path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${opts.maxAge}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

/** 見出しの中の、その名前の値をすべて（同じ名前が複数届くことがある） */
export function readCookieAll(cookieHeader: string | undefined, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) out.push(rest.join("="));
  }
  return out;
}

/**
 * この場面の Cookie の値。接頭辞の付く場面では `__Host-` の名前だけを読み、2 つ以上あれば undefined。
 * legacy が true なら、`__Host-` が無いときだけ古い名前も読む（移しても困らない値だけ。今はカート）
 */
export function readScopedCookie(cookieHeader: string | undefined, base: string, scope: CookieScope, opts: { legacy?: boolean } = {}): string | undefined {
  if (!hostPrefixed(scope)) return readCookieAll(cookieHeader, base)[0];
  const values = readCookieAll(cookieHeader, `${HOST_PREFIX}${base}`);
  if (values.length > 1) return undefined;
  if (values.length === 1) return values[0];
  return opts.legacy ? readCookieAll(cookieHeader, base)[0] : undefined;
}

/**
 * 置く Set-Cookie。接頭辞の付く場面か置き場のパスが変わったとき、古い Cookie が届いていれば、それを消す見出しも返す
 * （legacyPath は古い Cookie を置いていたパス。管理画面は /admin、LINE / Google の途中は /_oauth だった）
 */
export function scopedSetCookies(cookieHeader: string | undefined, base: string, value: string, scope: CookieScope & { maxAge: number; legacyPath?: string }): string[] {
  const out: string[] = [];
  const moved = hostPrefixed(scope) || Boolean(scope.legacyPath && scope.legacyPath !== scope.path);
  // 古いものを先に消す（パスが違えばブラウザでは別の Cookie だが、名前が同じでも後に書いた方が残るように）
  if (moved && readCookieAll(cookieHeader, base).length > 0) {
    out.push(serializeCookie(base, "", { path: scope.legacyPath ?? scope.path, secure: scope.secure, maxAge: 0 }));
  }
  out.push(serializeCookie(scopedCookieName(base, scope), value, { path: scope.path, secure: scope.secure, maxAge: scope.maxAge }));
  return out;
}

/** 消す Set-Cookie（今の名前と古い名前の両方。古いものは legacyPath に置いてあった） */
export function scopedClearCookies(base: string, scope: CookieScope & { legacyPath?: string }): string[] {
  const out = [serializeCookie(scopedCookieName(base, scope), "", { path: scope.path, secure: scope.secure, maxAge: 0 })];
  if (hostPrefixed(scope) || (scope.legacyPath && scope.legacyPath !== scope.path)) {
    out.push(serializeCookie(base, "", { path: scope.legacyPath ?? scope.path, secure: scope.secure, maxAge: 0 }));
  }
  return out;
}
