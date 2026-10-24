/**
 * お店で試着の申し込みの一覧と 1 件の画面（ショップの画面と実店舗のスタッフの画面で共通。0025）。
 * 1 件は tryon_request_detail（ショップの stores の項目か、その実店舗の tryon の項目）で読む。
 * 在庫を EC に戻すボタンは、ショップの stores の項目を持つ人にだけ出す（DB の tryon_restock も同じ項目で止める）。
 */
import type { Child } from "hono/jsx";
import { DbError } from "../../db/client";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, type Crumb, type ShopTabs } from "../../routes/admin/layout";
import { formFields, owner, type AdminContext } from "../../routes/admin/context";
import { yen } from "../../routes/common";
import { dateLabel, holdUntil, todayHere, tryonSettings, type SpecialDay, type TimeRange } from "./index";

export const TRYON_STATUSES = ["requested", "sent", "ready", "purchased", "not_purchased", "expired", "cancelled"] as const;
export type TryonStatus = (typeof TRYON_STATUSES)[number];
export const isTryonStatus = (s: unknown): s is TryonStatus => typeof s === "string" && (TRYON_STATUSES as readonly string[]).includes(s);
export const statusLabel = (s: string) => t(`tryon.status_${isTryonStatus(s) ? s : "requested"}` as MessageKey);
/** 0025 の tryon_update と同じ遷移（画面にボタンを出すため） */
const NEXT: Record<TryonStatus, TryonStatus[]> = {
  requested: ["sent", "ready", "cancelled"],
  sent: ["ready", "cancelled"],
  ready: ["purchased", "not_purchased", "ready", "cancelled"],
  purchased: [],
  not_purchased: [],
  expired: ["purchased", "not_purchased"],
  cancelled: [],
};

export interface RequestRow {
  id: string;
  shop_id: string;
  store_id: string;
  number: number;
  status: TryonStatus;
  visit_date: string | null;
  hold_until: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  restocked: boolean;
  created_at: string;
}

export interface RequestDetail {
  request: RequestRow;
  store: { id: string; name: string; hours: Record<string, TimeRange[]>; special_days: SpecialDay[] } | null;
  shop: { id: string; name: string; settings: Record<string, unknown> };
  can_restock: boolean;
  items: { sku_id: string; code: string | null; product: string | null; sku: string | null; qty: number; unit_price_jpy: number }[];
}

const FLASH: Record<string, MessageKey> = {
  saved: "tryon.saved",
  invalid_hours: "tryon.invalid_hours",
  invalid_store: "tryon.invalid_store",
  invalid_transition: "tryon.invalid_transition",
  restocked: "tryon.restocked",
  generic: "error.generic",
};

export function Flash({ code, detail }: { code?: string; detail?: string }) {
  const key = code ? FLASH[code] : undefined;
  if (!key) return null;
  return <p class={code === "saved" || code === "restocked" ? "notice" : "error"}>{detail ? tf(key, { detail }) : t(key)}</p>;
}

