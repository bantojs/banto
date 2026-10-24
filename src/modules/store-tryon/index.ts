/**
 * 同梱モジュール「お店で試着」（store_tryon、既定 OFF。docs/store-tryon.md、0025_store_tryon.sql）。
 * お客様がネットで選んだ商品を実店舗で試着できるよう取り置く。決済はしない（購入は店舗のレジ）。
 * ここは店舗の営業日の計算と設定の読み取りだけ（データ取得なし）。日付はすべてショップの時間帯の YYYY-MM-DD。
 */
import { t, tf, type MessageKey } from "../../i18n";
import { getTimeZone } from "../../i18n/time";
import { dateLabel, todayIn } from "../delivery-time";
import type { StoreView } from "../../themes/types";

export const TRYON_MODULE = "store_tryon";
/** 会員が自分で取り消せる状態（0026 の member_tryon_cancel と同じ。取り置きが終わる前） */
export const MEMBER_CANCELLABLE: readonly string[] = ["requested", "sent", "ready"];

/** 営業時間の 1 つの時間帯（"10:00", "20:00"） */
export type TimeRange = [string, string];
export interface SpecialDay {
  date: string;
  /** true なら臨時休業。false なら hours で臨時営業（営業時間の変更） */
  closed: boolean;
  hours: TimeRange[];
  note: string | null;
}
/** お客様の画面の実店舗（0025 の shop_store_list: 組織の実店舗に、ショップでの設定（試着を受けるか・並び順）を重ねたもの） */
export interface StoreRow {
  id: string;
  shop_id: string;
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  /** お知らせの宛先（運営者だけが読める列） */
  email?: string | null;
  hours: Record<string, TimeRange[]>;
  special_days: SpecialDay[];
  note: string | null;
  tryon: boolean;
  notify_email?: boolean;
  active: boolean;
  sort_order: number;
}

/** 組織の実店舗（0025 の stores。正本。運営側だけが読める） */
export interface OrgStore {
  id: string;
  org_id: string;
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  notify_email: boolean;
  hours: Record<string, TimeRange[]>;
  special_days: SpecialDay[];
  note: string | null;
  active: boolean;
  sort_order: number;
}

/** ショップで使う実店舗（0025 の shop_stores） */
export interface ShopStoreLink {
  shop_id: string;
  store_id: string;
  tryon: boolean;
  sort_order: number;
}

/** 実店舗ごとの項目（0025 の org_member_stores） */
export const STORE_PERMS = ["tryon", "hours"] as const;
export type StorePerm = (typeof STORE_PERMS)[number];
export const MAX_RANGES_PER_DAY = 2;
export const MAX_SPECIAL_DAYS = 400;

export interface TryonSettings {
  /** shop = お店におまかせ（ショップの都合で送り、届いたら hold_days 日取り置く）、visit = お客様が来店日を選ぶ */
  mode: "shop" | "visit";
  /** 取り置きの日数（shop: 店舗に届いた日から、visit: 来店予定日から） */
  hold_days: number;
  /** 来店日として選べる範囲（申し込みの何日後から何日後まで） */
  min_days: number;
  max_days: number;
  /** 1 回に申し込める点数 */
  max_items: number;
  /** 申し込みの画面に出す案内（例: 「店舗へは 3〜5 日でお届けします」） */
  notice: string;
}

const int = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

export function tryonSettings(settings: Record<string, unknown> | null | undefined): TryonSettings {
  const raw = (settings ?? {})["store_tryon"];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const min = int(o["min_days"], 0, 60, 3);
  return {
    mode: o["mode"] === "visit" ? "visit" : "shop",
    hold_days: int(o["hold_days"], 1, 60, 7),
    min_days: min,
    max_days: Math.max(min, int(o["max_days"], 0, 90, 14)),
    max_items: int(o["max_items"], 1, 20, 5),
    notice: typeof o["notice"] === "string" ? o["notice"].slice(0, 500) : "",
  };
}

// ---------- 営業時間 ----------
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const pad = (s: string) => (s.length === 4 ? `0${s}` : s);

