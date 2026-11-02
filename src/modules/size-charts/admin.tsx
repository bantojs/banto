import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { CategoryRow, ProductRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { mediaBaseUrl, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { MAX_IMAGE_BYTES, imageSize, imageUrl, randomKey, sniffImage } from "../../media/images";
import { optionNamesOf } from "../../products/option-names";
import { columnsOf, rowsOf, rowsToTsv, sizeChartOf, tsvToRows, type SizeChartColumn, type SizeChartRow } from "../../size-charts/chart";
import { SIZE_CHART_CSS, SizeChartView } from "../../size-charts/html";
import { AutocheckHint, AutocheckScript, autocheckAttrs } from "../../routes/admin/autocheck";

/**
 * 同梱モジュール「採寸表」の編集（0095_mod_size_charts、docs/size-charts.md）。項目 catalog。
 *   GET/POST /admin/shops/:shopId/modules/size-charts                         ショップ全体の段
 *   GET/POST /admin/shops/:shopId/modules/size-charts/categories/:categoryId  カテゴリーの段
 *   GET/POST /admin/shops/:shopId/modules/size-charts/products/:productId     商品の段
 * どの段の表を使うかは DB（size_chart_get の effective）が決める。ここは 1 つの段を置き換えるだけ（size_chart_set）。
 * 測り方の図はブラウザで横幅 1600px までの WebP に縮小してから送る（スクリプトが無ければそのまま。5MB・4096px まで）。
 */
export const sizeChartsAdmin = new Hono<AppEnv>();

/** 列の欄は今ある列 + 空き 3 つ（12 まで）、行の欄は今ある行 + 空き 5 つ（60 まで） */
const MAX_COLUMNS = 12;
const MAX_ROWS = 60;
const IMAGE_WIDTH = 1600;

type Level = { kind: "shop" } | { kind: "category"; category: CategoryRow } | { kind: "product"; product: ProductRow };
interface Own {
  hidden: boolean;
  axis: string | null;
  columns: SizeChartColumn[] | null;
  rows: SizeChartRow[] | null;
  note: string | null;
  image: { key: string; width: number; height: number } | null;
}

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  return shop && moduleEnabled(shop.settings, "size_charts") ? shop : null;
}

async function levelOf(c: AdminContext, shop: ShopRow): Promise<Level | null> {
  const { db } = owner(c);
  const cid = c.req.param("categoryId");
  const pid = c.req.param("productId");
  if (cid) {
    const [category] = await db.from<CategoryRow>("categories").select("*", { eq: { id: cid, shop_id: shop.id }, limit: 1 });
    return category ? { kind: "category", category } : null;
  }
  if (pid) {
    const [product] = await db.from<ProductRow>("products").select("id,shop_id,slug,name,category_id,published,created_at,updated_at,tags,description", { eq: { id: pid, shop_id: shop.id }, limit: 1 });
    return product ? { kind: "product", product } : null;
  }
  return { kind: "shop" };
}

const ids = (l: Level) => ({ p_category_id: l.kind === "category" ? l.category.id : null, p_product_id: l.kind === "product" ? l.product.id : null });
const basePath = (shop: ShopRow, l: Level) =>
  `/admin/shops/${shop.id}/modules/size-charts${l.kind === "category" ? `/categories/${l.category.id}` : l.kind === "product" ? `/products/${l.product.id}` : ""}`;

function ownOf(raw: unknown): Own | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const img = r["image"] as Record<string, unknown> | null;
  return {
    hidden: r["hidden"] === true,
    axis: typeof r["axis"] === "string" ? r["axis"] : null,
    columns: Array.isArray(r["columns"]) ? columnsOf(r["columns"]) : null,
    rows: Array.isArray(r["rows"]) ? rowsOf(r["rows"]) : null,
    note: typeof r["note"] === "string" ? r["note"] : null,
    image: img && typeof img["key"] === "string" ? { key: img["key"], width: Number(img["width"]), height: Number(img["height"]) } : null,
  };
}

const SOURCE: Record<string, MessageKey> = { shop: "sizechart.level_shop", category: "sizechart.level_category", product: "sizechart.level_product" };

const FLASH: Record<string, { kind: "ok" | "error"; key: MessageKey }> = {
  saved: { kind: "ok", key: "sizechart.saved" },
  invalid: { kind: "error", key: "sizechart.invalid" },
  image: { kind: "error", key: "sizechart.image_invalid" },
  axis: { kind: "error", key: "sizechart.axis_invalid" },
};

