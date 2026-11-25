/**
 * AI 用 API の注文（0174）とお店で試着（0175）の明細の画像（メンテナの決定 2026-11-25。docs/ai-access.md §25）。
 * DB（api_order_json・api_tryon_json）は 1 件の注文・申し込みの応答の明細に、その商品の画像の候補 image_candidates（並べ順のまま、options と置き場の鍵）を付ける。
 * ここで SKU の 1 枚目を firstImageForSku（お店の画面・商品フィードと同じ一本道）で選び、MEDIA_BASE_URL の URL に直して image にする。
 * 候補は外へ返さない。候補の無い明細（注文の一覧・当てる前の DB）はそのまま（image を足さない）
 */
import { imageUrl } from "../media/images";
import { firstImageForSku } from "../products/images";

export interface OrderItemImage {
  url: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
}

interface Candidate {
  options?: unknown;
  storage_key?: unknown;
  thumb_key?: unknown;
  width?: unknown;
  height?: unknown;
}

/** 明細の options（[{ key, value }]）→ SKU の options（key: 値） */
function skuOptionsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(v)) return out;
  for (const o of v) {
    if (o && typeof o === "object" && typeof (o as Record<string, unknown>)["key"] === "string") {
      // null（値の無い鍵）は空の文字にする。imageMatchesSku も無い値を "" と比べる
      const val = (o as Record<string, unknown>)["value"];
      out[(o as Record<string, string>)["key"]!] = val === null || val === undefined ? "" : String(val);
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 明細 1 行: image_candidates があれば image に直す */
export function withItemImage(item: Record<string, unknown>, mediaBase: string): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(item, "image_candidates")) return item;
  const { image_candidates: raw, ...rest } = item;
  const candidates = (Array.isArray(raw) ? raw : []).filter((c): c is Candidate => !!c && typeof c === "object" && typeof (c as Candidate).storage_key === "string");
  const first = firstImageForSku(candidates, skuOptionsOf(item["options"]));
  const image: OrderItemImage | null = first
    ? {
        url: imageUrl(mediaBase, first.storage_key as string),
        thumb: typeof first.thumb_key === "string" && first.thumb_key ? imageUrl(mediaBase, first.thumb_key) : null,
        width: num(first.width),
        height: num(first.height),
      }
    : null;
  return { ...rest, image };
}

/** 注文の JSON の明細すべて */
export function withOrderItemMedia<T extends Record<string, unknown>>(order: T, mediaBase: string): T {
  const items = order["items"];
  if (!Array.isArray(items)) return order;
  return { ...order, items: items.map((it) => (it && typeof it === "object" ? withItemImage(it as Record<string, unknown>, mediaBase) : it)) };
}
