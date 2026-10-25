/**
 * CSV のセル（RFC 4180 の引用 + 表計算ソフトの式の無害化）。
 * 購入者・会員・外部の API が書いた文字列（氏名・住所・独自項目）がそのまま運営者の CSV に出るので、
 * 先頭が = + - @ タブ 改行 のセルは ' を前置して「文字」にする（Excel / LibreOffice で式として評価されないように。2026-10-25 の監査）。
 * 数値（number 型）はそのまま（負の金額を文字にしない）。
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