/** "10:00-20:00" / "10:00-13:00, 14:00-20:00" / ""（休み）→ 時間帯。読めなければ null */
export function parseRanges(text: string): TimeRange[] | null {
  const s = text.replace(/[〜～~]/g, "-").replace(/[：]/g, ":").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  if (s === "" || s === "-" || s === "休" || s === "定休日") return [];
  const out: TimeRange[] = [];
  for (const part of s.split(/[,、，\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(part);
    if (!m || !TIME.test(m[1]!) || !TIME.test(m[2]!)) return null;
    const open = pad(m[1]!);
    const close = pad(m[2]!);
    if (open >= close) return null;
    out.push([open, close]);
  }
  if (out.length > MAX_RANGES_PER_DAY) return null;
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}

export function formatRanges(ranges: TimeRange[]): string {
  return ranges.map(([a, b]) => `${a}-${b}`).join(", ");
}

function rangesOf(v: unknown): TimeRange[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && typeof r[0] === "string" && typeof r[1] === "string" && TIME.test(r[0]) && TIME.test(r[1]) && r[0] < r[1])
    .slice(0, MAX_RANGES_PER_DAY)
    .map(([a, b]) => [pad(a), pad(b)]);
}

/** DB の hours を曜日 0〜6 の表に（形の違う値は休みとして扱う） */
export function weeklyHours(v: unknown): Record<string, TimeRange[]> {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: Record<string, TimeRange[]> = {};
  for (let d = 0; d < 7; d++) out[String(d)] = rangesOf(o[String(d)]);
  return out;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function specialDays(v: unknown): SpecialDay[] {
  if (!Array.isArray(v)) return [];
  const out: SpecialDay[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o["date"] !== "string" || !YMD.test(o["date"])) continue;
    const hours = rangesOf(o["hours"]);
    const closed = o["closed"] === true || hours.length === 0;
    out.push({ date: o["date"], closed, hours: closed ? [] : hours, note: typeof o["note"] === "string" && o["note"].trim() ? o["note"].trim().slice(0, 50) : null });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 臨時休業・臨時営業の入力（1 行に 1 日）: 「2026-12-31 休業 年末」「2026-12-30 11:00-17:00 短縮営業」。
 * 日付は 2026/12/31 も可。今日より前の日付は捨てる（保存のたびに片付く）。読めない行は errors に行番号
 */
export function parseSpecialDays(text: string, today: string): { days: SpecialDay[]; errors: number[] } {
  const days = new Map<string, SpecialDay>();
  const errors: number[] = [];
  const ymd = (y: string, m: string, d: string) => {
    const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
  };
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    // 1 日（2026-12-31 休業 年末）か、期間（2026-12-31〜2027-01-03 休業 年末年始。31 日まで）
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s*(?:〜|~|\.\.)\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2}))?\s+(\S+)\s*(.*)$/.exec(s);
    if (!m) return void errors.push(i + 1);
    const from = ymd(m[1]!, m[2]!, m[3]!);
    const to = m[4] ? ymd(m[4], m[5]!, m[6]!) : from;
    if (!from || !to || to < from || addDays(from, 30) < to) return void errors.push(i + 1);
    const word = m[7]!;
    const note = m[8]!.trim().slice(0, 50) || null;
    const closed = /^(休業|休み|休|closed)$/i.test(word);
    const hours = closed ? [] : parseRanges(word);
    if (hours === null || (!closed && hours.length === 0)) return void errors.push(i + 1);
    for (let date = from; date <= to; date = addDays(date, 1)) if (date >= today) days.set(date, { date, closed, hours, note });
  });
  return { days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, MAX_SPECIAL_DAYS), errors };
}

export function formatSpecialDays(days: SpecialDay[]): string {
  return days.map((d) => [d.date, d.closed ? "休業" : formatRanges(d.hours), d.note ?? ""].join(" ").trim()).join("\n");
}

export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** その日の営業（臨時休業・臨時営業が曜日の営業時間より優先） */
export function hoursOn(store: Pick<StoreRow, "hours" | "special_days">, ymd: string): { open: boolean; ranges: TimeRange[]; special: SpecialDay | null } {
  const sp = specialDays(store.special_days).find((d) => d.date === ymd) ?? null;
  if (sp) return { open: !sp.closed, ranges: sp.hours, special: sp };
  const ranges = weeklyHours(store.hours)[String(weekdayOf(ymd))] ?? [];
  return { open: ranges.length > 0, ranges, special: null };
}

/** その日かそれより後の最初の営業日（60 日先までに無ければ null） */
export function nextOpenDay(store: Pick<StoreRow, "hours" | "special_days">, ymd: string): string | null {
  for (let i = 0; i <= 60; i++) {
    const d = addDays(ymd, i);
    if (hoursOn(store, d).open) return d;
  }
  return null;
}

