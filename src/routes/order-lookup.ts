import { ipHash } from "../members/auth";
import { PrivilegedRpcError } from "../db/privileged";
import { ORDER_LOOKUP_LIMITS_MIGRATION } from "../orders/lookup";
import type { PublicShop, StorefrontData } from "../storefront/data";
import { privilegedFor } from "./payment-deps";
import { clientIpFor, type Ctx } from "./common";

/**
 * ゲストの注文照会（番号とメールアドレス）。同梱テーマの画面・領収書とヘッドレス API の両方がここを通る。
 * 0067 が当たっていれば service_role の order_lookup（外れた照会を IP・注文ごとに数える。lookup_order は anon から外れる）、
 * 当たる前は今までどおり anon の lookup_order
 */
export async function guestOrderLookup(c: Ctx, sf: StorefrontData, shop: PublicShop, number: number, email: string): Promise<{ ok: true; order: Record<string, unknown> | null } | { ok: false; reason: "too_many_requests" }> {
  if (!(await sf.migratedTo(ORDER_LOOKUP_LIMITS_MIGRATION))) return { ok: true, order: await sf.lookupOrder(shop, number, email) };
  const db = privilegedFor(c);
  const secret = c.get("sessionSecret");
  if (!db || !secret) return { ok: true, order: null };
  const ip = await clientIpFor(c, shop);
  try {
    const r = await db.orderLookup(shop.id, number, email, ip ? await ipHash(secret, ip) : null);
    return { ok: true, order: r && typeof r === "object" ? r : null };
  } catch (e) {
    if (e instanceof PrivilegedRpcError && e.is("too_many_requests")) return { ok: false, reason: "too_many_requests" };
    throw e;
  }
}
