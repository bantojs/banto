/**
 * Amazon Pay の中継ページ・戻り・取り消し（同梱プラグイン amazon_pay。流れは src/payments/amazon-pay.ts）。
 *
 *   GET <shop>/checkout/amazon-pay/start?t=…    Banto の短いページ。ここだけ Amazon の checkout.js を読み、支払いボタンを出す
 *   GET <shop>/checkout/amazon-pay/relay.js     そのページのスクリプト（Banto のオリジンから配る）
 *   GET <shop>/checkout/amazon-pay/return?t=…   Amazon Pay から戻る。API で引き直して確定し、完了画面へ
 *   GET <shop>/checkout/amazon-pay/cancel?t=…   Amazon Pay の画面で戻るを押した。予約を戻してカートへ
 *
 * テーマは描かない（Liquid のテーマのレジの CSP を変えないため）。お店の画面の使い方（storefront.mode）に関わらず残す（src/storefront/mode.ts）。
 */
import type { Ctx } from "../common";
import type { PublicShop } from "../../storefront/data";
import { t } from "../../i18n";
import { escapeHtml } from "../../mail/html";
import { migrated } from "../../db/migration-state";
import { migrationStateFor } from "../common";
import { REPLAY_GUARD_MIGRATION } from "../webhooks/stripe";
import { amazonPayFor, privilegedFor } from "../payment-deps";
import { CHECKOUT_SESSION_ID_RE } from "../../plugins/amazon_pay";
import { AMAZON_PAY_RELAY_CSP, AMAZON_PAY_RELAY_SCRIPT, buttonPayload, handleAmazonPayReturn, openAmazonPayTicket } from "../../payments/amazon-pay";
import { AMAZON_PAY_SCRIPT_URL } from "../../plugins/amazon_pay";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

function page(c: Ctx, title: string, body: string, opts: { status?: 200 | 400 | 409 | 503; head?: string; csp?: string } = {}): Response {
  c.header("Cache-Control", "no-store");
  // 券が付いた URL を Amazon や外へ参照元として渡さない
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", opts.csp ?? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header("X-Robots-Tag", "noindex");
  return c.html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.7;color:#222;background:#fff}.muted{color:#666}#banto-amazon-pay-button{margin:1.5rem 0;min-height:45px}</style>${opts.head ?? ""}</head><body>${body}</body></html>`,
    opts.status ?? 200,
  );
}

function expired(c: Ctx, shopUrl: string): Response {
  return page(c, t("amazon_pay.expired_title"), `<h1>${escapeHtml(t("amazon_pay.expired_title"))}</h1><p>${escapeHtml(t("amazon_pay.expired_body"))}</p><p><a href="${escapeHtml(`${shopUrl}/cart`)}">${escapeHtml(t("amazon_pay.back_to_cart"))}</a></p>`, { status: 400 });
}

/** 中継ページ: 支払いボタン（Amazon の checkout.js）。ボタンの中身（金額・戻り先・予約）は Banto が署名する */
export async function amazonPayStart(c: Ctx, shop: PublicShop, shopUrl: string): Promise<Response> {
  const secret = c.get("sessionSecret");
  const client = amazonPayFor(c);
  if (!secret || !client) return expired(c, shopUrl);
  const token = c.req.query("t");
  const ticket = await openAmazonPayTicket(secret, token, shop.id);
  if (!ticket || !token) return expired(c, shopUrl);
  const q = `t=${encodeURIComponent(token)}`;
  const payload = buttonPayload({
    storeId: client.storeId,
    ticket,
    returnUrl: `${shopUrl}/checkout/amazon-pay/return?${q}`,
    cancelUrl: `${shopUrl}/checkout/amazon-pay/cancel?${q}`,
    storeName: shop.name,
  });
  const signature = await client.signButtonPayload(payload);
  const id = client.publicKeyId.toUpperCase();
  const config = { merchantId: client.merchantId, publicKeyId: client.publicKeyId, payload, signature, sandbox: client.sandbox && !id.startsWith("SANDBOX") && !id.startsWith("LIVE") };
  // JSON の欄はスクリプトとして動かない（CSP の外）。</script> で抜けないように < を逃がす
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const body =
    `<h1>${escapeHtml(t("amazon_pay.start_title"))}</h1>` +
    `<p>${escapeHtml(t("amazon_pay.start_amount").replace("{amount}", yen(ticket.amountJpy)))}</p>` +
    `<p class="muted">${escapeHtml(t("amazon_pay.start_hint"))}</p>` +
    `<div id="banto-amazon-pay-button"></div>` +
    `<p id="banto-amazon-pay-wait" class="muted">${escapeHtml(t("amazon_pay.start_loading"))}</p>` +
    `<p><a href="${escapeHtml(`${shopUrl}/checkout/amazon-pay/cancel?${q}`)}">${escapeHtml(t("amazon_pay.cancel"))}</a></p>` +
    `<script type="application/json" id="banto-amazon-pay">${json}</script>` +
    `<script src="${AMAZON_PAY_SCRIPT_URL}"></script>` +
    `<script src="${escapeHtml(`${shopUrl}/checkout/amazon-pay/relay.js`)}"></script>`;
  return page(c, t("amazon_pay.start_title"), body, { csp: AMAZON_PAY_RELAY_CSP });
}

