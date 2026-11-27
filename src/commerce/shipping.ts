/**
 * 送料と税の表示ルール（docs/ARCHITECTURE.md には無い、v0.1 で追加した商取引の最小ルール）。
 * - 価格はすべて税込（総額表示）。tax_rate は表示（内税の内訳）にだけ使う
 * - 送料は「全国一律」または「都道府県別」。free_over_jpy 以上の商品合計で無料
 * - 計算はこの関数だけで行い、確定時の金額を予約と注文に残す（後から設定を変えても過去の注文は変わらない）
 * - 会員の条件ごとの送料無料の金額（0171、free_over_by_audience）: 当てはまる会員だけ、より低い金額で無料。
 *   会員が条件に合うかは DB（member_free_shipping_over、最新の独自項目と banto_audience_ok）が決め、ここは金額を受け取るだけ
 */
import { audienceOk, type AudienceContext } from "../members/audience";

/** 会員の条件ごとの送料無料の金額（0171） */
export const AUDIENCE_FREE_SHIPPING_MIGRATION = "0171_audience_free_shipping";
/** 送料無料の金額にセール商品を含まない印（0183） */
export const FREE_SHIPPING_EXCLUDE_SALE_MIGRATION = "0183_free_shipping_exclude_sale";
/** 決まりの数の上限（DB の banto_audience_free_rules も同じ読み方で先頭の 10 件だけを見る） */
export const AUDIENCE_FREE_RULES_MAX = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

export type Prefecture = (typeof PREFECTURES)[number];

export interface ShippingSettings {
  mode: "flat" | "by_prefecture";
  /** 全国一律、または都道府県別で未設定の県に使う額 */
  flat_fee_jpy: number;
  by_prefecture: Partial<Record<Prefecture, number>>;
  /** 商品合計がこの額以上で送料無料。null なら無し */
  free_over_jpy: number | null;
  /** 0183: ショップ全体の送料無料の金額にセール商品（通常価格のある SKU）を含まない */
  free_over_excludes_sale: boolean;
  /** 会員の条件ごとの送料無料の金額（0171）。label はお店の画面の送料の案内に出す名前（空なら出さない）。お客様の画面の設定（公開の形）では空 */
  free_over_by_audience: AudienceFreeRule[];
  /** 送料の案内に出す会員の条件ごとの送料無料（名前を付けた決まりだけ。管理画面の形からも公開の形からも作る） */
  member_free: { label: string; free_over_jpy: number; exclude_sale: boolean }[];
  /** 会員の条件ごとの決まりがあるか（あれば会員の判定を DB に聞く。公開の形では member_free: true） */
  has_member_free: boolean;
}

export interface AudienceFreeRule {
  audience_id: string;
  /** この金額以上で送料無料（0 = いつでも無料） */
  free_over_jpy: number;
  /** 送料の案内に出す名前（例「ゴールド会員」）。null なら案内に出さない（会員の条件の名前はお客様に見せない） */
  label: string | null;
  /** 0183: この金額にセール商品（通常価格のある SKU）を含まない */
  exclude_sale: boolean;
}

/**
 * 送料無料の決まり 1 つ（0183）: この金額以上で無料。excludeSale ならセール商品を除いた商品の合計で比べる
 */
export interface FreeTarget {
  over: number;
  excludeSale: boolean;
}

/** 送料無料と比べる金額: all = 商品の合計（値引きの前、今までどおり）、nonSale = そこからセール商品の分を引いたもの */
export interface FreeBases {
  all: number;
  nonSale: number;
}

const baseOf = (t: FreeTarget, b: FreeBases) => (t.excludeSale ? b.nonSale : b.all);

/** どれか 1 つの決まりを満たすか */
export function freeReached(targets: readonly FreeTarget[], b: FreeBases): boolean {
  return targets.some((t) => baseOf(t, b) >= t.over);
}

