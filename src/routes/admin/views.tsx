import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { t } from "../../i18n";
import { requireOwner } from "./auth";
import { formFields, owner, param, type AdminContext } from "./context";
import { searchHref, type SearchParams } from "./search";
import { loadShop } from "./shops";
import type { ShopPerm } from "./access";

/**
 * 一覧のビュー（よく使う条件に名前を付けて保存。メンテナの決定 2026-11-08、0135）。
 * ショップのメンバーで共有し、その画面の項目を持つ人が保存・削除する。書くのは DB の views_add / views_remove だけ（settings の項目が無い人でも
 * 書けるように。並びは DB の中で今の値を読み直して直すので、同時に保存しても片方が消えない）。
 * ビューは条件の URL の値をそのまま持つ。開くと、その条件の一覧の URL になる（スクリプト無しで動く）
 */
export type ViewScreen = "orders" | "customers" | "products" | "inquiries";
export const VIEWS_MIGRATION = "0135_admin_views";
const SCREEN_PERM: Record<ViewScreen, ShopPerm> = { orders: "orders", customers: "customers", products: "catalog", inquiries: "support" };
const MAX_VIEWS = 20;

export interface SavedView {
  name: string;
  query: SearchParams;
}

/** 一覧の URL（ビューの保存のあとに戻る先。URL を送らせず、画面の種類から決める） */
export const listPath = (shopId: string, screen: ViewScreen): string =>
  `/admin/shops/${shopId}/${screen === "inquiries" ? "modules/inquiries" : screen}`;

/** 保存してあるビュー（形の違うものは飛ばす） */
export function viewsOf(settings: Record<string, unknown> | null | undefined, screen: ViewScreen): SavedView[] {
  const raw = (settings ?? {})[`views_${screen}`];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v): SavedView[] => {
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (typeof o["name"] !== "string" || !o["query"] || typeof o["query"] !== "object") return [];
    const query = Object.fromEntries(Object.entries(o["query"] as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
    return [{ name: o["name"], query }];
  });
}

const sameQuery = (a: SearchParams, b: SearchParams): boolean => {
  const norm = (x: SearchParams) => JSON.stringify(Object.entries(x).filter(([, v]) => v !== "").sort(([p], [q]) => (p < q ? -1 : 1)));
  return norm(a) === norm(b);
};

/**
 * 一覧の上のビューのタブ（「すべて」と保存したビュー）と、今の条件をビューに保存する欄・ビューを消す欄。
 * enabled = 0135 が当たっている。保存・削除の欄は、その画面の項目を持つ人（= 一覧を開けている人）に出す
 */
export function ViewTabs(props: { shopId: string; screen: ViewScreen; views: SavedView[]; current: SearchParams; enabled: boolean; error?: string | undefined }) {
  if (!props.enabled) return null;
  const base = listPath(props.shopId, props.screen);
  const hasConditions = Object.values(props.current).some((v) => v !== "");
  const active = props.views.findIndex((v) => sameQuery(v.query, props.current));
  const action = `/admin/shops/${props.shopId}/views/${props.screen}`;
  return (
    <div class="views">
      <nav class="viewtabs" aria-label={t("views.title")}>
        <a href={base} aria-current={!hasConditions ? "page" : undefined}>
          {t("views.all")}
        </a>
        {props.views.map((v, i) => (
          <a href={searchHref(base, v.query)} aria-current={i === active ? "page" : undefined}>
            {v.name}
          </a>
        ))}
      </nav>
      {props.error ? <p class="error">{t(props.error === "full" ? "views.full" : props.error === "too_large" ? "views.too_large" : "views.invalid")}</p> : null}
      {hasConditions && active < 0 && props.views.length < MAX_VIEWS ? (
        <details class="view-save">
          <summary>{t("views.save")}</summary>
          <form method="post" action={action}>
            <input type="hidden" name="query" value={JSON.stringify(Object.fromEntries(Object.entries(props.current).filter(([, v]) => v !== "")))} />
            <label>
              {t("views.name")}
              <input type="text" name="name" required maxlength={40} />
            </label>
            <button type="submit" class="secondary small">
              {t("views.save_submit")}
            </button>
            <p class="muted">{t("views.shared_hint")}</p>
          </form>
        </details>
      ) : null}
      {active >= 0 ? (
        <form method="post" action={`${action}/delete`} class="view-delete" onsubmit={`return confirm(${JSON.stringify(t("views.delete_confirm"))})`}>
          <input type="hidden" name="name" value={props.views[active]!.name} />
          <button type="submit" class="secondary small">
            {t("views.delete")}
          </button>
        </form>
      ) : null}
    </div>
  );
}

export const views = new Hono<AppEnv>();

const readScreen = (v: string): ViewScreen | null => (v === "orders" || v === "customers" || v === "products" || v === "inquiries" ? v : null);

/** DB の断りの理由 → 画面の知らせ */
const viewError = (e: DbError): string => (/views_full/.test(e.message) ? "full" : /views_too_large/.test(e.message) ? "too_large" : "invalid");
const withError = (href: string, code: string): string => `${href}${href.includes("?") ? "&" : "?"}view_error=${code}`;

/** 今の条件をビューとして足す（同じ名前があれば置き換える。DB の views_add） */
views.post("/:shopId/views/:screen", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const screen = readScreen(param(c, "screen"));
  if (!screen) return c.text(t("shop.not_found"), 404);
  const shop = await loadShop(c, shopId, SCREEN_PERM[screen]);
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const base = listPath(shopId, screen);
  let query: SearchParams = {};
  try {
    const parsed: unknown = JSON.parse(f.query ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) query = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return c.redirect(withError(base, "invalid"));
  }
  try {
    await owner(c).db.rpc("views_add", { p_shop_id: shopId, p_screen: screen, p_name: f.name ?? "", p_query: query });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(withError(searchHref(base, query), viewError(e)));
    throw e;
  }
  return c.redirect(searchHref(base, query));
});

/** ビューを名前で消す（DB の views_remove） */
views.post("/:shopId/views/:screen/delete", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const screen = readScreen(param(c, "screen"));
  if (!screen) return c.text(t("shop.not_found"), 404);
  const shop = await loadShop(c, shopId, SCREEN_PERM[screen]);
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = listPath(shopId, screen);
  try {
    await owner(c).db.rpc("views_remove", { p_shop_id: shopId, p_screen: screen, p_name: (await formFields(c)).name ?? "" });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(withError(base, viewError(e)));
    throw e;
  }
  return c.redirect(base);
});
