import { Hono } from "hono";
import { IMAGE_CAPABILITY, IMAGE_MAX_CHOICES, imageMaxWidth, imageProcessing } from "../../media/variants";

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** 連携のマニフェストが、商品画像を変換できると宣言しているか（docs/hooks.md の capabilities） */
const hasImageCapability = (m: unknown): boolean => isRecord(m) && Array.isArray(m["capabilities"]) && m["capabilities"].includes(IMAGE_CAPABILITY);
import { STOREFRONT_MODES, safeHttpsUrl, storefrontSettings } from "../../storefront/mode";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { DomainAttachResult, DomainState } from "../../adapters/types";
import type { ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { orderPageUrl } from "../../orders/lookup";
import { memberAccountPage } from "../../storefront/urls";
import { LEGAL_CHECK_HOURS, LEGAL_KINDS, checkLegalLinks, legalLinksOf, parseLegalUrl, type LegalKind, type LegalLinkResults } from "../../storefront/legal-links";
import { AdminLayout, PageHead, type ShopHere } from "./layout";
import { formFields, owner, param, publicBaseUrl, shopTemplateDomain, type AdminContext } from "./context";
import { domainTemplateFrom, isTemplateDomain, templateSlug } from "../../storefront/subdomain";
import { requireOwner } from "./auth";
import { can, shopAccess, type ShopAccess, type ShopPerm } from "./access";
import { bundledPluginUrl } from "../../plugins";
import { bundledPluginIdFromUrl } from "../../plugins/types";
import { fetchManifest } from "../../hooks/manifest";
import { PREFECTURES, parseShippingSettings, taxRate } from "../../commerce/shipping";
import { checkoutTerms, missingTerms, parseOrigins, parseRelayIps, relayIps, returnOrigins, shopLimit } from "../../commerce/checkout";
import { FIELD_TYPES, fieldRowsFromForm, fieldVisibility, optionsHaveSeparator, optionsText, productFields, type FieldType, type FieldVisibility, type ProductField } from "../../products/fields";
import { customerFields } from "../../customers/fields";
import { enabledModules, moduleEnabled } from "../../modules/registry";
import { normalizeDomain, shopHome } from "../../storefront/urls";
import { TAX_ROUNDINGS, shopTaxRates, taxRoundingOf } from "../../commerce/tax";
import { AutocheckHint, AutocheckScript, autocheckAttrs } from "./autocheck";
import { failCode, updateShop } from "./shop-save";

export const shops = new Hono<AppEnv>();

/**
 * 管理対象のショップ。自分が触れるショップで、perm の権限の項目を持つときだけ返す（無ければ null = 404）。
 * id だけで引かない（RLS の公開ポリシーにより、他人の「公開中」ショップも SELECT できてしまうため）。
 * perm: 権限の項目、"admin" = 組織の owner / admin、"any" = 何か 1 つでも持つ。自分の権限は c.get("shopAccess") に入る
 */
export async function loadShop(c: AdminContext, shopId: string, perm: ShopPerm | "admin" | "any"): Promise<ShopRow | null> {
  const r = await shopAccess(c, shopId);
  if (!r) return null;
  c.set("shopAccess", r.access);
  if (!can(r.access, perm)) {
    // ショップには入れるが、この画面の項目が無い（GET なら「どの項目が要るか」を案内する。src/routes/admin/denied.tsx）
    c.set("deniedShop", { shop: { id: r.shop.id, name: r.shop.name, settings: r.shop.settings }, perm });
    return null;
  }
  // 前に断った印が残っていると、この後の本当の 404 が「項目が要ります」に置き換わるので外す
  c.set("deniedShop", undefined);
  return r.shop;
}

function flash(code: string | undefined, detail?: string): { kind: "ok" | "error"; text: string } | null {
  if (!code) return null;
  const map: Record<string, MessageKey> = {
    saved: "shop.saved",
    publish_blocked: "shop.publish_blocked",
    generic: "error.generic",
    not_saved: "settings.not_saved",
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
    domain_needs_base_url: "domain.needs_base_url",
    domain_taken: "domain.taken",
    domain_unverified: "domain.unverified",
    domain_unavailable: "domain.unavailable",
    slug_domain_invalid: "shop.slug_domain_invalid",
    slug_domain_taken: "shop.slug_domain_taken",
    fields_saved: "fields.saved",
    fields_invalid: "fields.invalid",
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

/**
 * ショップの設定の画面の上の近道。商品・注文・会員・モジュール・連携・AI 連携は上のタブ（AdminLayout の shopTabs）にあるので、
 * ここにはタブに無いもの（カテゴリー・ON のモジュールの画面・お店の画面）だけを出す。持っていない権限の項目のものは出さない
 */
export function ShopNav({ shop, access, publicBaseUrl }: { shop: ShopRow; access: ShopAccess | undefined; publicBaseUrl: string }) {
  const links: [ShopPerm, string, string][] = [
    ["catalog", `/admin/shops/${shop.id}/categories`, t("category.title")],
    ...enabledModules(shop.settings)
      .filter((m) => m.adminPath && can(access, m.perm))
      .map((m): [ShopPerm, string, string] => [m.perm, `/admin/shops/${shop.id}/modules/${m.adminPath}`, t(m.name)]),
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

/**
 * ショップの設定の画面（メンテナの決定 2026-11-08「ショップ設定は分ける」）。
 * 基本と法定表記 / 配送と税 / 決済 / 会員とログイン / 領収書（同梱モジュール）/ 上級者向け。1 画面に保存は 1 つ。
 * 上級者向けはふだん触らないものの一覧で、1 つずつの画面に分ける。見た目（既定のテーマ）はデザインの画面、商品・会員の独自項目は商品・会員の中
 */
export type SettingsSection = "general" | "shipping" | "payments" | "members" | "advanced" | AdvancedSection;
type AdvancedSection = "domain" | "storefront" | "headless" | "legal-links" | "terms" | "images" | "backup";
const ADVANCED: AdvancedSection[] = ["domain", "storefront", "headless", "legal-links", "terms", "images", "backup"];
const SECTIONS: readonly string[] = ["shipping", "payments", "members", "advanced", ...ADVANCED];

/** 設定の画面の URL（基本と法定表記はショップの URL そのもの） */
export function settingsPath(shopId: string, section: SettingsSection = "general"): string {
  return section === "general" ? `/admin/shops/${shopId}` : `/admin/shops/${shopId}/settings/${section}`;
}

/**
 * 画面ごとに要る権限の項目。保存する鍵の項目（DB の banto_shop_settings_perm、0129）に合わせる。"admin" = 組織の owner / admin。
 * 会員とログインは、ログインの方法（LINE・Google は integrations のモジュール）だけを触る人にも開ける（会員機能の欄は owner / admin だけ）
 */
const SECTION_PERM: Record<SettingsSection, ShopPerm | "admin"> = {
  general: "settings",
  shipping: "settings",
  payments: "settings",
  members: "admin",
  advanced: "settings",
  domain: "settings",
  storefront: "admin",
  headless: "integrations",
  "legal-links": "integrations",
  terms: "settings",
  images: "admin",
  backup: "admin",
};
function sectionAllowed(access: ShopAccess | undefined, section: SettingsSection): boolean {
  if (section === "members") return can(access, "admin") || can(access, "integrations");
  // shops の行の更新は、鍵ごとの項目の前に RLS が settings を求める（0024 の shops_member_update）
  if (section === "headless" || section === "legal-links") return can(access, "settings") && can(access, "integrations");
  return can(access, SECTION_PERM[section]);
}

const SECTION_TITLE: Record<SettingsSection, MessageKey> = {
  general: "settings.tab_general",
  shipping: "settings.tab_shipping",
  payments: "settings.tab_payments",
  members: "settings.tab_members",
  advanced: "settings.tab_advanced",
  domain: "domain.title",
  storefront: "sfmode.title",
  headless: "headless.title",
  "legal-links": "legal_links.title",
  terms: "terms.title",
  images: "settings.images_title",
  backup: "backup.title",
};
const ADVANCED_DESC: Record<AdvancedSection, MessageKey> = {
  domain: "settings.adv_domain",
  storefront: "settings.adv_storefront",
  headless: "settings.adv_headless",
  "legal-links": "settings.adv_legal_links",
  terms: "settings.adv_terms",
  images: "settings.adv_images",
  backup: "settings.adv_backup",
};

function SettingsLayout(props: { shop: ShopRow; access: ShopAccess | undefined; section: SettingsSection; flash: ReturnType<typeof flash>; children?: unknown }) {
  const { shop, section } = props;
  const title = t(SECTION_TITLE[section]);
  const advanced = (ADVANCED as readonly string[]).includes(section);
  const here: ShopHere = section === "general" ? "settings" : section === "shipping" || section === "payments" || section === "members" ? `settings-${section}` : "settings-advanced";
  const crumbs = [
    { label: shop.name, href: settingsPath(shop.id) },
    ...(advanced ? [{ label: t("settings.tab_advanced"), href: settingsPath(shop.id, "advanced") }] : []),
    { label: title },
  ];
  return (
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={section === "general" ? [{ label: shop.name }] : crumbs} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: "settings", here }}>
      <PageHead title={title} />
      {advanced ? (
        <p>
          <a href={settingsPath(shop.id, "advanced")}>← {t("settings.back_advanced")}</a>
        </p>
      ) : null}
      {props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{props.flash.text}</p> : null}
      {props.children as never}
      <AutocheckScript />
    </AdminLayout>
  );
}

const SaveButton = (props: { label?: string }) => (
  <p>
    <button type="submit">{props.label ?? t("shop.save")}</button>
  </p>
);

/** 基本と法定表記: 名前・URL の名前・連絡先・法務の 3 つ・公開 */
function GeneralSection(props: { shop: ShopRow; publicBaseUrl: string; slugMovesDomain?: boolean }) {
  const { shop, slugMovesDomain } = props;
  const missing = missingTerms(shop.settings);
  const termLabel = { delivery: t("terms.delivery"), cancellation: t("terms.cancellation"), payment_note: t("terms.payment_note") };
  return (
    <>
      <p class="quick">
        <a class="btn secondary" href={shopHome(props.publicBaseUrl, shop)} target="_blank" rel="noopener">
          {t("shop.storefront")} ↗
        </a>
        <span class={shop.published ? "status on" : "status"} style="align-self:center">
          {shop.published ? t("dashboard.published") : t("dashboard.unpublished")}
        </span>
      </p>
      {missing.length > 0 ? (
        <p class="notice">
          {t("terms.missing").replace("{items}", missing.map((k) => termLabel[k]).join("・"))} <a href={settingsPath(shop.id, "terms")}>{t("terms.title")}</a>
        </p>
      ) : null}
      <form method="post" action={`/admin/shops/${shop.id}`} class="card">
        <label for="name">{t("shop.name")}</label>
        <input id="name" type="text" name="name" value={shop.name} required maxlength={200} />
        <label for="slug">{t("shop.slug")}</label>
        <input id="slug" type="text" name="slug" value={shop.slug} required pattern="[a-z0-9][a-z0-9-]{0,62}" />
        {slugMovesDomain ? <p class="muted">{t("shop.slug_moves_domain")}</p> : null}
        <label for="contact_email">{t("shipping.contact_email")}</label>
        <input id="contact_email" type="email" name="contact_email" value={typeof shop.settings?.["contact_email"] === "string" ? String(shop.settings["contact_email"]) : ""} />
        <p class="muted">{t("shipping.contact_email_hint")}</p>
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
        <SaveButton />
      </form>
    </>
  );
}

/** 配送と税。お届け日時の指定（同梱モジュール）はここから */
function ShippingSection(props: { shop: ShopRow; access: ShopAccess | undefined }) {
  const { shop } = props;
  const shippingCfg = parseShippingSettings((shop.settings ?? {})["shipping"]);
  const delivery = moduleEnabled(shop.settings, "delivery_time");
  return (
    <>
      <form method="post" action={`/admin/shops/${shop.id}/shipping`} class="card">
        <h2>{t("shipping.fee_title")}</h2>
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
          <AutocheckHint label={t("shipping.by_prefecture")} />
          <table {...autocheckAttrs("mode", "by_prefecture")}>
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
        <h2>{t("shipping.tax_title")}</h2>
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
        <SaveButton />
      </form>
      <section class="card">
        <h2>{t("mod.delivery_time.name")}</h2>
        <p class="muted">{t("mod.delivery_time.description")}</p>
        {delivery ? (
          <p>
            <a href={`/admin/shops/${shop.id}/modules/delivery-time`}>{t("settings.open_settings")}</a>
          </p>
        ) : can(props.access, "settings") ? (
          <p class="muted">
            {t("settings.module_off")} <a href={`/admin/shops/${shop.id}/modules`}>{t("modules.title")}</a>
          </p>
        ) : null}
      </section>
    </>
  );
}

/** 決済: Stripe の状態と、ほかの決済（プラグイン）への案内。保存する欄は無い（Stripe Connect のつなぐ・外すだけ） */
function PaymentsSection(props: { shop: ShopRow; publicBaseUrl: string; stripeConnectConfigured: boolean; stripeDirectEnabled: boolean }) {
  const { shop } = props;
  return (
    <>
      <section class="card" id="stripe">
        <h2>{t("stripe.title")}</h2>
        <p>
          {props.stripeDirectEnabled ? (
            <span class="badge ok">{t("stripe.direct_on")}</span>
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
      <section class="card">
        <h2>{t("settings.payments_others")}</h2>
        <p class="muted">
          {t("settings.payments_others_hint")} <a href={`/admin/shops/${shop.id}/plugins`}>{t("plugins.title")}</a>
        </p>
      </section>
    </>
  );
}

/** 会員とログイン: 会員機能の欄（owner / admin）と、ログインの方法（LINE・Google・パスキーは同梱モジュール） */
function MembersSection(props: { shop: ShopRow; access: ShopAccess | undefined }) {
  const { shop, access } = props;
  const s = shop.settings ?? {};
  const admin = can(access, "admin");
  const methods: { name: MessageKey; module: string; path?: string; note?: string | null }[] = [
    { name: "mod.line_login.name", module: "line_login", path: "line-login" },
    { name: "mod.google_login.name", module: "google_login", path: "google-login" },
    { name: "mod.passkey.name", module: "passkey", note: shop.domain ? null : t("settings.login_passkey_domain") },
  ];
  return (
    <>
      {admin ? (
        <form method="post" action={`/admin/shops/${shop.id}/members`} class="card" id="members">
          <label>
            <input type="checkbox" name="members_enabled" value="on" checked={s["members_enabled"] === true} /> {t("shop.members_enabled")}
          </label>
          <p class="muted">{t("shop.members_hint")}</p>
          <label>
            <input type="checkbox" name="members_password" value="on" checked={s["members_password"] === true} /> {t("shop.members_password")}
          </label>
          <p class="muted">{t("shop.members_password_hint")}</p>
          <label>
            <input type="checkbox" name="marketing_consent" value="on" checked={s["marketing_consent"] === true} /> {t("shop.marketing_consent")}
          </label>
          <p class="muted">{t("shop.marketing_consent_hint")}</p>
          <SaveButton />
        </form>
      ) : null}
      <section class="card">
        <h2>{t("settings.login_methods")}</h2>
        <table>
          <tbody>
            <tr>
              <td>{t("settings.login_email")}</td>
              <td>
                <span class="status on">{t("settings.login_always")}</span>
              </td>
              <td />
            </tr>
            {methods.map((m) => {
              const on = moduleEnabled(shop.settings, m.module);
              return (
                <tr>
                  <td>
                    {t(m.name)}
                    {m.note ? <div class="muted">{m.note}</div> : null}
                  </td>
                  <td>
                    <span class={on ? "status on" : "status"}>{on ? t("settings.login_on") : t("settings.login_off")}</span>
                  </td>
                  <td>
                    {on && m.path && can(access, "integrations") ? (
                      <a href={`/admin/shops/${shop.id}/modules/${m.path}`}>{t("settings.open_settings")}</a>
                    ) : !on && can(access, "settings") ? (
                      <a href={`/admin/shops/${shop.id}/modules`}>{t("modules.title")}</a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** 上級者向け: ふだん触らないものの一覧。触れる画面だけ出す */
function AdvancedSectionList(props: { shop: ShopRow; access: ShopAccess | undefined }) {
  const { shop } = props;
  return (
    <>
      <p class="muted">{t("settings.advanced_intro")}</p>
      <ul class="setting-list card">
        {ADVANCED.filter((s) => sectionAllowed(props.access, s)).map((s) => (
          <li>
            <a href={settingsPath(shop.id, s)}>{t(SECTION_TITLE[s])}</a>
            <span class="muted">{t(ADVANCED_DESC[s])}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function DomainSection(props: { shop: ShopRow; publicBaseUrl: string; domain: { provider: boolean; state: DomainState | null; template?: string | null } }) {
  const { shop } = props;
  return (
    <form method="post" action={`/admin/shops/${shop.id}/domain`} class="card" id="domain">
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
      <label for="domain_input">{props.domain.template ? t("domain.label_template") : t("domain.label")}</label>
      <input id="domain_input" type="text" name="domain" value={shop.domain ?? ""} placeholder={props.domain.template ?? "shop.example.jp"} maxlength={253} />
      {props.domain.template ? <p class="muted">{tf("domain.template_hint", { domain: props.domain.template })}</p> : null}
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
      <SaveButton label={t("domain.save")} />
    </form>
  );
}

function StorefrontSection(props: { shop: ShopRow }) {
  const { shop } = props;
  const sf = storefrontSettings(shop.settings);
  return (
    <form method="post" action={`/admin/shops/${shop.id}/storefront`} class="card" id="storefront">
      <p class="muted">{t("sfmode.intro")}</p>
      {(["full", "checkout", "off"] as const).map((m) => (
        <p>
          <label>
            <input type="radio" name="mode" value={m} checked={sf.mode === m} /> <strong>{t(`sfmode.mode_${m}` as MessageKey)}</strong>
            <br />
            <span class="muted">{t(`sfmode.mode_${m}_hint` as MessageKey)}</span>
          </label>
        </p>
      ))}
      <label for="site_url">{t("sfmode.site_url")}</label>
      <input id="site_url" type="url" name="site_url" value={sf.siteUrl ?? ""} placeholder="https://example.com" style="width:100%;max-width:40rem" />
      <label for="product_url">{t("sfmode.product_url")}</label>
      <input id="product_url" type="text" name="product_url" value={sf.productUrl ?? ""} placeholder="https://example.com/product/{slug}/" style="width:100%;max-width:40rem" />
      <p class="muted">{t("sfmode.urls_hint")}</p>
      <p class="muted">{t("sfmode.analytics_hint")}</p>
      <SaveButton />
    </form>
  );
}

/** ヘッドレス連携。IP ごとの上限の欄は owner / admin だけ（鍵が admin の項目、0129） */
function HeadlessSection(props: { shop: ShopRow; access: ShopAccess | undefined }) {
  const { shop } = props;
  const admin = can(props.access, "admin");
  return (
    <form method="post" action={`/admin/shops/${shop.id}/headless`} class="card" id="headless">
      <p class="muted">{t("headless.intro")}</p>
      <label for="return_origins">{t("headless.return_origins")}</label>
      <textarea id="return_origins" name="return_origins" rows={3} style="width:100%;max-width:40rem" placeholder="https://example.com">
        {returnOrigins(shop.settings).join("\n")}
      </textarea>
      <p class="muted">{t("headless.return_origins_hint")}</p>
      <label for="order_page_url">{t("headless.order_page_url")}</label>
      <input id="order_page_url" type="url" name="order_page_url" value={orderPageUrl(shop.settings) ?? ""} placeholder="https://example.com/order-status/" style="width:100%;max-width:40rem" />
      <p class="muted">{t("headless.order_page_url_hint")}</p>
      <label for="account_page_url">{t("headless.account_page_url")}</label>
      <input id="account_page_url" type="url" name="account_page_url" value={memberAccountPage(shop.settings) ?? ""} placeholder="https://example.com/my-account/" style="width:100%;max-width:40rem" />
      <p class="muted">{t("headless.account_page_url_hint")}</p>
      <label for="relay_ips">{t("headless.relay_ips")}</label>
      <textarea id="relay_ips" name="relay_ips" rows={2} style="width:100%;max-width:40rem" placeholder="203.0.113.10">
        {relayIps(shop.settings).join("\n")}
      </textarea>
      <p class="muted">{t("headless.relay_ips_hint")}</p>
      {admin ? (
        <>
          <label for="max_pending_per_ip">{t("headless.max_pending_per_ip")}</label>
          <input id="max_pending_per_ip" type="number" name="max_pending_per_ip" min={1} max={9999} value={String(shopLimit(shop.settings, "checkout", "max_pending_per_ip", 20))} />
          <label for="login_per_ip_per_hour">{t("headless.login_per_ip_per_hour")}</label>
          <input id="login_per_ip_per_hour" type="number" name="login_per_ip_per_hour" min={1} max={9999} value={String(shopLimit(shop.settings, "members_login_limits", "per_ip_per_hour", 30))} />
          <label for="order_lookup_per_ip_per_hour">{t("headless.order_lookup_per_ip_per_hour")}</label>
          <input id="order_lookup_per_ip_per_hour" type="number" name="order_lookup_per_ip_per_hour" min={1} max={9999} value={String(shopLimit(shop.settings, "order_lookup", "per_ip_per_hour", 20))} />
          <p class="muted">{t("headless.limits_hint")}</p>
        </>
      ) : null}
      <SaveButton />
    </form>
  );
}

function TermsSection(props: { shop: ShopRow }) {
  const { shop } = props;
  const terms = checkoutTerms(shop.settings);
  return (
    <form method="post" action={`/admin/shops/${shop.id}/terms`} class="card" id="terms">
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
      <SaveButton />
    </form>
  );
}

function ImagesSection(props: { shop: ShopRow; imageConverter: boolean | null }) {
  const { shop } = props;
  return (
    <form method="post" action={`/admin/shops/${shop.id}/images`} class="card" id="images">
      <label for="image_max">{t("shop.image_max")}</label>
      <select id="image_max" name="image_max">
        {IMAGE_MAX_CHOICES.map((n) => (
          <option value={String(n)} selected={imageMaxWidth(shop.settings) === n}>
            {tf("shop.image_max_option", { n })}
          </option>
        ))}
      </select>
      <p class="muted">{t("shop.image_max_hint")}</p>
      <label for="image_processing">{t("shop.image_processing")}</label>
      <select id="image_processing" name="image_processing">
        <option value="browser" selected={imageProcessing(shop.settings) === "browser"}>
          {t("shop.image_processing_browser")}
        </option>
        <option value="plugin" selected={imageProcessing(shop.settings) === "plugin"}>
          {t("shop.image_processing_plugin")}
        </option>
      </select>
      <p class="muted">{t("shop.image_processing_hint")}</p>
      {imageProcessing(shop.settings) === "plugin" && props.imageConverter === false ? <p class="error">{t("shop.image_processing_no_plugin")}</p> : null}
      <SaveButton />
    </form>
  );
}

function BackupSection(props: { shop: ShopRow }) {
  const { shop } = props;
  return (
    <section class="card" id="backup">
      <p>{t("backup.hint")}</p>
      <p>
        <a href={`/admin/shops/${shop.id}/export.json`} download>
          {t("backup.download")}
        </a>{" "}
        ・ <a href={`/admin/shops/${shop.id}/orders.csv`}>{t("order.csv")}</a>
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
  );
}

/** 商品・会員の独自項目の定義の画面（商品・会員の中。メンテナの決定 2026-11-08「独自項目は書式の文字の欄ではなく表で決める」） */
const BLANK_FIELD_ROWS = 3;
/** スクリプトがあれば「項目を足す」で空の行を足す（無くても空の行 3 つで足せる）。行の番号は f_n で数える */
const FIELDS_ADD_SCRIPT = `(function(){
  var f=document.getElementById("fields-form");if(!f)return;
  var b=f.querySelector("[data-add-row]"),tb=f.querySelector("tbody"),n=f.querySelector("input[name=f_n]");if(!b||!tb||!n)return;
  b.hidden=false;
  b.addEventListener("click",function(){var last=tb.querySelector("tr[data-blank]:last-of-type");if(!last)return;var i=Number(n.value);var r=last.cloneNode(true);
    r.querySelectorAll("[name]").forEach(function(el){el.name=el.name.replace(/_\\d+$/,"_"+i);if(el.id)el.id=el.id.replace(/_\\d+$/,"_"+i);if(el.type==="checkbox")el.checked=false;else if(el.tagName!=="SELECT")el.value="";else el.selectedIndex=0;});
    r.querySelectorAll("label[for]").forEach(function(l){l.htmlFor=l.htmlFor.replace(/_\\d+$/,"_"+i);});
    tb.appendChild(r);n.value=String(i+1);var k=r.querySelector("input[type=text]");if(k)k.focus();});
})();`;
const FIELD_TYPE_LABEL: Record<FieldType, MessageKey> = { text: "fields.type_text", textarea: "fields.type_textarea", number: "fields.type_number", url: "fields.type_url", select: "fields.type_select", image: "fields.type_image" };
const FIELD_VIS_LABEL: Record<FieldVisibility, MessageKey> = { public: "fields.vis_public", card: "fields.vis_card", private: "fields.vis_private" };

function FieldsPage(props: { shop: ShopRow; access: ShopAccess | undefined; kind: "product" | "customer"; flash: ReturnType<typeof flash> }) {
  const { shop } = props;
  const product = props.kind === "product";
  const title = t(product ? "fields.title" : "customer_fields.title");
  const fields = product ? productFields(shop.settings) : customerFields(shop.settings);
  // 会員の項目に画像は使わない（src/customers/fields.ts）
  const types = FIELD_TYPES.filter((ty) => product || ty !== "image");
  const rows: (ProductField | null)[] = [...fields, ...Array.from({ length: BLANK_FIELD_ROWS }, () => null)];
  return (
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={[{ label: shop.name, href: settingsPath(shop.id) }, { label: title }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: product ? "products" : "customers", here: product ? "product-fields" : "customer-fields" }}>
      <PageHead title={title} sub={t(product ? "fields.intro" : "customer_fields.intro")} />
      {props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{props.flash.text}</p> : null}
      <form method="post" action={`/admin/shops/${shop.id}/${product ? "fields" : "customer-fields"}`} class="card" id="fields-form">
        <input type="hidden" name="f_n" value={String(rows.length)} />
        <div class="table-scroll">
          <table class="fields-table">
            <thead>
              <tr>
                <th>{t("fields.col_label")}</th>
                <th>{t("fields.col_key")}</th>
                <th>{t("fields.col_type")}</th>
                <th>{t("fields.col_options")}</th>
                {product ? <th>{t("fields.col_visibility")}</th> : null}
                <th>{t("fields.col_delete")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => (
                <tr data-blank={f ? undefined : ""}>
                  <td>
                    <input type="text" name={`f_label_${i}`} value={f?.label ?? ""} maxlength={60} aria-label={t("fields.col_label")} />
                  </td>
                  <td>
                    {f ? (
                      <>
                        <code>{f.key}</code>
                        <input type="hidden" name={`f_orig_${i}`} value={f.key} />
                      </>
                    ) : (
                      <input type="text" name={`f_key_${i}`} maxlength={40} pattern="[a-z][a-z0-9_]{0,39}" placeholder="material" aria-label={t("fields.col_key")} />
                    )}
                  </td>
                  <td>
                    <select name={`f_type_${i}`} aria-label={t("fields.col_type")}>
                      {types.map((ty) => (
                        <option value={ty} selected={(f?.type ?? "text") === ty}>
                          {t(FIELD_TYPE_LABEL[ty])}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="text" name={`f_options_${i}`} value={optionsText(f?.options)} placeholder={t("fields.options_placeholder")} aria-label={t("fields.col_options")} />
                    {f?.options?.length ? <input type="hidden" name={`f_options_orig_${i}`} value={JSON.stringify(f.options)} /> : null}
                    {optionsHaveSeparator(f?.options) ? <p class="muted">{t("fields.options_has_separator")}</p> : null}
                  </td>
                  {product ? (
                    <td>
                      <select name={`f_vis_${i}`} aria-label={t("fields.col_visibility")}>
                        {(["public", "card", "private"] as const).map((v) => (
                          <option value={v} selected={(f ? fieldVisibility(f) : "public") === v}>
                            {t(FIELD_VIS_LABEL[v])}
                          </option>
                        ))}
                      </select>
                    </td>
                  ) : null}
                  <td>
                    {f ? (
                      <label>
                        <input type="checkbox" name={`f_del_${i}`} value="on" aria-label={tf("fields.delete_label", { label: f.label })} />
                      </label>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <button type="button" class="secondary" data-add-row hidden>
            {t("fields.add_row")}
          </button>
        </p>
        <p class="muted">{t(product ? "fields.hint" : "customer_fields.hint")}</p>
        <SaveButton />
      </form>
      <script dangerouslySetInnerHTML={{ __html: FIELDS_ADD_SCRIPT }} />
    </AdminLayout>
  );
}

/** 設定の画面を出す（GET）。触れない画面は 404 */
async function settingsPage(c: AdminContext, section: SettingsSection) {
  const shop = await loadShop(c, param(c, "shopId"), "any");
  const access = c.get("shopAccess");
  if (!shop) return c.text(t("shop.not_found"), 404);
  if (!sectionAllowed(access, section)) {
    // 基本の画面: ショップの設定の項目が無いメンバーには、触れる画面へのメニューだけ出す
    if (section !== "general") return c.text(t("shop.not_found"), 404);
    return c.html(
      <AdminLayout title={shop.name} nav crumbs={[{ label: shop.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access, active: "settings" }}>
        <PageHead title={shop.name} sub={t("access.nav_only")} />
        <ShopNav shop={shop} access={access} publicBaseUrl={publicBaseUrl(c)} />
      </AdminLayout>,
    );
  }
  const base = publicBaseUrl(c);
  const fl = flash(c.req.query("flash"), c.req.query("detail"));
  let body: unknown;
  switch (section) {
    case "general":
      body = <GeneralSection shop={shop} publicBaseUrl={base} slugMovesDomain={isTemplateDomain(domainTemplateFrom(c.get("adapters").config), shop)} />;
      break;
    case "shipping":
      body = <ShippingSection shop={shop} access={access} />;
      break;
    case "payments": {
      const cfg = c.get("adapters").config;
      const stripeKeySet = Boolean(cfg.get("STRIPE_SECRET_KEY") && cfg.get("STRIPE_WEBHOOK_SECRET"));
      const direct = await owner(c).db.from<{ id: string; enabled: boolean }>("hook_endpoints").selectOne("id,enabled", { eq: { shop_id: shop.id, url: bundledPluginUrl("stripe") } });
      body = <PaymentsSection shop={shop} publicBaseUrl={base} stripeConnectConfigured={Boolean(cfg.get("STRIPE_SECRET_KEY") && cfg.get("STRIPE_CLIENT_ID"))} stripeDirectEnabled={Boolean(direct?.enabled) && stripeKeySet} />;
      break;
    }
    case "members":
      body = <MembersSection shop={shop} access={access} />;
      break;
    case "advanced":
      body = <AdvancedSectionList shop={shop} access={access} />;
      break;
    case "domain": {
      // 独自ドメインの提供元（ホスティングの提供者）。状態は提供元に 1 回だけ聞く。失敗しても画面は出す
      const provider = c.get("adapters").domain;
      // サブドメインモードのひな形のドメインは提供元に登録しないので、状態も聞かない
      const tpl = domainTemplateFrom(c.get("adapters").config);
      const fromTemplate = isTemplateDomain(tpl, shop);
      const state = provider && shop.domain && !fromTemplate ? await provider.status(shop.domain, { id: shop.id, slug: shop.slug }).catch(() => null) : null;
      const templated = shopTemplateDomain(c, shop.slug);
      body = <DomainSection shop={shop} publicBaseUrl={base} domain={{ provider: Boolean(provider), state, template: typeof templated === "string" && templated !== "invalid" ? templated : null }} />;
      break;
    }
    case "storefront":
      body = <StorefrontSection shop={shop} />;
      break;
    case "headless":
      body = <HeadlessSection shop={shop} access={access} />;
      break;
    case "legal-links":
      body = <LegalLinksSection shop={shop} />;
      break;
    case "terms":
      body = <TermsSection shop={shop} />;
      break;
    case "images": {
      // 画像の変換を外部プラグインに任せる設定（0092）。任せているのに、画像を変換できるプラグイン（マニフェストの capabilities に images）がつながっていなければ知らせる。
      // 連携の一覧を読めない人（integrations の項目が無い）には判定しない（null）
      const imageConverter = imageProcessing(shop.settings) === "plugin" && can(access, "integrations") ? await imageConverterConnected(c, shop.id) : null;
      body = <ImagesSection shop={shop} imageConverter={imageConverter} />;
      break;
    }
    case "backup":
      body = <BackupSection shop={shop} />;
      break;
  }
  return c.html(
    <SettingsLayout shop={shop} access={access} section={section} flash={fl}>
      {body}
    </SettingsLayout>,
  );
}

shops.get("/:shopId", requireOwner, (c: AdminContext) => settingsPage(c, "general"));
shops.get("/:shopId/settings/:section", requireOwner, async (c: AdminContext) => {
  const section = c.req.param("section") ?? "";
  if (!SECTIONS.includes(section)) return c.text(t("shop.not_found"), 404);
  return settingsPage(c, section as SettingsSection);
});
shops.get("/:shopId/fields", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  // 定義は shops の行に置くので、settings の項目も要る（RLS、0024）
  if (!shop || !can(c.get("shopAccess"), "settings")) return c.text(t("shop.not_found"), 404);
  return c.html(<FieldsPage shop={shop} access={c.get("shopAccess")} kind="product" flash={flash(c.req.query("flash"))} />);
});
shops.get("/:shopId/customer-fields", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "customers");
  // 定義は shops の行に置くので、settings の項目も要る（RLS、0024）
  if (!shop || !can(c.get("shopAccess"), "settings")) return c.text(t("shop.not_found"), 404);
  return c.html(<FieldsPage shop={shop} access={c.get("shopAccess")} kind="customer" flash={flash(c.req.query("flash"))} />);
});

/**
 * 画像を変換できるプラグイン（capabilities に images）がつながっているか。
 * 見つからなければ、知らせる前に有効な外部の連携のマニフェストを取り直してから判定し直す（プラグインを上げても、Banto が前のマニフェストを
 * 覚えたままのことがあるため。取り直すのはこの「知らせそうなとき」だけで、数件・短い待ち時間。ふだんの取り直しは Cron、0096）
 */
const MANIFEST_RECHECK_MAX = 5;
const MANIFEST_RECHECK_TIMEOUT_MS = 3000;
async function imageConverterConnected(c: AdminContext, shopId: string): Promise<boolean> {
  const { db } = owner(c);
  const rows = await db.from<{ id: string; url: string; enabled: boolean; manifest: unknown }>("hook_endpoints").select("id,url,enabled,manifest", { eq: { shop_id: shopId } });
  if (rows.some((e) => e.enabled && hasImageCapability(e.manifest))) return true;
  const external = rows.filter((e) => e.enabled && bundledPluginIdFromUrl(e.url) === null).slice(0, MANIFEST_RECHECK_MAX);
  if (external.length === 0) return false;
  const doFetch = c.get("adapters").publicFetch ?? c.get("deps").fetch;
  const fresh = await Promise.all(external.map((e) => fetchManifest(e.url, doFetch, MANIFEST_RECHECK_TIMEOUT_MS)));
  let found = false;
  await Promise.all(
    external.map(async (e, i) => {
      const m = fresh[i];
      if (!m) return;
      if (hasImageCapability(m)) found = true;
      if (JSON.stringify(m) === JSON.stringify(e.manifest)) return;
      // URL が変わっていたら書かない（連携の画面で同時に直された場合）
      await db.from("hook_endpoints").update({ manifest: m }, { id: e.id, shop_id: shopId, url: e.url }).catch((err: unknown) => console.error("[banto] manifest recheck:", err));
    }),
  );
  return found;
}

shops.post("/:shopId", requireOwner, async (c: AdminContext) => {
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
  // サブドメインモード: ひな形どおりのドメインは、スラッグと一緒に付け替える（パスキーと LINE / Google の戻り先は登録し直し。画面で知らせている）
  if (values.slug !== shop.slug && isTemplateDomain(domainTemplateFrom(c.get("adapters").config), shop)) {
    const next = shopTemplateDomain(c, values.slug!);
    if (next === "invalid" || next === null) return c.redirect(`/admin/shops/${shopId}?flash=slug_domain_invalid`);
    values.domain = next;
  }
  // お客様からの連絡先（注文メールの返信先・特商法の表記）。欄が無いフォームからは変えない
  if (f.contact_email !== undefined) {
    const contact = f.contact_email.trim();
    values.settings = { ...(shop.settings ?? {}), contact_email: contact && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) ? contact : null };
  }
  try {
    await updateShop(c, shopId, values);
  } catch (e) {
    if (e instanceof DbError && /shops_publish_requires_legal/.test(e.message)) {
      return c.redirect(`/admin/shops/${shopId}?flash=publish_blocked`);
    }
    if (e instanceof DbError && values.domain && /shops_domain_key/.test(e.message)) return c.redirect(`/admin/shops/${shopId}?flash=slug_domain_taken`);
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}?flash=saved`);
});

/** 配送と税（shops.settings に保存） */
shops.post("/:shopId/shipping", requireOwner, async (c: AdminContext) => {
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
  const settings = {
    ...(shop.settings ?? {}),
    shipping,
    tax_rate: rate !== null && rate < 100 ? rate : 10,
    tax_rate_reduced: reduced !== null && reduced < 100 ? reduced : 8,
    tax_rounding: taxRoundingOf(f.tax_rounding),
  };
  try {
    await updateShop(c, shopId, { settings });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "shipping")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "shipping")}?flash=shipping_saved`);
});

/** 会員機能・パスワード・案内メールの同意の欄（鍵は owner / admin の項目、0129） */
shops.post("/:shopId/members", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const settings = {
    ...(shop.settings ?? {}),
    members_enabled: f.members_enabled === "on",
    members_password: f.members_password === "on",
    marketing_consent: f.marketing_consent === "on",
  };
  try {
    await updateShop(c, shopId, { settings });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "members")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "members")}?flash=saved`);
});

/** 商品画像の本画像の横幅と、変換をだれがするか（これから上げる画像から。src/media/variants.ts、0091・0092） */
shops.post("/:shopId/images", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const current = shop.settings ?? {};
  const images = {
    ...(isRecord(current["images"]) ? current["images"] : {}),
    max_width: imageMaxWidth({ images: { max_width: Number(f.image_max) } }),
    // 欄が無い（0092 の前）ときは前の値のまま
    ...(f.image_processing !== undefined ? { processing: f.image_processing === "plugin" ? "plugin" : "browser" } : {}),
  };
  try {
    await updateShop(c, shopId, { settings: { ...current, images } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "images")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "images")}?flash=saved`);
});

/** 購入前の確認画面に出す内容（shops.settings.checkout_terms。src/commerce/checkout.ts が読む） */
shops.post("/:shopId/terms", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const clean = (v: string | undefined) => (v ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
  const checkout_terms = { delivery: clean(f.delivery), cancellation: clean(f.cancellation), payment_note: clean(f.payment_note) };
  try {
    await updateShop(c, shopId, { settings: { ...(shop.settings ?? {}), checkout_terms } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "terms")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "terms")}?flash=terms_saved`);
});

/** カスタム項目の定義（shops.settings.product_fields。値は products.attributes。src/products/fields.ts） */
shops.post("/:shopId/fields", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { rows, invalid } = fieldRowsFromForm(await formFields(c));
  if (invalid.length) return c.redirect(`/admin/shops/${shopId}/fields?flash=fields_invalid&detail=${encodeURIComponent(invalid.join(", "))}`);
  const product_fields = productFields({ product_fields: rows });
  try {
    await updateShop(c, shopId, { settings: { ...(shop.settings ?? {}), product_fields } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/fields?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}/fields?flash=fields_saved`);
});

/**
 * 会員の項目の定義（shops.settings.customer_fields。値は customers.attributes。src/customers/fields.ts、0047）。
 * 値は外部の顧客マスタが AI 用トークンの API で写す（向きは外部 → Banto）。定義に無い鍵は SQL が受け付けない
 */
shops.post("/:shopId/customer-fields", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "customers");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { rows, invalid } = fieldRowsFromForm(await formFields(c));
  if (invalid.length) return c.redirect(`/admin/shops/${shopId}/customer-fields?flash=fields_invalid&detail=${encodeURIComponent(invalid.join(", "))}`);
  const customer_fields = customerFields({ customer_fields: rows });
  try {
    await updateShop(c, shopId, { settings: { ...(shop.settings ?? {}), customer_fields } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/customer-fields?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}/customer-fields?flash=customer_fields_saved`);
});

/**
 * 独自ドメイン（0015_shop_domain、docs/custom-domain.md）。空にすると外す。
 * Banto 自身のホスト名は付けられない（管理画面や他のショップまでそのショップになってしまうため）。
 */
shops.post("/:shopId/domain", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  // サブドメインモード: 空にするとひな形のドメイン（既定のアドレス）に戻す。ほかのスラッグのひな形のドメインは付けさせない
  const tpl = domainTemplateFrom(c.get("adapters").config);
  const templated = shopTemplateDomain(c, shop.slug);
  const entered = normalizeDomain(f.domain ?? "");
  const domain = entered === null && typeof templated === "string" && templated !== "invalid" ? templated : entered;
  if (entered === null && templated === "invalid") return c.redirect(`${settingsPath(shopId, "domain")}?flash=slug_domain_invalid`);
  const own = [new URL(c.req.url).hostname, new URL(publicBaseUrl(c)).hostname];
  if (domain === "invalid" || (domain && (own.includes(domain) || domain.endsWith(".workers.dev")))) return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_invalid`);
  if (domain && tpl && templateSlug(tpl, domain) !== null && templateSlug(tpl, domain) !== shop.slug) return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_invalid`);
  // ひな形のドメインは提供元（DomainAdapter）に登録しない（デプロイのワイルドカードの DNS で届く）
  const isTpl = (d: string | null) => Boolean(d && tpl && d === templated);
  // 独自ドメインを使うなら Banto 自身の URL（PUBLIC_BASE_URL）が要る。無いと、ショップのドメインで開いたときに Banto の URL が決まらず、
  // 管理画面への転送・サイトマップ・会員ページの戻り先が開いた Host で揺れる（docs/custom-domain.md §1）
  if (domain && !c.get("adapters").config.get("PUBLIC_BASE_URL")) return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_needs_base_url`);
  // 独自ドメインの提供元（DomainAdapter）。付ける前に所有の確認と登録を頼み、断られたら保存しない。
  // 無ければ今までどおり（運営者が Cloudflare で Worker に付けてから保存する。docs/custom-domain.md §6）
  const provider = c.get("adapters").domain;
  const ref = { id: shop.id, slug: shop.slug };
  const previous = shop.domain ?? null;
  if (provider && domain && domain !== previous && !isTpl(domain)) {
    const r: DomainAttachResult = await provider.attach(domain, ref).catch(() => ({ ok: false, reason: "unavailable" }));
    if (!r.ok) {
      const detail = r.message ? `&detail=${encodeURIComponent(r.message.slice(0, 200))}` : "";
      return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_${r.reason}${detail}`);
    }
  }
  try {
    await updateShop(c, shopId, { domain });
  } catch (e) {
    // 提供元には登録したのに Banto 側で保存できなかった → 提供元の登録を戻す（失敗しても画面の結果は変えない）
    if (provider && domain && domain !== previous && !isTpl(domain)) await provider.detach(domain, ref).catch(() => undefined);
    if (e instanceof DbError && (e.code === "23505" || /shops_domain_key/.test(e.message))) return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_taken`);
    if (e instanceof DbError && (e.code === "23514" || /shops_domain_format/.test(e.message))) return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_invalid`);
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "domain")}?flash=${failCode(e)}`);
    throw e;
  }
  // 外した・変えた: 前のドメインの登録を提供元から消す（失敗しても Banto 側の設定は戻さない）
  if (provider && previous && previous !== domain && !isTpl(previous)) await provider.detach(previous, ref).catch(() => undefined);
  return c.redirect(`${settingsPath(shopId, "domain")}?flash=domain_saved`);
});

/** お店の画面の使い方（shops.settings.storefront、0041。src/storefront/mode.ts）。分析（GA4）は同梱モジュール ga4 の画面で */
shops.post("/:shopId/storefront", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const mode = (STOREFRONT_MODES as readonly string[]).includes(f.mode ?? "") ? f.mode! : "full";
  const site = (f.site_url ?? "").trim();
  const product = (f.product_url ?? "").trim();
  // https の URL だけ（転送先に javascript: や http を入れさせない）。商品ページは {slug} が要る
  const siteUrl = site ? safeHttpsUrl(site) : null;
  const productUrl = product ? safeHttpsUrl(product, { template: true }) : null;
  if ((site && !siteUrl) || (product && !productUrl)) return c.redirect(`${settingsPath(shopId, "storefront")}?flash=storefront_invalid`);
  const current = shop.settings ?? {};
  const settings: Record<string, unknown> = { ...current, storefront: { mode, site_url: siteUrl, product_url: productUrl } };
  try {
    await updateShop(c, shopId, { settings });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "storefront")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "storefront")}?flash=storefront_saved`);
});

/** ヘッドレス連携（shops.settings.headless）。決済後の戻り先として許可するオリジン、信頼する中継元の IP、IP ごとの上限（0033） */
shops.post("/:shopId/headless", requireOwner, async (c: AdminContext) => {
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
      if (f[key] !== undefined) return c.redirect(`${settingsPath(shopId, "headless")}?flash=${flashCode}`);
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
    await updateShop(c, shopId, { settings });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "headless")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "headless")}?flash=headless_saved`);
});

/** 外の URL を確かめて結果を書く（保存と「今すぐ確かめる」。管理画面の操作なので、その場で取りに行く） */
async function recordLegalLinks(c: AdminContext, shop: ShopRow, urls: Partial<Record<LegalKind, string>>): Promise<void> {
  const shopId = shop.id;
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
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const current = shop.settings ?? {};
  const origins = returnOrigins(current);
  const urls: Partial<Record<LegalKind, string>> = {};
  for (const k of LEGAL_KINDS) {
    const r = parseLegalUrl(f[`url_${k}`] ?? "", origins);
    if (!r.ok) return c.redirect(`${settingsPath(shopId, "legal-links")}?flash=legal_links_invalid&detail=${encodeURIComponent(t(LEGAL_LABEL[k]))}`);
    if (r.url) urls[k] = r.url;
  }
  const hours = Number(f.check_hours);
  const headless = { ...((current.headless ?? {}) as Record<string, unknown>), legal_links: { ...urls, check_hours: (LEGAL_CHECK_HOURS as readonly number[]).includes(hours) ? hours : 24 } };
  try {
    await updateShop(c, shopId, { settings: { ...current, headless } });
    await recordLegalLinks(c, shop, urls);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "legal-links")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "legal-links")}?flash=legal_links_saved`);
});

shops.post("/:shopId/legal-links/check", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  try {
    await recordLegalLinks(c, shop, legalLinksOf(shop.settings).urls);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${settingsPath(shopId, "legal-links")}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${settingsPath(shopId, "legal-links")}?flash=legal_links_checked`);
});

/** テーマ設定（既定テーマが解釈する。独自テーマは好きなキーを使ってよい） */
shops.post("/:shopId/theme", requireOwner, async (c: AdminContext) => {
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
    await updateShop(c, shopId, { settings: { ...(shop.settings ?? {}), theme_settings } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/design?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}/design?flash=theme_saved`);
});
