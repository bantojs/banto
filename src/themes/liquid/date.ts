/**
 * Liquid の `date` フィルター（と `date_to_xmlschema` などの派生）の Banto の実装。
 *
 * liquidjs 10.30 の `date` は呼ぶたびに `Intl.DateTimeFormat` を作る（時間帯が IANA 名なら `toLocaleString` を 2 回、月名・曜日名で
 * さらに 1 つずつ）。1 回が数百 µs なので、ループで呼ぶだけで 1 ページの CPU が手数の上限（engine.ts）に届く前に数十秒になる。
 * ここでは同じ入力（Date / 数（UNIX 秒）/ 'now' / 'today' / 日付の文字列）と同じ strftime の書式を受け、`Intl.DateTimeFormat` を
 * （ロケール・時間帯・使う部品）ごとにモジュールのキャッシュで使い回す。出力は liquidjs の `date` と同じ（test/themes-limits.test.ts で突き合わせる）。
 *
 * 時間帯: 2 つ目の引数 → liquidjs の `timezoneOffset`（engine の `timezone`、お店の画面は BANTO_TIMEZONE）→ 実行環境の時間帯。
 * IANA 名か、分の数（JS の getTimezoneOffset と同じ向き。UTC より西が正）。
 */
import { toValue, type Context, type Liquid } from "liquidjs/dist/liquid.browser.mjs";

/** `Intl.DateTimeFormat` を覚えておく数の上限（ロケール × 時間帯 × 部品。テーマが 2 つ目の引数で時間帯を変えても膨らまない） */
const FORMAT_CACHE_MAX = 64;
const formats = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions, kind: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}\u0000${options.timeZone ?? ""}\u0000${kind}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    if (formats.size >= FORMAT_CACHE_MAX) formats.delete(formats.keys().next().value!);
    formats.set(key, f);
  }
  return f;
}

/** 実行環境の時間帯（liquidjs は時間帯の指定が無いときこれを使う） */
let runtimeZone: string | undefined;
function runtimeTimeZone(): string {
  runtimeZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  return runtimeZone;
}

/** その時間帯での壁時計。`wall` は壁時計の年月日時分秒を UTC として持つ Date（getUTC* で読む） */
interface Zoned {
  /** 壁時計（UTC の getter で読む） */
  wall: Date;
  /** 本当の時刻（UNIX ミリ秒） */
  epoch: number;
  /** UTC からのずれ（分。JS の getTimezoneOffset と同じ向き） */
  offset: number;
  /** IANA 名（分の数で指定したときは空） */
  zoneName: string;
}

const PARTS: Intl.DateTimeFormatOptions = { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
/** en-US の PARTS の出力 "10/28/2026, 09:05:07"（formatToParts より 3 倍ほど速いので文字列から読む） */
const R_EN_US = /(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/;

/**
 * 直前に求めた「時間帯 × 15 分」の UTC からのずれ。時間帯のずれが変わる瞬間（夏時間）は IANA のどの時間帯でも 15 分の境なので、
 * 同じ 15 分の中では同じ（ループで 'now' や近い日時を何度も描くとき Intl を呼ばない）。19 世紀の地方平均時（秒のあるずれ）は分に丸める
 */
let lastBucketKey = "";
let lastOffset = 0;

function zoneOffset(zone: string, d: Date, epoch: number): number {
  const key = `${zone}\u0000${Math.floor(epoch / 900_000)}`;
  if (key === lastBucketKey) return lastOffset;
  const f = cachedFormat("en-US", { ...PARTS, timeZone: zone }, "parts");
  const m = R_EN_US.exec(f.format(d));
  let local: number;
  if (m) local = Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!, +m[4]! % 24, +m[5]!, +m[6]!);
  else {
    const parts = f.formatToParts(d);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  }
  const offset = Math.round((Math.floor(epoch / 1000) * 1000 - local) / 60_000);
  lastBucketKey = key;
  lastOffset = offset;
  return offset;
}

function zoned(d: Date, timezone: string | number | undefined): Zoned {
  const epoch = d.getTime();
  if (typeof timezone === "number") {
    return { wall: new Date(epoch - timezone * 60_000), epoch, offset: timezone, zoneName: "" };
  }
  const zone = timezone ?? runtimeTimeZone();
  const offset = zoneOffset(zone, d, epoch);
  return { wall: new Date(epoch - offset * 60_000), epoch, offset, zoneName: zone };
}

function pad(str: string, length: number, ch: string): string {
  const n = length - str.length;
  return n <= 0 ? str : ch.repeat(n) + str;
}

/** 壁時計の値を Intl で（月名・曜日名・`%c` `%x` `%X`）。壁時計を UTC として持っているので UTC で描けばよい */
function named(z: Zoned, locale: string | undefined, options: Intl.DateTimeFormatOptions, kind: string): string {
  return cachedFormat(locale, { ...options, timeZone: "UTC" }, kind).format(z.wall);
}

const NUMERIC_ALL: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
const NUMERIC_DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };
const NUMERIC_TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "numeric", second: "numeric" };

