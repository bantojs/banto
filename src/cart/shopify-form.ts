/**
 * Shopify のテーマが送るカートの書き方を、Banto のカート（SKU ごとの数）への変更に読み替える（docs/themes.md「カート」）。
 * フォーム（{% form 'cart' %}・url_to_remove）と AJAX（/cart/add.js・/cart/change.js・/cart/update.js）の両方。
 *   - updates[<SKU の id>]=2、または updates[]=2&updates[]=1（今のカートの行の順）、JSON の { updates: {...} | [...] }
 *   - id（SKU の id）か line（1 から数える行）と quantity
 *   - 足す: id と quantity、または items: [{ id, quantity }]
 * 判定（公開中の SKU か・在庫）はここでは行わない（呼び出し側が skusForCart と priceCart で確かめる）
 */
export interface CartChange {
  skuId: string;
  qty: number;
}

/** 1 回に変えられる行の数（カートの上限より十分大きく） */
const MAX_CHANGES = 100;

const toInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d{1,6}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};
const one = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** 行の位置（updates[]・updates の配列・line）で書いているか。位置は画面に出ている行で数えるので、呼び出し側が並びを引く */
export function usesLinePosition(input: Record<string, unknown>): boolean {
  if (Array.isArray(input["updates"]) || input["updates[]"] !== undefined) return true;
  const id = one(input["id"]);
  return !(typeof id === "string" && id.trim()) && input["line"] !== undefined;
}

/** 数を変える（updates）。order は今のカートの行の SKU の id（updates[] の位置に使う） */
export function updatesFrom(input: Record<string, unknown>, order: readonly string[]): CartChange[] {
  const out: CartChange[] = [];
  const push = (skuId: unknown, q: unknown) => {
    const qty = toInt(one(q));
    if (typeof skuId === "string" && skuId && qty !== null && qty >= 0 && out.length < MAX_CHANGES) out.push({ skuId, qty });
  };
  const u = input["updates"];
  if (Array.isArray(u)) u.forEach((q, i) => push(order[i], q));
  else if (isObject(u)) for (const [k, q] of Object.entries(u)) push(k, q);
  const list = input["updates[]"];
  if (list !== undefined) (Array.isArray(list) ? list : [list]).forEach((q, i) => push(order[i], q));
  for (const [k, q] of Object.entries(input)) {
    const m = /^updates\[([^\]]+)\]$/.exec(k);
    if (m) push(m[1], q);
  }
  return out;
}

/** 1 行を変える（change）。id か line。quantity 0 で外す */
export function changeFrom(input: Record<string, unknown>, order: readonly string[]): CartChange | null {
  const qty = toInt(one(input["quantity"]));
  if (qty === null || qty < 0) return null;
  const id = one(input["id"]);
  if (typeof id === "string" && id.trim()) return { skuId: id.trim(), qty };
  if (typeof id === "number") return null;
  const line = toInt(one(input["line"]));
  if (line !== null && line >= 1 && line <= order.length) return { skuId: order[line - 1]!, qty };
  return null;
}

/** 足す（add）。id と quantity（quantity は省くと 1）、または items */
export function addsFrom(input: Record<string, unknown>): CartChange[] {
  const out: CartChange[] = [];
  const push = (id: unknown, q: unknown) => {
    const qty = q === undefined || q === "" ? 1 : toInt(one(q));
    const sid = one(id);
    if (typeof sid === "string" && sid.trim() && qty !== null && qty > 0 && out.length < MAX_CHANGES) out.push({ skuId: sid.trim(), qty });
  };
  const items = input["items"];
  if (Array.isArray(items)) {
    for (const it of items) if (isObject(it)) push(it["id"], it["quantity"]);
  } else {
    push(input["id"] ?? input["sku_id"], input["quantity"] ?? input["qty"]);
  }
  return out;
}
