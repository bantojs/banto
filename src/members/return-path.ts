/**
 * ログイン・LINE / Google を結んだ後に戻るお店の中のパス（`return_to`）。テーマのリンク・フォームが今のページを渡す。
 *
 * 開いたリダイレクトを作らないため、受けるのは **同じショップの中のパスだけ**（外のサイトへ戻すのはヘッドレスの
 * `settings.headless.return_origins` の許可リストだけ。src/commerce/checkout.ts の safeReturnUrl）。
 * - `/` で始まり `//` ではない。空白・改行・制御文字・バックスラッシュ・`#` を含まない。長さは 1,000 まで
 * - 仮のオリジンの上で読み直して、オリジンが変わらず、ショップのパス（独自ドメインの上なら ""）の中にあること
 * - Banto が付け足す鍵（`banto_…`）を含まない
 * - ログインの途中の画面・ログアウト・提供元からの戻り（`/_oauth/…`）には戻さない（行ったり来たりになる）。レジ（POST だけの画面）はカートへ
 * 合わなければ null（呼ぶ側は今までどおり会員ページへ）。返すのはパスとクエリを符号化した形
 */
export function safeShopPath(raw: unknown, shopPath: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("#")) return null;
  if (/[\s\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) return null;
  const base = "https://shop.invalid";
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.origin !== base) return null;
  const path = u.pathname;
  if (path.startsWith("/_oauth/") || path === "/_oauth") return null;
  const inShop = shopPath === "" ? true : path === shopPath || path.startsWith(`${shopPath}/`);
  if (!inShop) return null;
  const rest = shopPath === "" ? path : path.slice(shopPath.length) || "/";
  if (/^\/account\/(login|code|verify|logout|logout-all|oauth|passkey|password-login)(\/|$)/.test(rest)) return null;
  if (u.search.includes(";") || [...u.searchParams.keys()].some(bantoKey)) return null;
  // レジの画面は POST だけなので、戻る先はカート
  if (rest === "/checkout" || rest.startsWith("/checkout/")) return `${shopPath}/cart`;
  return `${path}${u.search}`;
}

/** Banto が付け足す鍵（banto_…）に読めるか（. や空白を _ に直す・もう一度復号する読み方も同じ鍵として扱う） */
function bantoKey(key: string): boolean {
  let k = key;
  try {
    k = decodeURIComponent(key);
  } catch {
    // 復号できない鍵はそのまま見る
  }
  return k.toLowerCase().replace(/[^a-z0-9]/g, "_").startsWith("banto_");
}

/** ログインの画面へのリンク（今のページへ戻す）。今のページが戻せないなら return_to を付けない */
export function loginUrlFor(shopPath: string, currentPath: string | null | undefined): string {
  const back = currentPath ? safeShopPath(currentPath, shopPath) : null;
  return `${shopPath}/account/login${back ? `?return_to=${encodeURIComponent(back)}` : ""}`;
}
