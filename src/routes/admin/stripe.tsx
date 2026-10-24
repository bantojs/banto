import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { createStripeClient, StripeError } from "../../payments/stripe";
import { openJson, sealJson } from "../../util/signed";
import { owner, param, publicBaseUrl, sessionSecret, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * Stripe Connect（Standard、OAuth）。保持するのは stripe_account_id だけ（CLAUDE.md §1-5）。
 *   GET  /admin/shops/:shopId/stripe/connect     → Stripe の接続画面へ
 *   GET  /admin/stripe/callback?code&state       ← Stripe から戻る
 *   POST /admin/shops/:shopId/stripe/disconnect
 */
export const stripe = new Hono<AppEnv>();

interface ConnectState {
  shop_id: string;
  user_id: string;
  exp: number;
}

function stripeClient(c: AdminContext) {
  const cfg = c.get("adapters").config;
  const secretKey = cfg.get("STRIPE_SECRET_KEY");
  const clientId = cfg.get("STRIPE_CLIENT_ID");
  if (!secretKey || !clientId) return null;
  return createStripeClient({ secretKey, clientId, context: cfg.get("STRIPE_CONTEXT"), fetch: c.get("deps").fetch });
}

/** Connect（OAuth）が使える設定か */
export function stripeConnectConfigured(c: AdminContext): boolean {
  return stripeClient(c) !== null;
}

function callbackUrl(c: AdminContext): string {
  return `${publicBaseUrl(c)}/admin/stripe/callback`;
}

stripe.get("/shops/:shopId/stripe/connect", requireOwner, async (c: AdminContext) => {
  const { db, session } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text("not found", 404);
  const client = stripeClient(c);
  const secret = sessionSecret(c);
  if (!client || !secret) return c.redirect(`/admin/shops/${shopId}?flash=stripe_not_configured`);
  const state: ConnectState = { shop_id: shopId, user_id: session.user_id, exp: Math.floor(Date.now() / 1000) + 10 * 60 };
  return c.redirect(client.oauthAuthorizeUrl({ redirectUri: callbackUrl(c), state: await sealJson(secret, state) }));
});

stripe.get("/stripe/callback", requireOwner, async (c: AdminContext) => {
  const { db, session } = owner(c);
  const secret = sessionSecret(c);
  const client = stripeClient(c);
  const state = secret ? ((await openJson(secret, c.req.query("state"))) as Partial<ConnectState> | null) : null;
  if (!state || typeof state.shop_id !== "string" || state.user_id !== session.user_id || typeof state.exp !== "number" || state.exp < Date.now() / 1000) {
    return c.redirect("/admin?flash=stripe_state_invalid");
  }
  const back = `/admin/shops/${state.shop_id}`;
  if (c.req.query("error")) return c.redirect(`${back}?flash=stripe_failed`);
  const code = c.req.query("code");
  if (!code || !client) return c.redirect(`${back}?flash=stripe_failed`);
  try {
    const { stripe_user_id } = await client.oauthToken(code);
    const rows = await db.from<ShopRow>("shops").update({ stripe_account_id: stripe_user_id }, { id: state.shop_id });
    if (rows.length === 0) return c.redirect(`${back}?flash=stripe_failed`);
  } catch (e) {
    if (e instanceof StripeError || e instanceof DbError) return c.redirect(`${back}?flash=stripe_failed`);
    throw e;
  }
  return c.redirect(`${back}?flash=stripe_connected`);
});

stripe.post("/shops/:shopId/stripe/disconnect", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text("not found", 404);
  const client = stripeClient(c);
  if (shop.stripe_account_id && client) {
    // Stripe 側の解除に失敗しても、こちらの接続情報は消す（再接続すれば整合する）
    await client.deauthorize(shop.stripe_account_id).catch(() => undefined);
  }
  await db.from<ShopRow>("shops").update({ stripe_account_id: null }, { id: shopId });
  return c.redirect(`/admin/shops/${shopId}?flash=stripe_disconnected`);
});
