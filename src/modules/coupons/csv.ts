/**
 * Banto のクーポン CSV（同梱モジュール coupons の「CSV から取り込む」と、WooCommerce の取り込みの「要確認のクーポン」の書き出し）。
 * 仕様は docs/coupon-csv.md。人が表計算ソフトで直しても、AI が作っても、同じ形で取り込める。
 *
 * ここは形を読むだけ（DB に触らない）。商品・カテゴリーの slug の照合、会員の確認、値の範囲、既にあるかどうかは
 * DB の import_coupons（0043）が行う。知らない列に値があれば、その行は取り込まない（書いたつもりの制限を黙って捨てない）。
 */
import { zonedInputToIso } from "../../i18n/time";
import { normalizeTags } from "../../products/tags";
import { PAYMENT_METHOD_RE } from "../../commerce/discounts";

/** 列の並び（書き出しの順）。note と source_meta は人と AI のための欄で、取り込みでは読まない */
export const COUPON_CSV_COLUMNS = [
  "code",
  "name",
  "kind",
  "value",
  "starts_at",
  "ends_at",
  "usage_limit",
  "per_customer_limit",
  "combinable",
  "audience",
  "member_emails",
  "min_subtotal_jpy",
  "max_subtotal_jpy",
  "min_qty",
  "exclude_sale",
  "product_slugs",
  "exclude_product_slugs",
  "category_slugs",
  "exclude_category_slugs",
  "tags",
  "exclude_tags",
  "brands",
  "exclude_brands",
  "payment_methods",
  "active",
  "ref",
  "note",
  "source_meta",
] as const;
export type CouponCsvColumn = (typeof COUPON_CSV_COLUMNS)[number];

/** 取り込みで読まない列（メモ） */
const IGNORED: readonly string[] = ["note", "source_meta"];

export const MAX_COUPON_CSV_ROWS = 500;
export const MAX_COUPON_CSV_BYTES = 2 * 1024 * 1024;

