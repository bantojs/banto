import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { selectIn } from "../../db/select-in";
import type { CategoryRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { TAX_CLASSES } from "../../commerce/tax";
import { namedOptionEntries, optionNamesOf } from "../../products/option-names";
import { UUID_RE } from "../../util/cursor";
import { requireOwner } from "./auth";
import { categoryOptions, loadCategories } from "./categories";
import { formFields, owner, param, type AdminContext } from "./context";
import { AdminLayout, PageHead } from "./layout";
import { ADMIN_PAGE_SIZE } from "./paging";
import { loadShop } from "./shops";

/**
 * 商品のまとめて編集（メンテナの決定 2026-11-08「一括編集の保存はまとめて 1 回・誤りが 1 つでもあれば何も変えない RPC」、0137）。
 * 一覧で選んだ商品（1 ページ分、50 まで）の行と、その下の SKU の行を表に並べ、直したいマスだけを書き換えて 1 回で保存する。
 * 送るのは変えたマスだけで、開いたときの値も一緒に送る（そのあいだにだれかが直したマスは DB が知らせる）。
 * 誤りがあれば、入れた値を残したまま誤りのマスに印を付けて描き直す。変えていないマスは今の値で描き直す（ほかの人の保存を戻さない）。
 * 在庫はここでは扱わない（在庫の画面。数を置き換えると、開いてから売れた分を上書きするため）。スクリプト無しで動く。
 */
export const BULK_MIGRATION = "0137_catalog_bulk";

type Kind = "product" | "sku";
type Col = "name" | "published" | "category_id" | "tags" | "brand" | "tax_class" | "price_jpy" | "compare_at_price_jpy" | "gtin";
const COLUMNS: { col: Col; kind: Kind; label: MessageKey }[] = [
  { col: "name", kind: "product", label: "product.name" },
  { col: "published", kind: "product", label: "bulk.col_published" },
  { col: "category_id", kind: "product", label: "product.category" },
  { col: "tags", kind: "product", label: "product.tags" },
  { col: "brand", kind: "product", label: "product.brand" },
  { col: "tax_class", kind: "product", label: "tax.class" },
  { col: "price_jpy", kind: "sku", label: "bulk.col_price" },
  { col: "compare_at_price_jpy", kind: "sku", label: "bulk.col_compare_at" },
  { col: "gtin", kind: "sku", label: "bulk.col_gtin" },
];
const DEFAULT_COLS: Col[] = ["name", "published", "category_id", "tags", "price_jpy", "compare_at_price_jpy"];

interface BulkProduct {
  id: string;
  name: string;
  published: boolean;
  category_id: string | null;
  tags: string[] | null;
  brand: string | null;
  tax_class: string | null;
}
interface BulkSku {
  id: string;
  product_id: string;
  code: string;
  name: string | null;
  options: Record<string, unknown> | null;
  price_jpy: number;
  compare_at_price_jpy: number | null;
  gtin: string | null;
}
interface CellError {
  kind: Kind;
  id: string;
  col: Col;
  error: "invalid" | "changed" | "not_found" | "compare_at_low";
  current?: string | null;
}

/** マスの今の値（DB の banto_bulk_text と同じ文字の形。空は ""） */
function cellText(col: Col, row: BulkProduct | BulkSku): string {
  const r = row as unknown as Record<string, unknown>;
  if (col === "published") return String(Boolean(r["published"]));
  if (col === "tags") return ((r["tags"] as string[] | null) ?? []).join(", ");
  if (col === "tax_class") return typeof r["tax_class"] === "string" ? r["tax_class"] : "standard";
  const v = r[col];
  return v === null || v === undefined ? "" : String(v);
}

/** 数のマス: 全角の数字・カンマを読む */
const normalizeNumber = (v: string): string =>
  v
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "")
    .trim();
const cellKey = (kind: Kind, id: string, col: Col) => `${kind}:${id}:${col}`;

/** URL の商品 id（?id= を何度でも・?ids= のカンマ区切り。このショップのものかは読むときに絞る） */
function readIds(c: AdminContext, extra?: string[]): string[] {
  const raw = [...(c.req.queries("id") ?? []), ...(c.req.query("ids") ?? "").split(","), ...(extra ?? [])];
  return [...new Set(raw.map((x) => x.trim()).filter((x) => UUID_RE.test(x)))].slice(0, ADMIN_PAGE_SIZE);
}
function readCols(v: string | undefined): Col[] {
  if (v === undefined) return DEFAULT_COLS;
  const want = new Set(v.split(","));
  const cols = COLUMNS.filter((x) => want.has(x.col)).map((x) => x.col);
  return cols.length > 0 ? cols : DEFAULT_COLS;
}
const bulkHref = (shopId: string, ids: string[], cols: Col[], extra = "") => `/admin/shops/${shopId}/products/bulk?ids=${ids.join(",")}&cols=${cols.join(",")}${extra}`;

