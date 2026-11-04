import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { HOOK_EVENTS, isHookEvent } from "../../hooks/events";
import { APP_HANDLE_RE, fetchManifest, parseManifest, settingsFromForm, type PluginManifest } from "../../hooks/manifest";
import { endpointSecret, signHookPayload, signPluginTicket } from "../../hooks/signing";
import { blockedHookTarget, externalHookUrl } from "../../hooks/target";
import { ConnectConfirm, ConnectionCard, connectable, connectionOf, registerConnectRoutes, signingSecretFor } from "./connect";
import { bundledPluginIdFromUrl, findBundledPlugin } from "../../plugins";
import { t, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, Copyable, PageHead } from "./layout";
import { formFields, owner, param, sessionSecret, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { moduleEnabled } from "../../modules/registry";
import { migrated } from "../../db/migration-state";
import { EVENT_RELAY_MIGRATION, EVENT_RELAY_MODULE, forgetRelayTargets } from "../../modules/event-relay/relay";

/**
 * 連携（hooks の送信先 = 外部プラグイン）。/admin/shops/:shopId/hooks
 * コアはプラグインが誰のホストかを知らない。接点は署名付き POST とヘッドレス API だけ（CLAUDE.md §7）。
 */
export const hooks = new Hono<AppEnv>();

interface EndpointRow {
  id: string;
  shop_id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  manifest: PluginManifest | null;
  settings: Record<string, string | boolean>;
  created_at: string;
  /** 拡張データの名前の空間（0084） */
  app_handle?: string | null;
  /** お店の行動を渡す許し（0107） */
  storefront_events?: { types: string[]; visitors: "members" | "all" } | null;
}

/** 拡張データ（0084）が DB に入ったか。入る前は app_handle の列が無い */


interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
}

function flash(code: string | undefined): { kind: "ok" | "error"; text: string } | null {
  const map: Record<string, MessageKey> = {
    saved: "shop.saved",
    deleted: "hooks.deleted",
    invalid_url: "hooks.invalid_url",
    invalid_app_handle: "hooks.app_handle_invalid",
    app_handle_taken: "hooks.app_handle_taken",
    connect_scope: "connect.scope_error",
    manifest_failed: "hooks.manifest_failed",
    not_found: "hooks.not_found",
    test_ok: "hooks.test_ok",
    test_failed: "hooks.test_failed",
    generic: "error.generic",
  };
  const key = code ? map[code] : undefined;
  if (!key) return null;
  return { kind: code === "saved" || code === "deleted" || code === "test_ok" ? "ok" : "error", text: t(key) };
}

const URL_RE = /^https?:\/\/[^\s]+$/;

/** 外から渡された URL を開く fetch（Node は名前を引いた先を接続の直前に確かめる publicFetch、Workers は素の fetch） */
function outboundFetch(c: AdminContext): typeof fetch {
  return c.get("adapters").publicFetch ?? c.get("deps").fetch;
}

/** 同梱プラグインのうち、イベントを受け取らないもの（決済事業者の Webhook を受ける側）。イベントの購読欄を出さない */
function receivesEvents(url: string | undefined): boolean {
  const id = url ? bundledPluginIdFromUrl(url) : null;
  if (id === null) return true;
  return Boolean(findBundledPlugin(id)?.handle);
}

