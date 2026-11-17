import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { t, tf } from "../../i18n";
import { namedOptionEntries, optionNamesOf } from "../../products/option-names";
import type { ShopRow } from "../../db/types";
import { requireOwner } from "./auth";
import { formFields, owner, param, type AdminContext } from "./context";
import { AdminLayout, PageHead } from "./layout";
import { Pager } from "./paging";
import { SearchBar, searchChips, searchHref, type SearchParams } from "./search";
import { loadShop } from "./shops";

/**
 * 在庫の画面（商品をまたいで全 SKU を 1 つの表に。メンテナの決定 2026-11-08「在庫は差でも変えられる RPC を足す」、0136）。
 *   - 入荷・出荷: 足す・引く数を入れる（stock_adjust。DB の条件付きの更新で、開いてから保存までに売れた分を上書きしない）
 *   - 棚卸し: 数えた数を入れる（stock_count。開いたときの数を一緒に送り、そのあいだに動いた SKU があれば何も変えずに知らせる）
 * 入れた欄だけを送る。断られたときは、入れた値を残したまま今の数で表を描き直す（そのまま確かめて送り直せる）。
 * キーワードは品番・JAN の完全一致を含むので、バーコードの読み取りで 1 行に絞れる。
 */
export const INVENTORY_MIGRATION = "0136_inventory_ops";
const PAGE_SIZE = 100;

type Mode = "adjust" | "count";
interface InventoryRow {
  sku_id: string;
  code: string;
  gtin: string | null;
  name: string | null;
  options: Record<string, unknown> | null;
  product_id: string;
  product_name: string;
  available: number;
}
interface Conflict {
  code: string;
  expected: number;
  current: number;
  available: number;
}
interface Problem {
  /** 知らせの文 */
  error: string;
  /** 入れた値（sku_id → 文字） */
  values: Record<string, string>;
  conflicts?: Conflict[];
}

/** URL の条件（知らない名前は捨てる。品番は 200 字まで） */
function readParams(get: (name: string) => string | undefined): { params: SearchParams; mode: Mode; after: string | null } {
  const q = (get("q") ?? "").trim().slice(0, 100);
  const stock = get("stock") === "out" ? "out" : "";
  const mode: Mode = get("mode") === "count" ? "count" : "adjust";
  const after = (get("after") ?? "").slice(0, 200) || null;
  return { params: { q, stock, mode: mode === "count" ? "count" : "" }, mode, after };
}

/** 入荷・出荷の欄の値（+ と - を許す。空は送らない） */
const DELTA_RE = /^[+-]?\d{1,7}$/;
/** 棚卸しの欄の値 */
const COUNT_RE = /^\d{1,9}$/;
const normalizeNumber = (v: string): string => v.replace(/[０-９＋－−]/g, (ch) => (ch === "＋" ? "+" : ch === "－" || ch === "−" ? "-" : String.fromCharCode(ch.charCodeAt(0) - 0xfee0))).trim();

export const inventory = new Hono<AppEnv>();

