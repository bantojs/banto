import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError, type DbClient } from "../../db/client";
import type { CategoryRow } from "../../db/types";
import { t, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import { SLUG_RE, formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { categoryTree, type CategoryNode } from "../../products/categories";
import { migrated } from "../../db/migration-state";
import { SKU_OPTION_AXES_MIGRATION, optionAxesFromForm } from "../../products/option-axes";
import { AxesEditor, ChipsScript, appliedText, axesErrorCode, axesText } from "./option-axes";
import { can } from "./access";

/**
 * カテゴリーの管理（0008_catalog.sql、3 段まで）。owner の JWT で RLS 経由で書く。
 *   /admin/shops/:shopId/categories
 */
export const categories = new Hono<AppEnv>();

/** 管理画面で使うカテゴリー一覧 */
export const loadCategories = (db: DbClient, shopId: string) => db.from<CategoryRow>("categories").select("*", { eq: { shop_id: shopId }, order: "sort_order.asc" });

/** 親の選択肢（字下げつき）。exclude は自分自身（自分を親にしない） */
export function categoryOptions(rows: CategoryRow[], exclude?: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: CategoryNode[], depth: number) => {
    for (const n of nodes) {
      if (n.id === exclude) continue;
      out.push({ id: n.id, label: `${"　".repeat(depth)}${n.name}` });
      walk(n.children, depth + 1);
    }
  };
  walk(categoryTree(rows), 0);
  return out;
}

function flash(code: string | undefined): { kind: "ok" | "error"; text: string } | null {
  const map: Record<string, MessageKey> = {
    saved: "shop.saved",
    invalid_slug: "setup.shop.invalid_slug",
    slug_taken: "category.slug_taken",
    too_deep: "category.too_deep",
    generic: "error.generic",
    axes_saved: "axes.saved",
    axes_invalid: "axes.invalid",
    axes_mismatch: "axes.mismatch",
  };
  const key = code ? map[code] : undefined;
  return key ? { kind: code === "saved" || code === "axes_saved" ? "ok" : "error", text: t(key) } : null;
}

function errorCode(e: unknown): string {
  if (!(e instanceof DbError)) throw e;
  if (e.status === 409) return "slug_taken";
  if (/category_too_deep|category_cycle/.test(e.message)) return "too_deep";
  return "generic";
}

categories.get("/:shopId/categories", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const rows = await loadCategories(db, shop.id);
  const f = flash(c.req.query("flash"));
  const applied = appliedText((k) => c.req.query(k));
  const base = `/admin/shops/${shop.id}/categories`;
  // SKU を分ける軸（0065）。適用するまでは出さない
  const axesOn = await migrated({ db, cache: c.get("adapters").cache }, SKU_OPTION_AXES_MIGRATION);
  const axesBase = `/admin/shops/${shop.id}/option-axes`;
  const applyButton = (categoryId: string | null, label: string) => (
    <form method="post" action={`${axesBase}/apply`} style="display:inline">
      {categoryId ? <input type="hidden" name="category_id" value={categoryId} /> : null}
      <button type="submit" class="secondary small">
        {label}
      </button>
    </form>
  );
  const parentSelect = (selected: string | null, exclude?: string) => (
    <select name="parent_id">
      <option value="">{t("category.top_level")}</option>
      {categoryOptions(rows, exclude).map((o) => (
        <option value={o.id} selected={o.id === selected}>
          {o.label}
        </option>
      ))}
    </select>
  );
  const renderRows = (nodes: CategoryNode[], depth: number): unknown[] =>
    nodes.flatMap((n) => {
      const row = rows!.find((r) => r.id === n.id)!;
      return [
        <tr>
          <td>
            <form method="post" action={`${base}/${n.id}`} style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
              <span>{"　".repeat(depth)}</span>
              <input type="text" name="name" value={row.name} required maxlength={100} style="width:12rem" />
              <input type="text" name="slug" value={row.slug} required pattern="[a-z0-9][a-z0-9-]{0,62}" style="width:10rem" />
              {parentSelect(row.parent_id, row.id)}
              <input type="number" name="sort_order" value={String(row.sort_order)} style="width:5rem" />
              <button type="submit" class="secondary small">
                {t("shop.save")}
              </button>
            </form>
          </td>
          {axesOn ? (
            <td>
              <details>
                <summary>
                  {t("axes.title")}: {row.option_axes === null || row.option_axes === undefined ? t("axes.mode_inherit") : axesText(row.option_axes)}
                </summary>
                <form method="post" action={`${axesBase}/categories/${n.id}`}>
                  <AxesEditor name={row.name} axes={row.option_axes ?? null} modes={["inherit", "only_code", "axes"]} />
                  <button type="submit" class="secondary small">
                    {t("shop.save")}
                  </button>
                </form>
                {applyButton(n.id, t("axes.apply"))}
              </details>
            </td>
          ) : null}
          <td>
            <form method="post" action={`${base}/${n.id}/delete`}>
              <button type="submit" class="small">
                {t("category.delete")}
              </button>
            </form>
          </td>
        </tr>,
        ...renderRows(n.children, depth + 1),
      ];
    });
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("category.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("category.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "products" }}>
      <PageHead title={t("category.title")} sub={t("category.intro")}>
        <a class="btn" href="#add">
          {t("category.add")}
        </a>
      </PageHead>
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
      {applied ? <p class="notice">{applied}</p> : null}
      {axesOn ? (
        <section class="card" id="option-axes">
          <h2>{t("axes.title")}</h2>
          <p class="muted">{t("axes.intro")}</p>
          <p class="muted">{t("axes.apply_hint")}</p>
          <h3>
            {t("axes.shop")}: {axesText(shop.option_axes ?? null)}
          </h3>
          {can(c.get("shopAccess"), "settings") ? (
            <form method="post" action={`${axesBase}/shop`}>
              <p class="muted">{t("axes.shop_hint")}</p>
              <AxesEditor name={t("axes.shop")} axes={shop.option_axes ?? null} modes={["none", "only_code", "axes"]} />
              <button type="submit" class="secondary">
                {t("shop.save")}
              </button>
            </form>
          ) : null}
          <p>{applyButton(null, t("axes.apply_shop"))}</p>
        </section>
      ) : null}
        <div>
          {rows.length === 0 ? (
            <div class="empty">
              <p>{t("category.none")}</p>
            </div>
          ) : (
            <table>
              <tbody>{renderRows(categoryTree(rows), 0)}</tbody>
            </table>
          )}
          <section class="card" id="add">
          <h2>{t("category.add")}</h2>
          <form method="post" action={base}>
            <label for="name">{t("category.name")}</label>
            <input id="name" type="text" name="name" required maxlength={100} />
            <label for="slug">{t("product.slug")}</label>
            <input id="slug" type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,62}" />
            <label>{t("category.parent")}</label>
            {parentSelect(null)}
            <label for="sort_order">{t("category.sort_order")}</label>
            <input id="sort_order" type="number" name="sort_order" value="0" style="width:6rem" />
            <p>
              <button type="submit">{t("category.add")}</button>
            </p>
          </form>
          </section>
        </div>
      {/* チップの入力（値の候補）。ページのすべての入力欄ができてから動かす */}
      {axesOn ? <ChipsScript /> : null}
    </AdminLayout>,
  );
});