/** 取り置きの期限: from から days 日。休みの日に当たれば次の営業日まで延ばす */
export function holdUntil(store: Pick<StoreRow, "hours" | "special_days">, from: string, days: number): string {
  const end = addDays(from, days);
  return nextOpenDay(store, end) ?? end;
}

/** 来店日として選べる日（今日から min〜max 日後の営業日） */
export function visitDates(store: Pick<StoreRow, "hours" | "special_days">, s: Pick<TryonSettings, "min_days" | "max_days">, today: string): string[] {
  const out: string[] = [];
  for (let i = s.min_days; i <= s.max_days; i++) {
    const d = addDays(today, i);
    if (hoursOn(store, d).open) out.push(d);
  }
  return out;
}

/** 今日から days 日のあいだの臨時休業・臨時営業 */
export function upcomingSpecialDays(store: Pick<StoreRow, "special_days">, today: string, days = 31): SpecialDay[] {
  const end = addDays(today, days);
  return specialDays(store.special_days).filter((d) => d.date >= today && d.date <= end);
}

export function weekdayLabel(d: number): string {
  return t(`tryon.weekday_${d}` as MessageKey);
}

/** 10月20日（火）（配送日時の指定と同じ表記） */
export { dateLabel };

/** 曜日ごとの営業時間の表（同じ時間の曜日もそのまま 7 行。休みは「定休日」） */
export function weeklyLines(store: Pick<StoreRow, "hours">): { day: string; text: string }[] {
  const w = weeklyHours(store.hours);
  return [1, 2, 3, 4, 5, 6, 0].map((d) => ({ day: weekdayLabel(d), text: w[String(d)]!.length ? formatRanges(w[String(d)]!).replace(/-/g, "〜") : t("tryon.closed_day") }));
}

export function todayHere(now: number = Date.now()): string {
  return todayIn(getTimeZone(), now);
}

/** テーマに渡す店舗の表示（今日の営業・曜日ごとの営業時間・近い臨時休業 / 臨時営業） */
export function storeView(store: StoreRow, today: string): StoreView {
  const now = hoursOn(store, today);
  const text = (closed: boolean, ranges: TimeRange[]) => (closed ? t("tryon.special_closed") : tf("tryon.special_open", { hours: formatRanges(ranges).replace(/-/g, "〜") }));
  return {
    id: store.id,
    name: store.name,
    postal_code: store.postal_code,
    address: store.address,
    phone: store.phone,
    note: store.note,
    tryon: store.tryon,
    week: weeklyLines(store),
    today: now.open ? tf("tryon.today_open", { hours: formatRanges(now.ranges).replace(/-/g, "〜") }) : t("tryon.today_closed"),
    specials: upcomingSpecialDays(store, today).map((d) => ({ date: dateLabel(d.date), text: [text(d.closed, d.hours), d.note].filter(Boolean).join(" ") })),
  };
}

export interface TryonInput {
  store: string;
  visit_date: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  note: string;
}

export const TRYON_FIELDS = ["store", "visit_date", "customer_name", "customer_email", "customer_phone", "note"] as const;

/** 申し込みの入力を整え、確かめる（店舗が受付中か・来店日がその店舗の営業日で範囲内か） */
export function checkTryon(form: Record<string, string | undefined>, stores: StoreRow[], s: TryonSettings, today: string): { input: TryonInput; store: StoreRow | null; error: MessageKey | null } {
  const v = (k: (typeof TRYON_FIELDS)[number], max: number) => (form[k] ?? "").replace(/[\r\n]+/g, k === "note" ? "\n" : " ").trim().slice(0, max);
  const input: TryonInput = {
    store: v("store", 40),
    visit_date: v("visit_date", 10),
    customer_name: v("customer_name", 100),
    customer_email: v("customer_email", 254).toLowerCase(),
    customer_phone: v("customer_phone", 20),
    note: v("note", 500),
  };
  const store = stores.find((x) => x.id === input.store && x.tryon) ?? null;
  if (!store) return { input, store: null, error: "tryon.error_store" };
  if (s.mode === "visit") {
    if (!visitDates(store, s, today).includes(input.visit_date)) return { input, store, error: "tryon.error_date" };
  } else input.visit_date = "";
  if (!input.customer_name) return { input, store, error: "tryon.error_name" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.customer_email)) return { input, store, error: "tryon.error_email" };
  if (!/^[0-9+\-() ]{8,20}$/.test(input.customer_phone)) return { input, store, error: "tryon.error_phone" };
  return { input, store, error: null };
}
