/**
 * 会員の独自項目（顧客マスタの外部連携の器。docs/knowledge/13-external-customer-master.md、0047_customer_master）。
 * 定義は shops.settings.customer_fields、値は customers.attributes。商品のカスタム項目（src/products/fields.ts）と同じ宣言型。
 * 向きは「外部 → Banto」: ランク・メルマガの同意・担当者・タグのようなマーケティングの属性を CRM が正として持ち、
 * AI 用トークンの API（customers:write）で Banto に写す。Banto は読むだけ（管理画面の一覧と、今後のクーポンの条件）。
 * 値の検査は SQL（banto_customer_attributes。定義に無い鍵は受け付けない）。ここは定義の読み書きと表示だけ。
 */
import { fieldDefinitions, formatFieldDefinitions, parseFieldRows, type ProductField } from "../products/fields";

/**
 * ショップが同意の欄を出すか（shops.settings.marketing_consent、既定 OFF）。
 * 同意は本人の行為なので、欄を出さないショップでは「未回答」のまま（false を書かない）
 */
export function marketingConsentEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return (settings ?? {})["marketing_consent"] === true;
}

export type CustomerField = ProductField;

/** 会員の項目はお客様の画面には出さない（public は常に false。定義の private の印は無視する） */
export function customerFields(settings: Record<string, unknown> | null | undefined): CustomerField[] {
  return fieldDefinitions((settings ?? {})["customer_fields"], { publicDefault: false }).map((f) => ({ ...f, public: false }));
}

export function parseCustomerFieldDefinitions(input: string): CustomerField[] {
  return customerFields({ customer_fields: parseFieldRows(input) });
}

export { formatFieldDefinitions };

/** 外部の ID（{provider, id}）。形が違えば null */
export function externalRef(v: unknown): { provider: string; id: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o["provider"] === "string" && typeof o["id"] === "string" ? { provider: o["provider"], id: o["id"] } : null;
}

/**
 * 管理画面のフォーム（attr_<key>）→ customer_set_attributes に渡す値。空欄は null（消す）。
 * 型の検査は SQL が行うので、ここは文字列を渡すだけ（number は数に直す）
 */
export function attributesFromForm(fields: CustomerField[], form: Record<string, string | undefined>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const f of fields) {
    const raw = form[`attr_${f.key}`];
    if (raw === undefined) continue;
    const v = raw.trim();
    if (v === "") {
      out[f.key] = null;
      continue;
    }
    out[f.key] = f.type === "number" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

/** 管理画面の一覧に出す「表示名: 値」の並び（定義の順。定義に無い鍵は出さない） */
export function attributeRows(fields: CustomerField[], values: unknown): { key: string; label: string; value: string }[] {
  const v = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  return fields
    .filter((f) => typeof v[f.key] === "string" || typeof v[f.key] === "number")
    .map((f) => ({ key: f.key, label: f.label, value: String(v[f.key]) }));
}
