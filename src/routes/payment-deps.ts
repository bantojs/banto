import type { Ctx } from "./common";
import { createPrivilegedDb, type PrivilegedDb } from "../db/privileged";
import { createStripeClient, type StripeClient } from "../payments/stripe";
import { createKomojuClient } from "../plugins/komoju";
import type { CouponSource, PaymentSetup, PlaceOrderDeps } from "../commerce/checkout";
import type { PublicShop } from "../storefront/data";
import { moduleEnabled } from "../modules/registry";

/** 決済まわりのクライアント。ストアフロント（同梱テーマのレジ）とヘッドレス API で共通 */
function stripeFor(c: Ctx): StripeClient | null {
  const cfg = c.get("adapters").config;
  const secretKey = cfg.get("STRIPE_SECRET_KEY");
  if (!secretKey) return null;
  return createStripeClient({ secretKey, clientId: cfg.get("STRIPE_CLIENT_ID"), context: cfg.get("STRIPE_CONTEXT"), fetch: c.get("deps").fetch });
}

function komojuFor(c: Ctx): ReturnType<typeof createKomojuClient> | null {
  const secretKey = c.get("adapters").config.get("KOMOJU_SECRET_KEY");
  return secretKey ? createKomojuClient({ secretKey, fetch: c.get("deps").fetch }) : null;
}

export function privilegedFor(c: Ctx): PrivilegedDb | null {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
}

/** 決済の準備（API と共通）。設定が足りなければ null */
export function placeOrderDeps(c: Ctx, setup: PaymentSetup): PlaceOrderDeps | null {
  const privileged = privilegedFor(c);
  if (!privileged) return null;
  return { privileged, stripe: stripeFor(c), komoju: komojuFor(c), setup };
}

/**
 * クーポンの判定の材料（coupon_lookup、service_role）。同梱モジュール coupons が OFF のショップでは null を返し、
 * カートにも確認画面にも DB の往復を足さない（ショップ行の設定で判定する）
 */
export function couponSource(c: Ctx, shop: PublicShop): CouponSource | null {
  if (!moduleEnabled(shop.settings, "coupons")) return null;
  const privileged = privilegedFor(c);
  if (!privileged) return null;
  return {
    lookup: (codes, subject, customerId) => privileged.couponLookup(shop.id, codes, subject, customerId ?? null),
  };
}
