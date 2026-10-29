/**
 * 注文照会（0066_headless_order_lookup、docs/headless.md「注文照会・領収書」）。Banto はデータ（JSON）を渡すだけで、画面は連携サイトが作る。
 *
 * - 注文照会のページ（連携サイト）は shops.settings.headless.order_page_url（許可リストのオリジンの https）。
 *   注文メールのリンクと、Banto の注文照会の画面の転送先に使う
 * - メールのリンクは `<ページ>?banto_order=<番号>`、会員の注文なら `&banto_member=1` も付ける。秘密は URL に載せない
 *   （会員は会員トークンで、ゲストは番号とメールアドレスで開く）
 * - 「注文トークン」は、番号とメールアドレスが合った組をショップごとに署名したもの（24 時間）。ゲストの領収書と、
 *   注文から開くお問い合わせ（同梱モジュール inquiries）に渡す。署名の鍵の用途は inquiries から使っていた名前のまま
 */
import { openJson, sealJson } from "../util/signed";

/** 注文トークンの期限（注文照会の結果・会員の注文から開いたフォームに使う） */
export const ORDER_TOKEN_SECONDS = 24 * 60 * 60;

const orderSecret = (secret: string, shopId: string) => `${secret}|inquiry-order|${shopId}`;

export function sealOrderToken(secret: string, shopId: string, number: number, email: string, now = Date.now()): Promise<string> {
  return sealJson(orderSecret(secret, shopId), { n: number, e: email.trim().toLowerCase(), exp: Math.floor(now / 1000) + ORDER_TOKEN_SECONDS });
}

export async function openOrderToken(secret: string, shopId: string, raw: string | undefined, now = Date.now()): Promise<{ number: number; email: string } | null> {
  if (!raw || raw.length > 1000) return null;
  const v = (await openJson(orderSecret(secret, shopId), raw)) as { n?: unknown; e?: unknown; exp?: unknown } | null;
  if (!v || typeof v.n !== "number" || typeof v.e !== "string" || typeof v.exp !== "number" || v.exp * 1000 < now) return null;
  return { number: v.n, email: v.e };
}

/** 注文照会のページ（連携サイト）。https の文字列でなければ null（保存のときに許可リストのオリジンか確かめている） */
export function orderPageUrl(settings: Record<string, unknown> | null | undefined): string | null {
  const h = (settings ?? {})["headless"];
  const v = h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>)["order_page_url"] : null;
  return typeof v === "string" && v.startsWith("https://") ? v : null;
}

/** 注文メールのリンク。page は連携サイトの注文照会のページか、Banto の /orders/lookup */
export function orderLink(page: string, number: number, member: boolean): string {
  const u = new URL(page);
  u.searchParams.set("banto_order", String(number));
  if (member) u.searchParams.set("banto_member", "1");
  else u.searchParams.delete("banto_member");
  return u.toString();
}

/** ?banto_order= の番号（数字だけ・9 桁まで）。合わなければ null */
export function orderNumberParam(v: string | undefined): number | null {
  return v && /^[0-9]{1,9}$/.test(v) ? Number(v) : null;
}
