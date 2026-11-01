/**
 * 外部プラグインに「つなぐ」（0088、docs/hooks.md §6）。運営者は秘密（署名シークレット・AI 用トークン）を手で写さない:
 *   1. 連携の登録（URL）でマニフェストに connect_url があれば、求めるスコープ・イベント・ブロックを出して確かめる
 *   2. 「許してつなぐ」で連携の行を作り、2 分・1 回だけの券（app_connect_begin）を付けてプラグインの connect_url へ移す
 *   3. プラグインは裏で券を引き換える（POST /api/connect/exchange、src/routes/api/connect.ts）
 * 外すのは連携を消すこと（トークン・接続・拡張データがまとめて消える。監査ログに残る）。つなぎ直すと前のトークンは取り消し。
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { createPrivilegedDb } from "../../db/privileged";
import { migrated } from "../../db/migration-state";
import { API_SCOPES, SCOPE_PERM, hashApiToken, isApiScope, type ApiScope } from "../../api/tokens";
import { APP_HANDLE_RE, fetchManifest, type PluginManifest } from "../../hooks/manifest";
import { isHookEvent } from "../../hooks/events";
import { connectionSecretPurpose, endpointSecret } from "../../hooks/signing";
import { openSecret } from "../../members/secret-box";
import { randomToken } from "../../util/signed";
import { t } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, publicBaseUrl, sessionSecret, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { can, type ShopAccess } from "./access";
import type { ShopRow } from "../../db/types";

export const APP_CONNECT_MIGRATION = "0088_app_connect";

export interface ConnectionRow {
  endpoint_id: string;
  scopes: string[];
  connected_at: string | null;
  ticket_expires_at: string | null;
}

export const connectReady = (c: AdminContext): Promise<boolean> => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, APP_CONNECT_MIGRATION);

/** つなげるマニフェスト（connect_url がある） */
export const connectable = (m: PluginManifest | null): m is PluginManifest & { connect_url: string } => Boolean(m?.connect_url);

/** その連携の接続（無ければ null。0088 の前も null） */
export async function connectionOf(c: AdminContext, endpointId: string): Promise<ConnectionRow | null> {
  if (!(await connectReady(c))) return null;
  return owner(c).db.from<ConnectionRow>("app_connections").selectOne("endpoint_id,scopes,connected_at,ticket_expires_at", { eq: { endpoint_id: endpointId } });
}

/**
 * 連携の署名シークレット: つないだ連携は接続ごとの乱数（暗号文を service_role で読んで開く）、ほかはサイトの秘密から作る値。
 * 開けなければ null（サイトの秘密が変わった → つなぎ直す）
 */
export async function signingSecretFor(c: AdminContext, shopId: string, endpointId: string, connected: boolean): Promise<string | null> {
  const site = sessionSecret(c);
  if (!site) return null;
  if (!connected) return endpointSecret(site, endpointId);
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  const box = await createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch }).appConnectionSecretBox(endpointId);
  return box ? openSecret(site, shopId, connectionSecretPurpose(endpointId), box) : null;
}