/** 送料無料まであといくら（満たしていれば 0、決まりが無ければ null）。決まりごとの残りの少ないほう */
export function freeLeft(targets: readonly FreeTarget[], b: FreeBases): number | null {
  if (targets.length === 0) return null;
  return Math.max(0, Math.min(...targets.map((t) => t.over - baseOf(t, b))));
}

/** 品目からセール商品を除いた合計（0183。セール = 通常価格が価格より高い SKU。価格は行の単価） */
export function nonSaleSubtotal(lines: readonly { qty: number; sku: { price_jpy: number; compare_at_price_jpy?: number | null } }[], subtotal: number): number {
  const sale = lines.reduce((a, l) => a + (typeof l.sku.compare_at_price_jpy === "number" && l.sku.compare_at_price_jpy > l.sku.price_jpy ? l.sku.price_jpy * l.qty : 0), 0);
  return Math.max(0, subtotal - sale);
}

/** 数字だけの金額は今までどおり（セール商品も含む） */
export const basesOf = (v: number | FreeBases): FreeBases => (typeof v === "number" ? { all: v, nonSale: v } : v);

/** 送料が 0 円になった理由: threshold = ショップ全体の金額・audience = 会員の条件の金額（会員特典）。送料がかかるか、もともと 0 円なら null */
export type ShippingFreeReason = "threshold" | "audience" | null;

export const DEFAULT_SHIPPING: ShippingSettings = { mode: "flat", flat_fee_jpy: 0, by_prefecture: {}, free_over_jpy: null, free_over_excludes_sale: false, free_over_by_audience: [], member_free: [], has_member_free: false };

export function isPrefecture(s: string): s is Prefecture {
  return (PREFECTURES as readonly string[]).includes(s);
}

/** shops.settings.shipping を安全に読む（壊れていても既定値で動く） */
export function parseShippingSettings(raw: unknown): ShippingSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SHIPPING;
  const r = raw as Record<string, unknown>;
  const rules = audienceFreeRules(r["free_over_by_audience"]);
  const fee = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);
  const by: Partial<Record<Prefecture, number>> = {};
  if (r["by_prefecture"] && typeof r["by_prefecture"] === "object") {
    for (const [k, v] of Object.entries(r["by_prefecture"] as Record<string, unknown>)) {
      const f = fee(v);
      if (isPrefecture(k) && f !== null) by[k] = f;
    }
  }
  return {
    mode: r["mode"] === "by_prefecture" ? "by_prefecture" : "flat",
    flat_fee_jpy: fee(r["flat_fee_jpy"]) ?? 0,
    by_prefecture: by,
    free_over_jpy: fee(r["free_over_jpy"]),
    free_over_excludes_sale: r["free_over_excludes_sale"] === true,
    free_over_by_audience: rules,
    member_free: rules.length > 0 ? rules.filter((x) => x.label !== null).map((x) => ({ label: x.label!, free_over_jpy: x.free_over_jpy, exclude_sale: x.exclude_sale })) : publicMemberFree(r["free_over_by_audience"]),
    has_member_free: rules.length > 0 || r["member_free"] === true,
  };
}

/** 公開の形（banto_public_shipping）の free_over_by_audience: [{ label, free_over_jpy }] */
function publicMemberFree(raw: unknown): { label: string; free_over_jpy: number; exclude_sale: boolean }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; free_over_jpy: number; exclude_sale: boolean }[] = [];
  for (const v of raw.slice(0, AUDIENCE_FREE_RULES_MAX)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const over = o["free_over_jpy"];
    if (typeof o["label"] !== "string" || o["label"].trim() === "" || typeof over !== "number" || !Number.isInteger(over) || over < 0 || over > 1_000_000) continue;
    out.push({ label: o["label"].trim().slice(0, 40), free_over_jpy: over, exclude_sale: o["exclude_sale"] === true });
  }
  return out;
}

/**
 * お客様に公開する送料の設定（DB の banto_public_shipping と同じ）。会員の条件ごとの決まりは、名前を付けたものの名前と金額だけ。
 * 会員の条件の id・名前の無い決まりの金額は出さない。決まりがあることだけ member_free: true で知らせる（会員の判定を DB に聞くため）
 */
