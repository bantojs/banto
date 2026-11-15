/**
 * パスごとの本文の上限（src/app.ts のミドルウェアと、ショップのドメインの振り分けが本文を読むときの両方が使う）。
 * null は、ここでは数えない入口: 運営者・AI 用 API（ログインかトークンが要り、画像・テーマの取り込みは入口ごとに読みながら数える）と、
 * 決済の Webhook（署名の確認の前に 256 KiB で止める）。お店の画面（独自ドメインではスラッグの無いパス）と公開 API は、
 * だれでも送れるのでここで止める。運営者の入口のうち、ログインの前に本文を読むもの（ログイン・招待・セットアップ・二段階認証）も同じ
 */

/** お問い合わせの入口（添付 5MB × 3） */
const INQUIRY_BODY_BYTES = 20 * 1024 * 1024;
/** そのほかのお店の画面・公開 API のフォームと、ログインの前の運営者の入口 */
const PUBLIC_BODY_BYTES = 2 * 1024 * 1024;

/** ログインの前に本文を読む運営者の入口 */
const ADMIN_ANONYMOUS = ["/admin/login", "/admin/logout", "/admin/invite", "/admin/setup", "/admin/mfa"];

export function bodyLimitFor(path: string): number | null {
  if (ADMIN_ANONYMOUS.some((p) => path === p || path.startsWith(`${p}/`))) return PUBLIC_BODY_BYTES;
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/v1/") || path === "/mcp" || path.startsWith("/webhooks/")) return null;
  if (/(^|\/)inquiries(\/|$)/.test(path)) return INQUIRY_BODY_BYTES;
  return PUBLIC_BODY_BYTES;
}