/** 許す画面（連携の登録で、マニフェストに connect_url があったとき） */
export function ConnectConfirm(props: { shop: ShopRow; access: ShopAccess | undefined; url: string; manifest: PluginManifest & { connect_url: string }; error?: string }) {
  const m = props.manifest;
  const scopes = (m.scopes ?? []).filter((s) => API_SCOPES.includes(s));
  const needsApp = Boolean(m.app || m.blocks?.length || scopes.includes("app_data:write"));
  const origin = new URL(m.connect_url).origin;
  return (
    <section class="card">
      <h2>{t("connect.title")}</h2>
      <p class="notice">
        <strong>{m.name}</strong> {m.version ? `v${m.version}` : ""}
        {m.description ? <div class="muted">{m.description}</div> : null}
      </p>
      {props.error ? <p class="error">{props.error}</p> : null}
      <p>{t("connect.intro")}</p>
      <p class="muted">
        {t("connect.goes_to")} <code>{origin}</code>
      </p>
      <form method="post" action={`/admin/shops/${props.shop.id}/hooks/connect`}>
        <input type="hidden" name="url" value={props.url} />
        <fieldset style="border:0;padding:0">
          <legend>{t("connect.scopes")}</legend>
          {scopes.length === 0 ? <p class="muted">{t("connect.no_scopes")}</p> : null}
          {scopes.map((sc) => {
            const ok = can(props.access, SCOPE_PERM[sc]);
            return (
              <div>
                <label>
                  <input type="checkbox" name="scopes" value={sc} checked={ok} disabled={!ok} /> <code>{sc}</code>
                  {ok ? null : <span class="muted"> ({t("tokens.scope_needs_perm")})</span>}
                </label>
              </div>
            );
          })}
        </fieldset>
        {scopes.includes("orders:pii") || scopes.includes("customers:read") || scopes.includes("customers:write") ? <p class="notice">{t("tokens.pii_warning")}</p> : null}
        {(m.events ?? []).filter(isHookEvent).length > 0 ? (
          <p>
            {t("connect.events")}: <code>{(m.events ?? []).filter(isHookEvent).join(", ")}</code>
          </p>
        ) : null}
        {m.blocks?.length ? (
          <p>
            {t("connect.blocks")}: {m.blocks.map((b) => b.label).join("・")}
          </p>
        ) : null}
        {needsApp ? (
          <div>
            <label for="app_handle">{t("hooks.app_handle")}</label>
            <input id="app_handle" type="text" name="app_handle" value={m.app ?? ""} required={scopes.includes("app_data:write")} maxlength={40} pattern="[a-z]([a-z0-9\-]{0,38}[a-z0-9])?" style="width:16rem" />
            <div class="muted">{t("hooks.app_handle_hint")}</div>
          </div>
        ) : null}
        <p class="muted">{t("connect.how")}</p>
        <p>
          <button type="submit">{t("connect.submit")}</button>{" "}
          <a class="btn secondary" href={`/admin/shops/${props.shop.id}/hooks`}>
            {t("pages.cancel")}
          </a>
        </p>
      </form>
    </section>
  );
}

/** 連携の画面の「つないだ連携」 */
export function ConnectionCard(props: { shopId: string; endpointId: string; conn: ConnectionRow; canReconnect: boolean }) {
  const { conn } = props;
  return (
    <section class="card">
      <h2>{t("connect.connected_title")}</h2>
      {conn.connected_at ? (
        <p>
          {t("connect.connected_at")}: {formatDateTime(conn.connected_at)}
        </p>
      ) : (
        <p class="notice">{t("connect.pending")}</p>
      )}
      <p>
        {t("connect.scopes")}: {conn.scopes.length ? <code>{conn.scopes.join(", ")}</code> : <span class="muted">{t("connect.no_scopes")}</span>}
      </p>
      <p class="muted">{t("connect.secret_note")}</p>
      {props.canReconnect ? (
        <form method="post" action={`/admin/shops/${props.shopId}/hooks/${props.endpointId}/reconnect`}>
          <button type="submit" class="secondary">
            {t("connect.reconnect")}
          </button>
          <span class="muted"> {t("connect.reconnect_hint")}</span>
        </form>
      ) : null}
      <p class="muted">{t("connect.disconnect_hint")}</p>
    </section>
  );
}

/** 券を作ってプラグインへ移す（つなぐ・つなぎ直す共通） */
async function beginAndRedirect(c: AdminContext, shopId: string, endpointId: string, scopes: ApiScope[], connectUrl: string): Promise<Response | string> {
  const ticket = randomToken(32);
  try {
    await owner(c).db.rpc("app_connect_begin", { p_shop_id: shopId, p_endpoint_id: endpointId, p_scopes: scopes, p_ticket_hash: await hashApiToken(ticket) });
  } catch (e) {
    // not_found: 無効にした連携・同梱の内部 URL の行はつなげない（0089）
    if (e instanceof DbError) return /scope_not_permitted/.test(e.message) ? "scope" : /app_handle_required/.test(e.message) ? "app_handle" : /not_found/.test(e.message) ? "not_found" : "generic";
    throw e;
  }
  const to = new URL(connectUrl);
  to.searchParams.set("ticket", ticket);
  to.searchParams.set("banto", publicBaseUrl(c));
  to.searchParams.set("shop_id", shopId);
  to.searchParams.set("endpoint_id", endpointId);
  return c.redirect(to.toString(), 303);
}

