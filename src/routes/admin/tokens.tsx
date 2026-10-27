import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { API_COUPONS_CUSTOMERS_MIGRATION, API_INQUIRIES_MIGRATION, API_SCOPES, DEFAULT_SCOPES, SCOPES_0036, SCOPES_0061, SCOPE_PERM, generateApiToken, hashApiToken, isApiScope, tokenPrefix, type ApiScope } from "../../api/tokens";
import { t, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, publicBaseUrl, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { can, shopAccess } from "./access";
import { migrated } from "../../db/migration-state";

/**
 * AI 連携（トークン）: /admin/shops/:shopId/tokens（docs/ai-access.md）
 * 生トークンは発行直後の画面に一度だけ出す。DB にはハッシュと接頭辞だけ。
 */
export const tokens = new Hono<AppEnv>();

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const SCOPE_LABEL: Record<ApiScope, MessageKey> = {
  "products:read": "tokens.scope.products_read",
  "products:write": "tokens.scope.products_write",
  "orders:read": "tokens.scope.orders_read",
  "orders:pii": "tokens.scope.orders_pii",
  "orders:write": "tokens.scope.orders_write",
  "shop:read": "tokens.scope.shop_read",
  "shop:write": "tokens.scope.shop_write",
  "stats:read": "tokens.scope.stats_read",
  "coupons:read": "tokens.scope.coupons_read",
  "coupons:write": "tokens.scope.coupons_write",
  "customers:read": "tokens.scope.customers_read",
  "customers:write": "tokens.scope.customers_write",
  "inquiries:read": "tokens.scope.inquiries_read",
  "inquiries:write": "tokens.scope.inquiries_write",
};

const fmt = (iso: string | null): string => formatDateTime(iso);

tokens.get("/:shopId/tokens", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const sa = await shopAccess(c, shopId);
  if (!sa || !can(sa.access, "integrations")) return c.text(t("shop.not_found"), 404);
  const shop = sa.shop;
  // 発行者が持つ項目のスコープだけ出す（DB のトリガーも同じ判定をする。0028）
  const grantable = (sc: ApiScope) => can(sa.access, SCOPE_PERM[sc]);
  // クーポンと会員のスコープは 0036 が当たってから出す（当たる前は DB の CHECK で発行できない）
  // お問い合わせのスコープは 0061 が当たってから出す
  const state = { db, cache: c.get("adapters").cache };
  const [has0036, has0061] = await Promise.all([migrated(state, API_COUPONS_CUSTOMERS_MIGRATION), migrated(state, API_INQUIRIES_MIGRATION)]);
  const offered = API_SCOPES.filter((sc) => (has0036 || !SCOPES_0036.includes(sc)) && (has0061 || !SCOPES_0061.includes(sc)));
  const rows = await db.from<TokenRow>("api_tokens").select("id,name,prefix,scopes,expires_at,revoked_at,last_used_at,created_at", { eq: { shop_id: shopId }, order: "created_at.desc" });
  const base = publicBaseUrl(c);
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("tokens.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("tokens.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "tokens" }}>
      <PageHead title={t("tokens.title")} sub={t("tokens.intro")}>
        <a class="btn" href="#issue">
          {t("tokens.issue")}
        </a>
      </PageHead>
      {flash === "revoked" ? <p class="notice">{t("tokens.revoked_ok")}</p> : null}
      {flash === "generic" ? <p class="error">{t("error.generic")}</p> : null}

      {rows.length === 0 ? (
        <div class="empty">
          <p>{t("tokens.none")}</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("hooks.name")}</th>
              <th>{t("tokens.prefix")}</th>
              <th>{t("tokens.scopes")}</th>
              <th>{t("tokens.last_used")}</th>
              <th>{t("tokens.expires")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <span class={`status ${r.revoked_at ? "off" : "on"}`}>{r.name}</span>
                  {r.revoked_at ? <span class="badge ng">{t("tokens.revoked")}</span> : null}
                </td>
                <td>
                  <code>{r.prefix}…</code>
                </td>
                <td>{r.scopes.join(", ")}</td>
                <td>{fmt(r.last_used_at)}</td>
                <td>{fmt(r.expires_at)}</td>
                <td>
                  {!r.revoked_at ? (
                    <form method="post" action={`/admin/shops/${shop.id}/tokens/${r.id}/revoke`} style="display:inline">
                      <button type="submit" class="small">
                        {t("tokens.revoke")}
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <section class="card" id="issue">
      <h2>{t("tokens.issue")}</h2>
      <form method="post" action={`/admin/shops/${shop.id}/tokens`}>
        <label for="name">{t("hooks.name")}</label>
        <input id="name" type="text" name="name" required maxlength={100} placeholder="Claude デスクトップ" />
        <fieldset style="border:0;padding:0">
          <legend>{t("tokens.scopes")}</legend>
          {offered.map((sc) => (
            <div>
              <label>
                <input type="checkbox" name="scopes" value={sc} checked={grantable(sc) && (DEFAULT_SCOPES as readonly string[]).includes(sc)} disabled={!grantable(sc)} /> <code>{sc}</code> — {t(SCOPE_LABEL[sc])}
                {grantable(sc) ? null : <span class="muted"> ({t("tokens.scope_needs_perm")})</span>}
              </label>
            </div>
          ))}
        </fieldset>
        <p class="notice">{t("tokens.pii_warning")}</p>
        <label for="expires_days">{t("tokens.expires_days")}</label>
        <input id="expires_days" type="number" name="expires_days" min={1} max={3650} placeholder="無期限" style="width:8rem" />
        <p>
          <button type="submit">{t("tokens.issue")}</button>
        </p>
      </form>
      </section>

      <section class="card">
      <h2>{t("tokens.howto")}</h2>
      <p>{t("tokens.howto_body")}</p>
      <pre>{JSON.stringify({ mcpServers: { banto: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer banto_..." } } } }, null, 2)}</pre>
      <p class="muted">
        REST: <code>{base}/api/v1</code>（OpenAPI: <code>{base}/api/v1/openapi.json</code>）· <a href="https://github.com/bantojs/banto/blob/main/docs/ai-access.md" target="_blank" rel="noopener">docs/ai-access.md</a>
      </p>
      </section>
    </AdminLayout>,
  );
});

tokens.post("/:shopId/tokens", requireOwner, async (c: AdminContext) => {
  const { db, session } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const body = await c.req.parseBody({ all: true });
  const rawScopes = body["scopes"];
  const scopes = (Array.isArray(rawScopes) ? rawScopes : typeof rawScopes === "string" ? [rawScopes] : []).filter((v): v is ApiScope => typeof v === "string" && isApiScope(v));
  const f = await formFields(c);
  const name = (f.name ?? "").trim().slice(0, 100);
  const days = Number.parseInt(f.expires_days ?? "", 10);
  if (!name || scopes.length === 0) return c.redirect(`/admin/shops/${shopId}/tokens?flash=generic`);
  const raw = generateApiToken();
  try {
    await db.from("api_tokens").insert({
      shop_id: shopId,
      owner_id: session.user_id,
      name,
      token_hash: await hashApiToken(raw),
      prefix: tokenPrefix(raw),
      scopes,
      expires_at: Number.isInteger(days) && days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
    });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/tokens?flash=generic`);
    throw e;
  }
  // 生トークンはこの応答にだけ出す（URL やログに載せない）
  return c.html(
    <AdminLayout title={t("tokens.issued")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("tokens.title"), href: `/admin/shops/${shop.id}/tokens` }, { label: t("tokens.issued") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "tokens" }}>
      <PageHead title={t("tokens.issued")}>
        <a class="btn secondary" href={`/admin/shops/${shop.id}/tokens`}>
          {t("tokens.title")}
        </a>
      </PageHead>
      <p class="notice">{t("tokens.issued_once")}</p>
      <pre>{raw}</pre>
      <p>
        {t("tokens.scopes")}: {scopes.join(", ")}
      </p>
      <h2>{t("tokens.howto")}</h2>
      <pre>{JSON.stringify({ mcpServers: { banto: { type: "http", url: `${publicBaseUrl(c)}/mcp`, headers: { Authorization: `Bearer ${raw}` } } } }, null, 2)}</pre>
    </AdminLayout>,
    { headers: { "Cache-Control": "no-store" } },
  );
});

tokens.post("/:shopId/tokens/:tokenId/revoke", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const rows = await db.from<TokenRow>("api_tokens").update({ revoked_at: new Date().toISOString() }, { id: param(c, "tokenId"), shop_id: shopId });
  return c.redirect(`/admin/shops/${shopId}/tokens?flash=${rows.length > 0 ? "revoked" : "generic"}`);
});
