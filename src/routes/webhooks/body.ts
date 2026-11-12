import { readBodyLimited, type Ctx } from "../common";

/**
 * 決済の Webhook（Stripe・KOMOJU・Amazon Pay）の本文の上限。
 * 正規の通知はどれも数 KB（Stripe の checkout.session のイベント・KOMOJU の payment のイベント・Amazon Pay の SNS の封筒）で、
 * 項目が増えても十分に収まる大きさにした。署名を確かめる前に読むので、ここで止めないと
 * 署名を知らない人が大きな本文でメモリと CPU（HMAC）を使わせられる（Node 実行には本文の上限が無い）。
 */
export const WEBHOOK_BODY_BYTES = 256 * 1024;

export type WebhookBody = { ok: true; text: string } | { ok: false; status: 400 | 413 };

/**
 * Webhook の本文を、実際に読んだバイト数で上限まで読む。
 * 申告の Content-Length が上限より大きければ読まずに 413、申告が小さくても読んだ分で 413（Content-Length を信じない）。
 * 本文が途中で切れた（読み取りの失敗）ら 400
 */
export async function readWebhookText(req: Request, max = WEBHOOK_BODY_BYTES): Promise<WebhookBody> {
  let raw: Uint8Array | null;
  try {
    raw = await readBodyLimited(req, max);
  } catch {
    return { ok: false, status: 400 };
  }
  if (!raw) return { ok: false, status: 413 };
  return { ok: true, text: new TextDecoder().decode(raw) };
}

/** 本文を読み、読めなければ返す応答（413 too_large / 400 invalid_payload）。3 つの Webhook で共通 */
export async function webhookBody(c: Ctx): Promise<{ text: string } | { res: Response }> {
  const body = await readWebhookText(c.req.raw);
  if (body.ok) return { text: body.text };
  return { res: body.status === 413 ? c.json({ error: "too_large" }, 413) : c.json({ error: "invalid_payload" }, 400) };
}
