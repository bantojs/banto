import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { DEFAULT_SCOPES, SCOPE_PERM, generateApiToken, hashApiToken, isApiScope, issuableScopes, tokenPrefix, type ApiScope } from "../../api/tokens";
import { migrated } from "../../db/migration-state";
import { t, tf } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, Copyable, PageHead } from "./layout";
import { formFields, owner, param, publicBaseUrl, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { can } from "./access";
import { permLabel } from "./denied";
import { SCOPE_LABEL, ScopePicker, TOKEN_PRESETS, isTokenPreset } from "./purposes";

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
  endpoint_id?: string | null;
}

/** 名前を付けた連携（app_data:write のトークンを結ぶ先、0084） */
interface AppEndpoint {
  id: string;
  name: string;
  app_handle: string;
}


/** 発行できるスコープ（当てるまで出さないものを除く。0111 の dialogs:write など） */
const scopesFor = (c: AdminContext) => issuableScopes((v) => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, v));


const fmt = (iso: string | null): string => formatDateTime(iso);


/** app_data:write のトークンを結べる連携（名前のあるもの） */
async function appEndpoints(c: AdminContext, shopId: string): Promise<AppEndpoint[]> {
  const rows = await owner(c).db.from<AppEndpoint & { app_handle: string | null }>("hook_endpoints").select("id,name,app_handle", { eq: { shop_id: shopId }, order: "created_at.asc" });
  return rows.filter((r): r is AppEndpoint => typeof r.app_handle === "string" && r.app_handle !== "");
}

tokens.get("/:shopId/tokens", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  // loadShop を通す（項目の無い人には、どの項目が要るかを出す。src/routes/admin/denied.tsx）
  const loaded = await loadShop(c, shopId, "integrations");
  if (!loaded) return c.text(t("shop.not_found"), 404);
  const sa = { shop: loaded, access: c.get("shopAccess")! };
  const shop = sa.shop;
  // 発行者が持つ項目のスコープだけ出す（DB のトリガーも同じ判定をする。0028）
  const grantable = (sc: ApiScope) => can(sa.access, SCOPE_PERM[sc]);
  const presetQ = c.req.query("preset");
  const preset = isTokenPreset(presetQ) ? presetQ : null;
  const scopeList = await scopesFor(c);
  const [rows, apps] = await Promise.all([
    db.from<TokenRow>("api_tokens").select("id,name,prefix,scopes,expires_at,revoked_at,last_used_at,created_at,endpoint_id", { eq: { shop_id: shopId }, order: "created_at.desc" }),
    appEndpoints(c, shopId),
  ]);
  const appName = new Map(apps.map((a) => [a.id, a.app_handle]));
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
      {flash === "app_endpoint" ? <p class="error">{t("tokens.app_endpoint_required")}</p> : null}

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
                <td>
                  {r.scopes.map((sc) => (isApiScope(sc) ? t(SCOPE_LABEL[sc]) : sc)).join("・")}
                  {r.endpoint_id ? <span class="muted"> → {appName.get(r.endpoint_id) ?? "-"}</span> : null}
                </td>
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
          {/* 目的のひな形（そこから細かく直せる）。スクリプト無しで、選び直すとこの画面を開き直す */}
          <nav class="viewtabs" aria-label={t("tokens.preset")}>
            {(["catalog", "orders", "theme", "custom"] as const).map((p) => (
              <a href={`/admin/shops/${shop.id}/tokens?preset=${p}#issue`} aria-current={(preset ?? "custom") === p ? "page" : undefined}>
                {t(`tokens.preset_${p}`)}
              </a>
            ))}
          </nav>
          <ScopePicker available={scopeList} checked={(sc) => (preset ? (TOKEN_PRESETS[preset] as readonly string[]) : (DEFAULT_SCOPES as readonly string[])).includes(sc)} grantable={grantable} reason={(sc) => tf("access.needs_perm", { perm: permLabel(SCOPE_PERM[sc]) })} />
        </fieldset>
        {grantable("app_data:write") ? (
          <div>
            <label for="endpoint_id">{t("tokens.app_endpoint")}</label>
            {apps.length > 0 ? (
              <select id="endpoint_id" name="endpoint_id">
                <option value="">-</option>
                {apps.map((a) => (
                  <option value={a.id}>
                    {a.name} ({a.app_handle})
                  </option>
                ))}
              </select>
            ) : (
              <p class="muted">{t("tokens.app_endpoint_none")}</p>
            )}
            <div class="muted">{t("tokens.app_endpoint_hint")}</div>
          </div>
        ) : null}
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
      <Copyable value={JSON.stringify({ mcpServers: { banto: { type: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer banto_..." } } } }, null, 2)} name={t("tokens.howto")} />
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
  const issuable = await scopesFor(c);
  if (scopes.some((sc) => !issuable.includes(sc))) return c.redirect(`/admin/shops/${shopId}/tokens?flash=generic`);
  const f = await formFields(c);
  const name = (f.name ?? "").trim().slice(0, 100);
  const days = Number.parseInt(f.expires_days ?? "", 10);
  if (!name || scopes.length === 0) return c.redirect(`/admin/shops/${shopId}/tokens?flash=generic`);
  // app_data:write は名前のある連携に結ぶ（ほかのスコープだけのトークンは結ばない）
  let endpointId: string | null = null;
  if (scopes.includes("app_data:write")) {
    const ep = (await appEndpoints(c, shopId)).find((a) => a.id === f.endpoint_id);
    if (!ep) return c.redirect(`/admin/shops/${shopId}/tokens?flash=app_endpoint`);
    endpointId = ep.id;
  }
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
      ...(endpointId ? { endpoint_id: endpointId } : {}),
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
      <Copyable value={raw} name={t("tokens.title")} />
      <p>
        {t("tokens.scopes")}: {scopes.map((sc) => t(SCOPE_LABEL[sc])).join("・")}
      </p>
      <h2>{t("tokens.howto")}</h2>
      <Copyable value={JSON.stringify({ mcpServers: { banto: { type: "http", url: `${publicBaseUrl(c)}/mcp`, headers: { Authorization: `Bearer ${raw}` } } } }, null, 2)} name={t("tokens.howto")} />
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
