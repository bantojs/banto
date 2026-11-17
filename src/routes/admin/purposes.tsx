import type { ApiScope } from "../../api/tokens";
import { HOOK_EVENTS, type HookEvent } from "../../hooks/events";
import { t, type MessageKey } from "../../i18n";

/**
 * 外部サービスと連携の画面で、スコープ（AI 用トークン・つなぐ）と出来事（知らせる先）を「目的の言葉」でまとめて見せる部品
 * （メンテナの決定 2026-11-08「入口は目的の言葉」）。スコープ名・出来事の名前は小さく添えるだけ。
 * 判定（だれが何を許せるか）は今までどおり DB（banto_scope_perm・app_connect_begin）。ここは見せ方だけ
 */

export const SCOPE_LABEL: Record<ApiScope, MessageKey> = {
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
  "theme:write": "tokens.scope.theme_write",
  "theme:publish": "tokens.scope.theme_publish",
  "content:read": "tokens.scope.content_read",
  "content:write": "tokens.scope.content_write",
  "app_data:write": "tokens.scope.app_data_write",
  "line:send": "tokens.scope.line_send",
  "dialogs:write": "tokens.scope.dialogs_write",
  "stores:write": "tokens.scope.stores_write",
};

/** 目的ごとのまとまり（どのスコープもちょうど 1 つに入る。test/admin-purposes.test.ts） */
export const SCOPE_GROUPS: { label: MessageKey; scopes: ApiScope[] }[] = [
  { label: "purpose.products", scopes: ["products:read", "products:write", "app_data:write"] },
  { label: "purpose.orders", scopes: ["orders:read", "orders:write", "orders:pii"] },
  { label: "purpose.customers", scopes: ["customers:read", "customers:write"] },
  { label: "purpose.marketing", scopes: ["coupons:read", "coupons:write", "line:send", "dialogs:write"] },
  { label: "purpose.support", scopes: ["inquiries:read", "inquiries:write"] },
  { label: "purpose.content", scopes: ["content:read", "content:write", "theme:write", "theme:publish"] },
  { label: "purpose.shop", scopes: ["shop:read", "shop:write", "stats:read", "stores:write"] },
];

/** 購入者・会員の個人情報に触れるスコープ（印を付ける） */
export const PII_SCOPES: readonly ApiScope[] = ["orders:pii", "customers:read", "customers:write"];

/** AI 用トークンの目的のひな形（そこから細かく直せる）。custom は今までの既定（読み取りだけ・個人情報なし） */
export const TOKEN_PRESETS = {
  catalog: ["products:read", "products:write"],
  orders: ["orders:read", "products:read"],
  theme: ["theme:write", "theme:publish"],
} as const satisfies Record<string, readonly ApiScope[]>;
export type TokenPreset = keyof typeof TOKEN_PRESETS;
export const isTokenPreset = (v: string | undefined): v is TokenPreset => v === "catalog" || v === "orders" || v === "theme";

/**
 * スコープを目的ごとに選ぶ欄。available に無いスコープ（当てる前のもの・マニフェストが求めていないもの）は出さない。
 * 許せないもの（自分の項目に無い）は選べなくして理由を出す
 */
export function ScopePicker(props: { available: readonly ApiScope[]; checked: (sc: ApiScope) => boolean; grantable: (sc: ApiScope) => boolean; reason: (sc: ApiScope) => string }) {
  return (
    <div class="purpose-groups">
      {SCOPE_GROUPS.map((g) => {
        const scopes = g.scopes.filter((sc) => props.available.includes(sc));
        if (scopes.length === 0) return null;
        return (
          <fieldset class="purpose-group">
            <legend>{t(g.label)}</legend>
            {scopes.map((sc) => {
              const ok = props.grantable(sc);
              return (
                <label class="purpose-line">
                  <input type="checkbox" name="scopes" value={sc} checked={ok && props.checked(sc)} disabled={!ok} />{" "}
                  <span>
                    {t(SCOPE_LABEL[sc])} <code>{sc}</code>
                    {PII_SCOPES.includes(sc) ? <span class="badge warn">{t("purpose.pii")}</span> : null}
                    {ok ? null : <span class="lockline">{props.reason(sc)}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}

/** 許したスコープを目的の言葉で並べる（つないだ連携の詳細） */
export function ScopeList(props: { scopes: readonly string[] }) {
  const known = SCOPE_GROUPS.flatMap((g) => g.scopes).filter((sc) => props.scopes.includes(sc));
  if (known.length === 0) return <p class="muted">{t("connect.no_scopes")}</p>;
  return (
    <ul class="plainlist">
      {known.map((sc) => (
        <li>
          <strong>{t(SCOPE_LABEL[sc])}</strong> <code>{sc}</code>
          {PII_SCOPES.includes(sc) ? <span class="badge warn">{t("purpose.pii")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** 出来事のまとまり（どの出来事もちょうど 1 つに入る） */
export const EVENT_GROUPS: { label: MessageKey; events: HookEvent[] }[] = [
  { label: "purpose.orders", events: ["order.created", "order.paid", "order.shipped", "order.cancelled", "checkout.abandoned"] },
  { label: "purpose.customers", events: ["customer.created", "customer.updated", "customer.deleted"] },
  { label: "purpose.products_stock", events: ["product.updated", "inventory.low"] },
  { label: "purpose.modules", events: ["tryon.requested", "tryon.updated", "inquiry.created", "inquiry.updated", "favorite.added", "favorite.removed"] },
];

export const eventLabel = (ev: HookEvent): string => t(`event.${ev.replace(".", "_")}` as MessageKey);

/** 知らせる出来事を、まとまりごとに選ぶ欄 */
export function EventPicker(props: { checked: (ev: HookEvent) => boolean }) {
  return (
    <div class="purpose-groups">
      {EVENT_GROUPS.map((g) => (
        <fieldset class="purpose-group">
          <legend>{t(g.label)}</legend>
          {g.events.map((ev) => (
            <label class="purpose-line">
              <input type="checkbox" name="events" value={ev} checked={props.checked(ev)} />{" "}
              <span>
                {eventLabel(ev)} <code>{ev}</code>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

/** 出来事を言葉で並べる（チップ） */
export function EventChips(props: { events: readonly string[] }) {
  const known = HOOK_EVENTS.filter((ev) => props.events.includes(ev));
  if (known.length === 0) return <p class="muted">{t("hooks.no_events")}</p>;
  return (
    <p class="chips">
      {known.map((ev) => (
        <span class="chip" title={ev}>
          {eventLabel(ev)}
        </span>
      ))}
    </p>
  );
}