/** 状態・店舗の絞り込みと一覧の表 */
export function RequestList(props: {
  action: string;
  requests: RequestRow[];
  stores: { id: string; name: string }[];
  status: string;
  store: string;
  href: (r: RequestRow) => string;
  shopName?: (r: RequestRow) => string;
}) {
  const storeName = new Map(props.stores.map((x) => [x.id, x.name]));
  return (
    <>
      <form method="get" action={props.action}>
        <select name="status">
          <option value="">{t("tryon.all_statuses")}</option>
          {TRYON_STATUSES.map((st) => (
            <option value={st} selected={st === props.status}>
              {statusLabel(st)}
            </option>
          ))}
        </select>{" "}
        {props.stores.length > 1 ? (
          <select name="store">
            <option value="">{t("tryon.all_stores")}</option>
            {props.stores.map((st) => (
              <option value={st.id} selected={st.id === props.store}>
                {st.name}
              </option>
            ))}
          </select>
        ) : null}{" "}
        <button type="submit">{t("tryon.filter")}</button>
      </form>
      {props.requests.length === 0 ? (
        <p class="muted">{t("tryon.no_requests")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("tryon.number")}</th>
              <th>{t("tryon.created_at")}</th>
              <th>{props.shopName ? t("nav.shops") : t("tryon.store")}</th>
              <th>{t("tryon.customer")}</th>
              <th>{t("tryon.status")}</th>
              <th>{t("tryon.visit_or_hold")}</th>
            </tr>
          </thead>
          <tbody>
            {props.requests.map((r) => (
              <tr>
                <td>
                  <a href={props.href(r)}>#{r.number}</a>
                </td>
                <td>{formatDateTime(r.created_at)}</td>
                <td>{props.shopName ? props.shopName(r) : (storeName.get(r.store_id) ?? "")}</td>
                <td>{r.customer_name ?? ""}</td>
                <td>{statusLabel(r.status)}</td>
                <td>{r.hold_until ? tf("tryon.hold_until_short", { date: dateLabel(r.hold_until) }) : r.visit_date ? tf("tryon.visit_short", { date: dateLabel(r.visit_date) }) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 1 件（0025 の tryon_request_detail）。触れない申し込みなら null */
export async function loadRequest(c: AdminContext, id: string): Promise<RequestDetail | null> {
  try {
    return await owner(c).db.rpc<RequestDetail | null>("tryon_request_detail", { p_request_id: id });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null; // id の形が違う
    throw e;
  }
}

export function RequestPage(props: { d: RequestDetail; base: string; crumbs: Crumb[]; shopTabs?: ShopTabs; flash?: string; detail?: string }) {
  const { d, base } = props;
  const r = d.request;
  const s = tryonSettings(d.shop.settings);
  // 取り置きの期限の既定: おまかせなら今日から、来店日の指定なら来店日から hold_days 日（休みの日なら次の営業日）
  const today = todayHere();
  const from = s.mode === "visit" && r.visit_date && r.visit_date > today ? r.visit_date : today;
  const defaultHold = r.hold_until ?? (d.store ? holdUntil(d.store, from, s.hold_days) : from);
  const next = NEXT[r.status] ?? [];
  const url = `${base}/requests/${r.id}`;
  return (
    <AdminLayout title={`${d.shop.name} · #${r.number}`} nav crumbs={props.crumbs} shopTabs={props.shopTabs}>
      <h1>
        {t("tryon.request")} #{r.number}
      </h1>
      <Flash code={props.flash} detail={props.detail} />
      <table>
        <tbody>
          <tr>
            <th>{t("tryon.status")}</th>
            <td>{statusLabel(r.status)}</td>
          </tr>
          <tr>
            <th>{t("tryon.created_at")}</th>
            <td>{formatDateTime(r.created_at)}</td>
          </tr>
          <tr>
            <th>{t("nav.shops")}</th>
            <td>{d.shop.name}</td>
          </tr>
          <tr>
            <th>{t("tryon.store")}</th>
            <td>{d.store?.name ?? ""}</td>
          </tr>
          {r.visit_date ? (
            <tr>
              <th>{t("tryon.visit_date")}</th>
              <td>{dateLabel(r.visit_date)}</td>
            </tr>
          ) : null}
          {r.hold_until ? (
            <tr>
              <th>{t("tryon.hold_until")}</th>
              <td>{dateLabel(r.hold_until)}</td>
            </tr>
          ) : null}
          <tr>
            <th>{t("tryon.customer")}</th>
            <td>
              {r.customer_name ?? ""}
              <br />
              {r.customer_email ?? ""} {r.customer_phone ?? ""}
              {r.customer_id ? (
                <>
                  <br />
                  <span class="muted">{t("tryon.member")}</span>
                </>
              ) : null}
            </td>
          </tr>
          {r.note ? (
            <tr>
              <th>{t("tryon.note")}</th>
              <td>{r.note}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <h2>{t("tryon.items")}</h2>
      <table>
        <tbody>
          {d.items.map((i) => (
            <tr>
              <td>
                <code>{i.code ?? ""}</code>
              </td>
              <td>
                {i.product ?? ""}
                {i.sku ? ` / ${i.sku}` : ""}
              </td>
              <td>×{i.qty}</td>
              <td>{yen(i.unit_price_jpy * i.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {next.length > 0 ? (
        <>
          <h2>{t("tryon.change_status")}</h2>
          {next.includes("ready") ? (
            <form method="post" action={`${url}/status`}>
              <input type="hidden" name="status" value="ready" />
              <label for="hold_until">{t("tryon.hold_until")}</label>
              <input id="hold_until" type="date" name="hold_until" value={defaultHold} required /> <button type="submit">{r.status === "ready" ? t("tryon.change_hold") : t("tryon.to_ready")}</button>
              <p class="muted">{t("tryon.ready_hint")}</p>
            </form>
          ) : null}
          <p>
            {next
              .filter((st) => st !== "ready")
              .map((st) => (
                <form method="post" action={`${url}/status`} style="display:inline-block;margin-right:.5rem">
                  <input type="hidden" name="status" value={st} />
                  <button type="submit">{t(`tryon.to_${st}` as MessageKey)}</button>
                </form>
              ))}
          </p>
        </>
      ) : null}
      {["not_purchased", "expired", "cancelled"].includes(r.status) ? (
        r.restocked ? (
          <p class="muted">{t("tryon.restocked_already")}</p>
        ) : d.can_restock ? (
          <form method="post" action={`${url}/restock`}>
            <button type="submit">{t("tryon.restock")}</button>
            <p class="muted">{t("tryon.restock_hint")}</p>
          </form>
        ) : (
          <p class="muted">{t("tryon.restock_by_shop")}</p>
        )
      ) : null}
    </AdminLayout>
  );
}

/** 状態を進める。戻り値はリダイレクト先 */
export async function postStatus(c: AdminContext, d: RequestDetail, base: string): Promise<string> {
  const f = await formFields(c);
  const status = f.status ?? "";
  const hold = /^\d{4}-\d{2}-\d{2}$/.test(f.hold_until ?? "") ? f.hold_until! : null;
  const back = `${base}/requests/${d.request.id}`;
  if (!isTryonStatus(status) || (status === "ready" && !hold)) return `${back}?flash=invalid_transition`;
  try {
    await owner(c).db.rpc("tryon_update", { p_shop_id: d.request.shop_id, p_request_id: d.request.id, p_status: status, p_hold_until: status === "ready" ? hold : null });
  } catch (e) {
    if (e instanceof DbError) return `${back}?flash=${e.message.includes("invalid_transition") ? "invalid_transition" : "generic"}`;
    throw e;
  }
  return `${back}?flash=saved`;
}