function errorText(e: CellError): string {
  if (e.error === "changed") return tf("bulk.err_changed", { current: e.current ?? t("bulk.empty") });
  if (e.error === "not_found") return t("bulk.err_not_found");
  if (e.error === "compare_at_low") return t("bulk.err_compare_at_low");
  const key: Record<Col, MessageKey> = {
    name: "bulk.err_name",
    published: "bulk.err_invalid",
    category_id: "bulk.err_category",
    tags: "bulk.err_invalid",
    brand: "bulk.err_brand",
    tax_class: "bulk.err_invalid",
    price_jpy: "bulk.err_price",
    compare_at_price_jpy: "bulk.err_price",
    gtin: "bulk.err_gtin",
  };
  return t(key[e.col]);
}

export const bulk = new Hono<AppEnv>();

async function renderPage(
  c: AdminContext,
  shop: ShopRow,
  ids: string[],
  cols: Col[],
  problem?: {
    values: Record<string, string>;
    errors: CellError[];
    failed?: boolean;
  },
) {
  const { db } = owner(c);
  const enabled = await migrated({ db, cache: c.get("adapters").cache }, BULK_MIGRATION);
  const listHref = `/admin/shops/${shop.id}/products`;
  const [products, skus, categories] =
    enabled && ids.length > 0
      ? await Promise.all([
          selectIn<BulkProduct & Record<string, unknown>>(db, "products", "id,name,published,category_id,tags,brand,tax_class,created_at", shop.id, "id", ids),
          selectIn<BulkSku & Record<string, unknown>>(db, "skus", "id,product_id,code,name,options,price_jpy,compare_at_price_jpy,gtin", shop.id, "product_id", ids),
          loadCategories(db, shop.id),
        ])
      : [[], [], [] as CategoryRow[]];
  // 選んだ順に並べる（一覧の並びのまま）
  const order = new Map(ids.map((id, i) => [id, i]));
  products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  skus.sort((a, b) => (a.code < b.code ? -1 : 1));
  const names = optionNamesOf(shop.option_names);
  const catOpts = categoryOptions(categories);
  const pCols = COLUMNS.filter((x) => x.kind === "product" && cols.includes(x.col));
  const sCols = COLUMNS.filter((x) => x.kind === "sku" && cols.includes(x.col));
  const errors = new Map((problem?.errors ?? []).map((e) => [cellKey(e.kind, e.id, e.col), e]));
  const values = problem?.values ?? {};
  const flash = c.req.query("flash");

  const Cell = (props: { kind: Kind; row: BulkProduct | BulkSku; col: Col; label: string }) => {
    const key = cellKey(props.kind, props.row.id, props.col);
    const orig = cellText(props.col, props.row);
    const v = values[key] ?? orig;
    const err = errors.get(key);
    const cls = `cell${v !== orig ? " chg" : ""}${err ? " err" : ""}`;
    const common = {
      name: `v:${key}`,
      class: cls,
      "aria-label": props.label,
      "aria-invalid": err ? "true" : undefined,
      title: err ? errorText(err) : undefined,
    };
    const input =
      props.col === "published" ? (
        <select {...common}>
          <option value="true" selected={v === "true"}>
            {t("dashboard.published")}
          </option>
          <option value="false" selected={v !== "true"}>
            {t("dashboard.unpublished")}
          </option>
        </select>
      ) : props.col === "tax_class" ? (
        <select {...common}>
          {TAX_CLASSES.map((x) => (
            <option value={x} selected={v === x}>
              {t(`tax.class_${x}`)}
            </option>
          ))}
        </select>
      ) : props.col === "category_id" ? (
        <select {...common}>
          <option value="">{t("bulk.no_category")}</option>
          {catOpts.map((o) => (
            <option value={o.id} selected={v === o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          {...common}
          value={v}
          inputmode={props.col === "price_jpy" || props.col === "compare_at_price_jpy" || props.col === "gtin" ? "numeric" : undefined}
          maxlength={props.col === "name" ? 200 : props.col === "tags" ? 1000 : 100}
        />
      );
    return (
      <td>
        <input type="hidden" name={`o:${key}`} value={orig} />
        {input}
        {err ? <span class="error cell-error">{errorText(err)}</span> : null}
      </td>
    );
  };

  return c.html(
    <AdminLayout
      title={`${shop.name} · ${t("bulk.title")}`}
      nav
      crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list"), href: listHref }, { label: t("bulk.title") }]}
      shopTabs={{
        shop: { id: shop.id, name: shop.name, settings: shop.settings },
        access: c.get("shopAccess"),
        active: "products",
      }}
    >
      <PageHead title={t("bulk.title")} sub={t("bulk.lead")} />
      {!enabled ? (
        <p class="notice">
          {t("bulk.needs_update")} <a href="/admin/update">{t("inventory.open_update")}</a>
        </p>
      ) : products.length === 0 ? (
        <div class="empty">
          {t("bulk.none_selected")} <a href={listHref}>{t("product.list")}</a>
        </div>
      ) : (
        <>
          {flash === "saved" ? (
            <p class="notice">
              {tf("bulk.saved", {
                products: c.req.query("p") ?? "0",
                skus: c.req.query("s") ?? "0",
              })}
            </p>
          ) : null}
          {flash === "nothing" ? <p class="notice">{t("bulk.nothing")}</p> : null}
          {problem ? <p class="error">{problem.failed ? t("bulk.failed") : tf("bulk.has_errors", { n: problem.errors.length })}</p> : null}
          <nav class="chips bulk-cols" aria-label={t("bulk.columns")}>
            <span class="muted">{t("bulk.columns")}</span>
            {COLUMNS.map((x) => {
              const on = cols.includes(x.col);
              const next = on ? cols.filter((y) => y !== x.col) : COLUMNS.map((y) => y.col).filter((y) => y === x.col || cols.includes(y));
              return (
                <a class="chip" href={bulkHref(shop.id, ids, next.length > 0 ? next : cols)} aria-pressed={on ? "true" : "false"}>
                  {t(x.label)}
                </a>
              );
            })}
          </nav>
          <form method="post" action={`/admin/shops/${shop.id}/products/bulk`} class="bulk-form">
            <input type="hidden" name="ids" value={ids.join(",")} />
            <input type="hidden" name="cols" value={cols.join(",")} />
            <div class="table-scroll">
              <table class="bulk-table">
                <thead>
                  <tr>
                    <th>{t("bulk.row")}</th>
                    {pCols.map((x) => (
                      <th>{t(x.label)}</th>
                    ))}
                    {sCols.map((x) => (
                      <th class="num">{t(x.label)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <>
                      <tr class="bulk-product">
                        <th scope="row">
                          <a href={`${listHref}/${p.id}`}>{p.name}</a>
                        </th>
                        {pCols.map((x) => (
                          <Cell kind="product" row={p} col={x.col} label={`${p.name} ${t(x.label)}`} />
                        ))}
                        {sCols.map(() => (
                          <td />
                        ))}
                      </tr>
                      {skus
                        .filter((k) => k.product_id === p.id)
                        .map((k) => {
                          const opts = namedOptionEntries(k.options, names)
                            .map(([a, b]) => `${a}: ${b}`)
                            .join(" / ");
                          const label = `${k.code}${k.name || opts ? ` (${[k.name, opts].filter(Boolean).join(" · ")})` : ""}`;
                          return (
                            <tr class="bulk-sku">
                              <th scope="row" class="muted">
                                {label}
                              </th>
                              {pCols.map(() => (
                                <td />
                              ))}
                              {sCols.map((x) => (
                                <Cell kind="sku" row={k} col={x.col} label={`${k.code} ${t(x.label)}`} />
                              ))}
                            </tr>
                          );
                        })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
            <p class="muted">{t("bulk.hint")}</p>
            <p>
              <button type="submit">{t("bulk.submit")}</button> <a href={listHref}>{t("bulk.back")}</a>
            </p>
          </form>
        </>
      )}
    </AdminLayout>,
    problem ? 409 : 200,
  );
}

bulk.get("/:shopId/products/bulk", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  return renderPage(c, shop, readIds(c), readCols(c.req.query("cols")));
});

bulk.post("/:shopId/products/bulk", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const ids = readIds(c, (f.ids ?? "").split(","));
  const cols = readCols(f.cols);
  // 変えたマスだけ（開いたときの値と比べる）。名前は v:<kind>:<id>:<col>
  const changes: {
    kind: Kind;
    id: string;
    col: Col;
    from: string | null;
    to: string | null;
  }[] = [];
  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(f)) {
    const m = /^v:(product|sku):([0-9a-f-]{36}):([a-z_]+)$/.exec(name);
    if (!m) continue;
    const def = COLUMNS.find((x) => x.col === m[3] && x.kind === m[1]);
    if (!def) continue;
    const orig = f[`o:${name.slice(2)}`] ?? "";
    const numeric = def.col === "price_jpy" || def.col === "compare_at_price_jpy" || def.col === "gtin";
    const to = numeric ? normalizeNumber(raw) : raw.trim();
    if (to === orig.trim()) continue;
    values[name.slice(2)] = raw;
    changes.push({
      kind: def.kind,
      id: m[2]!,
      col: def.col,
      from: orig.trim() === "" ? null : orig.trim(),
      to: to === "" ? null : to,
    });
  }
  if (changes.length === 0) return c.redirect(bulkHref(shop.id, ids, cols, "&flash=nothing"));
  let r: {
    ok: boolean;
    products?: number;
    skus?: number;
    errors?: CellError[];
  };
  try {
    r = await owner(c).db.rpc<typeof r>("catalog_bulk_update", {
      p_shop_id: shop.id,
      p_changes: changes,
    });
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
    // 形の違う送り方（画面からは起きない）・表の制約は、マスを決められないので全体の誤りとして出す（入れた値は残す）
    return renderPage(c, shop, ids, cols, { values, errors: [], failed: true });
  }
  if (!r.ok) return renderPage(c, shop, ids, cols, { values, errors: r.errors ?? [] });
  return c.redirect(bulkHref(shop.id, ids, cols, `&flash=saved&p=${r.products ?? 0}&s=${r.skus ?? 0}`));
});
