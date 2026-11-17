import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { migrated } from "../../db/migration-state";
import { t, tf, type MessageKey } from "../../i18n";
import { moduleEnabled } from "../../modules/registry";
import { yen } from "../common";
import { requireOwner } from "./auth";
import { owner, param, type AdminContext } from "./context";
import { INVENTORY_MIGRATION } from "./inventory";
import { AdminLayout, PageHead } from "./layout";
import { loadShop } from "./shops";

/**
 * ショップのホーム（メンテナの決定 2026-11-08「目次は仕事ごと」の最初の画面）: 「今やること」と開店の準備。
 * 数えるのは DB の shop_home（0139）の 1 回だけで、見る人の項目にある分しか返らない（出荷の担当に売上を出さない）。
 * 「今やること」は 1 件以上あるものだけを、その条件の一覧へのリンクにして並べる。0139 の前は、使える画面へのリンクだけ
 */
export const SHOP_HOME_MIGRATION = "0139_shop_home";

interface HomeData {
  orders?: { to_ship: number };
  sales?: { orders: number; revenue_jpy: number };
  catalog?: { out_of_stock: number; drafts: number; products: number };
  support?: { waiting: number };
  content?: { scheduled: number; drafts: number };
  setup?: { legal: boolean; product: boolean; published: boolean };
}

export const home = new Hono<AppEnv>();

home.get("/:shopId/home", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "any");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { db } = owner(c);
  const cache = c.get("adapters").cache;
  const [ready, inventoryOn] = await Promise.all([migrated({ db, cache }, SHOP_HOME_MIGRATION), migrated({ db, cache }, INVENTORY_MIGRATION)]);
  const data = ready ? await db.rpc<HomeData>("shop_home", { p_shop_id: shop.id }) : null;
  const base = `/admin/shops/${shop.id}`;
  const on = (m: string) => moduleEnabled(shop.settings, m);

  // 今やること（1 件以上のものだけ）
  const todos: { n: number; label: MessageKey; href: string }[] = [];
  if (data?.orders?.to_ship) todos.push({ n: data.orders.to_ship, label: "home.todo_to_ship", href: `${base}/orders?status=paid` });
  if (data?.support?.waiting && on("inquiries")) todos.push({ n: data.support.waiting, label: "home.todo_inquiries", href: `${base}/modules/inquiries?status=waiting_shop` });
  if (data?.catalog?.out_of_stock) todos.push({ n: data.catalog.out_of_stock, label: "home.todo_out_of_stock", href: inventoryOn ? `${base}/inventory?stock=out` : `${base}/products?stock=out` });
  if (data?.catalog?.drafts) todos.push({ n: data.catalog.drafts, label: "home.todo_product_drafts", href: `${base}/products?state=draft` });
  if (data?.content?.scheduled && (on("pages") || on("blog"))) todos.push({ n: data.content.scheduled, label: "home.todo_scheduled", href: on("pages") ? `${base}/modules/pages` : `${base}/modules/blog` });

  // 開店の準備（owner / admin。全部済んだら出さない）
  const setup = data?.setup;
  const steps = setup
    ? [
        { done: setup.legal, label: "home.setup_legal" as MessageKey, href: base },
        { done: setup.product, label: "home.setup_product" as MessageKey, href: `${base}/products/new` },
        { done: setup.published, label: "home.setup_publish" as MessageKey, href: base },
      ]
    : [];
  const setupOpen = steps.some((s) => !s.done);

  return c.html(
    <AdminLayout title={`${shop.name} · ${t("nav.home")}`} nav crumbs={[{ label: shop.name, href: `${base}/home` }, { label: t("nav.home") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), here: "home" }}>
      <PageHead title={shop.name} sub={t("nav.home")} />
      {setupOpen ? (
        <section class="card">
          <h2>{t("home.setup_title")}</h2>
          <ol class="checklist">
            {steps.map((s) => (
              <li class={s.done ? "done" : undefined}>
                {s.done ? <span aria-label={t("home.done")}>✓ </span> : null}
                {s.done ? t(s.label) : <a href={s.href}>{t(s.label)}</a>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {data?.sales ? (
        <section class="card">
          <h2>{t("dashboard.last30")}</h2>
          <div class="metric">
            {yen(data.sales.revenue_jpy)}
            <small>{tf("home.orders_count", { n: data.sales.orders })}</small>
          </div>
        </section>
      ) : null}
      {ready ? (
        <section class="card">
          <h2>{t("home.todo_title")}</h2>
          {todos.length === 0 ? (
            <p class="muted">{t("home.todo_none")}</p>
          ) : (
            <ul class="todo-list">
              {todos.map((x) => (
                <li>
                  <a href={x.href}>
                    <strong>{x.n}</strong> {t(x.label)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p class="notice">
          {t("home.needs_update")} <a href="/admin/update">{t("inventory.open_update")}</a>
        </p>
      )}
    </AdminLayout>,
  );
});
