/**
 * SKU の選択肢の key と表示名（0094_option_keys、メンテナの決定 2026-11-02。docs/knowledge/02-decisions.md）。
 *   - SKU の options・画像の options・SKU を分ける軸の鍵は英字の key（size・color・opt1…）。表示名はショップの名前の表 shops.option_names
 *   - 書き込みは名前でも key でもよい（DB のトリガーが key に直す）。ここは表示のための読み替えだけ
 *   - 表に無い key は、key をそのまま名前として出す（今までの名前の鍵はそれ自体が名前）
 */
export type OptionNames = Readonly<Record<string, string>>;

/** DB・公開の JSON の値 → 名前の表（壊れた値は空） */
export function optionNamesOf(v: unknown): OptionNames {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "string" && n) out[k] = n;
  return out;
}

/** key → 表示名（無ければ key） */
export function optionLabel(names: OptionNames, key: string): string {
  return names[key] ?? key;
}

/** 名前か key → key（表に無ければ null。大文字小文字を区別しない） */
export function optionKeyFor(names: OptionNames, label: string): string | null {
  const l = label.trim();
  if (Object.prototype.hasOwnProperty.call(names, l)) return l;
  const lower = l.toLowerCase();
  for (const [k, n] of Object.entries(names)) if (n.toLowerCase() === lower) return k;
  return null;
}

/** options（key: 値）→ 表示用の [名前, 値] の並び */
export function namedOptionEntries(options: Record<string, unknown> | null | undefined, names: OptionNames): [string, string][] {
  return Object.entries(options ?? {}).map(([k, v]) => [optionLabel(names, k), String(v)]);
}
