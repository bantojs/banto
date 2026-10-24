import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { stripeWebhook } from "./stripe";
import { komojuWebhook } from "./komoju";

/**
 * 外部サービスからの Webhook 受信。署名検証 + イベント ID で冪等化（CLAUDE.md §5）。
 * ここは service_role 経路（src/db/privileged.ts）を使う数少ない場所。
 */
export const webhooks = new Hono<AppEnv>();

webhooks.get("/", (c) => c.json({ endpoints: ["/webhooks/stripe", "/webhooks/komoju"] }));
webhooks.route("/stripe", stripeWebhook);
webhooks.route("/komoju", komojuWebhook);
