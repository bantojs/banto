/**
 * お店の行動の中継の入口（同梱モジュール event_relay、0107）。docs/event-relay.md
 *   POST /<ショップ>/_x                        お店の画面のスクリプト（会員の Cookie の署名で会員を確かめる）
 *   POST /api/shops/<ショップ>/events           ヘッドレス（Authorization: Bearer <会員トークン>、無ければゲスト）
 * どちらも DB に触らない（会員は署名だけ、送り先は覚えたもの）。受けたらすぐ 204 を返し、プラグインへは応答の後に送る。
 * モジュールが OFF・形が違う・送り先が無い（ゲストを許した連携が無いショップのゲストなど）でも、送らずに 204（中の様子を外に見せない）。
 * 回数を超えたら 429。ゲストは本文の visitor（ブラウザが作る訪問者 ID、0108）で渡す
 */
import type { PublicShop } from "../../storefront/data";
import { afterResponse, clientIp, param, readBodyLimited, type Ctx } from "../../routes/common";
import { privilegedFor } from "../../routes/payment-deps";
import { moduleEnabled } from "../registry";
import { rateLimiter } from "../../adapters/rate-limit";
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData } from "../../storefront/data";
import { openToken } from "../../members/auth";
import { EVENT_RELAY_MODULE, RELAY_MAX_BYTES, RELAY_PER_MINUTE, forwardRelay, parseRelayBody, relayTargets } from "./relay";

/** 届いたまとまりを受けて送る。customerId は呼ぶ側が署名で確かめた会員（ゲストは null） */
export async function acceptRelay(c: Ctx, shop: PublicShop, customerId: string | null, source: "storefront" | "headless"): Promise<Response> {
  const noContent = () => c.body(null, 204, { "Cache-Control": "no-store" });
  if (!moduleEnabled(shop.settings, EVENT_RELAY_MODULE)) return noContent();
  const ip = clientIp(c) ?? "unknown";
  if (!(await rateLimiter(c.get("adapters")).hit(`relay:${shop.id}:${ip}`, RELAY_PER_MINUTE, 60))) return c.json({ error: "too_many_requests" }, 429);
  const raw = await readBodyLimited(c.req.raw, RELAY_MAX_BYTES);
  if (!raw) return c.json({ error: "too_large" }, 413);
  const body = parseRelayBody(new TextDecoder().decode(raw));
  const secret = c.get("sessionSecret");
  const db = privilegedFor(c);
  if (!body || body.events.length === 0 || (!customerId && !body.visitor) || !secret || !db) return noContent();
  // ゲストのまとまりは、ゲストも渡す連携があるショップだけ送り先を引く（無いショップで DB に問い合わせない。0108 の前は無い）
  if (!customerId && shop.relay_guests !== true) return noContent();
  const targets = await relayTargets({ db, cache: c.get("adapters").cache }, shop.id).catch(() => []);
  if (targets.length === 0) return noContent();
  await afterResponse(c, forwardRelay({ targets, shopId: shop.id, customerId, visitor: body.visitor, source, events: body.events, sessionSecret: secret, fetch: c.get("deps").fetch }).catch(() => 0));
  return noContent();
}

// ---------- ヘッドレス ----------

export const eventsApi = new Hono<AppEnv>();

/** 連携サイトが送る（CORS は公開の *）。会員トークンがあれば署名と期限だけで確かめる（壊れていれば 401）。無ければゲスト */
eventsApi.post("/shops/:shop/events", async (c) => {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return c.json({ error: "not_configured" }, 503);
  const shop = await new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache).shopBySlug(param(c, "shop"));
  if (!shop || !moduleEnabled(shop.settings, EVENT_RELAY_MODULE)) return c.json({ error: "not_found" }, 404);
  const header = c.req.header("authorization") ?? "";
  let customerId: string | null = null;
  if (header) {
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const secret = c.get("sessionSecret");
    const t = token && token !== header && secret && (shop.settings ?? {})["members_enabled"] === true ? await openToken(secret, shop.id, token, "a") : null;
    if (!t) return c.json({ error: "invalid_member_token" }, 401);
    customerId = t.cid;
  }
  return acceptRelay(c, shop, customerId, "headless");
});