const DAYS_IN_MONTH = (y: number): number[] => [31, (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dayOfYear(w: Date): number {
  const dim = DAYS_IN_MONTH(w.getUTCFullYear());
  let n = 0;
  for (let i = 0; i < w.getUTCMonth(); i++) n += dim[i]!;
  return n + w.getUTCDate();
}

function weekOfYear(w: Date, startDay: number): string {
  const daysSinceStartDay = (w.getUTCDay() - startDay + 7) % 7;
  return String(Math.floor((dayOfYear(w) - 1 - daysSinceStartDay + 7) / 7));
}

function ordinal(w: Date): string {
  const date = w.getUTCDate();
  if (date === 11 || date === 12 || date === 13) return "th";
  switch (date % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function offsetString(z: Zoned, colon: boolean): string {
  const n = Math.abs(z.offset);
  return `${z.offset > 0 ? "-" : "+"}${pad(String(Math.floor(n / 60)), 2, "0")}${colon ? ":" : ""}${pad(String(n % 60), 2, "0")}`;
}

interface Conv {
  flags: Record<string, boolean>;
  width: string | undefined;
  locale: string | undefined;
  memory: { use(count: number): void } | undefined;
}

type Code = (z: Zoned, o: Conv) => string | number;

/** liquidjs の formatCodes と同じ変換（strftime） */
const CODES: Record<string, Code> = {
  a: (z, o) => named(z, o.locale, { weekday: "short" }, "a"),
  A: (z, o) => named(z, o.locale, { weekday: "long" }, "A"),
  b: (z, o) => named(z, o.locale, { month: "short" }, "b"),
  B: (z, o) => named(z, o.locale, { month: "long" }, "B"),
  c: (z) => named(z, undefined, NUMERIC_ALL, "c"),
  C: (z) => Math.floor(z.wall.getUTCFullYear() / 100),
  d: (z) => z.wall.getUTCDate(),
  e: (z) => z.wall.getUTCDate(),
  H: (z) => z.wall.getUTCHours(),
  I: (z) => String(z.wall.getUTCHours() % 12 || 12),
  j: (z) => dayOfYear(z.wall),
  k: (z) => z.wall.getUTCHours(),
  l: (z) => String(z.wall.getUTCHours() % 12 || 12),
  L: (z) => z.wall.getUTCMilliseconds(),
  m: (z) => z.wall.getUTCMonth() + 1,
  M: (z) => z.wall.getUTCMinutes(),
  N: (z, o) => {
    const width = Number(o.width) || 9;
    const str = pad(String(z.wall.getUTCMilliseconds()), 3, "0").slice(0, width);
    o.memory?.use(width - str.length);
    return str + "0".repeat(Math.max(0, width - str.length));
  },
  p: (z) => (z.wall.getUTCHours() < 12 ? "AM" : "PM"),
  P: (z) => (z.wall.getUTCHours() < 12 ? "am" : "pm"),
  q: (z) => ordinal(z.wall),
  s: (z) => Math.floor(z.epoch / 1000),
  S: (z) => z.wall.getUTCSeconds(),
  u: (z) => z.wall.getUTCDay() || 7,
  U: (z) => weekOfYear(z.wall, 0),
  w: (z) => z.wall.getUTCDay(),
  W: (z) => weekOfYear(z.wall, 1),
  x: (z) => named(z, undefined, NUMERIC_DATE, "x"),
  X: (z) => named(z, undefined, NUMERIC_TIME, "X"),
  y: (z) => ((z.wall.getUTCFullYear() % 100) + 100) % 100,
  Y: (z) => z.wall.getUTCFullYear(),
  z: (z, o) => offsetString(z, !!o.flags[":"]),
  Z: (z, o) => z.zoneName || offsetString(z, !!o.flags[":"]),
  t: () => "\t",
  n: () => "\n",
  "%": () => "%",
};
CODES["h"] = CODES["b"]!;

const PAD_WIDTHS: Record<string, number> = { C: 2, d: 2, e: 2, H: 2, I: 2, j: 3, k: 2, l: 2, L: 3, m: 2, M: 2, S: 2, U: 2, W: 2, y: 2 };
const PAD_SPACE = new Set("aAbBceklpP");
const R_FORMAT = /%([-_0^#:]+)?(\d+)?([EO])?(.)/;

function changeCase(str: string): string {
  const hasLower = [...str].some((ch) => ch >= "a" && ch <= "z");
  return hasLower ? str.toUpperCase() : str.toLowerCase();
}

/** 書式を読んだ結果（文字列はそのまま出す部分） */
interface Piece {
  input: string;
  conversion: string;
  flags: Record<string, boolean>;
  width: string | undefined;
}
const COMPILED_MAX = 64;
const compiled = new Map<string, (string | Piece)[]>();

/** 書式を 1 回だけ読む（同じ書式をループで使うとき、正規表現を毎回当てない） */
function compile(formatStr: string): (string | Piece)[] {
  let pieces = compiled.get(formatStr);
  if (pieces) return pieces;
  pieces = [];
  let remaining = formatStr;
  let match: RegExpExecArray | null;
  while ((match = R_FORMAT.exec(remaining))) {
    if (match.index > 0) pieces.push(remaining.slice(0, match.index));
    remaining = remaining.slice(match.index + match[0].length);
    const [input, flagStr = "", width, , conversion = ""] = match;
    const flags: Record<string, boolean> = {};
    for (const flag of flagStr) flags[flag] = true;
    pieces.push({ input, conversion, flags, width });
  }
  if (remaining) pieces.push(remaining);
  if (formatStr.length <= 256) {
    if (compiled.size >= COMPILED_MAX) compiled.delete(compiled.keys().next().value!);
    compiled.set(formatStr, pieces);
  }
  return pieces;
}

function strftime(z: Zoned, formatStr: string, locale: string | undefined, memory: Conv["memory"]): string {
  let output = "";
  for (const piece of compile(formatStr)) {
    if (typeof piece === "string") {
      output += piece;
      continue;
    }
    const { conversion, flags, width } = piece;
    const code = CODES[conversion];
    if (!code) {
      output += piece.input;
      continue;
    }
    let ret = String(code(z, { flags, width, locale, memory }));
    let padChar = PAD_SPACE.has(conversion) ? " " : "0";
    let padWidth = Number(width) || PAD_WIDTHS[conversion] || 0;
    if (flags["^"]) ret = ret.toUpperCase();
    else if (flags["#"]) ret = changeCase(ret);
    if (flags["_"]) padChar = " ";
    else if (flags["0"]) padChar = "0";
    if (flags["-"]) padWidth = 0;
    memory?.use(padWidth - ret.length);
    output += pad(ret, padWidth, padChar);
  }
  return output;
}

function stringify(v: unknown): string {
  const x = toValue(v);
  if (typeof x === "string") return x;
  if (x === null || x === undefined) return "";
  if (Array.isArray(x)) return x.map(stringify).join("");
  return String(x);
}

/** liquidjs の parseDate と同じ入力の読み方。読めなければ undefined */
function parseDate(v: unknown, timezone: string | number | undefined): Zoned | undefined {
  let d: Date;
  if (v === null || v === undefined) return undefined;
  if (v === "now" || v === "today") d = new Date(Date.now());
  else if (typeof v === "number") d = new Date(v * 1000);
  else if (typeof v === "string") d = /^\d+$/.test(v) ? new Date(+v * 1000) : new Date(v);
  else d = new Date(v as Date);
  if (Number.isNaN(d.getTime())) return undefined;
  return zoned(d, timezone);
}

interface FilterThis {
  context: Context;
}

function zoneOf(ctx: Context, override: unknown): string | number | undefined {
  const tz: unknown = toValue(override);
  if (typeof tz === "string" || typeof tz === "number") return tz;
  const def: unknown = ctx.opts.timezoneOffset;
  return typeof def === "string" || typeof def === "number" ? def : undefined;
}

function dateFilter(this: FilterThis, v: unknown, format?: unknown, timezone?: unknown): unknown {
  const ctx = this.context;
  const value: unknown = toValue(v);
  ctx.memoryLimit.use((typeof value === "string" ? value.length : 0) + (typeof timezone === "string" ? timezone.length : 0));
  const z = parseDate(value, zoneOf(ctx, timezone));
  if (!z) return value;
  const f: unknown = toValue(format);
  const fmt = f === null || f === undefined ? ctx.opts.dateFormat : stringify(f);
  ctx.memoryLimit.use(fmt.length);
  return strftime(z, fmt, ctx.opts.locale, ctx.memoryLimit);
}

function stringifyDate(this: FilterThis, v: unknown, monthType: string, type: unknown, style: unknown): unknown {
  const ctx = this.context;
  const value: unknown = toValue(v);
  const z = parseDate(value, zoneOf(ctx, undefined));
  if (!z) return value;
  const ml = ctx.memoryLimit;
  if (type === "ordinal") {
    const d = z.wall.getUTCDate();
    return style === "US" ? strftime(z, `${monthType} ${d}%q, %Y`, ctx.opts.locale, ml) : strftime(z, `${d}%q ${monthType} %Y`, ctx.opts.locale, ml);
  }
  return strftime(z, `%d ${monthType} %Y`, ctx.opts.locale, ml);
}

/** liquidjs の date 系のフィルターを Banto の実装で上書きする */
export function registerDateFilters(liquid: Liquid): void {
  liquid.registerFilter("date", dateFilter);
  liquid.registerFilter("date_to_xmlschema", function (this: FilterThis, v: unknown) {
    return dateFilter.call(this, v, "%Y-%m-%dT%H:%M:%S%:z");
  });
  liquid.registerFilter("date_to_rfc822", function (this: FilterThis, v: unknown) {
    return dateFilter.call(this, v, "%a, %d %b %Y %H:%M:%S %z");
  });
  liquid.registerFilter("date_to_string", function (this: FilterThis, v: unknown, type?: unknown, style?: unknown) {
    return stringifyDate.call(this, v, "%b", type, style);
  });
  liquid.registerFilter("date_to_long_string", function (this: FilterThis, v: unknown, type?: unknown, style?: unknown) {
    return stringifyDate.call(this, v, "%B", type, style);
  });
}

/** テスト用: 覚えている Intl.DateTimeFormat の数 */
export function dateFormatCacheSize(): number {
  return formats.size;
}
