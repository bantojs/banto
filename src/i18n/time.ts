import { getLocale } from "./index";

/**
 * 日時の表示。Worker は UTC で動くので、運営者の時間帯（BANTO_TIMEZONE、既定 Asia/Tokyo）に直して出す。
 * ロケールと同じくデプロイ単位の設定で、app.ts のミドルウェアと registerJobs が setTimeZone() する。
 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";
let currentTimeZone = DEFAULT_TIMEZONE;

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setTimeZone(tz: string | undefined | null): string {
  currentTimeZone = isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  return currentTimeZone;
}

export function getTimeZone(): string {
  return currentTimeZone;
}

/** ISO 文字列を運営者の時間帯で "2026/10/15 16:58" のように。不正な値はそのまま返す。null は "-" */
export function formatDateTime(iso: string | null | undefined, opts: { dateOnly?: boolean } = {}): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const locale = getLocale() === "en" ? "en-CA" : "ja-JP"; // en-CA は YYYY-MM-DD 順で曖昧さが無い
  const f = new Intl.DateTimeFormat(locale, {
    timeZone: currentTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(opts.dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
  return f.format(d).replace(", ", " ");
}

/** その瞬間の、時間帯の UTC からのずれ（分） */
function offsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((local - Math.floor(ms / 60000) * 60000) / 60000);
}

/** 管理画面の datetime-local（"2026-10-20T10:00"、運営者の時間帯）→ ISO（UTC）。形が違えば null */
export function zonedInputToIso(value: string, tz: string = currentTimeZone): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  if (Number.isNaN(asUtc)) return null;
  let t = asUtc - offsetMinutes(asUtc, tz) * 60000;
  // 夏時間の切り替わりの前後で、ずれが変わる場合に合わせ直す
  const again = asUtc - offsetMinutes(t, tz) * 60000;
  if (again !== t) t = again;
  return new Date(t).toISOString();
}

/** ISO → 管理画面の datetime-local の値（運営者の時間帯）。null や不正な値は "" */
export function isoToZonedInput(iso: string | null | undefined, tz: string = currentTimeZone): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return d.toISOString().slice(0, 16);
}
