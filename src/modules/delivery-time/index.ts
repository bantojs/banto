/**
 * 配送日時の指定（同梱モジュール delivery_time、既定 OFF。docs/delivery-time.md）。
 * 時間帯はヤマト運輸・佐川急便で共通の区分（メンテナの決定 2026-10-17）。お届け日は「注文日から最短 N 日〜最長 M 日」（ショップの設定）。
 * チェックアウト（src/commerce/checkout.ts）が配送先と一緒に受け取り、quote に署名して残し、注文の orders.delivery（0018）に入る。
 * 日付はデプロイの時間帯（BANTO_TIMEZONE、既定 Asia/Tokyo）で数える。
 */
import { moduleEnabled } from "../registry";
import { getTimeZone } from "../../i18n/time";
import { getLocale, t, type MessageKey } from "../../i18n";

export const DELIVERY_MODULE = "delivery_time";
export const DELIVERY_SLOTS = ["am", "14-16", "16-18", "18-20", "19-21"] as const;
export type DeliverySlot = (typeof DELIVERY_SLOTS)[number];

export interface DeliverySettings {
  /** 注文日から何日後からお届け日を選べるか */
  min_days: number;
  /** 何日後まで選べるか */
  max_days: number;
  /** 選べる時間帯 */
  slots: DeliverySlot[];
}

export const DEFAULT_DELIVERY: DeliverySettings = { min_days: 3, max_days: 14, slots: [...DELIVERY_SLOTS] };

export function isDeliverySlot(v: unknown): v is DeliverySlot {
  return typeof v === "string" && (DELIVERY_SLOTS as readonly string[]).includes(v);
}

const intIn = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

/** モジュールが OFF なら null */
export function deliverySettings(settings: Record<string, unknown> | null | undefined): DeliverySettings | null {
  if (!moduleEnabled(settings, DELIVERY_MODULE)) return null;
  const raw = (settings ?? {})["delivery_time"];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const min = intIn(o["min_days"], 0, 60, DEFAULT_DELIVERY.min_days);
  const max = Math.max(min, intIn(o["max_days"], 0, 90, DEFAULT_DELIVERY.max_days));
  const slots = Array.isArray(o["slots"]) ? DELIVERY_SLOTS.filter((s) => (o["slots"] as unknown[]).includes(s)) : [...DEFAULT_DELIVERY.slots];
  return { min_days: min, max_days: max, slots };
}

/** その時間帯の「今日」（YYYY-MM-DD） */
export function todayIn(tz: string, now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 表示用の日付（10月20日（火）） */
export function dateLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const ja = getLocale() !== "en";
  const s = new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { timeZone: "UTC", month: ja ? "long" : "short", day: "numeric", weekday: "short" }).format(d);
  return ja ? s.replace(/\((.)\)/, "（$1）") : s;
}

export function slotLabel(slot: DeliverySlot): string {
  return t(`delivery.slot_${slot.replace("-", "_")}` as MessageKey);
}

/** 選べるお届け日 */
export function deliveryDates(ds: DeliverySettings, now: number = Date.now(), tz: string = getTimeZone()): { value: string; label: string }[] {
  const today = todayIn(tz, now);
  const out: { value: string; label: string }[] = [];
  for (let i = ds.min_days; i <= ds.max_days; i++) {
    const v = addDays(today, i);
    out.push({ value: v, label: dateLabel(v) });
  }
  return out;
}

/** 配送先の画面で出す選択肢（同梱テーマの AddressPage と、ヘッドレスのカートの応答 `delivery` で同じもの） */
export interface DeliveryOptions {
  dates: { value: string; label: string }[];
  slots: { value: DeliverySlot; label: string }[];
}

/** 配送日時の選択肢。モジュールが OFF なら null。キャッシュ済みのショップ行だけで決まる（DB を読まない） */
export function deliveryOptions(settings: Record<string, unknown> | null | undefined, now: number = Date.now(), tz: string = getTimeZone()): DeliveryOptions | null {
  const ds = deliverySettings(settings);
  return ds ? { dates: deliveryDates(ds, now, tz), slots: ds.slots.map((sl) => ({ value: sl, label: slotLabel(sl) })) } : null;
}

export interface DeliveryRequest {
  date: string | null;
  slot: DeliverySlot | null;
}

/**
 * 入力（YYYY-MM-DD と時間帯の id。空なら「指定なし」）をショップの設定で確かめる。
 * モジュールが OFF なら常に「指定なし」（送られてきても使わない）。範囲外・選べない時間帯は invalid
 */
export function checkDelivery(settings: Record<string, unknown> | null | undefined, rawDate: string, rawSlot: string, now: number = Date.now(), tz: string = getTimeZone()): { ok: true; request: DeliveryRequest | null } | { ok: false; invalid: ("delivery_date" | "delivery_slot")[] } {
  const ds = deliverySettings(settings);
  if (!ds || (!rawDate && !rawSlot)) return { ok: true, request: null };
  const invalid: ("delivery_date" | "delivery_slot")[] = [];
  if (rawDate && !deliveryDates(ds, now, tz).some((d) => d.value === rawDate)) invalid.push("delivery_date");
  if (rawSlot && !(isDeliverySlot(rawSlot) && ds.slots.includes(rawSlot))) invalid.push("delivery_slot");
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, request: { date: rawDate || null, slot: isDeliverySlot(rawSlot) ? rawSlot : null } };
}

/** 確認画面・管理画面・送り状の表示（例: 10月20日（火） 午前中） */
export function deliveryText(r: { date?: string | null; slot?: string | null } | null | undefined): string | null {
  if (!r || (!r.date && !r.slot)) return null;
  const parts = [r.date ? dateLabel(r.date) : t("delivery.no_date"), isDeliverySlot(r.slot) ? slotLabel(r.slot) : t("delivery.no_slot")];
  return parts.join(" ");
}