async function renderPage(c: AdminContext, shop: ShopRow, get: (name: string) => string | undefined, problem?: Problem, status: 200 | 400 | 409 = 200) {
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const enabled = await migrated(deps, INVENTORY_MIGRATION);
  const { params, mode, after } = readParams(get);
  const base = `/admin/shops/${shop.id}/inventory`;
  const listHref = searchHref(base, params);
  const rows = enabled
    ? await owner(c).db.rpc<InventoryRow[]>("inventory_list", { p_shop_id: shop.id, p_q: params["q"] || null, p_stock: params["stock"] || null, p_after_code: after, p_limit: PAGE_SIZE + 1 })
    : [];
  const shown = rows.slice(0, PAGE_SIZE);
  const next = rows.length > PAGE_SIZE ? encodeURIComponent(shown[shown.length - 1]!.code) : null;
  const names = optionNamesOf(shop.option_names);
  const chips = searchChips(base, params, (name) => (name === "stock" ? t("inventory.out_only") : null));
  const modeHref = (m: Mode) => searchHref(base, { ...params, mode: m === "count" ? "count" : "" });
  const flash = c.req.query("flash");
  const n = c.req.query("n") ?? "0";
  const values = problem?.values ?? {};
  const action = `${base}/${mode}`;
  const filtered = Boolean(params["q"] || params["stock"]);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("inventory.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("inventory.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "products", here: "inventory" }}>
      <PageHead title={t("inventory.title")} sub={t("inventory.lead")} />
      {!enabled ? (
        <p class="notice">
          {t("inventory.needs_update")} <a href="/admin/update">{t("inventory.open_update")}</a>
        </p>
      ) : (
        <>
          {flash === "adjusted" ? <p class="notice">{tf("inventory.adjusted", { n })}</p> : null}
          {flash === "counted" ? <p class="notice">{tf("inventory.counted", { n })}</p> : null}
          {flash === "nothing" ? <p class="notice">{t("inventory.nothing")}</p> : null}
          {problem ? <p class="error">{problem.error}</p> : null}
          {problem?.conflicts && problem.conflicts.length > 0 ? (
            <table class="inventory-conflicts">
              <thead>
                <tr>
                  <th>{t("inventory.code")}</th>
                  <th class="num">{t("inventory.when_opened")}</th>
                  <th class="num">{t("inventory.now")}</th>
                  <th class="num">{t("inventory.entered")}</th>
                </tr>
              </thead>
              <tbody>
                {problem.conflicts.map((x) => (
                  <tr>
                    <td>{x.code}</td>
                    <td class="num">{x.expected}</td>
                    <td class="num">{x.current}</td>
                    <td class="num">{x.available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <nav class="viewtabs" aria-label={t("inventory.mode")}>
            <a href={modeHref("adjust")} aria-current={mode === "adjust" ? "page" : undefined}>
              {t("inventory.mode_adjust")}
            </a>
            <a href={modeHref("count")} aria-current={mode === "count" ? "page" : undefined}>
              {t("inventory.mode_count")}
            </a>
          </nav>
          <SearchBar action={base} q={params["q"] ?? ""} placeholder={t("inventory.search_placeholder")} chips={chips} clearHref={searchHref(base, { mode: params["mode"] ?? "" })}>
            <input type="hidden" name="mode" value={params["mode"] ?? ""} />
            <label>
              {t("inventory.stock_filter")}
              <select name="stock">
                <option value="">{t("search.any")}</option>
                <option value="out" selected={params["stock"] === "out"}>
                  {t("inventory.out_only")}
                </option>
              </select>
            </label>
          </SearchBar>
          {shown.length === 0 ? (
            <p>{filtered ? t("inventory.no_match") : t("inventory.none")}</p>
          ) : (
            <form method="post" action={action} class="inventory-form">
              <input type="hidden" name="back" value={listHref.slice(base.length) + (after ? `${listHref.includes("?") ? "&" : "?"}after=${encodeURIComponent(after)}` : "")} />
              <p class="muted">{mode === "adjust" ? t("inventory.adjust_hint") : t("inventory.count_hint")}</p>
              <table>
                <thead>
                  <tr>
                    <th>{t("inventory.product")}</th>
                    <th>{t("inventory.code")}</th>
                    <th>{t("inventory.gtin")}</th>
                    <th class="num">{t("inventory.available")}</th>
                    <th class="num">{mode === "adjust" ? t("inventory.delta") : t("inventory.counted_value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const opts = namedOptionEntries(r.options, names)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" / ");
                    const label = `${r.product_name} ${r.code}`;
                    return (
                      <tr>
                        <td>
                          <a href={`/admin/shops/${shop.id}/products/${r.product_id}`}>{r.product_name}</a>
                          {r.name || opts ? <span class="muted" style="display:block">{[r.name, opts].filter(Boolean).join(" · ")}</span> : null}
                        </td>
                        <td>{r.code}</td>
                        <td>{r.gtin ?? "-"}</td>
                        <td class={r.available === 0 ? "num error" : "num"}>{r.available}</td>
                        <td class="num">
                          {mode === "adjust" ? (
                            <input type="text" inputmode="numeric" name={`d_${r.sku_id}`} value={values[r.sku_id] ?? ""} placeholder="+0" aria-label={tf("inventory.delta_for", { sku: label })} size={7} maxlength={9} pattern="[+\-＋－−]?[0-9０-９]{1,7}" />
                          ) : (
                            <>
                              <input type="hidden" name={`e_${r.sku_id}`} value={String(r.available)} />
                              <input type="text" inputmode="numeric" name={`c_${r.sku_id}`} value={values[r.sku_id] ?? ""} placeholder={String(r.available)} aria-label={tf("inventory.count_for", { sku: label })} size={7} maxlength={9} pattern="[0-9０-９]{1,9}" />
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p>
                <button type="submit">{mode === "adjust" ? t("inventory.adjust_submit") : t("inventory.count_submit")}</button>
              </p>
            </form>
          )}
          <Pager base={listHref} next={next} paged={Boolean(after)} />
        </>
      )}
    </AdminLayout>,
    status,
  );
}

inventory.get("/:shopId/inventory", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  return renderPage(c, shop, (name) => c.req.query(name));
});

/** 送られた欄（prefix_<sku_id>）→ sku_id と値 */
function entries(f: Record<string, string>, prefix: string): [string, string][] {
  return Object.entries(f)
    .filter(([k, v]) => k.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(k.slice(prefix.length)) && v.trim() !== "")
    .map(([k, v]) => [k.slice(prefix.length), normalizeNumber(v)]);
}

/** 戻り先の条件（hidden の back。知らない名前は捨てる） */
function backParams(back: string | undefined): URLSearchParams {
  const src = new URLSearchParams((back ?? "").replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const k of ["q", "stock", "mode", "after"]) {
    const v = src.get(k);
    if (v) out.set(k, v);
  }
  return out;
}

const redirectBack = (c: AdminContext, shopId: string, back: URLSearchParams, flash: string, n?: number) => {
  const qs = new URLSearchParams(back);
  qs.set("flash", flash);
  if (n !== undefined) qs.set("n", String(n));
  return c.redirect(`/admin/shops/${shopId}/inventory?${qs.toString()}`);
};

/** 入荷・出荷（足す・引く。1 つでも足りなければ、どれも変えない） */
inventory.post("/:shopId/inventory/adjust", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const back = backParams(f.back);
  const get = (name: string) => back.get(name) ?? undefined;
  const input = entries(f, "d_");
  const values = Object.fromEntries(input);
  if (input.some(([, v]) => !DELTA_RE.test(v))) return renderPage(c, shop, get, { error: t("inventory.invalid"), values }, 400);
  const items = input.map(([sku_id, v]) => ({ sku_id, delta: Number.parseInt(v, 10) })).filter((x) => x.delta !== 0);
  if (items.length === 0) return redirectBack(c, shop.id, back, "nothing");
  try {
    await owner(c).db.rpc("stock_adjust", { p_shop_id: shop.id, p_items: items });
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
    const short = /insufficient_stock:(.+)$/.exec(e.message);
    const error = short ? tf("inventory.insufficient", { code: short[1]!.trim() }) : t("inventory.invalid");
    return renderPage(c, shop, get, { error, values }, short ? 409 : 400);
  }
  return redirectBack(c, shop.id, back, "adjusted", items.length);
});

/** 棚卸し（数えた数に置き換える。開いてから動いた SKU があれば、どれも変えずに知らせる） */
inventory.post("/:shopId/inventory/count", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const back = backParams(f.back);
  const get = (name: string) => back.get(name) ?? undefined;
  const input = entries(f, "c_");
  const values = Object.fromEntries(input);
  if (input.some(([id, v]) => !COUNT_RE.test(v) || !/^-?\d{1,9}$/.test(f[`e_${id}`] ?? ""))) return renderPage(c, shop, get, { error: t("inventory.invalid"), values }, 400);
  const items = input.map(([sku_id, v]) => ({ sku_id, expected: Number.parseInt(f[`e_${sku_id}`]!, 10), available: Number.parseInt(v, 10) }));
  if (items.length === 0) return redirectBack(c, shop.id, back, "nothing");
  let r: { ok: boolean; updated?: number; conflicts?: Conflict[] };
  try {
    r = await owner(c).db.rpc<typeof r>("stock_count", { p_shop_id: shop.id, p_items: items });
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
    return renderPage(c, shop, get, { error: t("inventory.invalid"), values }, 400);
  }
  if (!r.ok) return renderPage(c, shop, get, { error: t("inventory.conflict"), values, conflicts: r.conflicts ?? [] }, 409);
  return redirectBack(c, shop.id, back, "counted", r.updated ?? 0);
});