export function publicShipping(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { free_over_by_audience: rawRules, member_free: _drop, ...rest } = raw as Record<string, unknown>;
  void _drop;
  const rules = audienceFreeRules(rawRules);
  if (rules.length === 0) return rest;
  return { ...rest, member_free: true, free_over_by_audience: rules.filter((x) => x.label !== null).map((x) => ({ label: x.label, free_over_jpy: x.free_over_jpy, exclude_sale: x.exclude_sale })) };
}

/** free_over_by_audience を読む（形の違う行・重なる条件は捨てる。10 件まで。DB の banto_audience_free_rules と同じ読み方） */
export function audienceFreeRules(raw: unknown): AudienceFreeRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AudienceFreeRule[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (out.length >= AUDIENCE_FREE_RULES_MAX) break;
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const id = typeof o["audience_id"] === "string" ? o["audience_id"].toLowerCase() : "";
    const over = o["free_over_jpy"];
    if (!UUID_RE.test(id) || seen.has(id) || typeof over !== "number" || !Number.isInteger(over) || over < 0 || over > 1_000_000) continue;
    const label = typeof o["label"] === "string" ? o["label"].trim().slice(0, 40) : "";
    seen.add(id);
    out.push({ audience_id: id, free_over_jpy: over, label: label || null, exclude_sale: o["exclude_sale"] === true });
  }
  return out;
}

/** ショップ全体の送料無料の決まり（無ければ []） */
export function shopFreeTargets(settings: ShippingSettings): FreeTarget[] {
  return settings.free_over_jpy === null ? [] : [{ over: settings.free_over_jpy, excludeSale: settings.free_over_excludes_sale }];
}

/**
 * 送料と、0 円になった理由。prefecture が不明なら flat_fee を使う。
 * subtotal: 商品の合計（数字なら今までどおり、セール商品を除いた合計も渡すときは FreeBases、0183）。
 * memberFree: ログイン中の会員が当てはまる会員の条件の決まり（DB の member_free_shipping。0183 の前は member_free_shipping_over の金額）。無ければ null
 */
export function shippingQuote(settings: ShippingSettings, subtotal: number | FreeBases, prefecture: string | null | undefined, memberFree: number | readonly FreeTarget[] | null = null): { fee: number; free_reason: ShippingFreeReason } {
  const b = basesOf(subtotal);
  if (freeReached(shopFreeTargets(settings), b)) return { fee: 0, free_reason: "threshold" };
  let fee = settings.flat_fee_jpy;
  if (settings.mode === "by_prefecture" && prefecture && isPrefecture(prefecture)) {
    const f = settings.by_prefecture[prefecture];
    if (f !== undefined) fee = f;
  }
  const member: FreeTarget[] = memberFree === null ? [] : typeof memberFree === "number" ? [{ over: memberFree, excludeSale: false }] : [...memberFree];
  if (fee > 0 && freeReached(member, b)) return { fee: 0, free_reason: "audience" };
  return { fee, free_reason: null };
}

/**
 * カートの「あと○円で送料無料」の目安（0171、表示だけ）: 覚えた会員の条件の一覧（shop_audiences_render の free_over_jpy と、0183 から
 * free_over_excludes_sale）と、会員の Cookie・会員トークンに入れた独自項目（数分ごとに入れ直す）で、当てはまる決まり。ゲスト・当てはまらなければ []。
 * お金（確認画面の送料）は DB の member_free_shipping が決める
 */