function EndpointForm(props: { action: string; endpoint?: EndpointRow; manifest: PluginManifest | null; apps?: boolean }) {
  const e = props.endpoint;
  const events = new Set(e?.events ?? props.manifest?.events ?? []);
  const showEvents = receivesEvents(e?.url);
  return (
    <form method="post" action={props.action}>
      <label for="name">{t("hooks.name")}</label>
      <input id="name" type="text" name="name" value={e?.name ?? props.manifest?.name ?? ""} required maxlength={200} />
      <label for="url">{t("hooks.url")}</label>
      {e && bundledPluginIdFromUrl(e.url) !== null ? (
        <div>
          <input type="hidden" name="url" value={e.url} />
          <span class="badge">{t("plugins.bundled")}</span>
        </div>
      ) : (
        <input id="url" type="text" name="url" value={e?.url ?? ""} required pattern="https?://.*" />
      )}
      {showEvents ? (
        <fieldset style="border:0;padding:0">
          <legend>{t("hooks.events")}</legend>
          {HOOK_EVENTS.map((ev) => (
            <label style="display:inline-block;margin-right:1rem">
              <input type="checkbox" name="events" value={ev} checked={events.has(ev)} /> <code>{ev}</code>
            </label>
          ))}
        </fieldset>
      ) : (
        <p class="muted">{t("hooks.no_events_plugin")}</p>
      )}
      {props.manifest && props.manifest.settings.length > 0 ? (
        <fieldset style="border:0;padding:0">
          <legend>{t("hooks.settings")}</legend>
          {props.manifest.settings.map((s) => {
            const v = e?.settings[s.key];
            return (
              <div>
                {s.type === "boolean" ? (
                  <label>
                    <input type="checkbox" name={`setting_${s.key}`} value="on" checked={v === true} /> {s.label}
                  </label>
                ) : s.type === "select" ? (
                  <div>
                    <label for={`setting_${s.key}`}>{s.label}</label>
                    <select id={`setting_${s.key}`} name={`setting_${s.key}`}>
                      {(s.options ?? []).map((o) => (
                        <option value={o.value} selected={v === o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label for={`setting_${s.key}`}>{s.label}</label>
                    <input id={`setting_${s.key}`} type="text" name={`setting_${s.key}`} value={typeof v === "string" ? v : ""} required={s.required === true} />
                  </div>
                )}
                {s.description ? <div class="muted">{s.description}</div> : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
      {props.apps && !(e && bundledPluginIdFromUrl(e.url) !== null) ? (
        <div>
          <label for="app_handle">{t("hooks.app_handle")}</label>
          <input id="app_handle" type="text" name="app_handle" value={e?.app_handle ?? (e?.id ? "" : (props.manifest?.app ?? ""))} maxlength={40} pattern="[a-z]([a-z0-9\-]{0,38}[a-z0-9])?" style="width:16rem" />
          <div class="muted">{t("hooks.app_handle_hint")}</div>
        </div>
      ) : null}
      <label>
        <input type="checkbox" name="enabled" value="on" checked={e?.enabled ?? true} /> {t("hooks.enabled")}
      </label>
      <p>
        <button type="submit">{t("shop.save")}</button>
      </p>
    </form>
  );
}

// つなぐ（0088）。/:shopId/hooks/:endpointId より先に登録する（connect が連携の id に読まれないように）
registerConnectRoutes(hooks, externalHookUrl);

hooks.get("/:shopId/hooks", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const [endpoints, deliveries] = await Promise.all([
    db.from<EndpointRow>("hook_endpoints").select("*", { eq: { shop_id: shopId }, order: "created_at.asc" }),
    db.from<DeliveryRow>("hook_deliveries").select("id,endpoint_id,event,status,attempts,last_status,last_error,created_at,next_attempt_at", { eq: { shop_id: shopId }, order: "created_at.desc", limit: 50 }),
  ]);
  const names = new Map(endpoints.map((e) => [e.id, e.name]));
  const f = flash(c.req.query("flash"));
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("hooks.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "hooks" }}>
      <PageHead title={t("hooks.title")} sub={t("hooks.intro")}>
        <a class="btn" href="#add">
          {t("hooks.add")}
        </a>
      </PageHead>
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
      {endpoints.length === 0 ? (
        <div class="empty">
          <p>{t("hooks.none")}</p>
        </div>
      ) : null}
      {endpoints.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("hooks.name")}</th>
              <th>{t("hooks.url")}</th>
              <th>{t("hooks.events")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => (
              <tr>
                <td>
                  <span class={`status ${e.enabled ? "on" : "off"}`}>
                    <a href={`/admin/shops/${shop.id}/hooks/${e.id}`}>{e.name}</a>
                  </span>
                  {!e.enabled ? <span class="badge ng">{t("hooks.disabled")}</span> : null}
                </td>
                <td>
                  <code>{e.url}</code>
                </td>
                <td>{e.events.join(", ")}</td>
                <td>{e.manifest?.admin_url ? <a href={`/admin/shops/${shop.id}/hooks/${e.id}/ui`}>{t("hooks.plugin_ui")}</a> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <section class="card" id="add">
      <h2>{t("hooks.add")}</h2>
      <form method="post" action={`/admin/shops/${shop.id}/hooks/new`}>
        <label for="url">{t("hooks.url")}</label>
        <input id="url" type="text" name="url" required pattern="https?://.*" placeholder="https://plugin.example/banto" />
        <p class="muted">{t("hooks.add_hint")}</p>
        <p>
          <button type="submit">{t("hooks.next")}</button>
        </p>
      </form>
      </section>

      <h2>{t("hooks.deliveries")}</h2>
      {deliveries.length === 0 ? (
        <div class="empty">
          <p>{t("hooks.no_deliveries")}</p>
        </div>
      ) : null}
      {deliveries.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("order.date")}</th>
              <th>{t("hooks.name")}</th>
              <th>{t("hooks.event")}</th>
              <th>{t("order.status")}</th>
              <th>{t("hooks.attempts")}</th>
              <th>{t("hooks.last_result")}</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr>
                <td>{formatDateTime(d.created_at)}</td>
                <td>{names.get(d.endpoint_id) ?? "-"}</td>
                <td>
                  <code>{d.event}</code>
                </td>
                <td>
                  <span class={`status ${d.status === "delivered" ? "on" : d.status === "failed" ? "warn" : "info"}`}>{t(`hooks.status.${d.status}` as MessageKey)}</span>
                </td>
                <td>{d.attempts}</td>
                <td>
                  {d.last_status ?? ""} {d.last_error ? <span class="muted">{d.last_error.slice(0, 80)}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </AdminLayout>,
  );
});

/** URL を受け取り、マニフェストを取得して登録フォームを出す */
hooks.post("/:shopId/hooks/new", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const url = (f.url ?? "").trim();
  if (!externalHookUrl(url)) return c.redirect(`/admin/shops/${shopId}/hooks?flash=invalid_url`);
  const manifest = await fetchManifest(url, outboundFetch(c));
  // つなぐ手順に対応したプラグイン（0088）は、許す画面を出す（秘密を手で写さない）
  if (connectable(manifest)) {
    return c.html(
      <AdminLayout title={t("connect.title")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title"), href: `/admin/shops/${shop.id}/hooks` }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "hooks" }}>
        <PageHead title={t("connect.title")} />
        <ConnectConfirm shop={shop} access={c.get("shopAccess")} url={url} manifest={manifest} />
      </AdminLayout>,
    );
  }
  return c.html(
    <AdminLayout title={t("hooks.add")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title"), href: `/admin/shops/${shop.id}/hooks` }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "hooks" }}>
      <PageHead title={t("hooks.add")} />
      {manifest ? (
        <p class="notice">
          {t("hooks.manifest_found")} <strong>{manifest.name}</strong> {manifest.version ? `v${manifest.version}` : ""}
          {manifest.description ? <div class="muted">{manifest.description}</div> : null}
        </p>
      ) : (
        <p class="muted">{t("hooks.manifest_missing")}</p>
      )}
      <EndpointForm action={`/admin/shops/${shop.id}/hooks`} apps manifest={manifest} endpoint={{ id: "", shop_id: shopId, name: manifest?.name ?? "", url, events: manifest?.events ?? [], enabled: true, manifest, settings: {}, created_at: "" }} />
    </AdminLayout>,
  );
});

function endpointValues(f: Record<string, string>, eventsRaw: string[], manifest: PluginManifest | null, apps = false, bundled = false): Partial<EndpointRow> | "invalid_url" | "invalid_app_handle" {
  const url = (f.url ?? "").trim();
  // 同梱プラグインの設定の保存は内部 URL（呼び出し側が元の URL に戻す）。外部プラグインは新規も更新も externalHookUrl
  // （私設のアドレス・localhost・banto.invalid への書き換えを受けない。外部として登録した行の URL は同梱の内部 URL に変えられない）
  if (bundled ? !URL_RE.test(url) : !externalHookUrl(url)) return "invalid_url";
  const values: Partial<EndpointRow> = {
    name: (f.name ?? "").trim().slice(0, 200) || url,
    url,
    events: receivesEvents(url) ? eventsRaw.filter(isHookEvent) : [],
    enabled: f.enabled === "on",
    settings: settingsFromForm(manifest, f),
  };
  // 拡張データの名前の空間（0084）。同梱プラグインには付けない
  if (apps && bundledPluginIdFromUrl(url) === null && f.app_handle !== undefined) {
    const handle = f.app_handle.trim();
    if (handle !== "" && !APP_HANDLE_RE.test(handle)) return "invalid_app_handle";
    values.app_handle = handle === "" ? null : handle;
  }
  return values;
}

/** 保存の失敗を画面の知らせに直す（名前の重なりは一意の索引） */
function saveError(e: DbError): string {
  return e.code === "23505" || /hook_endpoints_app_handle_unique|duplicate key/.test(e.message) ? "app_handle_taken" : "generic";
}

async function eventsFromBody(c: AdminContext): Promise<string[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body["events"];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return typeof raw === "string" ? [raw] : [];
}

hooks.post("/:shopId/hooks", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const events = await eventsFromBody(c);
  const f = await formFields(c);
  const url = (f.url ?? "").trim();
  if (!externalHookUrl(url)) return c.redirect(`/admin/shops/${shopId}/hooks?flash=invalid_url`);
  // マニフェストは登録時に再取得する（フォームの値を信用しない）
  const manifest = await fetchManifest(url, outboundFetch(c));
  const values = endpointValues(f, events, manifest, true);
  if (typeof values === "string") return c.redirect(`/admin/shops/${shopId}/hooks?flash=${values}`);
  try {
    const [created] = await db.from<EndpointRow>("hook_endpoints").insert({ ...values, shop_id: shopId, manifest });
    return c.redirect(`/admin/shops/${shopId}/hooks/${created!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/hooks?flash=${saveError(e)}`);
    throw e;
  }
});

async function loadEndpoint(c: AdminContext): Promise<{ shop: NonNullable<Awaited<ReturnType<typeof loadShop>>>; endpoint: EndpointRow } | null> {
  const { db } = owner(c);
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return null;
  const endpoint = await db.from<EndpointRow>("hook_endpoints").selectOne("*", { eq: { id: param(c, "endpointId"), shop_id: shop.id } });
  if (!endpoint) return null;
  const bundledId = bundledPluginIdFromUrl(endpoint.url);
  endpoint.manifest = bundledId !== null ? (findBundledPlugin(bundledId)?.manifest ?? null) : parseManifest(endpoint.manifest);
  return { shop, endpoint };
}

hooks.get("/:shopId/hooks/:endpointId", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  if (!data) return c.text(t("hooks.not_found"), 404);
  const { shop, endpoint } = data;
  const secret = sessionSecret(c);
  // つないだ連携（0088）は接続ごとの署名シークレットをプラグインに渡し済み。画面には出さない
  const conn = await connectionOf(c, endpoint.id);
  const signing = secret && !conn ? await endpointSecret(secret, endpoint.id) : null;
  const base = `/admin/shops/${shop.id}/hooks/${endpoint.id}`;
  const f = flash(c.req.query("flash"));
  // お店の行動を渡す許し（同梱モジュール event_relay が ON・0107 が当たっているショップだけ）
  const relayOn = moduleEnabled(shop.settings, EVENT_RELAY_MODULE) && (await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, EVENT_RELAY_MIGRATION));
  return c.html(
    <AdminLayout title={endpoint.name} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title"), href: `/admin/shops/${shop.id}/hooks` }, { label: endpoint.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "hooks" }}>
      <PageHead
        title={
          <>
            {endpoint.name}
            {!endpoint.enabled ? <span class="badge ng">{t("hooks.disabled")}</span> : null}
          </>
        }
        sub={<code>{endpoint.url}</code>}
      />
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
      {conn ? <ConnectionCard shopId={shop.id} endpointId={endpoint.id} conn={conn} canReconnect={connectable(endpoint.manifest)} /> : null}
      {/* 登録・保存のときにマニフェストを読めなかった外部の送信先。プラグインの欄（設定・お店の行動を渡す等）が出ない理由を見せる */}
      {!endpoint.manifest && bundledPluginIdFromUrl(endpoint.url) === null ? <p class="muted">{t("hooks.manifest_absent")}</p> : null}
      <EndpointForm action={base} endpoint={endpoint} manifest={endpoint.manifest} apps />
      {relayOn && endpoint.manifest?.storefront_events ? <StorefrontEventsForm action={`${base}/storefront-events`} requested={endpoint.manifest.storefront_events} granted={endpoint.storefront_events ?? null} /> : null}

      {bundledPluginIdFromUrl(endpoint.url) === null ? (
        <div>
          {conn ? null : (
            <>
              <h2>{t("hooks.secret")}</h2>
              <p class="muted">{t("hooks.secret_hint")}</p>
              {signing ? <Copyable value={signing} name={t("hooks.secret")} /> : <p class="error">{t("error.secret_missing")}</p>}
            </>
          )}
          <h2>{t("hooks.test")}</h2>
          <form method="post" action={`${base}/test`}>
            <button type="submit">{t("hooks.test_send")}</button>
          </form>
        </div>
      ) : null}
      {endpoint.manifest?.admin_url ? (
        <p>
          <a href={`${base}/ui`}>{t("hooks.plugin_ui")}</a>
        </p>
      ) : null}

      <h2>{t("hooks.delete")}</h2>
      <form method="post" action={`${base}/delete`}>
        <button type="submit">{t("hooks.delete")}</button>
      </form>
    </AdminLayout>,
  );
});

hooks.post("/:shopId/hooks/:endpointId", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  if (!data) return c.text(t("hooks.not_found"), 404);
  const { db } = owner(c);
  const { shop, endpoint } = data;
  const base = `/admin/shops/${shop.id}/hooks/${endpoint.id}`;
  const events = await eventsFromBody(c);
  const f = await formFields(c);
  const bundled = bundledPluginIdFromUrl(endpoint.url) !== null;
  // 外部プラグインはマニフェストを読み直す（ブロックの提案などが増えたとき。取れなければ前のまま）
  const fresh = !bundled ? await fetchManifest(endpoint.url, outboundFetch(c)) : null;
  const values = endpointValues(f, events, fresh ?? endpoint.manifest, !bundled, bundled);
  if (typeof values === "string") return c.redirect(`${base}?flash=${values}`);
  if (bundled) values.url = endpoint.url;
  if (fresh) values.manifest = fresh;
  try {
    await db.from<EndpointRow>("hook_endpoints").update(values, { id: endpoint.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=${saveError(e)}`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

/** お店の行動を渡す許し（0107）。決めるのは DB の hook_storefront_events_set（マニフェストが求めた範囲まで・監査ログ） */
hooks.post("/:shopId/hooks/:endpointId/storefront-events", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  if (!data) return c.text(t("hooks.not_found"), 404);
  const { shop, endpoint } = data;
  const base = `/admin/shops/${shop.id}/hooks/${endpoint.id}`;
  const body = await c.req.parseBody({ all: true });
  const raw = body["types"];
  const types = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((v): v is string => typeof v === "string");
  const grant = types.length > 0 ? { types, visitors: body["visitors"] === "all" ? "all" : "members" } : null;
  try {
    await owner(c).db.rpc("hook_storefront_events_set", { p_shop_id: shop.id, p_endpoint_id: endpoint.id, p_grant: grant });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  await forgetRelayTargets(c.get("adapters").cache, shop.id);
  return c.redirect(`${base}?flash=saved`);
});

/** 許しの欄。求められた種類だけを並べ、運営者は外せる（広げられない） */
function StorefrontEventsForm(props: { action: string; requested: { types: string[]; visitors: "members" | "all" }; granted: { types: string[]; visitors: "members" | "all" } | null }) {
  const on = new Set(props.granted?.types ?? []);
  return (
    <section class="card">
      <h2>{t("relay.title")}</h2>
      <p>{t("relay.intro")}</p>
      <p class="notice">{t("relay.privacy")}</p>
      <form method="post" action={props.action}>
        <fieldset>
          <legend>{t("relay.types")}</legend>
          {props.requested.types.map((ty) => (
            <label style="display:block">
              <input type="checkbox" name="types" value={ty} checked={on.has(ty)} /> {t(`relay.type.${ty}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {props.requested.visitors === "all" ? (
          <fieldset>
            <legend>{t("relay.visitors")}</legend>
            <label style="display:block">
              <input type="radio" name="visitors" value="members" checked={props.granted?.visitors !== "all"} /> {t("relay.visitors_members")}
            </label>
            <label style="display:block">
              <input type="radio" name="visitors" value="all" checked={props.granted?.visitors === "all"} /> {t("relay.visitors_all")}
            </label>
          </fieldset>
        ) : (
          <p class="muted">{t("relay.visitors_members_only")}</p>
        )}
        <p class="muted">{t("relay.hint")}</p>
        <button type="submit">{t("relay.save")}</button>
      </form>
    </section>
  );
}

hooks.post("/:shopId/hooks/:endpointId/delete", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  if (!data) return c.text(t("hooks.not_found"), 404);
  const { db } = owner(c);
  await db.from("hook_endpoints").delete({ id: data.endpoint.id, shop_id: data.shop.id });
  return c.redirect(`/admin/shops/${data.shop.id}/hooks?flash=deleted`);
});

/** テスト送信: キューを通さず同期で POST し、結果を表示する */
hooks.post("/:shopId/hooks/:endpointId/test", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  if (!data) return c.text(t("hooks.not_found"), 404);
  const { shop, endpoint } = data;
  const base = `/admin/shops/${shop.id}/hooks/${endpoint.id}`;
  // つないだ連携（0088）は接続ごとの署名シークレットで署名する
  // 行き先が私設のアドレス・社内の名前なら送らない（直叩き・復元で入った行を止める最後の砦）
  if (blockedHookTarget(endpoint.url)) return c.redirect(`${base}?flash=test_failed`);
  const secret = await signingSecretFor(c, shop.id, endpoint.id, Boolean(await connectionOf(c, endpoint.id)));
  if (!secret) return c.redirect(`${base}?flash=test_failed`);
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    event: "banto.ping",
    created_at: new Date().toISOString(),
    shop_id: shop.id,
    attempt: 1,
    data: { message: "test" },
    settings: endpoint.settings,
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await outboundFetch(c)(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "banto-hooks",
        "X-Banto-Event": "banto.ping",
        "X-Banto-Signature": await signHookPayload(secret, body),
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timer);
    return c.redirect(`${base}?flash=${res.ok ? "test_ok" : "test_failed"}`);
  } catch {
    return c.redirect(`${base}?flash=test_failed`);
  }
});

/** プラグイン独自画面（iframe）。URL はマニフェストの admin_url（https のみ） */
hooks.get("/:shopId/hooks/:endpointId/ui", requireOwner, async (c: AdminContext) => {
  const data = await loadEndpoint(c);
  const adminUrl = data?.endpoint.manifest?.admin_url;
  if (!data || !adminUrl) return c.text(t("hooks.not_found"), 404);
  const { shop, endpoint } = data;
  const src = new URL(adminUrl);
  src.searchParams.set("shop_id", shop.id);
  src.searchParams.set("endpoint_id", endpoint.id);
  // 署名付きの短い券（5 分）。プラグインは署名シークレットで確かめて、Banto のどの運営者が開いたかを知れる（0088）
  const signing = await signingSecretFor(c, shop.id, endpoint.id, Boolean(await connectionOf(c, endpoint.id)));
  if (signing) src.searchParams.set("banto_ticket", await signPluginTicket(signing, { shop_id: shop.id, endpoint_id: endpoint.id, user_id: owner(c).session.user_id }));
  return c.html(
    <AdminLayout title={endpoint.name} nav>
      <p>
        <a href={`/admin/shops/${shop.id}/hooks/${endpoint.id}`}>‹ {endpoint.name}</a>
      </p>
      <iframe src={src.toString()} style="width:100%;height:70vh;border:1px solid color-mix(in srgb,CanvasText 15%,transparent)" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>
    </AdminLayout>,
  );
});
