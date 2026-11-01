/**
 * つなぐ手順の引き換え（0088、docs/hooks.md §6）。プラグインのサーバーが、運営者のブラウザで受け取った券を裏で引き換える:
 *   POST /api/connect/exchange  { "ticket": "…" }
 *   → { token, signing_secret, shop, endpoint_id, app, scopes, api_base }
 * - 券は 2 分・1 回だけ（判定は DB の app_connect_exchange）。ブラウザから呼ぶものではないので CORS は付けない
 * - トークンと署名シークレットはここで作り、トークンは SHA-256 の値だけ、シークレットはサイトの秘密から作った鍵で暗号化して DB へ
 *   （CLAUDE.md §1-5 の例外 (c)）。生の値はこの応答にだけ出す
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createPrivilegedDb, PrivilegedRpcError } from "../../db/privileged";
import { generateApiToken, hashApiToken, tokenPrefix } from "../../api/tokens";
import { connectionSecretPurpose, newConnectionSecret } from "../../hooks/signing";
import { sealSecret } from "../../members/secret-box";
import { MAX_JSON_BODY_BYTES, publicBaseUrl, readBodyLimited, type Ctx } from "../common";
import { BANTO_VERSION } from "../../version";

export const connectApi = new Hono<AppEnv>();

const TICKET_RE = /^[A-Za-z0-9_-]{40,60}$/;

connectApi.post("/connect/exchange", async (c: Ctx) => {
  const noStore = { "Cache-Control": "no-store" };
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  const siteSecret = c.get("sessionSecret");
  if (!url || !serviceRoleKey || !siteSecret) return c.json({ error: "not_configured" }, 503, noStore);
  const raw = await readBodyLimited(c.req.raw, MAX_JSON_BODY_BYTES);
  let ticket: unknown = null;
  try {
    ticket = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>)["ticket"] : null;
  } catch {
    ticket = null;
  }
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) return c.json({ error: "invalid_ticket" }, 400, noStore);
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  const ticketHash = await hashApiToken(ticket);
  try {
    const where = await db.appConnectTicket(ticketHash);
    if (!where) return c.json({ error: "invalid_ticket" }, 400, noStore);
    const token = generateApiToken();
    const secret = newConnectionSecret();
    const box = await sealSecret(siteSecret, where.shop_id, connectionSecretPurpose(where.endpoint_id), secret);
    const r = await db.appConnectExchange(ticketHash, await hashApiToken(token), tokenPrefix(token), box);
    // 券の行き先が引き換えのあいだに変わっていないこと（暗号化の追加認証データが合わなくなる）
    if (r.shop_id !== where.shop_id || r.endpoint_id !== where.endpoint_id) return c.json({ error: "invalid_ticket" }, 400, noStore);
    return c.json(
      {
        token,
        signing_secret: secret,
        shop: { id: r.shop_id, slug: r.shop_slug, name: r.shop_name },
        endpoint_id: r.endpoint_id,
        app: r.app,
        scopes: r.scopes,
        api_base: `${publicBaseUrl(c)}/api/v1`,
        banto_version: BANTO_VERSION,
      },
      200,
      noStore,
    );
  } catch (e) {
    if (e instanceof PrivilegedRpcError && e.is("invalid_ticket")) return c.json({ error: "invalid_ticket" }, 400, noStore);
    if (e instanceof PrivilegedRpcError && (e.is("scope_not_permitted") || e.status === 403)) return c.json({ error: "scope_not_permitted" }, 409, noStore);
    throw e;
  }
});