/** 図を縮小してから送る（横幅 IMAGE_WIDTH・高さ 4096 まで、WebP）。失敗したら元のファイルのまま送る */
const RESIZE_SCRIPT = `(function(){var f=document.getElementById("size-chart-form");if(!f)return;var inp=f.querySelector("input[name=image]");var busy=false;
f.addEventListener("submit",function(e){if(busy||!inp||!inp.files||!inp.files[0]||typeof DataTransfer==="undefined")return;e.preventDefault();busy=true;var file=inp.files[0];var url=URL.createObjectURL(file);var im=new Image();
function go(){f.submit()}
im.onload=function(){var W=im.naturalWidth,H=im.naturalHeight;var r=Math.min(1,${IMAGE_WIDTH}/W,4096/H);var w=Math.max(1,Math.round(W*r)),h=Math.max(1,Math.round(H*r));var c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");if(!x){go();return}x.fillStyle="#fff";x.fillRect(0,0,w,h);x.drawImage(im,0,0,w,h);
c.toBlob(function(b){URL.revokeObjectURL(url);if(b&&b.type==="image/webp"){var dt=new DataTransfer();dt.items.add(new File([b],"size-chart.webp",{type:"image/webp"}));inp.files=dt.files}go()},"image/webp",0.85)};
im.onerror=function(){go()};im.src=url})})();`;

sizeChartsAdmin.get("/", requireOwner, (c: AdminContext) => page(c));
sizeChartsAdmin.get("/categories/:categoryId", requireOwner, (c: AdminContext) => page(c));
sizeChartsAdmin.get("/products/:productId", requireOwner, (c: AdminContext) => page(c));
sizeChartsAdmin.post("/", requireOwner, (c: AdminContext) => save(c));
sizeChartsAdmin.post("/categories/:categoryId", requireOwner, (c: AdminContext) => save(c));
sizeChartsAdmin.post("/products/:productId", requireOwner, (c: AdminContext) => save(c));

