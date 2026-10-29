import { Hono } from "hono";
import { STOREFRONT_MODES, safeHttpsUrl, storefrontSettings } from "../../storefront/mode";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { DomainAttachResult, DomainState } from "../../adapters/types";
import type { ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { createPrivilegedDb } from "../../db/privileged";
import { orderPageUrl } from "../../orders/lookup";
import { memberAccountPage } from "../../storefront/urls";
import { LEGAL_CHECK_HOURS, LEGAL_KINDS, checkLegalLinks, legalLinksOf, parseLegalUrl, type LegalKind, type LegalLinkResults } from "../../storefront/legal-links";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, publicBaseUrl, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { can, shopAccess, type ShopAccess, type ShopPerm } from "./access";
import { bundledPluginUrl } from "../../plugins";
import { PREFECTURES, parseShippingSettings, taxRate } from "../../commerce/shipping";
import { checkoutTerms, missingTerms, parseOrigins, parseRelayIps, relayIps, returnOrigins, shopLimit } from "../../commerce/checkout";
import { formatFieldDefinitions, parseFieldDefinitions, productFields } from "../../products/fields";
import { customerFields, parseCustomerFieldDefinitions } from "../../customers/fields";
import { enabledModules } from "../../modules/registry";
import { normalizeDomain, shopHome } from "../../storefront/urls";
import { TAX_ROUNDINGS, shopTaxRates, taxRoundingOf } from "../../commerce/tax";

export const shops = new Hono<AppEnv>();

/**
 * 管理対象のショップ。自分が触れるショップで、perm の権限の項目を持つときだけ返す（無ければ null = 404）。
 * id だけで引かない（RLS の公開ポリシーにより、他人の「公開中」ショップも SELECT できてしまうため）。
 * perm: 権限の項目、"admin" = 組織の owner / admin、"any" = 何か 1 つでも持つ。自分の権限は c.get("shopAccess") に入る
 */
export async function loadShop(c: AdminContext, shopId: string, perm: ShopPerm | "admin" | "any"): Promise<ShopRow | null> {
  const r = await shopAccess(c, shopId);
  if (!r || !can(r.access, perm)) return null;
  c.set("shopAccess", r.access);
  return r.shop;
}

function flash(code: string | undefined, detail?: string): { kind: "ok" | "error"; text: string } | null {
  if (!code) return null;
  const map: Record<string, MessageKey> = {
    saved: "shop.saved",
    publish_blocked: "shop.publish_blocked",
    generic: "error.generic",
    shipping_saved: "shipping.saved",
    theme_saved: "theme.saved",
    terms_saved: "terms.saved",
    headless_saved: "headless.saved",
    legal_links_saved: "legal_links.saved",
    legal_links_checked: "legal_links.checked",
    legal_links_invalid: "legal_links.invalid",
    order_page_invalid: "headless.order_page_invalid",
    account_page_invalid: "headless.account_page_invalid",
    storefront_saved: "sfmode.saved",
    storefront_invalid: "sfmode.invalid",
    domain_saved: "domain.saved",
    domain_invalid: "domain.invalid",
    domain_taken: "domain.taken",
    domain_unverified: "domain.unverified",
    domain_unavailable: "domain.unavailable",
    fields_saved: "fields.saved",
    customer_fields_saved: "customer_fields.saved",
    stripe_connected: "stripe.connected_ok",
    stripe_disconnected: "stripe.disconnected_ok",
    stripe_failed: "stripe.failed",
    stripe_not_configured: "stripe.not_configured",
    stripe_state_invalid: "stripe.state_invalid",
    restored: "backup.restored",
    restore_not_empty: "backup.restore_not_empty",
    restore_invalid: "backup.restore_invalid",
    restore_failed: "backup.restore_failed",
  };
  const key = map[code];
  if (!key) return null;
  const ok = ["saved", "domain_saved", "shipping_saved", "theme_saved", "terms_saved", "headless_saved", "legal_links_saved", "legal_links_checked", "storefront_saved", "fields_saved", "customer_fields_saved", "stripe_connected", "stripe_disconnected", "restored"].includes(code);
  return { kind: ok ? "ok" : "error", text: detail ? `${t(key)} ${detail.slice(0, 500)}` : t(key) };
}

/** モジュールの画面に要る権限の項目（loadShop と同じ。メニューの出し分け用） */
const MODULE_PERMS: Record<string, ShopPerm> = {
  coupons: "marketing",
  woo_import: "catalog",
  line_login: "integrations",
  google_login: "integrations",
  product_feed: "marketing",
  receipt: "settings",
  delivery_time: "settings",
  shipping_labels: "orders",
  store_tryon: "stores",
};

/**
 * ショップの設定の画面の上の近道。商品・注文・会員・モジュール・連携・AI 連携は上のタブ（AdminLayout の shopTabs）にあるので、
 * ここにはタブに無いもの（カテゴリー・ON のモジュールの画面・お店の画面）だけを出す。持っていない権限の項目のものは出さない
 */
export function ShopNav({ shop, access, publicBaseUrl }: { shop: ShopRow; access: ShopAccess | undefined; publicBaseUrl: string }) {
  const links: [ShopPerm, string, string][] = [
    ["catalog", `/admin/shops/${shop.id}/categories`, t("category.title")],
    ...enabledModules(shop.settings)
      .filter((m) => m.adminPath && can(access, MODULE_PERMS[m.id] ?? "settings"))
      .map((m): [ShopPerm, string, string] => [MODULE_PERMS[m.id] ?? "settings", `/admin/shops/${shop.id}/modules/${m.adminPath}`, t(m.name)]),
  ];
  return (
    <div class="quick">
      {links
        .filter(([perm]) => can(access, perm))
        .map(([, href, label]) => (
          <a class="btn secondary" href={href}>
            {label}
          </a>
        ))}
      <a class="btn secondary" href={shopHome(publicBaseUrl, shop)} target="_blank" rel="noopener">
        {t("shop.storefront")} ↗
      </a>
      <span class={shop.published ? "status on" : "status"} style="align-self:center">
        {shop.published ? t("dashboard.published") : t("dashboard.unpublished")}
      </span>
    </div>
  );
}


const LEGAL_LABEL: Record<LegalKind, MessageKey> = { legal: "shop.legal_notice", privacy: "shop.privacy_policy", returns: "shop.return_policy" };
const LEGAL_HOURS_LABEL: Record<number, MessageKey> = { 1: "legal_links.hours_1", 6: "legal_links.hours_6", 24: "legal_links.hours_24", 168: "legal_links.hours_168" };

/** 法務のページを連携サイトのページへ向ける（0062。保存は integrations の項目） */
function LegalLinksSection(props: { shop: ShopRow }) {
  const { shop } = props;
  const cfg = legalLinksOf(shop.settings);
  const state = (shop.legal_links_state ?? {}) as Record<string, { url?: unknown; ok?: unknown; checked_at?: unknown } | undefined>;
  const stateText = (k: LegalKind) => {
    const url = cfg.urls[k];
    if (!url) return null;
    const st = state[k];
    if (!st || st.url !== url || typeof st.checked_at !== "string") return <p class="muted">{t("legal_links.state_none")}</p>;
    const at = formatDateTime(st.checked_at);
    return st.ok === true ? <p class="muted">{tf("legal_links.state_ok", { at })}</p> : <p class="error">{tf("legal_links.state_ng", { at })}</p>;
  };
  return (
    <section class="card" id="legal-links">
      <h2>{t("legal_links.title")}</h2>
      <form method="post" action={`/admin/shops/${shop.id}/legal-links`}>
        <p class="muted">{t("legal_links.intro")}</p>
        {LEGAL_KINDS.map((k) => (
          <div>
            <label for={`legal_url_${k}`}>{t(LEGAL_LABEL[k])}</label>
            <input id={`legal_url_${k}`} type="url" name={`url_${k}`} value={cfg.urls[k] ?? ""} placeholder="https://example.com/legal" style="width:100%;max-width:40rem" />
            {stateText(k)}
          </div>
        ))}
        <p class="muted">{t("legal_links.url_hint")}</p>
        <label for="legal_check_hours">{t("legal_links.check_hours")}</label>
        <select id="legal_check_hours" name="check_hours">
          {LEGAL_CHECK_HOURS.map((h) => (
            <option value={String(h)} selected={cfg.check_hours === h}>
              {t(LEGAL_HOURS_LABEL[h]!)}
            </option>
          ))}
        </select>
        <p class="muted">{t("legal_links.hours_hint")}</p>
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      {Object.keys(cfg.urls).length > 0 ? (
        <form method="post" action={`/admin/shops/${shop.id}/legal-links/check`}>
          <button type="submit" class="secondary">
            {t("legal_links.check_now")}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function ShopSettingsPage(props: { shop: ShopRow; access: ShopAccess | undefined; flash: ReturnType<typeof flash>; publicBaseUrl: string; stripeConnectConfigured: boolean; stripeDirectEnabled: boolean; stripeKeySet: boolean; domain: { provider: boolean; state: DomainState | null }; integrations: boolean }) {
  const { shop } = props;
  const shippingCfg = parseShippingSettings((shop.settings ?? {})["shipping"]);
  const themeSettings = ((shop.settings ?? {})["theme_settings"] ?? {}) as Record<string, unknown>;
  const themeStr = (k: string) => (typeof themeSettings[k] === "string" ? String(themeSettings[k]) : "");
  const terms = checkoutTerms(shop.settings);
  const missing = missingTerms(shop.settings);
  const termLabel = { delivery: t("terms.delivery"), cancellation: t("terms.cancellation"), payment_note: t("terms.payment_note") };
  return (
    <AdminLayout title={`${shop.name} · ${t("shop.settings")}`} nav crumbs={[{ label: shop.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: "settings" }}>
      <PageHead title={shop.name} sub={t("shop.settings")} />
      {missing.length > 0 ? (
        <p class="notice">
          {t("terms.missing").replace("{items}", missing.map((k) => termLabel[k]).join("・"))} <a href="#terms">{t("terms.title")}</a>
        </p>
      ) : null}
      <ShopNav shop={shop} access={props.access} publicBaseUrl={props.publicBaseUrl} />
      {props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{props.flash.text}</p> : null}
      <div class="settings">
        <nav class="side-nav" aria-label={t("shop.settings")}>
          <a href="#general">{t("shop.general")}</a>
          <a href="#shipping">{t("shipping.title")}</a>
          <a href="#theme">{t("theme.title")}</a>
          <a href="#terms">{t("terms.title")}</a>
          <a href="#fields">{t("fields.title")}</a>
          <a href="#domain">{t("domain.title")}</a>
          <a href="#storefront">{t("sfmode.title")}</a>
          <a href="#headless">{t("headless.title")}</a>
          <a href="#stripe">{t("stripe.title")}</a>
          <a href="#backup">{t("backup.title")}</a>
        </nav>
        <div>
        <section class="card" id="general">
          <h2>{t("shop.general")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}`}>
            <label for="name">{t("shop.name")}</label>
            <input id="name" type="text" name="name" value={shop.name} required maxlength={200} />
            <label for="slug">{t("shop.slug")}</label>
            <input id="slug" type="text" name="slug" value={shop.slug} required pattern="[a-z0-9][a-z0-9-]{0,62}" />
            <label for="legal_notice">{t("shop.legal_notice")}</label>
            <textarea id="legal_notice" name="legal_notice" rows={8} style="width:100%;max-width:40rem">
              {shop.legal_notice ?? ""}
            </textarea>
            <label for="privacy_policy">{t("shop.privacy_policy")}</label>
            <textarea id="privacy_policy" name="privacy_policy" rows={8} style="width:100%;max-width:40rem">
              {shop.privacy_policy ?? ""}
            </textarea>
            <label for="return_policy">{t("shop.return_policy")}</label>
            <textarea id="return_policy" name="return_policy" rows={6} style="width:100%;max-width:40rem">
              {shop.return_policy ?? ""}
            </textarea>
            <label>
              <input type="checkbox" name="published" value="on" checked={shop.published} /> {t("shop.published")}
            </label>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="shipping">
          <h2>{t("shipping.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/shipping`}>
            <p class="muted">{t("shipping.intro")}</p>
            <label>
              <input type="radio" name="mode" value="flat" checked={shippingCfg.mode === "flat"} /> {t("shipping.flat")}
            </label>
            <label>
              <input type="radio" name="mode" value="by_prefecture" checked={shippingCfg.mode === "by_prefecture"} /> {t("shipping.by_prefecture")}
            </label>
            <label for="flat_fee_jpy">{t("shipping.flat_fee")}</label>
            <input id="flat_fee_jpy" type="number" name="flat_fee_jpy" min={0} value={String(shippingCfg.flat_fee_jpy)} style="width:8rem" />
            <label for="free_over_jpy">{t("shipping.free_over")}</label>
            <input id="free_over_jpy" type="number" name="free_over_jpy" min={0} value={shippingCfg.free_over_jpy === null ? "" : String(shippingCfg.free_over_jpy)} style="width:8rem" placeholder="なし" />
            <details>
              <summary>{t("shipping.table")}</summary>
              <table>
                <tbody>
                  {PREFECTURES.map((p) => (
                    <tr>
                      <td>{p}</td>
                      <td>
                        <input type="number" name={`pref_${p}`} min={0} value={shippingCfg.by_prefecture[p] === undefined ? "" : String(shippingCfg.by_prefecture[p])} placeholder={String(shippingCfg.flat_fee_jpy)} style="width:7rem" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <label for="tax_rate">{t("shipping.tax_rate")}</label>
            <input id="tax_rate" type="number" name="tax_rate" min={0} max={99} value={String(taxRate(shop.settings ?? {}))} style="width:6rem" />
            <label for="tax_rate_reduced">{t("tax.rate_reduced")}</label>
            <input id="tax_rate_reduced" type="number" name="tax_rate_reduced" min={0} max={99} value={String(shopTaxRates(shop.settings).reduced)} style="width:6rem" />
            <label for="tax_rounding">{t("tax.rounding")}</label>
            <select id="tax_rounding" name="tax_rounding">
              {TAX_ROUNDINGS.map((r) => (
                <option value={r} selected={taxRoundingOf((shop.settings ?? {})["tax_rounding"]) === r}>
                  {t(`tax.rounding_${r}`)}
                </option>
              ))}
            </select>
            <label id="members">
              <input type="checkbox" name="members_enabled" value="on" checked={(shop.settings ?? {})["members_enabled"] === true} /> {t("shop.members_enabled")}
            </label>
            <p class="muted">{t("shop.members_hint")}</p>
            <label>
              <input type="checkbox" name="members_password" value="on" checked={(shop.settings ?? {})["members_password"] === true} /> {t("shop.members_password")}
            </label>
            <p class="muted">{t("shop.members_password_hint")}</p>
            <label>
              <input type="checkbox" name="marketing_consent" value="on" checked={(shop.settings ?? {})["marketing_consent"] === true} /> {t("shop.marketing_consent")}
            </label>
            <p class="muted">{t("shop.marketing_consent_hint")}</p>
            <label for="contact_email">{t("shipping.contact_email")}</label>
            <input id="contact_email" type="email" name="contact_email" value={typeof shop.settings?.["contact_email"] === "string" ? String(shop.settings["contact_email"]) : ""} />
            <p class="muted">{t("shipping.contact_email_hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="theme">
          <h2>{t("theme.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/theme`}>
            <p class="muted">{t("theme.intro")}</p>
            <label for="description">{t("theme.description")}</label>
            <textarea id="description" name="description" rows={3} maxlength={300} style="width:100%;max-width:40rem">
              {themeStr("description")}
            </textarea>
            <label for="announcement">{t("theme.announcement")}</label>
            <input id="announcement" type="text" name="announcement" value={themeStr("announcement")} maxlength={120} />
            <label for="accent_color">{t("theme.accent")}</label>
            <input id="accent_color" type="color" name="accent_color" value={themeStr("accent_color") || "#1f6feb"} />
            <label for="logo_url">{t("theme.logo")}</label>
            <input id="logo_url" type="url" name="logo_url" value={themeStr("logo_url")} placeholder="https://" />
            <p class="muted">{t("theme.logo_hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="terms">
          <h2>{t("terms.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/terms`}>
            <p class="muted">{t("terms.intro")}</p>
            <label for="terms_delivery">{t("terms.delivery")}</label>
            <textarea id="terms_delivery" name="delivery" rows={2} maxlength={2000} placeholder={t("terms.delivery_placeholder")} style="width:100%;max-width:40rem">
              {terms.delivery ?? ""}
            </textarea>
            <label for="terms_cancellation">{t("terms.cancellation")}</label>
            <textarea id="terms_cancellation" name="cancellation" rows={4} maxlength={2000} placeholder={t("terms.cancellation_placeholder")} style="width:100%;max-width:40rem">
              {terms.cancellation ?? ""}
            </textarea>
            <label for="terms_payment_note">{t("terms.payment_note")}</label>
            <textarea id="terms_payment_note" name="payment_note" rows={2} maxlength={2000} style="width:100%;max-width:40rem">
              {terms.payment_note ?? ""}
            </textarea>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="fields">
          <h2>{t("fields.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/fields`}>
            <p class="muted">{t("fields.intro")}</p>
            <textarea name="definitions" rows={6} style="width:100%;max-width:40rem;font-family:monospace" placeholder={"material | 素材 | text\norigin | 原産国 | select | 日本/中国\ncost | 原価 | number | | private"}>
              {formatFieldDefinitions(productFields(shop.settings))}
            </textarea>
            <p class="muted">{t("fields.hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="customer-fields">
          <h2>{t("customer_fields.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/customer-fields`}>
            <p class="muted">{t("customer_fields.intro")}</p>
            <textarea name="definitions" rows={4} style="width:100%;max-width:40rem;font-family:monospace" placeholder={"rank | 会員ランク | select | regular/silver/gold\nnewsletter | メルマガ | select | yes/no\nowner | 担当者 | text"}>
              {formatFieldDefinitions(customerFields(shop.settings))}
            </textarea>
            <p class="muted">{t("customer_fields.hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="domain">
          <h2>{t("domain.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/domain`}>
            <p class="muted">{t("domain.intro")}</p>
            {props.domain.provider ? (
              <p class="muted">{t("domain.provider_intro")}</p>
            ) : (
              <ol class="muted">
                <li>{t("domain.step_cloudflare")}</li>
                <li>{t("domain.step_check")}</li>
                <li>{t("domain.step_save")}</li>
              </ol>
            )}
            <label for="domain_input">{t("domain.label")}</label>
            <input id="domain_input" type="text" name="domain" value={shop.domain ?? ""} placeholder="shop.example.jp" maxlength={253} />
            {shop.domain && props.domain.state ? (
              <p class={props.domain.state.status === "active" ? "notice" : "muted"}>
                {props.domain.state.status === "active" ? t("domain.state_active") : t("domain.state_pending")}
                {props.domain.state.message ? ` ${props.domain.state.message}` : ""}
              </p>
            ) : null}
            {shop.domain && props.domain.state?.instructions?.length ? (
              <>
                <p class="muted">{t("domain.instructions")}</p>
                <table>
                  <tbody>
                    {props.domain.state.instructions.map((i) => (
                      <tr>
                        <td>{i.type.toUpperCase()}</td>
                        <td>
                          <code>{i.name}</code>
                        </td>
                        <td>
                          <code>{i.value}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            {shop.domain ? (
              <p class="muted">
                {t("domain.current")} <code>{`https://${shop.domain}`}</code> · {t("domain.after_change")}
              </p>
            ) : (
              <p class="muted">
                {t("domain.none")} <code>{`${props.publicBaseUrl}/${shop.slug}`}</code>
              </p>
            )}
            <p>
              <button type="submit">{t("domain.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="storefront">
          <h2>{t("sfmode.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/storefront`}>
            <p class="muted">{t("sfmode.intro")}</p>
            {(["full", "checkout", "off"] as const).map((m) => (
              <p>
                <label>
                  <input type="radio" name="mode" value={m} checked={storefrontSettings(shop.settings).mode === m} /> <strong>{t(`sfmode.mode_${m}` as MessageKey)}</strong>
                  <br />
                  <span class="muted">{t(`sfmode.mode_${m}_hint` as MessageKey)}</span>
                </label>
              </p>
            ))}
            <label for="site_url">{t("sfmode.site_url")}</label>
            <input id="site_url" type="url" name="site_url" value={storefrontSettings(shop.settings).siteUrl ?? ""} placeholder="https://example.com" style="width:100%;max-width:40rem" />
            <label for="product_url">{t("sfmode.product_url")}</label>
            <input id="product_url" type="text" name="product_url" value={storefrontSettings(shop.settings).productUrl ?? ""} placeholder="https://example.com/product/{slug}/" style="width:100%;max-width:40rem" />
            <p class="muted">{t("sfmode.urls_hint")}</p>
            <p class="muted">{t("sfmode.analytics_hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        <section class="card" id="headless">
          <h2>{t("headless.title")}</h2>
          <form method="post" action={`/admin/shops/${shop.id}/headless`}>
            <p class="muted">{t("headless.intro")}</p>
            <label for="return_origins">{t("headless.return_origins")}</label>
            <textarea id="return_origins" name="return_origins" rows={3} style="width:100%;max-width:40rem" placeholder="https://example.com">
              {returnOrigins(shop.settings).join("\n")}
            </textarea>
            <p class="muted">{t("headless.return_origins_hint")}</p>
            {props.integrations ? (
              <>
                <label for="order_page_url">{t("headless.order_page_url")}</label>
                <input id="order_page_url" type="url" name="order_page_url" value={orderPageUrl(shop.settings) ?? ""} placeholder="https://example.com/order-status/" style="width:100%;max-width:40rem" />
                <p class="muted">{t("headless.order_page_url_hint")}</p>
              </>
            ) : null}
            {props.integrations ? (
              <>
                <label for="account_page_url">{t("headless.account_page_url")}</label>
                <input id="account_page_url" type="url" name="account_page_url" value={memberAccountPage(shop.settings) ?? ""} placeholder="https://example.com/my-account/" style="width:100%;max-width:40rem" />
                <p class="muted">{t("headless.account_page_url_hint")}</p>
              </>
            ) : null}
            <label for="relay_ips">{t("headless.relay_ips")}</label>
            <textarea id="relay_ips" name="relay_ips" rows={2} style="width:100%;max-width:40rem" placeholder="203.0.113.10">
              {relayIps(shop.settings).join("\n")}
            </textarea>
            <p class="muted">{t("headless.relay_ips_hint")}</p>
            <label for="max_pending_per_ip">{t("headless.max_pending_per_ip")}</label>
            <input id="max_pending_per_ip" type="number" name="max_pending_per_ip" min={1} max={9999} value={String(shopLimit(shop.settings, "checkout", "max_pending_per_ip", 20))} />
            <label for="login_per_ip_per_hour">{t("headless.login_per_ip_per_hour")}</label>
            <input id="login_per_ip_per_hour" type="number" name="login_per_ip_per_hour" min={1} max={9999} value={String(shopLimit(shop.settings, "members_login_limits", "per_ip_per_hour", 30))} />
            <label for="order_lookup_per_ip_per_hour">{t("headless.order_lookup_per_ip_per_hour")}</label>
            <input id="order_lookup_per_ip_per_hour" type="number" name="order_lookup_per_ip_per_hour" min={1} max={9999} value={String(shopLimit(shop.settings, "order_lookup", "per_ip_per_hour", 20))} />
            <p class="muted">{t("headless.limits_hint")}</p>
            <p>
              <button type="submit">{t("shop.save")}</button>
            </p>
          </form>
        </section>

        {props.integrations ? <LegalLinksSection shop={shop} /> : null}

        <section class="card" id="stripe">
          <h2>{t("stripe.title")}</h2>
          <p>
            {props.stripeDirectEnabled ? (
              <span>
                <span class="badge ok">{t("stripe.direct_on")}</span>
              </span>
            ) : shop.stripe_account_id ? (
              <span>
                <span class="badge ok">{t("stripe.connected")}</span> <code>{shop.stripe_account_id}</code>
              </span>
            ) : (
              <span class="badge ng">{t("stripe.not_connected")}</span>
            )}
          </p>
          <p>
            {t("stripe.direct_hint")} <a href={`/admin/shops/${shop.id}/plugins`}>{t("plugins.title")}</a>
          </p>
          <p class="muted">
            {t("stripe.webhook_hint_direct")} <code>{props.publicBaseUrl}/webhooks/stripe</code>
          </p>
          <details>
            <summary>{t("stripe.connect_advanced")}</summary>
            <p class="muted">{t("stripe.connect_intro")}</p>
            {!props.stripeConnectConfigured ? <p class="notice">{t("stripe.not_configured")}</p> : null}
            {shop.stripe_account_id ? (
              <form method="post" action={`/admin/shops/${shop.id}/stripe/disconnect`}>
                <button type="submit">{t("stripe.disconnect")}</button>
              </form>
            ) : props.stripeConnectConfigured ? (
              <p>
                <a href={`/admin/shops/${shop.id}/stripe/connect`}>{t("stripe.connect")}</a>
              </p>
            ) : null}
            <p class="muted">{t("stripe.webhook_hint")}</p>
          </details>
        </section>

        <section class="card" id="backup">
          <h2>{t("backup.title")}</h2>
          <p>{t("backup.hint")}</p>
          <p>
            <a href={`/admin/shops/${shop.id}/export.json`} download>{t("backup.download")}</a> ・{" "}
            <a href={`/admin/shops/${shop.id}/orders.csv`}>{t("order.csv")}</a>
          </p>
          <p class="muted">{t("backup.note")}</p>
          <details>
            <summary>{t("backup.restore")}</summary>
            <p class="muted">{t("backup.restore_hint")}</p>
            <form method="post" action={`/admin/shops/${shop.id}/restore`} enctype="multipart/form-data" onsubmit={`return confirm(${JSON.stringify(t("backup.restore_confirm"))})`}>
              <input type="file" name="file" accept="application/json,.json" required />
              <p>
                <button type="submit">{t("backup.restore_submit")}</button>
              </p>
            </form>
          </details>
        </section>
        </div>
      </div>
    </AdminLayout>
  );
}

shops.get("/:shopId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shop = await loadShop(c, param(c, "shopId"), "any");
  if (!shop) return c.text(t("shop.not_found"), 404);
  // ショップの設定の項目が無いメンバーには、触れる画面へのメニューだけ出す
  if (!can(c.get("shopAccess"), "settings")) {
    return c.html(
      <AdminLayout title={shop.name} nav crumbs={[{ label: shop.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "settings" }}>
        <PageHead title={shop.name} sub={t("access.nav_only")} />
        <ShopNav shop={shop} access={c.get("shopAccess")} publicBaseUrl={publicBaseUrl(c)} />
      </AdminLayout>,
    );
  }
  const cfg = c.get("adapters").config;
  const base = publicBaseUrl(c);
  const stripeKeySet = Boolean(cfg.get("STRIPE_SECRET_KEY") && cfg.get("STRIPE_WEBHOOK_SECRET"));
  const direct = await db.from<{ id: string; enabled: boolean }>("hook_endpoints").selectOne("id,enabled", { eq: { shop_id: shop.id, url: bundledPluginUrl("stripe") } });
  // 独自ドメインの提供元（ホスティングの提供者）。状態は提供元に 1 回だけ聞く。失敗しても画面は出す
  const provider = c.get("adapters").domain;
  const domainState = provider && shop.domain ? await provider.status(shop.domain, { id: shop.id, slug: shop.slug }).catch(() => null) : null;
  return c.html(
    <ShopSettingsPage
      domain={{ provider: Boolean(provider), state: domainState }}
      shop={shop}
      access={c.get("shopAccess")}
      flash={flash(c.req.query("flash"), c.req.query("detail"))}
      publicBaseUrl={base}
      stripeConnectConfigured={Boolean(cfg.get("STRIPE_SECRET_KEY") && cfg.get("STRIPE_CLIENT_ID"))}
      stripeDirectEnabled={Boolean(direct?.enabled) && stripeKeySet}
      stripeKeySet={stripeKeySet}
      integrations={can(c.get("shopAccess"), "integrations")}
    />,
  );
});

shops.post("/:shopId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const clean = (v: string | undefined) => {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
  };
  const values: Partial<ShopRow> = {
    name: (f.name ?? "").trim() || shop.name,
    slug: (f.slug ?? "").trim() || shop.slug,
    legal_notice: clean(f.legal_notice),
    privacy_policy: clean(f.privacy_policy),
    return_policy: clean(f.return_policy),
    published: f.published === "on",
  };
  try {
    await db.from<ShopRow>("shops").update(values, { id: shopId });
  } catch (e) {
    if (e instanceof DbError && /shops_publish_requires_legal/.test(e.message)) {
      return c.redirect(`/admin/shops/${shopId}?flash=publish_blocked`);
    }
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=saved`);
});

/** 送料・税・連絡先（shops.settings に保存。法務文書などの列とは別フォーム） */
shops.post("/:shopId/shipping", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const int = (v: string | undefined): number | null => {
    const n = Number.parseInt((v ?? "").trim(), 10);
    return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
  };
  const by: Record<string, number> = {};
  for (const p of PREFECTURES) {
    const v = int(f[`pref_${p}`]);
    if (v !== null) by[p] = v;
  }
  const shipping = {
    mode: f.mode === "by_prefecture" ? "by_prefecture" : "flat",
    flat_fee_jpy: int(f.flat_fee_jpy) ?? 0,
    free_over_jpy: int(f.free_over_jpy),
    by_prefecture: by,
  };
  const rate = int(f.tax_rate);
  const reduced = int(f.tax_rate_reduced);
  const contact = (f.contact_email ?? "").trim();
  const settings = {
    ...(shop.settings ?? {}),
    shipping,
    tax_rate: rate !== null && rate < 100 ? rate : 10,
    tax_rate_reduced: reduced !== null && reduced < 100 ? reduced : 8,
    tax_rounding: taxRoundingOf(f.tax_rounding),
    members_enabled: f.members_enabled === "on",
    members_password: f.members_password === "on",
    marketing_consent: f.marketing_consent === "on",
    ...(contact && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) ? { contact_email: contact } : { contact_email: null }),
  };
  try {
    await db.from<ShopRow>("shops").update({ settings }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=shipping_saved`);
});

/** 購入前の確認画面に出す内容（shops.settings.checkout_terms。src/commerce/checkout.ts が読む） */
shops.post("/:shopId/terms", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const clean = (v: string | undefined) => (v ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
  const checkout_terms = { delivery: clean(f.delivery), cancellation: clean(f.cancellation), payment_note: clean(f.payment_note) };
  try {
    await db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), checkout_terms } }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=terms_saved`);
});

/** カスタム項目の定義（shops.settings.product_fields。値は products.attributes。src/products/fields.ts） */
shops.post("/:shopId/fields", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const product_fields = parseFieldDefinitions(f.definitions ?? "");
  try {
    await db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), product_fields } }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=fields_saved#fields`);
});

/**
 * 会員の項目の定義（shops.settings.customer_fields。値は customers.attributes。src/customers/fields.ts、0047）。
 * 値は外部の顧客マスタが AI 用トークンの API で写す（向きは外部 → Banto）。定義に無い鍵は SQL が受け付けない
 */
shops.post("/:shopId/customer-fields", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const customer_fields = parseCustomerFieldDefinitions(f.definitions ?? "");
  try {
    await db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), customer_fields } }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=customer_fields_saved#customer-fields`);
});

/**
 * 独自ドメイン（0015_shop_domain、docs/custom-domain.md）。空にすると外す。
 * Banto 自身のホスト名は付けられない（管理画面や他のショップまでそのショップになってしまうため）。
 */
shops.post("/:shopId/domain", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const domain = normalizeDomain(f.domain ?? "");
  const own = [new URL(c.req.url).hostname, new URL(publicBaseUrl(c)).hostname];
  if (domain === "invalid" || (domain && (own.includes(domain) || domain.endsWith(".workers.dev")))) return c.redirect(`/admin/shops/${shopId}?flash=domain_invalid#domain`);
  // 独自ドメインの提供元（DomainAdapter）。付ける前に所有の確認と登録を頼み、断られたら保存しない。
  // 無ければ今までどおり（運営者が Cloudflare で Worker に付けてから保存する。docs/custom-domain.md §6）
  const provider = c.get("adapters").domain;
  const ref = { id: shop.id, slug: shop.slug };
  const previous = shop.domain ?? null;
  if (provider && domain && domain !== previous) {
    const r: DomainAttachResult = await provider.attach(domain, ref).catch(() => ({ ok: false, reason: "unavailable" }));
    if (!r.ok) {
      const detail = r.message ? `&detail=${encodeURIComponent(r.message.slice(0, 200))}` : "";
      return c.redirect(`/admin/shops/${shopId}?flash=domain_${r.reason}${detail}#domain`);
    }
  }
  try {
    await db.from<ShopRow>("shops").update({ domain }, { id: shopId });
  } catch (e) {
    // 提供元には登録したのに Banto 側で保存できなかった → 提供元の登録を戻す（失敗しても画面の結果は変えない）
    if (provider && domain && domain !== previous) await provider.detach(domain, ref).catch(() => undefined);
    if (e instanceof DbError && (e.code === "23505" || /shops_domain_key/.test(e.message))) return c.redirect(`/admin/shops/${shopId}?flash=domain_taken#domain`);
    if (e instanceof DbError && (e.code === "23514" || /shops_domain_format/.test(e.message))) return c.redirect(`/admin/shops/${shopId}?flash=domain_invalid#domain`);
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  // 外した・変えた: 前のドメインの登録を提供元から消す（失敗しても Banto 側の設定は戻さない）
  if (provider && previous && previous !== domain) await provider.detach(previous, ref).catch(() => undefined);
  return c.redirect(`/admin/shops/${shopId}?flash=domain_saved#domain`);
});

/** お店の画面の使い方（shops.settings.storefront、0041。src/storefront/mode.ts）。分析（GA4）は同梱モジュール ga4 の画面で */
shops.post("/:shopId/storefront", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const mode = (STOREFRONT_MODES as readonly string[]).includes(f.mode ?? "") ? f.mode! : "full";
  const site = (f.site_url ?? "").trim();
  const product = (f.product_url ?? "").trim();
  // https の URL だけ（転送先に javascript: や http を入れさせない）。商品ページは {slug} が要る
  const siteUrl = site ? safeHttpsUrl(site) : null;
  const productUrl = product ? safeHttpsUrl(product, { template: true }) : null;
  if ((site && !siteUrl) || (product && !productUrl)) return c.redirect(`/admin/shops/${shopId}?flash=storefront_invalid#storefront`);
  const current = shop.settings ?? {};
  const settings: Record<string, unknown> = { ...current, storefront: { mode, site_url: siteUrl, product_url: productUrl } };
  try {
    await db.from<ShopRow>("shops").update({ settings }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=storefront_saved#storefront`);
});

/** ヘッドレス連携（shops.settings.headless）。決済後の戻り先として許可するオリジン、信頼する中継元の IP、IP ごとの上限（0033） */
shops.post("/:shopId/headless", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const current = shop.settings ?? {};
  // 0033 の欄は DB にその版が入っているときだけ画面に出る。無ければ今の値をそのまま持ち越す
  const section = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const origins = parseOrigins(f.return_origins ?? "");
  const headless: Record<string, unknown> = { ...section(current.headless), return_origins: origins, relay_ips: f.relay_ips !== undefined ? parseRelayIps(f.relay_ips) : relayIps(current) };
  // 法務のページの外の URL（0062）は、許可から外したサイトのものを外す（許可したサイトの URL だけ向ける）
  if (headless.legal_links !== undefined) {
    const links = section(headless.legal_links);
    const kept = Object.fromEntries(Object.entries(links).filter(([k, v]) => !(LEGAL_KINDS as readonly string[]).includes(k) || (typeof v === "string" && parseLegalUrl(v, origins).ok)));
    headless.legal_links = kept;
  }
  // 注文照会のページ（0066）・会員ページ（0069）。欄はその版が入っているときだけ出る。無ければ今の値を持ち越す（許可から外したサイトなら外す）
  for (const [key, flashCode] of [["order_page_url", "order_page_invalid"], ["account_page_url", "account_page_invalid"]] as const) {
    const page = parseLegalUrl(f[key] ?? (typeof headless[key] === "string" ? headless[key] : ""), origins);
    if (!page.ok) {
      if (f[key] !== undefined) return c.redirect(`/admin/shops/${shopId}?flash=${flashCode}#headless`);
      delete headless[key];
    } else if (page.url) headless[key] = page.url;
    else delete headless[key];
  }
  const limit = (v: string | undefined, dflt: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : dflt;
  };
  const settings: Record<string, unknown> = { ...current, headless };
  if (f.max_pending_per_ip !== undefined) settings.checkout = { ...section(current.checkout), max_pending_per_ip: limit(f.max_pending_per_ip, 20) };
  if (f.login_per_ip_per_hour !== undefined) settings.members_login_limits = { ...section(current.members_login_limits), per_ip_per_hour: limit(f.login_per_ip_per_hour, 30) };
  if (f.order_lookup_per_ip_per_hour !== undefined) settings.order_lookup = { ...section(current.order_lookup), per_ip_per_hour: limit(f.order_lookup_per_ip_per_hour, 20) };
  try {
    await db.from<ShopRow>("shops").update({ settings }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=headless_saved`);
});

/** 外の URL を確かめて結果を書く（保存と「今すぐ確かめる」。管理画面の操作なので、その場で取りに行く） */
async function recordLegalLinks(c: AdminContext, shop: ShopRow, urls: Partial<Record<LegalKind, string>>): Promise<void> {
  const shopId = shop.id;
  const cfg = c.get("adapters").config;
  const outbound = c.get("adapters").publicFetch ?? c.get("deps").fetch;
  const results: LegalLinkResults = Object.keys(urls).length > 0 ? await checkLegalLinks(urls, outbound) : {};
  // 結果は運営者の JWT で書く（DB が integrations の項目を確かめる）
  await owner(c).db.rpc("legal_links_record", { p_shop_id: shopId, p_results: results });
  // この isolate のお店の画面のキャッシュを捨てる（ほかの isolate は最大 30 秒で入れ替わる）
  const cache = c.get("adapters").cache;
  await Promise.all([cache.delete(`shop:${shop.slug}`), ...(shop.domain ? [cache.delete(`domain:${shop.domain}`)] : [])]);
}

/** 法務のページの外の URL（shops.settings.headless.legal_links、0062）。https で、決済後の戻り先として許可したサイトだけ */
shops.post("/:shopId/legal-links", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const current = shop.settings ?? {};
  const origins = returnOrigins(current);
  const urls: Partial<Record<LegalKind, string>> = {};
  for (const k of LEGAL_KINDS) {
    const r = parseLegalUrl(f[`url_${k}`] ?? "", origins);
    if (!r.ok) return c.redirect(`/admin/shops/${shopId}?flash=legal_links_invalid&detail=${encodeURIComponent(t(LEGAL_LABEL[k]))}#legal-links`);
    if (r.url) urls[k] = r.url;
  }
  const hours = Number(f.check_hours);
  const headless = { ...((current.headless ?? {}) as Record<string, unknown>), legal_links: { ...urls, check_hours: (LEGAL_CHECK_HOURS as readonly number[]).includes(hours) ? hours : 24 } };
  try {
    await db.from<ShopRow>("shops").update({ settings: { ...current, headless } }, { id: shopId });
    await recordLegalLinks(c, shop, urls);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic#legal-links`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=legal_links_saved#legal-links`);
});

shops.post("/:shopId/legal-links/check", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  try {
    await recordLegalLinks(c, shop, legalLinksOf(shop.settings).urls);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic#legal-links`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=legal_links_checked#legal-links`);
});

/** テーマ設定（既定テーマが解釈する。独自テーマは好きなキーを使ってよい） */
shops.post("/:shopId/theme", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const clean = (v: string | undefined, max: number) => (v ?? "").trim().slice(0, max);
  const logo = clean(f.logo_url, 500);
  const theme_settings = {
    description: clean(f.description, 300),
    announcement: clean(f.announcement, 120),
    accent_color: /^#[0-9a-fA-F]{6}$/.test(clean(f.accent_color, 7)) ? clean(f.accent_color, 7) : "#1f6feb",
    logo_url: /^https:\/\//.test(logo) ? logo : "",
  };
  try {
    await db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), theme_settings } }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=theme_saved`);
});
