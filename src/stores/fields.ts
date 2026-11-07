/**
 * 実店舗の独自項目（0126_store_fields、メンテナの決定 2026-11-07、docs/stores.md「独自項目」）。
 * 定義は組織ごと（organizations.store_fields、{ key, label, type, options, private }）、値は stores.fields。形の正は DB のトリガー
 * （banto_store_fields_guard / banto_store_fields_norm）で、ここは画面の入力・表示の形を作るだけ。
 * 書き方と種類は商品のカスタム項目と同じ（src/products/fields.ts。card の印は使わない）
 */
import { cleanAttributes, fieldDefinitions, formatFieldDefinitions, parseFieldDefinitions, publicAttributes, type ProductField } from "../products/fields";

export const STORE_FIELDS_MIGRATION = "0126_store_fields";
export const STORE_FIELDS_MAX = 20;

/** DB の定義（private の印）→ 画面の形（public） */
export function storeFieldDefs(raw: unknown): ProductField[] {
  const rows = Array.isArray(raw) ? raw.map((r) => (r && typeof r === "object" ? { ...(r as Record<string, unknown>), public: (r as Record<string, unknown>)["private"] !== true, card: false } : r)) : [];
  return fieldDefinitions(rows).slice(0, STORE_FIELDS_MAX).map(({ card: _card, ...f }) => f);
}

/** 画面の形 → DB の定義 */
export function storeFieldsForDb(defs: readonly ProductField[]): Record<string, unknown>[] {
  return defs.slice(0, STORE_FIELDS_MAX).map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.public ? {} : { private: true }) }));
}

/** 定義の欄の文字（商品と同じ「キー | 表示名 | 種類 | 選択肢 | private」）→ 定義。card は捨てる */
export const parseStoreFieldRows = (text: string): ProductField[] => parseFieldDefinitions(text).map(({ card: _card, ...f }) => f).slice(0, STORE_FIELDS_MAX);
export const formatStoreFieldRows = (defs: readonly ProductField[]): string => formatFieldDefinitions(defs.map((f) => ({ ...f, card: false })));

/** 実店舗の編集のフォーム（sf_<key>）→ 値（形の検査は DB）。image はこの置き場の画像だけ */
export function storeFieldsFromForm(defs: readonly ProductField[], form: Record<string, string | undefined>, mediaBase?: string): Record<string, string | number> {
  const input: Record<string, unknown> = {};
  for (const f of defs) input[f.key] = form[`sf_${f.key}`] ?? "";
  return cleanAttributes([...defs], input, mediaBase);
}

/** お客様に見せる項目（表示名つき、定義の順）。show で選んだ鍵だけ（無ければ全部） */
export function storeFieldView(defsRaw: unknown, values: Record<string, unknown> | null | undefined, show?: readonly string[]): { key: string; label: string; type: string; value: string | number }[] {
  const defs = Array.isArray(defsRaw) ? fieldDefinitions(defsRaw) : [];
  const list = publicAttributes(defs, values ?? {});
  return show ? show.map((k) => list.find((x) => x.key === k)).filter((x): x is (typeof list)[number] => x !== undefined) : list;
}
