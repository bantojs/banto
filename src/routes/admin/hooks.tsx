import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { HOOK_EVENTS, isHookEvent } from "../../hooks/events";
import { fetchManifest, parseManifest, settingsFromForm, type PluginManifest } from "../../hooks/manifest";
import { endpointSecret, signHookPayload } from "../../hooks/signing";
import { bundledPluginIdFromUrl, findBundledPlugin } from "../../plugins";
import { t, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, sessionSecret, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

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
}

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
    manifest_failed: "hooks.manifest_failed",
    test_ok: "hooks.test_ok",
    test_failed: "hooks.test_failed",
    generic: "error.generic",
  };
  const key = code ? map[code] : undefined;
  if (!key) return null;
  return { kind: code === "saved" || code === "deleted" || code === "test_ok" ? "ok" : "error", text: t(key) };
}

const URL_RE = /^https?:\/\/[^\s]+$/;

/** 外部プラグインの URL として受け付けるか。同梱プラグインの内部 URL（banto.invalid）は /plugins の経路だけ（重複して通知が二重に届くのを防ぐ、0031） */
function externalHookUrl(url: string): boolean {
  if (!URL_RE.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "banto.invalid" && !host.endsWith(".banto.invalid");
  } catch {
    return false;
  }
}

/** 同梱プラグインのうち、イベントを受け取らないもの（決済事業者の Webhook を受ける側）。イベントの購読欄を出さない */
function receivesEvents(url: string | undefined): boolean {
  const id = url ? bundledPluginIdFromUrl(url) : null;
  if (id === null) return true;
  return Boolean(findBundledPlugin(id)?.handle);
}

function EndpointForm(props: { action: string; endpoint?: EndpointRow; manifest: PluginManifest | null }) {
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
      <label>
        <input type="checkbox" name="enabled" value="on" checked={e?.enabled ?? true} /> {t("hooks.enabled")}
      </label>
      <p>
        <button type="submit">{t("shop.save")}</button>
      </p>
    </form>
  );
}

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
    <AdminLayout title={`${shop.name} · ${t("hooks.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "hooks" }}>
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
  const manifest = await fetchManifest(url, c.get("deps").fetch);
  return c.html(
    <AdminLayout title={t("hooks.add")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title"), href: `/admin/shops/${shop.id}/hooks` }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "hooks" }}>
      <PageHead title={t("hooks.add")} />
      {manifest ? (
        <p class="notice">
          {t("hooks.manifest_found")} <strong>{manifest.name}</strong> {manifest.version ? `v${manifest.version}` : ""}
          {manifest.description ? <div class="muted">{manifest.description}</div> : null}
        </p>
      ) : (
        <p class="muted">{t("hooks.manifest_missing")}</p>
      )}
      <EndpointForm action={`/admin/shops/${shop.id}/hooks`} manifest={manifest} endpoint={{ id: "", shop_id: shopId, name: manifest?.name ?? "", url, events: manifest?.events ?? [], enabled: true, manifest, settings: {}, created_at: "" }} />
    </AdminLayout>,
  );
});

function endpointValues(f: Record<string, string>, eventsRaw: string[], manifest: PluginManifest | null): Partial<EndpointRow> | "invalid_url" {
  const url = (f.url ?? "").trim();
  if (!URL_RE.test(url)) return "invalid_url"; // 既存の行の保存（同梱プラグインの設定もここを通る）。新規の登録は externalHookUrl
  return {
    name: (f.name ?? "").trim().slice(0, 200) || url,
    url,
    events: receivesEvents(url) ? eventsRaw.filter(isHookEvent) : [],
    enabled: f.enabled === "on",
    settings: settingsFromForm(manifest, f),
  };
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
  const manifest = await fetchManifest(url, c.get("deps").fetch);
  const values = endpointValues(f, events, manifest);
  if (values === "invalid_url") return c.redirect(`/admin/shops/${shopId}/hooks?flash=invalid_url`);
  try {
    const [created] = await db.from<EndpointRow>("hook_endpoints").insert({ ...values, shop_id: shopId, manifest });
    return c.redirect(`/admin/shops/${shopId}/hooks/${created!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/hooks?flash=generic`);
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
  const signing = secret ? await endpointSecret(secret, endpoint.id) : null;
  const base = `/admin/shops/${shop.id}/hooks/${endpoint.id}`;
  const f = flash(c.req.query("flash"));
  return c.html(
    <AdminLayout title={endpoint.name} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("hooks.title"), href: `/admin/shops/${shop.id}/hooks` }, { label: endpoint.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "hooks" }}>
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
      <EndpointForm action={base} endpoint={endpoint} manifest={endpoint.manifest} />

      {bundledPluginIdFromUrl(endpoint.url) === null ? (
        <div>
          <h2>{t("hooks.secret")}</h2>
          <p class="muted">{t("hooks.secret_hint")}</p>
          {signing ? <pre>{signing}</pre> : <p class="error">{t("error.secret_missing")}</p>}
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
  const values = endpointValues(f, events, endpoint.manifest);
  if (values === "invalid_url") return c.redirect(`${base}?flash=invalid_url`);
  if (bundledPluginIdFromUrl(endpoint.url) !== null) values.url = endpoint.url;
  try {
    await db.from<EndpointRow>("hook_endpoints").update(values, { id: endpoint.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

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
  const secret = sessionSecret(c);
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
    const res = await c.get("deps").fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "banto-hooks",
        "X-Banto-Event": "banto.ping",
        "X-Banto-Signature": await signHookPayload(await endpointSecret(secret, endpoint.id), body),
      },
      body,
      signal: controller.signal,
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
  return c.html(
    <AdminLayout title={endpoint.name} nav>
      <p>
        <a href={`/admin/shops/${shop.id}/hooks/${endpoint.id}`}>‹ {endpoint.name}</a>
      </p>
      <iframe src={src.toString()} style="width:100%;height:70vh;border:1px solid color-mix(in srgb,CanvasText 15%,transparent)" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>
    </AdminLayout>,
  );
});