export function amazonPayRelayScript(c: Ctx): Response {
  c.header("Cache-Control", "public, max-age=300");
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(AMAZON_PAY_RELAY_SCRIPT);
}

/** 戻り: Amazon Pay の API で引き直して確定する。一時的に答えが無ければ、同じ URL を開き直せるページを出す */
export async function amazonPayReturn(c: Ctx, shop: PublicShop, shopUrl: string): Promise<Response> {
  const secret = c.get("sessionSecret");
  const client = amazonPayFor(c);
  const db = privilegedFor(c);
  if (!secret || !client || !db) return expired(c, shopUrl);
  const ticket = await openAmazonPayTicket(secret, c.req.query("t"), shop.id);
  if (!ticket) return expired(c, shopUrl);
  const sid = c.req.query("amazonCheckoutSessionId") ?? "";
  if (!CHECKOUT_SESSION_ID_RE.test(sid)) return c.redirect(ticket.cancelUrl, 303);
  const url = c.get("adapters").config.get("SUPABASE_URL") ?? "";
  const ms = migrationStateFor(c, url);
  const guard = ms ? await migrated(ms, REPLAY_GUARD_MIGRATION) : false;
  const r = await handleAmazonPayReturn({ db, client, ticket, checkoutSessionId: sid, guard });
  if (r.kind === "success") return c.redirect(ticket.successUrl, 303);
  if (r.kind === "cancelled" || r.kind === "mismatch") return c.redirect(withNotice(ticket.cancelUrl, `${shopUrl}/cart`), 303);
  const again = new URL(c.req.url);
  const retry = `${shopUrl}/checkout/amazon-pay/return${again.search}`;
  return page(c, t("amazon_pay.retry_title"), `<h1>${escapeHtml(t("amazon_pay.retry_title"))}</h1><p>${escapeHtml(t("amazon_pay.retry_body"))}</p><p><a href="${escapeHtml(retry)}">${escapeHtml(t("amazon_pay.retry_link"))}</a></p>`, { status: 503 });
}

/** Banto のカートへ戻すときだけ「支払いが済まなかった」を出す（外のサイトの URL には足さない） */
function withNotice(cancelUrl: string, cartUrl: string): string {
  return cancelUrl === cartUrl ? `${cartUrl}?error=unpaid` : cancelUrl;
}

/** Amazon Pay の画面で戻るを押した: 予約を戻してカートへ（確定した予約は戻らない。release_reservation は pending だけ） */
export async function amazonPayCancel(c: Ctx, shop: PublicShop, shopUrl: string): Promise<Response> {
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  const ticket = secret ? await openAmazonPayTicket(secret, c.req.query("t"), shop.id) : null;
  if (!ticket || !db) return c.redirect(`${shopUrl}/cart`, 303);
  await db.releaseReservation(ticket.reservationId, ticket.shopId).catch(() => false);
  return c.redirect(ticket.cancelUrl, 303);
}
