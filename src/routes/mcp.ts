import { Hono } from "hono";
import type { AppEnv } from "../app";
import { createPrivilegedDb } from "../db/privileged";
import { ApiService } from "../api/service";
import { bearerToken } from "../api/tokens";
import { MAX_JSON_BODY_BYTES, inquiryMailFor, migrationStateFor, readBodyLimited, type Ctx } from "./common";
import { handleJsonRpc } from "../mcp/server";
import { BANTO_VERSION } from "../version";

export const mcp = new Hono<AppEnv>();

mcp.get("/", (c) => c.json({ error: { code: "method_not_allowed", message: "This MCP server is stateless; use POST with JSON-RPC" } }, 405, { Allow: "POST" }));
mcp.delete("/", (c) => c.body(null, 204));

mcp.post("/", async (c: Ctx) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: { code: "unauthorized", message: "Authorization: Bearer banto_... is required" } }, 401, { "WWW-Authenticate": "Bearer" });
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.json({ error: { code: "upstream", message: "not configured" } }, 503);

  const raw = await readBodyLimited(c.req.raw, MAX_JSON_BODY_BYTES);
  if (!raw) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body is larger than 1MB" } }, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const api = await ApiService.forToken(token, {
    db: createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch }),
    storage: c.get("adapters").storage,
    fetch: c.get("deps").fetch,
    publicFetch: c.get("adapters").publicFetch,
    config: c.get("adapters").config,
    migrationState: migrationStateFor(c, url),
    inquiryMail: inquiryMailFor(c),
    privateStorage: c.get("adapters").privateStorage ?? null,
  });
  const serverInfo = { name: "banto", version: BANTO_VERSION };

  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch must contain 1 to 20 requests" } }, 400);
    const responses = (await Promise.all(body.map((m) => handleJsonRpc(api, serverInfo, m)))).filter((r) => r !== null);
    return responses.length === 0 ? c.body(null, 202) : c.json(responses);
  }
  const res = await handleJsonRpc(api, serverInfo, body);
  return res === null ? c.body(null, 202) : c.json(res);
});
