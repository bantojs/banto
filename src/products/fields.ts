/**
 * カスタム項目（WooCommerce の ACF 相当の「器」。docs/knowledge/08-woo-migration.md）。
 * 項目の定義は shops.settings.product_fields、値は products.attributes（0008_catalog.sql）。
 * 宣言して入力する形までで、任意のコードは動かさない。表示はテーマ、利用はモジュールが決める。
 */
export type FieldType = "text" | "textarea" | "number" | "url" | "select";
export const FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "number", "url", "select"];
/** WooCommerce のメタ（洗濯表示のフラグ・サイズ寸法など）を受け止められる数。管理画面の商品フォームが長くなるので、まとめ方は今後の課題 */
export const MAX_FIELDS = 150;

export interface ProductField {
  /** 値の保存キー（英小文字・数字・アンダースコア、1〜40 文字） */
  key: string;
  label: string;
  type: FieldType;
  /** select の選択肢 */
  options?: string[];
  /** ストアフロントと公開 API に出すか（false なら管理画面と AI 用 API だけ） */
  public: boolean;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function productFields(settings: Record<string, unknown> | null | undefined): ProductField[] {
  return fieldDefinitions((settings ?? {})["product_fields"]);
}

/**
 * 宣言型の項目定義の配列を読む（商品の product_fields と会員の customer_fields で共通。src/customers/fields.ts）。
 * 形の違う行・重なるキーは捨てる。public の既定は true（会員の項目は呼び手が false に倒す）
 */
export function fieldDefinitions(raw: unknown, opts: { publicDefault?: boolean } = {}): ProductField[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductField[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const key = typeof o["key"] === "string" ? o["key"] : "";
    const type = o["type"] as FieldType;
    if (!KEY_RE.test(key) || !FIELD_TYPES.includes(type) || out.some((f) => f.key === key)) continue;
    const label = typeof o["label"] === "string" && o["label"].trim() ? o["label"].trim().slice(0, 60) : key;
    const options = type === "select" && Array.isArray(o["options"]) ? o["options"].filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 60)).slice(0, 50) : undefined;
    const pub = opts.publicDefault === false ? o["public"] === true : o["public"] !== false;
    out.push({ key, label, type, ...(options ? { options } : {}), public: pub });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/**
 * 管理画面の項目定義フォーム → 定義の配列。1 行 1 項目で「キー | 表示名 | 種類 | 選択肢（/ 区切り）| 非公開」。
 * 例: material | 素材 | text
 *     origin | 原産国 | select | 日本/中国/ベトナム
 *     cost | 原価 | number | | private
 */
export function parseFieldDefinitions(input: string): ProductField[] {
  return productFields({ product_fields: parseFieldRows(input) });
}

/** 定義フォームの行 → 生の行（検査は fieldDefinitions が行う） */
export function parseFieldRows(input: string): Record<string, unknown>[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.split("|").map((x) => x.trim()))
    .filter((cols) => cols[0])
    .map(([key, label, type, options, flag]) => ({
      key,
      label: label || key,
      type: (FIELD_TYPES as readonly string[]).includes(type ?? "") ? type : "text",
      options: options ? options.split("/") : undefined,
      public: flag !== "private",
    }));
}

export function formatFieldDefinitions(fields: ProductField[]): string {
  return fields.map((f) => [f.key, f.label, f.type, (f.options ?? []).join("/"), f.public ? "" : "private"].join(" | ").replace(/( \| )+$/, "")).join("\n");
}

/** 入力値（管理画面のフォーム or API）→ 保存する値。定義に無いキーと、型に合わない値は捨てる */
export function cleanAttributes(fields: ProductField[], input: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const v = input[f.key];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "number") {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (Number.isFinite(n)) out[f.key] = n;
      continue;
    }
    const s = String(v).trim().slice(0, f.type === "textarea" ? 500 : 200);
    if (!s) continue;
    if (f.type === "url" && !/^https?:\/\//.test(s)) continue;
    if (f.type === "select" && !(f.options ?? []).includes(s)) continue;
    out[f.key] = s;
  }
  return out;
}

/** 公開してよい項目だけ、表示名つきで返す（ストアフロント・公開 API 用） */
export function publicAttributes(fields: ProductField[], values: Record<string, unknown> | null | undefined): { key: string; label: string; value: string | number }[] {
  const v = values ?? {};
  return fields.filter((f) => f.public && (typeof v[f.key] === "string" || typeof v[f.key] === "number")).map((f) => ({ key: f.key, label: f.label, value: v[f.key] as string | number }));
}