async function page(c: AdminContext) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const level = await levelOf(c, shop);
  if (!level) return c.notFound();
  const { db } = owner(c);
  const got = await db.rpc<{ own: unknown; effective: unknown; inherited: unknown }>("size_chart_get", { p_shop_id: shop.id, ...ids(level) });
  const own = ownOf(got?.own);
  const effective = sizeChartOf(got?.effective);
  const inherited = sizeChartOf(got?.inherited);
  const names = optionNamesOf(shop.option_names);
  const base = basePath(shop, level);
  const media = mediaBaseUrl(c);
  const fl = FLASH[c.req.query("flash") ?? ""];
  // 行の欄で使う列: この段の列、無ければ上の段の列
  const gridColumns = own?.columns ?? inherited?.columns ?? [];
  const ownColumns = own?.columns ?? [];
  const colSlots = Math.min(MAX_COLUMNS, Math.max(ownColumns.length + 3, 4));
  const ownRows = own?.rows ?? [];
  // この段に行が無いあいだ、上の段の行を薄い字（placeholder）で見せる（入力しない限り上の段の値が使われる）
  const upperRows = inherited?.rows ?? [];
  const rowSlots = Math.min(MAX_ROWS, Math.max(ownRows.length, (inherited?.rows ?? []).length) + 5);
  const title =
    level.kind === "shop" ? t("sizechart.level_shop") : level.kind === "category" ? tf("sizechart.for_category", { name: level.category.name }) : tf("sizechart.for_product", { name: level.product.name });
  const crumbs = [
    { label: shop.name, href: `/admin/shops/${shop.id}` },
    level.kind === "product" ? { label: level.product.name, href: `/admin/shops/${shop.id}/products/${level.product.id}` } : { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` },
    { label: t("sizechart.title") },
  ];
  const rowValue = (r: SizeChartRow | undefined) => r?.value ?? "";
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("sizechart.title")}`} nav crumbs={crumbs} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: level.kind === "shop" ? "modules" : "products" }}>
      <style dangerouslySetInnerHTML={{ __html: `${SIZE_CHART_CSS}.size-chart-grid input{width:6rem}.size-chart-grid input.value{width:7rem}` }} />
      <PageHead title={`${t("sizechart.title")} · ${title}`} sub={t("sizechart.intro")} />
      {fl ? <p class={fl.kind === "ok" ? "notice" : "error"}>{t(fl.key)}</p> : null}
      {level.kind === "shop" ? <p class="muted">{t("sizechart.shop_hint")}</p> : <p class="muted">{t("sizechart.inherit_hint")}</p>}

      <section class="card">
        <h2>{t("sizechart.effective")}</h2>
        {effective ? (
          <>
            <p class="muted">
              {tf("sizechart.sources", { columns: t(SOURCE[effective.sources.columns ?? "shop"] ?? "sizechart.level_shop"), rows: effective.sources.rows ? t(SOURCE[effective.sources.rows] ?? "sizechart.level_shop") : t("sizechart.none") })}
            </p>
            <SizeChartView chart={effective} mediaBaseUrl={media} id="size-chart-preview" />
          </>
        ) : (
          <p class="muted">{own?.hidden ? t("sizechart.hidden_now") : t("sizechart.no_chart")}</p>
        )}
      </section>

      <form method="post" action={base} enctype="multipart/form-data" id="size-chart-form" class="card">
        {level.kind === "product" ? (
          <label>
            <input type="checkbox" name="hidden" value="on" checked={own?.hidden ?? false} /> {t("sizechart.hide")}
          </label>
        ) : null}

        <fieldset>
          <legend>{t("sizechart.columns")}</legend>
          <label>
            <input type="checkbox" name="own_columns" value="on" checked={own?.columns !== null && own?.columns !== undefined} /> {t("sizechart.own_columns")}
          </label>
          {inherited && !own?.columns ? <p class="muted">{tf("sizechart.inherited_columns", { columns: inherited.columns.map((x) => x.label).join("・") })}</p> : null}
          <AutocheckHint label={t("sizechart.own_columns")} />
          <div {...autocheckAttrs("own_columns")}>
          <table class="size-chart-grid">
            <thead>
              <tr>
                <th>{t("sizechart.column_label")}</th>
                <th>{t("sizechart.column_unit")}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: colSlots }, (_, i) => (
                <tr>
                  <td>
                    <input type="hidden" name={`col_key_${i}`} value={ownColumns[i]?.key ?? ""} />
                    <input type="text" name={`col_label_${i}`} value={ownColumns[i]?.label ?? ""} maxlength={40} aria-label={t("sizechart.column_label")} />
                  </td>
                  <td>
                    <input type="text" name={`col_unit_${i}`} value={ownColumns[i]?.unit ?? ""} maxlength={10} list="size-chart-units" aria-label={t("sizechart.column_unit")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="size-chart-units">
            {["cm", "mm", "inch", "kg", "g", "号", "cm（ヌード）"].map((u) => (
              <option value={u} />
            ))}
          </datalist>
          <p class="muted">{t("sizechart.columns_hint")}</p>
          <label for="axis">{t("sizechart.axis")}</label>
          <select id="axis" name="axis">
            <option value="">{t("sizechart.axis_none")}</option>
            {Object.entries(names).map(([k, n]) => (
              <option value={k} selected={own?.axis === k}>
                {n}
              </option>
            ))}
          </select>
          <p class="muted">{t("sizechart.axis_hint")}</p>
          <label for="image">{t("sizechart.image")}</label>
          {own?.image ? (
            <p>
              <img src={imageUrl(media, own.image.key)} alt="" style="max-width:16rem;height:auto" />
              <br />
              <label>
                <input type="checkbox" name="image_remove" value="on" /> {t("sizechart.image_remove")}
              </label>
            </p>
          ) : null}
          <input id="image" type="file" name="image" accept="image/jpeg,image/png,image/webp" />
          <p class="muted">{t("sizechart.image_hint")}</p>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t("sizechart.rows")}</legend>
          <label>
            <input type="checkbox" name="own_rows" value="on" checked={own?.rows !== null && own?.rows !== undefined} /> {t("sizechart.own_rows")}
          </label>
          {gridColumns.length === 0 ? (
            <p class="muted">{t("sizechart.rows_need_columns")}</p>
          ) : (
            <div {...autocheckAttrs("own_rows")}>
              <AutocheckHint label={t("sizechart.own_rows")} />
              {ownRows.length === 0 && upperRows.length > 0 ? <p class="muted">{t("sizechart.upper_rows_hint")}</p> : null}
              <div class="size-chart-scroll">
                <table class="size-chart-grid">
                  <thead>
                    <tr>
                      <th>{t("sizechart.value")}</th>
                      {gridColumns.map((col) => (
                        <th>{col.unit ? `${col.label}（${col.unit}）` : col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: rowSlots }, (_, j) => (
                      <tr>
                        <td>
                          <input class="value" type="text" name={`row_value_${j}`} value={rowValue(ownRows[j])} placeholder={ownRows.length === 0 ? (upperRows[j]?.value ?? "") : ""} maxlength={40} aria-label={t("sizechart.value")} />
                        </td>
                        {gridColumns.map((col) => (
                          <td>
                            <input type="text" name={`cell_${j}_${col.key}`} value={ownRows[j]?.cells[col.key] ?? ""} placeholder={ownRows.length === 0 ? (upperRows[j]?.cells[col.key] ?? "") : ""} maxlength={40} aria-label={col.label} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>{t("sizechart.paste")}</summary>
                <p class="muted">{tf("sizechart.paste_hint", { columns: gridColumns.map((x) => x.label).join("・") })}</p>
                <textarea name="rows_tsv" rows={6} style="width:100%;font-family:monospace" placeholder={rowsToTsv(gridColumns, ownRows.length ? ownRows : (inherited?.rows ?? []).slice(0, 3)) || "S\t66\t48"}></textarea>
              </details>
            </div>
          )}
        </fieldset>

        <label for="note">{t("sizechart.note")}</label>
        <textarea id="note" name="note" rows={3} maxlength={2000} style="width:100%">
          {own?.note ?? ""}
        </textarea>
        <p class="muted">{t("sizechart.note_hint")}</p>
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      <script dangerouslySetInnerHTML={{ __html: RESIZE_SCRIPT }} />
      <AutocheckScript />
    </AdminLayout>,
  );
}

async function save(c: AdminContext) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const level = await levelOf(c, shop);
  if (!level) return c.notFound();
  const base = basePath(shop, level);
  const body = await c.req.parseBody({ all: true });
  const one = (k: string): string => {
    const v = body[k];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" ? s.trim() : "";
  };
  const { db } = owner(c);
  const storage = c.get("adapters").storage;
  const before = await db.rpc<{ own: unknown; inherited: unknown }>("size_chart_get", { p_shop_id: shop.id, ...ids(level) });
  const prev = ownOf(before?.own);
  // 行の欄に出していた列（画面と同じ: この段の列、無ければ上の段の列）
  const gridColumns = prev?.columns ?? sizeChartOf(before?.inherited)?.columns ?? [];

  // 列と行を読む。使うのは「この段で決める」にチェックがあるとき。
  // チェックが無くても、この段にまだ無いもの（上の段を使っていた）に入力があれば、この段で決めたものとして扱う
  // （スクリプトが動かない・古い画面のまま、でも入力が消えないように。この段のものを持っていてチェックを外したときは、上の段に戻す）
  const formColumns: { key?: string; label: string; unit: string | null }[] = [];
  for (let i = 0; i < MAX_COLUMNS; i++) {
    const label = one(`col_label_${i}`);
    if (!label) continue;
    const key = one(`col_key_${i}`);
    formColumns.push({ ...(key ? { key } : {}), label, unit: one(`col_unit_${i}`) || null });
  }
  const gridKeys = gridColumns.map((col) => col.key);
  const tsv = one("rows_tsv");
  const formRows: SizeChartRow[] = [];
  if (tsv) {
    formRows.push(...tsvToRows(gridColumns, tsv));
  } else {
    for (let j = 0; j < MAX_ROWS; j++) {
      const value = one(`row_value_${j}`);
      if (!value) continue;
      const cells: Record<string, string> = {};
      for (const k of gridKeys) {
        const v = one(`cell_${j}_${k}`);
        if (v) cells[k] = v;
      }
      formRows.push({ value, cells });
    }
  }
  const useColumns = one("own_columns") === "on" || (!prev?.columns && formColumns.length > 0);
  const useRows = one("own_rows") === "on" || (!prev?.rows && formRows.length > 0);
  const columns = useColumns ? formColumns : null;
  const rows: SizeChartRow[] | null = useRows ? formRows : null;

  // 図: 新しいファイル > 外す > 今のまま
  let image = prev?.image ?? null;
  let uploaded: string | null = null;
  const file = body["image"];
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_IMAGE_BYTES) return c.redirect(`${base}?flash=image`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    const dim = kind ? imageSize(bytes, kind.contentType) : null;
    if (!kind || !dim || dim.width > 4096 || dim.height > 4096) return c.redirect(`${base}?flash=image`);
    uploaded = `size-charts/${shop.id}/${randomKey()}.${kind.ext}`;
    await storage.put(uploaded, bytes.buffer as ArrayBuffer, kind.contentType);
    image = { key: uploaded, width: dim.width, height: dim.height };
  } else if (one("image_remove") === "on") {
    image = null;
  }

  const data = {
    hidden: level.kind === "product" && one("hidden") === "on",
    axis: columns ? one("axis") || null : null,
    columns,
    rows,
    note: one("note") || null,
    image,
  };
  try {
    const r = await db.rpc<{ old_image_key?: string | null }>("size_chart_set", { p_shop_id: shop.id, ...ids(level), p_data: data });
    const old = r?.old_image_key;
    if (old && old !== image?.key) await storage.delete(old).catch((e: unknown) => console.error("[banto] size chart image:", e));
  } catch (e) {
    if (uploaded) await storage.delete(uploaded).catch(() => undefined);
    if (e instanceof DbError) return c.redirect(`${base}?flash=${/axis/.test(e.message) ? "axis" : "invalid"}`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
}

/** 商品・カテゴリーの画面から開くリンク（モジュールが ON のときだけ） */
export function sizeChartHref(shop: { id: string; settings?: Record<string, unknown> | null }, target: { category?: string; product?: string }): string | null {
  if (!moduleEnabled(shop.settings ?? {}, "size_charts")) return null;
  const base = `/admin/shops/${shop.id}/modules/size-charts`;
  return target.product ? `${base}/products/${target.product}` : target.category ? `${base}/categories/${target.category}` : base;
}