/** RFC 4180 の CSV（ダブルクォート、"" のエスケープ、改行を含むセル、CRLF / LF、先頭の BOM） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

import { csvCell } from "../../util/csv";
export { csvCell };

/** クーポン CSV を書く（BOM 付き、CRLF。表計算ソフトで文字化けしないように） */
export function couponCsv(rows: Partial<Record<CouponCsvColumn, string | number | boolean | null>>[]): string {
  const lines = [COUPON_CSV_COLUMNS.join(","), ...rows.map((r) => COUPON_CSV_COLUMNS.map((k) => csvCell(r[k])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** DB の import_coupons に渡す 1 行 */
export interface CouponImportRow {
  line: number;
  values: Record<string, unknown>;
  conditions: Record<string, unknown>;
  product_slugs: string[];
  exclude_product_slugs: string[];
  category_slugs: string[];
  exclude_category_slugs: string[];
  member_emails: string[];
}

export interface ParsedCouponCsv {
  rows: CouponImportRow[];
  /** 形が違って DB に渡さない行（line は CSV の行番号、見出しが 1） */
  errors: { line: number; code: string; error: string }[];
  /** ファイル全体の問題（見出しが無い・行が多すぎる） */
  fatal: string | null;
}

const list = (v: string) =>
  v
    .split(/[\s,;、]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * 日時: 2026-10-01 / 2026-10-01 10:00 / 2026/10/01 10:00 / 2026-10-01T10:00（運営者の時間帯）、または時差つきの ISO 8601。
 * 日付だけの終了日はその日の 23:59（WooCommerce の有効期限と同じく、その日いっぱい）
 */
export function csvDate(raw: string, end: boolean): string | null | "bad" {
  const s = raw.trim();
  if (!s) return null;
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(s)) return Number.isNaN(Date.parse(s)) ? "bad" : new Date(s).toISOString();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) return "bad";
  const pad = (n: string) => n.padStart(2, "0");
  const time = m[4] ? `${pad(m[4])}:${m[5]}` : end ? "23:59" : "00:00";
  return zonedInputToIso(`${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}T${time}`) ?? "bad";
}

function bool(raw: string): boolean | null | "bad" {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (["true", "1", "yes", "on", "はい"].includes(s)) return true;
  if (["false", "0", "no", "off", "いいえ"].includes(s)) return false;
  return "bad";
}

function int(raw: string): number | null | "bad" {
  const s = raw.trim().replace(/,/g, "");
  if (!s) return null;
  return /^\d{1,9}$/.test(s) ? Number(s) : "bad";
}

/** CSV → import_coupons に渡す行。値の範囲（割合は 1〜100 など）は DB が確かめる */
export function parseCouponCsv(text: string): ParsedCouponCsv {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  if (!header.includes("kind") || !(header.includes("name") || header.includes("code"))) return { rows: [], errors: [], fatal: "no_header" };
  if (table.length - 1 > MAX_COUPON_CSV_ROWS) return { rows: [], errors: [], fatal: "too_many_rows" };
  const known = new Set<string>(COUPON_CSV_COLUMNS);
  const rows: CouponImportRow[] = [];
  const errors: ParsedCouponCsv["errors"] = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (k: CouponCsvColumn) => {
      const at = header.indexOf(k);
      return at < 0 ? "" : (cells[at] ?? "").trim();
    };
    const code = get("code").toUpperCase();
    const fail = (error: string) => errors.push({ line, code, error });
    // 知らない列に値がある（書いたつもりの条件を黙って捨てない）
    const unknown = header.filter((h, at) => h && !known.has(h) && !IGNORED.includes(h) && (cells[at] ?? "").trim() !== "");
    if (unknown.length > 0) return fail(`unknown_column: ${unknown.join(", ")}`);

    const values: Record<string, unknown> = {};
    const name = get("name") || code;
    if (name) values["name"] = name.slice(0, 100);
    if (code) values["code"] = code;
    if (get("kind")) values["kind"] = get("kind").toLowerCase();
    const value = int(get("value"));
    if (value === "bad") return fail("invalid_value");
    if (value !== null) values["value"] = value;
    for (const k of ["starts_at", "ends_at"] as const) {
      const d = csvDate(get(k), k === "ends_at");
      if (d === "bad") return fail(`invalid_${k}`);
      if (d !== null) values[k] = d;
    }
    for (const k of ["usage_limit", "per_customer_limit"] as const) {
      const n = int(get(k));
      if (n === "bad") return fail(`invalid_${k}`);
      if (n !== null) values[k] = n;
    }
    for (const k of ["combinable", "active"] as const) {
      const b = bool(get(k));
      if (b === "bad") return fail(`invalid_${k}`);
      if (b !== null) values[k] = b;
    }
    if (get("audience")) values["audience"] = get("audience").toLowerCase();
    if (get("ref")) values["external_ref"] = get("ref").slice(0, 100);

    const conditions: Record<string, unknown> = {};
    for (const k of ["min_subtotal_jpy", "max_subtotal_jpy", "min_qty"] as const) {
      const n = int(get(k));
      if (n === "bad") return fail(`invalid_${k}`);
      if (n !== null && n > 0) conditions[k] = n;
    }
    const sale = bool(get("exclude_sale"));
    if (sale === "bad") return fail("invalid_exclude_sale");
    if (sale) conditions["exclude_sale"] = true;
    for (const k of ["tags", "exclude_tags"] as const) {
      const tags = normalizeTags(get(k).split(";").join(","));
      if (tags.length > 0) conditions[k] = tags;
    }
    // ブランドは ; 区切り（名前にスペースを含むことがあるため、スペースでは区切らない）
    for (const k of ["brands", "exclude_brands"] as const) {
      const names = [...new Set(get(k).split(/[;\n]/).map((x) => x.trim()).filter(Boolean))];
      if (names.length > 0) conditions[k] = names;
    }
    const methods = [...new Set(list(get("payment_methods")).map((x) => x.toLowerCase()))];
    if (methods.some((m) => !PAYMENT_METHOD_RE.test(m))) return fail("invalid_conditions_payment_methods");
    if (methods.length > 0) conditions["payment_methods"] = methods;

    const emails = [...new Set(list(get("member_emails")).map((e) => e.toLowerCase()))];
    const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) return fail(`invalid_member_emails: ${bad}`);
    rows.push({
      line,
      values,
      conditions,
      product_slugs: list(get("product_slugs")),
      exclude_product_slugs: list(get("exclude_product_slugs")),
      category_slugs: list(get("category_slugs")),
      exclude_category_slugs: list(get("exclude_category_slugs")),
      member_emails: emails,
    });
  });
  return { rows, errors, fatal: null };
}
