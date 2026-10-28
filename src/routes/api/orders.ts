import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData } from "../../storefront/data";
import { moduleEnabled } from "../../modules/registry";
import { RECEIPT_MODULE, type ReceiptOrder } from "../../modules/receipt/render";
import { receiptAvailable, receiptData } from "../../modules/receipt/data";
import { openOrderToken, sealOrderToken } from "../../orders/lookup";
import { param, type Ctx } from "../common";

/**
 * ヘッドレスのゲストの注文照会・領収書（認証なし、CORS 許可。docs/headless.md「注文照会・領収書」、0066）。
 * Banto は JSON を返すだけで、画面（レイアウト・宛名の欄・印刷）は連携サイトが作る。会員の注文は ./members.ts の /members/orders。
 *
 *   POST /api/shops/:shop/orders/lookup   { number, email } → { order, receipt_available, order_token }
 *        番号と注文時のメールアドレスが合ったときだけ（同梱テーマの注文照会と同じ lookup_order。住所は返さない）。
 *        order_token（24 時間）は領収書と、この注文についてのお問い合わせ（/inquiries の order_token）に渡す
 *   POST /api/shops/:shop/orders/receipt  { order_token } → { receipt }（同梱モジュール receipt が ON・支払い済みの注文だけ）
 *
 * メールアドレスを URL に載せないため、どちらも POST。応答はキャッシュさせない
 */
export const ordersApi = new Hono<AppEnv>();

const NO_STORE = { "cache-control": "no-store" };

async function scope(c: Ctx) {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  const secret = c.get("sessionSecret");
  if (!url || !anonKey || !secret) return c.json({ error: "not_configured" }, 503);
  const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
  const shop = await sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  return { sf, shop, secret };
}

async function body(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

ordersApi.post("/shops/:shop/orders/lookup", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const b = await body(c);
  const number = typeof b["number"] === "number" ? b["number"] : Number.parseInt(String(b["number"] ?? "").trim(), 10);
  const email = typeof b["email"] === "string" ? b["email"].trim() : "";
  if (!Number.isInteger(number) || number <= 0 || !email || email.length > 254) return c.json({ error: "invalid_request" }, 400);
  const order = await s.sf.lookupOrder(s.shop, number, email);
  // 番号とアドレスのどちらが違ったかは返さない
  if (!order) return c.json({ error: "not_found" }, 404, NO_STORE);
  const receipt = moduleEnabled(s.shop.settings, RECEIPT_MODULE) && receiptAvailable(order);
  return c.json({ order, receipt_available: receipt, order_token: await sealOrderToken(s.secret, s.shop.id, number, email) }, 200, NO_STORE);
});

ordersApi.post("/shops/:shop/orders/receipt", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  if (!moduleEnabled(s.shop.settings, RECEIPT_MODULE)) return c.json({ error: "receipt_disabled" }, 404);
  const b = await body(c);
  const ot = await openOrderToken(s.secret, s.shop.id, typeof b["order_token"] === "string" ? b["order_token"] : undefined);
  if (!ot) return c.json({ error: "invalid_order_token" }, 400);
  const order = (await s.sf.lookupOrder(s.shop, ot.number, ot.email)) as ReceiptOrder | null;
  if (!order) return c.json({ error: "not_found" }, 404, NO_STORE);
  if (!receiptAvailable(order)) return c.json({ error: "receipt_not_available" }, 409, NO_STORE);
  return c.json({ receipt: receiptData(s.shop, order, new Date()) }, 200, NO_STORE);
});
