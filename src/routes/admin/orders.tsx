import { Hono } from "hono";
import { csvCell } from "../../util/csv";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
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
  const map: Record<string, MessageKey> = { saved: "shop.saved", masked: "order.mask_done", cancelled: "order.cancelled_ok", refunded: "order.refunded_ok", refund_failed: "order.refund_failed", not_cancellable: "order.not_cancellable", generic: "error.generic", tracking_invalid: "tracking.invalid" };
  const key = code ? map[code] : undefined;
  if (!key) return null;
  return { kind: ["refund_failed", "not_cancellable", "generic", "tracking_invalid"].includes(code ?? "") ? "error" : "ok", text: t(key) };
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
}

function matches(o: OrderListRow, q: string): boolean {
  const needle = q.toLowerCase();
  return String(o.number) === needle || (o.customer_email ?? "").toLowerCase().includes(needle) || (o.customer_name ?? "").toLowerCase().includes(needle) || (o.payment_ref ?? "").toLowerCase() === needle;
}

async function listOrders(c: AdminContext, shopId: string): Promise<{ rows: OrderListRow[]; q: string; status: string }> {
  const { db } = owner(c);
  const q = (c.req.query("q") ?? "").trim();
  const status = c.req.query("status") ?? "";
  const eq: Record<string, string> = { shop_id: shopId };
  if (["paid", "shipped", "cancelled", "refunded"].includes(status)) eq["status"] = status;
  const rows = await db.from<OrderListRow>("orders").select("*", { eq, order: "created_at.desc", limit: 500 });
  return { rows: q ? rows.filter((o) => matches(o, q)) : rows, q, status };
}


orders.get("/:shopId/orders", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  void db;
  const { rows, q, status } = await listOrders(c, shopId);
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) }).toString();
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("order.list")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("order.list") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "orders" }}>
      <PageHead title={t("order.list")}>
        <a class="btn secondary" href={`/admin/shops/${shop.id}/orders.csv${query ? `?${query}` : ""}`}>
          {t("order.csv")}
        </a>
      </PageHead>
      <form method="get" action={`/admin/shops/${shop.id}/orders`} class="toolbar">
        <input id="q" type="search" name="q" value={q} placeholder={t("order.search_placeholder")} aria-label={t("order.search")} />
        <select id="status" name="status" aria-label={t("order.status")}>
            <option value="">{t("product.state_all")}</option>
            {(["paid", "shipped", "cancelled", "refunded"] as const).map((st) => (
              <option value={st} selected={status === st}>
                {statusLabel(st)}
              </option>
            ))}
        </select>
        <button type="submit" class="secondary small">
          {t("order.search")}
        </button>
      </form>
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
                <td>{o.customer_name ?? "-"}</td>
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
    </AdminLayout>,
  );
});

/** CSV（Excel 向けに BOM 付き UTF-8）。検索条件は一覧と同じ */
orders.get("/:shopId/orders.csv", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { rows } = await listOrders(c, shopId);
  const { db } = owner(c);
  const [items, skus] = await Promise.all([
    db.from<OrderItemRow>("order_items").select("*", { eq: { shop_id: shopId } }),
    db.from<SkuRow>("skus").select("id,code,name", { eq: { shop_id: shopId } }),
  ]);
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const header = ["注文番号", "日時", "状態", "合計", "送料", "氏名", "メール", "電話", "郵便番号", "都道府県", "市区町村", "番地", "建物", "明細", "決済", "決済参照", "発送日時", "値引き", "クーポン"];
  const lines = rows.map((o) => {
    const a = (o.shipping_address ?? {}) as Record<string, unknown>;
    const detail = items
      .filter((i) => i.order_id === o.id)
      .map((i) => `${(i.sku_id ? skuById.get(i.sku_id)?.code : undefined) ?? i.item_name ?? i.sku_id ?? ""} x${i.qty}`)
      .join(" / ");
    return [o.number, formatDateTime(o.created_at), o.status, o.total_jpy, o.shipping_jpy, o.customer_name, o.customer_email, a["phone"], a["postal_code"], a["state"], a["city"], a["line1"], a["line2"], detail, o.payment_provider, o.payment_ref, o.shipped_at ? formatDateTime(o.shipped_at) : "", o.discount_jpy ?? 0, (o.discounts ?? []).map((d) => d.code).filter(Boolean).join(" ")].map(csvCell).join(",");
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
  const [items, skus] = await Promise.all([
    db.from<OrderItemRow & { tax_rate?: number | string | null }>("order_items").select("*", { eq: { order_id: orderId } }),
    db.from<SkuRow>("skus").select("id,code,name", { eq: { shop_id: shopId } }),
  ]);
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const base = `/admin/shops/${shopId}/orders/${orderId}`;
  const addr = order.shipping_address ?? null;
  const msg = flash(c.req.query("flash"));

  return c.html(
    <AdminLayout title={t("order.detail")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("order.list"), href: `/admin/shops/${shop.id}/orders` }, { label: fmtDate(order.created_at) }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "orders" }}>
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