export function memberFreeTargetsHint(list: readonly { condition: unknown; free_over_jpy?: number; free_over_excludes_sale?: boolean }[], viewer: AudienceContext): FreeTarget[] {
  if (!viewer.member) return [];
  const out: FreeTarget[] = [];
  for (const a of list) {
    if (typeof a.free_over_jpy !== "number" || !Number.isInteger(a.free_over_jpy) || a.free_over_jpy < 0) continue;
    // URL のパラメータは見ない（表示用の条件は一覧の側で金額を付けていない）
    if (!audienceOk(a.condition, { member: true, attrs: viewer.attrs })) continue;
    out.push({ over: a.free_over_jpy, excludeSale: a.free_over_excludes_sale === true });
  }
  return out;
}

/** 今までの目安（いちばん低い金額。セール商品の印は見ない） */
export function memberFreeOverHint(list: readonly { condition: unknown; free_over_jpy?: number; free_over_excludes_sale?: boolean }[], viewer: AudienceContext): number | null {
  const t = memberFreeTargetsHint(list, viewer);
  return t.length === 0 ? null : Math.min(...t.map((x) => x.over));
}

/** 見る人の送料無料の金額: ショップ全体と会員の目安の低い方。member は会員の目安のほうが低い（会員特典）か */
export function freeShippingTarget(shopWide: number | null, memberOver: number | null): { over: number | null; member: boolean } {
  if (memberOver !== null && (shopWide === null || memberOver < shopWide)) return { over: memberOver, member: true };
  return { over: shopWide, member: false };
}

/**
 * カートの「あと○円で送料無料」（0183）: ショップ全体と見る人の会員の決まりのうち、残りの少ないもの。left = 0 なら送料無料、
 * member は会員の決まりで送料無料になる・いちばん近いか。決まりが無ければ null
 */
export function freeShippingProgress(shopWide: readonly FreeTarget[], member: readonly FreeTarget[], b: FreeBases): { left: number; member: boolean } | null {
  const s = freeLeft(shopWide, b);
  const m = freeLeft(member, b);
  if (s === null && m === null) return null;
  if (m !== null && (s === null || m < s)) return { left: m, member: true };
  return { left: s!, member: false };
}

/** 送料を計算する。prefecture が不明なら flat_fee を使う */
export function shippingFee(settings: ShippingSettings, subtotal: number | FreeBases, prefecture: string | null | undefined, memberFree: number | readonly FreeTarget[] | null = null): number {
  return shippingQuote(settings, subtotal, prefecture, memberFree).fee;
}

/** ストアフロントの説明文（カート・送料ページ用） */
export function describeShipping(settings: ShippingSettings): {
  summary: string;
  freeOver: number | null;
  table: { prefecture: string; fee: number }[] | null;
  /** 会員の条件ごとの送料無料（0171）。名前（label）を付けた決まりだけ。お店の画面は「<名前>の方は ○円以上で送料無料」。excludeSale はセール商品を含まない（0183） */
  memberFree: { label: string; freeOver: number; excludeSale: boolean }[];
  /** 0183: ショップ全体の送料無料の金額にセール商品を含まない */
  freeOverExcludesSale: boolean;
} {
  const table = settings.mode === "by_prefecture" ? PREFECTURES.map((p) => ({ prefecture: p, fee: settings.by_prefecture[p] ?? settings.flat_fee_jpy })) : null;
  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  const summary =
    settings.mode === "by_prefecture"
      ? `送料は都道府県により ${yen(Math.min(...table!.map((t) => t.fee)))}〜${yen(Math.max(...table!.map((t) => t.fee)))}（税込）`
      : settings.flat_fee_jpy === 0
        ? "送料無料"
        : `送料は全国一律 ${yen(settings.flat_fee_jpy)}（税込）`;
  const memberFree = settings.member_free.map((r) => ({ label: r.label, freeOver: r.free_over_jpy, excludeSale: r.exclude_sale }));
  return { summary, freeOver: settings.free_over_jpy, table, memberFree, freeOverExcludesSale: settings.free_over_excludes_sale };
}

/** 税率（表示用）。既定 10% */
export function taxRate(settings: Record<string, unknown>): number {
  const v = settings["tax_rate"];
  return typeof v === "number" && v >= 0 && v <= 100 ? v : 10;
}

