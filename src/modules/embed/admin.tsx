import { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { ProductRow, ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { publicBaseUrl } from "../../routes/common";
import { storefrontSettings } from "../../storefront/mode";
import { moduleEnabled } from "../registry";
import { EMBED_SCRIPT_PATH } from "./script";

export const EMBED_MODULE = "embed";

/** 画面に出す商品の数（新しく更新した順）。それより多い商品は docs/embed.md の書き方で slug を入れてもらう */
const PRODUCTS_SHOWN = 30;

/**
 * 同梱モジュール「貼れるタグ」の画面（貼るコードを出すだけ。設定は持たない）。docs/embed.md
 *   GET /admin/shops/:shopId/modules/embed
 * 商品を扱うので項目 catalog。
 */
export const embedAdmin = new Hono<AppEnv>();

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function embedSnippets(base: string, slug: string) {
  return {
    loader: `<script src="${attr(base)}${EMBED_SCRIPT_PATH}" defer></script>`,
    cart: `<banto-cart shop="${attr(slug)}"></banto-cart>`,
    products: `<banto-products shop="${attr(slug)}" limit="12"></banto-products>`,
    product: (productSlug: string) => `<banto-product shop="${attr(slug)}" product="${attr(productSlug)}"></banto-product>`,
  };
}

function Snippet(props: { label: string; code: string; rows?: number }) {
  return (
    <div style="margin:.75rem 0">
      <div class="muted">{props.label}</div>
      <textarea readonly rows={props.rows ?? 1} style="width:100%;font-family:ui-monospace,monospace;font-size:.85rem">
        {props.code}
      </textarea>
    </div>
  );
}

embedAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop: ShopRow | null = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop || !moduleEnabled(shop.settings, EMBED_MODULE)) return c.notFound();
  const products = await owner(c).db.from<ProductRow>("products").select("slug,name", { eq: { shop_id: shop.id, published: true }, order: "updated_at.desc", limit: PRODUCTS_SHOWN });
  // 問い合わせ先は Banto 自身の URL（独自ドメインのショップでも。商品ページ・購入リンクは Banto がショップのドメインへ転送する）
  const s = embedSnippets(publicBaseUrl(c), shop.slug);
  const mode = storefrontSettings(shop.settings).mode;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.embed.name")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("mod.embed.name") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules", here: "embed" }}>
      <PageHead title={t("mod.embed.name")} />
      {mode === "off" ? <p class="error">{t("embed.mode_off")}</p> : null}
      {!shop.published ? <p class="error">{t("embed.unpublished")}</p> : null}
      <p>{t("embed.intro")}</p>
      <h2>{t("embed.step_loader")}</h2>
      <p class="muted">{t("embed.loader_hint")}</p>
      <Snippet label={t("embed.loader")} code={s.loader} />
      <h2>{t("embed.step_parts")}</h2>
      <Snippet label={t("embed.cart")} code={s.cart} />
      <Snippet label={t("embed.products")} code={s.products} />
      <h3>{t("embed.product")}</h3>
      {products.length === 0 ? <p class="muted">{t("embed.no_products")}</p> : null}
      {products.map((p) => (
        <Snippet label={p.name} code={s.product(p.slug)} />
      ))}
      {products.length >= PRODUCTS_SHOWN ? <p class="muted">{tf("embed.more_products", { n: PRODUCTS_SHOWN })}</p> : null}
      <h2>{t("embed.notes")}</h2>
      <ul>
        <li>{t("embed.note_checkout")}</li>
        <li>{t("embed.note_style")}</li>
        <li>{t("embed.note_builders")}</li>
      </ul>
    </AdminLayout>,
  );
});
