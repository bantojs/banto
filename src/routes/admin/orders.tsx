import { Hono } from "hono";
import { csvCell } from "../../util/csv";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { ADMIN_PAGE_SIZE, Pager, olderThan, readAfter, searchRows, splitPage, type PagePosition } from "./paging";
import { selectIn } from "../../db/select-in";
import type { OrderItemRow, OrderRow, SkuRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { yen } from "../common";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { createPrivilegedDb } from "../../db/privileged";
import { CancelError, cancelOrderWithRefund } from "../../orders/cancel";
import { actorHeader } from "../../audit";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { orderTaxBreakdown } from "../../commerce/tax";
import { moduleEnabled } from "../../modules/registry";
import { RECEIPT_MODULE, adminReceipt } from "../../modules/receipt/admin";
import { RECEIPT_STATUSES } from "../../modules/receipt/render";
import { deliveryText } from "../../modules/delivery-time";
import { TRACKING_CARRIERS, carrierLabel, isTrackingCarrier, normalizeTracking, trackingUrl } from "../../orders/tracking";
import { ORDER_NOTE_MAX_CHARS, orderTagsOf, parseOrderTags } from "../../orders/tags";
import { SearchBar, readSort, searchChips, searchHref, type SearchParams } from "./search";
import { migrated } from "../../db/migration-state";
import { VIEWS_MIGRATION, ViewTabs, viewsOf } from "./views";

export const orders = new Hono<AppEnv>();

const STATUS_KEY: Record<OrderRow["status"], MessageKey> = {
  paid: "order.status.paid",
  shipped: "order.status.shipped",
  cancelled: "order.status.cancelled",
  refunded: "order.status.refunded",
};

function statusLabel(s: OrderRow["status"]): string {
  return t(STATUS_KEY[s] ?? "order.status.paid");
}

const fmtDate = (iso: string): string => formatDateTime(iso);

/** 一覧と詳細の状態の点: 発送済み=緑、支払い済み（発送待ち）=青、ほか=灰 */
const statusDot = (s: OrderRow["status"]): string => (s === "shipped" ? "on" : s === "paid" ? "info" : "off");

function flash(code: string | undefined): { kind: "ok" | "error"; text: string } | null {
  const map: Record<string, MessageKey> = { saved: "shop.saved", tags_invalid: "order.tags_invalid", masked: "order.mask_done", cancelled: "order.cancelled_ok", refunded: "order.refunded_ok", refund_failed: "order.refund_failed", not_cancellable: "order.not_cancellable", generic: "error.generic", tracking_invalid: "tracking.invalid" };
  const key = code ? map[code] : undefined;
  if (!key) return null;
  return { kind: ["refund_failed", "not_cancellable", "generic", "tracking_invalid", "tags_invalid"].includes(code ?? "") ? "error" : "ok", text: t(key) };
}

interface OrderListRow extends OrderRow {
  number: number;
  shipping_jpy: number;
  /** 0017_tax */
  shipping_tax_rate?: number | string | null;
  tax_rounding?: string | null;
  /** 0018 */
  delivery?: { date?: string | null; slot?: string | null } | null;
  /** 0022 */
  tracking_carrier?: string | null;
  tracking_number?: string | null;
  /** 0106 */
  tags?: string[];
  note?: string | null;
}

/** CSV に入れる注文の上限（一覧と同じ条件の新しい順）。それより多いときは条件で絞る。全件のバックアップは docs/backup.md */
const CSV_MAX_ORDERS = 2000;

/** 一覧の検索を広げる版（電話・送り状番号・支払い方法・日付・金額・並び。0132） */
const ADMIN_SEARCH_MIGRATION = "0132_admin_search";
const ORDER_STATUSES = ["paid", "shipped", "cancelled", "refunded"] as const;
const ORDER_PAYMENTS = ["stripe", "komoju", "amazon_pay", "free"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEN_RE = /^\d{1,9}$/;

/**
 * 一覧と CSV で共通の条件（URL の値）。形の違う値は捨てる（DB も無視する）。
 * 0132 の前の DB では、今までどおりキーワード・状態・印だけ
 */
function orderSearchParams(c: AdminContext, extended: boolean): SearchParams {
  const v = (name: string) => (c.req.query(name) ?? "").trim();
  const status = v("status");
  const out: SearchParams = {
    q: v("q").slice(0, 100),
    status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : "",
    tag: v("tag").slice(0, 40),
  };
  if (!extended) return out;
  const payment = v("payment");
  out["payment"] = (ORDER_PAYMENTS as readonly string[]).includes(payment) ? payment : "";
  out["from"] = DATE_RE.test(v("from")) ? v("from") : "";
  out["to"] = DATE_RE.test(v("to")) ? v("to") : "";
  out["min"] = YEN_RE.test(v("min")) ? v("min") : "";
  out["max"] = YEN_RE.test(v("max")) ? v("max") : "";
  out["sort"] = readSort(v("sort")) === "old" ? "old" : "";
  return out;
}

/**
 * 一覧と CSV で共通: 条件で DB で絞り、limit 件（after より後ろ）を読む。
 * 0132 からは、キーワードか条件があれば検索の関数（admin_search_ids）がすべて絞る（キーワードは番号・メール・氏名・電話・送り状番号・決済の参照）。
 * 条件が無ければ、新しい順に RLS 越しに読む
 */
async function listOrders(c: AdminContext, shopId: string, opts: { limit: number; after?: PagePosition }): Promise<{ rows: OrderListRow[]; params: SearchParams; extended: boolean }> {
  const { db } = owner(c);
  const extended = await migrated({ db, cache: c.get("adapters").cache }, ADMIN_SEARCH_MIGRATION);
  const params = orderSearchParams(c, extended);
  const { q, status, tag } = params as { q: string; status: string; tag: string };
  const filters = Object.fromEntries(Object.entries(params).filter(([k, v]) => k !== "q" && v !== ""));
  if (extended && (q || Object.keys(filters).length > 0)) {
    const rows = await searchRows<OrderListRow>(c, { kind: "orders", shopId, q, filters, ...(opts.after ? { after: opts.after } : {}), limit: opts.limit, columns: "*" });
    return { rows, params, extended };
  }
  // 0132 の前: 印で絞る（0106）のは、検索と一緒のときは検索の結果をここで絞る
  const contains = tag ? { arrayContains: { tags: [tag] } } : {};
  const eq: Record<string, string> = { shop_id: shopId };
  if (status) eq["status"] = status;
  if (q) {
    const found = await searchRows<OrderListRow>(c, { kind: "orders", shopId, q, filters: status ? { status } : {}, ...(opts.after ? { after: opts.after } : {}), limit: opts.limit, columns: "*" });
    return { rows: tag ? found.filter((o) => orderTagsOf(o).includes(tag)) : found, params, extended };
  }
  const rows: OrderListRow[] = [];
  // PostgREST は 1 回 1,000 行まで。CSV のときだけ何回かに分けて読む
  for (let after = opts.after; rows.length < opts.limit; ) {
    const n = Math.min(1000, opts.limit - rows.length);
    const page = await db.from<OrderListRow>("orders").select("*", { eq, ...contains, where: after ? [olderThan(after)] : [], order: "created_at.desc,id.desc", limit: n });
    rows.push(...page);
    if (page.length < n) break;
    const last = page[page.length - 1]!;
    after = { k: last.created_at, id: last.id };
  }
  return { rows, params, extended };
}

const PAYMENT_LABEL: Record<(typeof ORDER_PAYMENTS)[number], MessageKey> = { stripe: "search.payment_stripe", komoju: "search.payment_komoju", amazon_pay: "search.payment_amazon_pay", free: "search.payment_free" };

/** 条件のチップの文字（キーワードと既定の並びはチップにしない） */
function orderChipLabel(name: string, value: string): string | null {
  if (name === "status") return `${t("order.status")}: ${statusLabel(value as OrderRow["status"])}`;
  if (name === "payment") return `${t("order.payment")}: ${t(PAYMENT_LABEL[value as (typeof ORDER_PAYMENTS)[number]] ?? "search.payment_stripe")}`;
  if (name === "from") return tf("search.chip_from", { date: value });
  if (name === "to") return tf("search.chip_to", { date: value });
  if (name === "min") return tf("search.chip_min", { yen: yen(Number(value)) });
  if (name === "max") return tf("search.chip_max", { yen: yen(Number(value)) });
  if (name === "tag") return `${t("order.tags")}: ${value}`;
  if (name === "sort") return t("search.sort_old");
  return null;
}

orders.get("/:shopId/orders", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const after = readAfter(c.req.query("after"));
  if (after === null) return c.text(t("error.generic"), 400);
  const list = await listOrders(c, shopId, { limit: ADMIN_PAGE_SIZE + 1, ...(after ? { after } : {}) });
  const { params, extended } = list;
  const page = splitPage(list.rows, (o) => o.created_at);
  const rows = page.rows;
  const base = `/admin/shops/${shop.id}/orders`;
  const listHref = searchHref(base, params);
  const query = listHref.slice(base.length);
  const tagHref = (v: string) => searchHref(base, { ...params, q: "", tag: v });
  const chips = searchChips(base, params, orderChipLabel);
  // 保存したビュー（0135）
  const viewsOn = await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, VIEWS_MIGRATION);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("order.list")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("order.list") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "orders" }}>
      <PageHead title={t("order.list")}>
        <a class="btn secondary" href={`/admin/shops/${shop.id}/orders.csv${query}`}>
          {chips.length > 0 || params["q"] ? t("search.csv_filtered") : t("order.csv")}
        </a>
      </PageHead>
      <ViewTabs shopId={shop.id} screen="orders" views={viewsOf(shop.settings, "orders")} current={params} enabled={viewsOn} error={c.req.query("view_error")} />
      <SearchBar action={base} q={params["q"] ?? ""} placeholder={t(extended ? "search.orders_placeholder" : "order.search_placeholder")} sortable={extended} sort={readSort(params["sort"])} chips={chips} clearHref={base}>
        <label>
          {t("order.status")}
          <select name="status">
            <option value="">{t("product.state_all")}</option>
            {ORDER_STATUSES.map((st) => (
              <option value={st} selected={params["status"] === st}>
                {statusLabel(st)}
              </option>
            ))}
          </select>
        </label>
        {extended ? (
          <>
            <label>
              {t("order.payment")}
              <select name="payment">
                <option value="">{t("search.any")}</option>
                {ORDER_PAYMENTS.map((pm) => (
                  <option value={pm} selected={params["payment"] === pm}>
                    {t(PAYMENT_LABEL[pm])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("search.from")}
              <input type="date" name="from" value={params["from"] ?? ""} />
            </label>
            <label>
              {t("search.to")}
              <input type="date" name="to" value={params["to"] ?? ""} />
            </label>
            <label>
              {t("search.min")}
              <input type="number" name="min" min={0} step={1} value={params["min"] ?? ""} inputmode="numeric" />
            </label>
            <label>
              {t("search.max")}
              <input type="number" name="max" min={0} step={1} value={params["max"] ?? ""} inputmode="numeric" />
            </label>
          </>
        ) : null}
        <label>
          {t("order.tag_filter")}
          <input type="text" name="tag" value={params["tag"] ?? ""} maxlength={40} />
        </label>
      </SearchBar>
      {rows.length === 0 ? (
        <p>{t("order.none")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("order.id")}</th>
              <th>{t("order.date")}</th>
              <th>{t("order.customer")}</th>
              <th>{t("order.total")}</th>
              <th>{t("order.status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr>
                <td>
                  <a href={`/admin/shops/${shop.id}/orders/${o.id}`}>#{o.number}</a>
                </td>
                <td>{fmtDate(o.created_at)}</td>
                <td>
                  {o.customer_name ?? "-"}
                  {orderTagsOf(o).length > 0 ? (
                    <div class="order-tags" style="margin-top:.25rem;display:flex;gap:.25rem;flex-wrap:wrap">
                      {orderTagsOf(o).map((v) => (
                        <a class="badge" href={tagHref(v)}>
                          {v}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td>{yen(o.total_jpy)}</td>
                <td>
                  {/* 支払い済み（これから発送）= 青、発送済み = 緑、キャンセル・返金 = 灰 */}
                  <span class={`status ${statusDot(o.status)}`}>{statusLabel(o.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager base={listHref} next={page.next} paged={Boolean(after)} />
    </AdminLayout>,
  );
});

/** CSV（Excel 向けに BOM 付き UTF-8）。検索条件は一覧と同じで、新しい順に CSV_MAX_ORDERS 件まで */
orders.get("/:shopId/orders.csv", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { rows } = await listOrders(c, shopId, { limit: CSV_MAX_ORDERS });
  const { db } = owner(c);
  // 明細と SKU は CSV に入る注文の分だけ（ショップ全体を読むと 1,000 行で欠ける）
  const items = await selectIn<OrderItemRow>(db, "order_items", "*", shopId, "order_id", rows.map((o) => o.id));
  const skus = await selectIn<SkuRow>(db, "skus", "id,code,name", shopId, "id", items.map((i) => i.sku_id).filter((id): id is string => Boolean(id)));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const i of items) itemsByOrder.set(i.order_id, [...(itemsByOrder.get(i.order_id) ?? []), i]);
  const header = ["注文番号", "日時", "状態", "合計", "送料", "氏名", "メール", "電話", "郵便番号", "都道府県", "市区町村", "番地", "建物", "明細", "決済", "決済参照", "発送日時", "値引き", "クーポン", "印", "メモ"];
  const lines = rows.map((o) => {
    const a = (o.shipping_address ?? {}) as Record<string, unknown>;
    const detail = (itemsByOrder.get(o.id) ?? [])
      .map((i) => `${(i.sku_id ? skuById.get(i.sku_id)?.code : undefined) ?? i.item_name ?? i.sku_id ?? ""} x${i.qty}`)
      .join(" / ");
    return [o.number, formatDateTime(o.created_at), o.status, o.total_jpy, o.shipping_jpy, o.customer_name, o.customer_email, a["phone"], a["postal_code"], a["state"], a["city"], a["line1"], a["line2"], detail, o.payment_provider, o.payment_ref, o.shipped_at ? formatDateTime(o.shipped_at) : "", o.discount_jpy ?? 0, (o.discounts ?? []).map((d) => d.code).filter(Boolean).join(" "), orderTagsOf(o).join(", "), o.note ?? ""].map(csvCell).join(",");
  });
  const body = "\ufeff" + [header.join(","), ...lines].join("\r\n") + "\r\n";
  return c.body(body, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="orders-${shop.slug}.csv"`, "Cache-Control": "no-store" });
});

orders.get("/:shopId/orders/:orderId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const orderId = param(c, "orderId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const order = await db.from<OrderListRow>("orders").selectOne("*", { eq: { id: orderId, shop_id: shopId } });
  if (!order) return c.text(t("order.not_found"), 404);
  const items = await db.from<OrderItemRow & { tax_rate?: number | string | null }>("order_items").select("*", { eq: { order_id: orderId } });
  const skus = await selectIn<SkuRow>(db, "skus", "id,code,name", shopId, "id", items.map((i) => i.sku_id).filter((id): id is string => Boolean(id)));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const base = `/admin/shops/${shopId}/orders/${orderId}`;
  const addr = order.shipping_address ?? null;
  const msg = flash(c.req.query("flash"));

  return c.html(
    <AdminLayout title={t("order.detail")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("order.list"), href: `/admin/shops/${shop.id}/orders` }, { label: fmtDate(order.created_at) }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "orders" }}>
      <PageHead
        title={
          <>
            #{order.number} <span class={`status ${statusDot(order.status)}`}>{statusLabel(order.status)}</span>
          </>
        }
        sub={`${t("order.detail")} · ${fmtDate(order.created_at)}`}
      >
        {moduleEnabled(shop.settings, RECEIPT_MODULE) && RECEIPT_STATUSES.includes(order.status) ? (
          <a class="btn secondary" href={`${base}/receipt`} target="_blank" rel="noopener">
            {t("receipt.get")}
          </a>
        ) : null}
      </PageHead>
      {msg ? <p class={msg.kind === "ok" ? "notice" : "error"}>{msg.text}</p> : null}
      {typeof order.amount_paid_jpy === "number" && order.amount_paid_jpy !== order.total_jpy ? <p class="error">{t("order.paid_mismatch").replace("{paid}", yen(order.amount_paid_jpy))}</p> : null}
      <div class="split">
        <div>
          <section class="card">
            <h2>{t("order.items")}</h2>
            <table>
              <thead>
                <tr>
                  <th>{t("sku.code")}</th>
                  <th>{t("sku.name")}</th>
                  <th class="num">{t("store.unit_price")}</th>
                  <th class="num">{t("store.qty")}</th>
                  <th class="num">{t("store.subtotal")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const sku = it.sku_id ? skuById.get(it.sku_id) : undefined;
                  return (
                    <tr>
                      <td>
                        <code>{sku?.code ?? it.sku_id ?? "-"}</code>
                      </td>
                      <td>{[it.item_name, it.item_variant ?? sku?.name].filter(Boolean).join(" / ")}</td>
                      <td class="num">{yen(it.unit_price_jpy)}</td>
                      <td class="num">{it.qty}</td>
                      <td class="num">{yen(it.unit_price_jpy * it.qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <dl class="sum">
              <dt>{t("store.subtotal")}</dt>
              <dd>{yen(items.reduce((s, it) => s + it.unit_price_jpy * it.qty, 0))}</dd>
              <dt>{t("store.shipping")}</dt>
              <dd>{yen(order.shipping_jpy)}</dd>
              {order.discount_jpy ? (
                <>
                  <dt>
                    {t("confirm.discount")} <span class="muted">{(order.discounts ?? []).map((d) => `${d.code ?? ""} ${d.name ?? ""}（−${yen(Number(d.amount_jpy ?? 0))}）`).join(" / ")}</span>
                  </dt>
                  <dd>−{yen(order.discount_jpy)}</dd>
                </>
              ) : null}
              <dt class="total">{t("order.total")}</dt>
              <dd class="total">{yen(order.total_jpy)}</dd>
            </dl>
            <ul class="muted">
              {orderTaxBreakdown({ ...order, items }, shop.settings).map((g) => (
                <li>{g.rate > 0 ? tf("tax.group", { rate: g.rate, amount: yen(g.amount_jpy), tax: yen(g.tax_jpy) }) : tf("tax.group_exempt", { amount: yen(g.amount_jpy) })}</li>
              ))}
            </ul>
          </section>

          {order.status === "paid" || order.status === "shipped" ? (
            <section class="card">
              <h2>{order.status === "paid" ? t("order.mark_shipped") : t("tracking.number")}</h2>
              <form method="post" action={`${base}/status`}>
                <input type="hidden" name="status" value={order.status === "paid" ? "shipped" : "tracking"} />
                <label for="tracking_carrier">{t("tracking.carrier")}</label>
                <select id="tracking_carrier" name="tracking_carrier">
                  {TRACKING_CARRIERS.map((k) => (
                    <option value={k} selected={k === (order.tracking_carrier ?? "yamato")}>
                      {carrierLabel(k)}
                    </option>
                  ))}
                </select>
                <label for="tracking_number">{t("tracking.number")}</label>
                <input id="tracking_number" name="tracking_number" value={order.tracking_number ?? ""} maxlength={60} inputmode="numeric" />
                <p class="muted">{order.status === "paid" ? t("tracking.hint_paid") : t("tracking.hint_shipped")}</p>
                <button type="submit">{order.status === "paid" ? t("order.mark_shipped") : t("tracking.save")}</button>
              </form>
            </section>
          ) : null}
        </div>

        <aside>
          <section class="card">
            <h2>{t("order.tags_title")}</h2>
            <form method="post" action={`${base}/annotate`}>
              <label for="tags">{t("order.tags")}</label>
              <input id="tags" name="tags" type="text" value={orderTagsOf(order).join(", ")} placeholder={t("order.tags_placeholder")} style="width:100%" />
              <p class="muted">{t("order.tags_hint")}</p>
              <label for="note">{t("order.note")}</label>
              <textarea id="note" name="note" rows={4} maxlength={ORDER_NOTE_MAX_CHARS} style="width:100%">
                {order.note ?? ""}
              </textarea>
              <p class="muted">{t("order.note_hint")}</p>
              <button type="submit" class="secondary">
                {t("order.tags_save")}
              </button>
            </form>
          </section>
          <section class="card">
            <h2>{t("order.customer")}</h2>
            <p>
              {order.customer_name ?? "-"}
              {order.customer_email ? (
                <>
                  <br />
                  <span class="muted">{order.customer_email}</span>
                </>
              ) : null}
            </p>
          </section>
          <section class="card">
            <h2>{t("order.shipping")}</h2>
            {addr ? (
              <p class="pre">
                {["postal_code", "state", "city", "line1", "line2", "name", "phone"]
                  .map((k) => addr[k])
                  .filter((v) => typeof v === "string" && v)
                  .join("\n")}
              </p>
            ) : (
              <p>-</p>
            )}
            {deliveryText(order.delivery) ? (
              <dl class="kv">
                <dt>{t("delivery.request")}</dt>
                <dd>{deliveryText(order.delivery)}</dd>
              </dl>
            ) : null}
            {order.tracking_number ? (
              <dl class="kv">
                <dt>{t("tracking.number")}</dt>
                <dd>
                  {carrierLabel(order.tracking_carrier)} <code>{order.tracking_number}</code>
                  {trackingUrl(order.tracking_carrier, order.tracking_number) ? (
                    <>
                      {" "}
                      <a href={trackingUrl(order.tracking_carrier, order.tracking_number)!} target="_blank" rel="noopener noreferrer">
                        {t("tracking.check")}
                      </a>
                    </>
                  ) : null}
                </dd>
              </dl>
            ) : null}
          </section>
          <section class="card">
            <h2>{t("order.payment")}</h2>
            <dl class="kv">
              <dt>{t("order.payment")}</dt>
              <dd>
                {order.payment_provider ?? "-"} <code>{order.payment_ref ?? ""}</code>
              </dd>
              <dt>{t("order.id")}</dt>
              <dd>
                #{order.number} <code class="muted">{order.id}</code>
              </dd>
            </dl>
          </section>
          {order.status === "paid" || order.customer_email ? (
            <section class="card danger-zone">
              <h2>{t("order.danger")}</h2>
              {order.status === "paid" ? (
                <>
                  <form method="post" action={`${base}/status`}>
                    <input type="hidden" name="status" value="cancelled" />
                    <button type="submit" class="danger">
                      {t("order.mark_cancelled")}
                    </button>
                  </form>
                  <p class="muted">{t("order.cancel_note")}</p>
                </>
              ) : null}
              {order.customer_email ? (
                <form method="post" action={`${base}/mask`}>
                  <button type="submit">{t("order.mask")}</button>
                </form>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </AdminLayout>,
  );
});

// 領収書（同梱モジュール receipt）
orders.get("/:shopId/orders/:orderId/receipt", requireOwner, (c: AdminContext) => adminReceipt(c));

orders.post("/:shopId/orders/:orderId/status", requireOwner, async (c: AdminContext) => {
  const { db, session } = owner(c);
  const shopId = param(c, "shopId");
  const orderId = param(c, "orderId");
  const f = await formFields(c);
  const status = f.status;
  const back = `/admin/shops/${shopId}/orders/${orderId}`;
  if (status === "cancelled") {
    // 返金 → cancel_order（在庫戻し）。service_role 経路は privileged.ts のみ
    const cfg = c.get("adapters").config;
    const url = cfg.get("SUPABASE_URL");
    const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
    const shop = await loadShop(c, shopId, "orders_cancel");
    if (!url || !serviceRoleKey || !shop) return c.redirect(`${back}?flash=generic`);
    try {
      // 監査ログ（0051）に「誰がキャンセルしたか」を残すため、特権経路でも運営者を名乗る
      const privileged = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch, actor: actorHeader("user", session.user_id) });
      const r = await cancelOrderWithRefund(privileged, orderId, shopId, { config: cfg, fetch: c.get("deps").fetch, stripeAccountId: shop.stripe_account_id });
      return c.redirect(`${back}?flash=${r.refunded ? "refunded" : "cancelled"}`);
    } catch (e) {
      if (e instanceof CancelError) return c.redirect(`${back}?flash=${e.code === "refund_failed" ? "refund_failed" : e.code === "not_cancellable" ? "not_cancellable" : "generic"}`);
      throw e;
    }
  }
  if (status !== "shipped" && status !== "tracking") return c.redirect(`${back}?flash=generic`);
  const rawTracking = (f.tracking_number ?? "").trim();
  if (rawTracking || status === "tracking") {
    // お問い合わせ番号つき（0022 の ship_orders: 支払い済みなら発送済みにして order.shipped、発送済みなら番号だけ）
    const number = normalizeTracking(rawTracking);
    const carrier = f.tracking_carrier;
    if (!number || !isTrackingCarrier(carrier)) return c.redirect(`${back}?flash=tracking_invalid`);
    try {
      const o = await db.from<OrderListRow>("orders").selectOne("number", { eq: { id: orderId, shop_id: shopId } });
      if (!o) return c.redirect(`${back}?flash=generic`);
      const r = await db.rpc<{ shipped: number; updated: number }>("ship_orders", { p_shop_id: shopId, p_items: [{ number: o.number, carrier, tracking: number }] });
      return c.redirect(`${back}?flash=${r.shipped + r.updated > 0 ? "saved" : "generic"}`);
    } catch (e) {
      if (e instanceof DbError) return c.redirect(`${back}?flash=generic`);
      throw e;
    }
  }
  try {
    const rows = await db.from<OrderListRow>("orders").update({ status: "shipped", shipped_at: new Date().toISOString() }, { id: orderId, shop_id: shopId, status: "paid" });
    if (rows.length === 0) return c.redirect(`${back}?flash=generic`);
    const o = rows[0]!;
    await db.rpc("enqueue_hook", {
      p_shop_id: shopId,
      p_event: "order.shipped",
      p_payload: { order_id: o.id, order_number: o.number, shop_id: shopId, total_jpy: o.total_jpy, status: o.status, shipped_at: o.shipped_at ?? null, customer_id: o.customer_id ?? null },
    });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=generic`);
    throw e;
  }
  return c.redirect(`${back}?flash=saved`);
});

/** 印とメモを保存（0106、項目 orders。判定と形の検査は DB の order_annotate） */
orders.post("/:shopId/orders/:orderId/annotate", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const orderId = param(c, "orderId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const back = `/admin/shops/${shopId}/orders/${orderId}`;
  const f = await formFields(c);
  try {
    await owner(c).db.rpc("order_annotate", { p_shop_id: shopId, p_order_id: orderId, p_tags: parseOrderTags(f.tags ?? ""), p_note: (f.note ?? "").slice(0, ORDER_NOTE_MAX_CHARS), p_note_set: true });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=${/not_found/.test(e.message) ? "generic" : "tags_invalid"}`);
    throw e;
  }
  return c.redirect(`${back}?flash=saved`);
});

orders.post("/:shopId/orders/:orderId/mask", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const orderId = param(c, "orderId");
  const order = await db.from<OrderRow>("orders").selectOne("customer_email", { eq: { id: orderId, shop_id: shopId } });
  if (!order) return c.text(t("order.not_found"), 404);
  if (order.customer_email) {
    await db.rpc("mask_customer", { p_shop_id: shopId, p_email: order.customer_email });
  }
  return c.redirect(`/admin/shops/${shopId}/orders/${orderId}?flash=masked`);
});