const scopesFrom = async (c: AdminContext): Promise<string[]> => {
  const body = await c.req.parseBody({ all: true });
  const raw = body["scopes"];
  return (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((v): v is string => typeof v === "string");
};

export function registerConnectRoutes(hooks: Hono<AppEnv>, externalHookUrl: (url: string) => boolean): void {
  /** 許してつなぐ: マニフェストを読み直し（フォームの値を信用しない）、連携の行を作って券を付けて移す */
  hooks.post("/:shopId/hooks/connect", requireOwner, async (c: AdminContext) => {
    const shopId = param(c, "shopId");
    const shop = await loadShop(c, shopId, "integrations");
    if (!shop) return c.text(t("shop.not_found"), 404);
    if (!(await connectReady(c))) return c.redirect(`/admin/shops/${shopId}/hooks?flash=generic`);
    const picked = await scopesFrom(c);
    const f = await formFields(c);
    const url = (f.url ?? "").trim();
    if (!externalHookUrl(url)) return c.redirect(`/admin/shops/${shopId}/hooks?flash=invalid_url`);
    const manifest = await fetchManifest(url, c.get("adapters").publicFetch ?? c.get("deps").fetch);
    if (!connectable(manifest)) return c.redirect(`/admin/shops/${shopId}/hooks?flash=manifest_failed`);
    // 許せるのはマニフェストが求めたスコープのうち、画面で選んだものだけ
    const scopes = (manifest.scopes ?? []).filter((s) => picked.includes(s) && isApiScope(s));
    const handle = (f.app_handle ?? "").trim();
    if (handle !== "" && !APP_HANDLE_RE.test(handle)) return c.redirect(`/admin/shops/${shopId}/hooks?flash=invalid_app_handle`);
    const db = owner(c).db;
    let endpointId: string;
    try {
      const [row] = await db.from<Record<string, unknown> & { id: string }>("hook_endpoints").insert({
        shop_id: shopId,
        name: manifest.name.slice(0, 200),
        url,
        events: (manifest.events ?? []).filter(isHookEvent),
        enabled: true,
        manifest,
        settings: {},
        ...(handle ? { app_handle: handle } : {}),
      });
      endpointId = row!.id;
    } catch (e) {
      if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/hooks?flash=${e.code === "23505" ? "app_handle_taken" : "generic"}`);
      throw e;
    }
    const r = await beginAndRedirect(c, shopId, endpointId, scopes, manifest.connect_url);
    if (typeof r !== "string") return r;
    // 始められなければ作った行を消す（中途半端な連携を残さない）
    await db.from("hook_endpoints").delete({ id: endpointId, shop_id: shopId });
    return c.redirect(`/admin/shops/${shopId}/hooks?flash=${r === "scope" ? "connect_scope" : r === "app_handle" ? "invalid_app_handle" : r === "not_found" ? "not_found" : "generic"}`);
  });

  /** つなぎ直す: 同じスコープ（今のマニフェストが求める範囲）で新しい券。引き換えると前のトークンは取り消し、署名シークレットも新しくなる */
  hooks.post("/:shopId/hooks/:endpointId/reconnect", requireOwner, async (c: AdminContext) => {
    const shopId = param(c, "shopId");
    const endpointId = param(c, "endpointId");
    const shop = await loadShop(c, shopId, "integrations");
    if (!shop) return c.text(t("shop.not_found"), 404);
    const base = `/admin/shops/${shopId}/hooks/${endpointId}`;
    const ep = await owner(c).db.from<{ id: string; url: string }>("hook_endpoints").selectOne("id,url", { eq: { id: endpointId, shop_id: shopId } });
    const conn = ep ? await connectionOf(c, endpointId) : null;
    if (!ep || !conn) return c.text(t("hooks.not_found"), 404);
    const manifest = await fetchManifest(ep.url, c.get("adapters").publicFetch ?? c.get("deps").fetch);
    if (!connectable(manifest)) return c.redirect(`${base}?flash=manifest_failed`);
    const scopes = conn.scopes.filter((s): s is ApiScope => isApiScope(s) && (manifest.scopes ?? []).includes(s));
    await owner(c).db.from("hook_endpoints").update({ manifest }, { id: endpointId, shop_id: shopId });
    const r = await beginAndRedirect(c, shopId, endpointId, scopes, manifest.connect_url);
    if (typeof r !== "string") return r;
    return c.redirect(`${base}?flash=${r === "scope" ? "connect_scope" : r === "not_found" ? "not_found" : "generic"}`);
  });
}