function categoryValues(f: Record<string, string>, shopId: string): Partial<CategoryRow> | "invalid_slug" | "generic" {
  const slug = (f.slug ?? "").trim();
  const name = (f.name ?? "").trim().slice(0, 100);
  if (!SLUG_RE.test(slug)) return "invalid_slug";
  if (!name) return "generic";
  const sort = Number.parseInt(f.sort_order ?? "0", 10);
  return { shop_id: shopId, slug, name, parent_id: f.parent_id ? f.parent_id : null, sort_order: Number.isInteger(sort) ? sort : 0 };
}

categories.post("/:shopId/categories", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const base = `/admin/shops/${shopId}/categories`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const values = categoryValues(await formFields(c), shopId);
  if (typeof values === "string") return c.redirect(`${base}?flash=${values}`);
  try {
    await db.from<CategoryRow>("categories").insert(values);
  } catch (e) {
    return c.redirect(`${base}?flash=${errorCode(e)}`);
  }
  return c.redirect(`${base}?flash=saved`);
});

categories.post("/:shopId/categories/:categoryId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const categoryId = param(c, "categoryId");
  const base = `/admin/shops/${shopId}/categories`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const values = categoryValues(await formFields(c), shopId);
  if (typeof values === "string") return c.redirect(`${base}?flash=${values}`);
  try {
    await db.from<CategoryRow>("categories").update(values, { id: categoryId, shop_id: shopId });
  } catch (e) {
    return c.redirect(`${base}?flash=${errorCode(e)}`);
  }
  return c.redirect(`${base}?flash=saved`);
});

/** 削除: 子は最上位に、商品は未分類になる（外部キーの on delete set null） */
categories.post("/:shopId/categories/:categoryId/delete", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const categoryId = param(c, "categoryId");
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  await db.from("categories").delete({ id: categoryId, shop_id: shopId });
  return c.redirect(`/admin/shops/${shopId}/categories?flash=saved`);
});

// ---------- SKU を分ける軸（0065） ----------
/** カテゴリーの軸（ひな形）。「上の段を引き継ぐ」は null */
categories.post("/:shopId/option-axes/categories/:categoryId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const back = `/admin/shops/${shopId}/categories`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const axes = optionAxesFromForm(await formFields(c));
  if (axes === "invalid") return c.redirect(`${back}?flash=axes_invalid#option-axes`);
  try {
    await db.from<CategoryRow>("categories").update({ option_axes: axes }, { id: param(c, "categoryId"), shop_id: shopId });
  } catch (e) {
    if (axesErrorCode(e)) return c.redirect(`${back}?flash=axes_invalid`);
    throw e;
  }
  return c.redirect(`${back}?flash=axes_saved`);
});

/** ショップの既定（settings の項目。ショップの行を書くため） */
categories.post("/:shopId/option-axes/shop", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const back = `/admin/shops/${shopId}/categories`;
  if (!(await loadShop(c, shopId, "settings"))) return c.text(t("shop.not_found"), 404);
  const axes = optionAxesFromForm(await formFields(c));
  if (axes === "invalid") return c.redirect(`${back}?flash=axes_invalid#option-axes`);
  try {
    await db.from("shops").update({ option_axes: axes }, { id: shopId });
  } catch (e) {
    if (axesErrorCode(e)) return c.redirect(`${back}?flash=axes_invalid`);
    throw e;
  }
  return c.redirect(`${back}?flash=axes_saved#option-axes`);
});

/** 上の段の軸を、上書きしていない商品に当てる（SKU が合う商品だけ。合わない商品は名前を出す） */
categories.post("/:shopId/option-axes/apply", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const back = `/admin/shops/${shopId}/categories`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const r = await db.rpc<{ applied: number; unchanged: number; skipped: { slug: string }[] }>("option_axes_apply", { p_shop_id: shopId, p_category_id: f.category_id || null });
  const skipped = r.skipped.map((x) => x.slug).slice(0, 30).join(",");
  return c.redirect(`${back}?applied=${r.applied}&unchanged=${r.unchanged}&skipped=${encodeURIComponent(skipped)}#option-axes`);
});
