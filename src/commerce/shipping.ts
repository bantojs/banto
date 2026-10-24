/**
 * 送料と税の表示ルール（docs/ARCHITECTURE.md には無い、v0.1 で追加した商取引の最小ルール）。
 * - 価格はすべて税込（総額表示）。tax_rate は表示（内税の内訳）にだけ使う
 * - 送料は「全国一律」または「都道府県別」。free_over_jpy 以上の商品合計で無料
 * - 計算はこの関数だけで行い、確定時の金額を予約と注文に残す（後から設定を変えても過去の注文は変わらない）
 */
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
}

export const DEFAULT_SHIPPING: ShippingSettings = { mode: "flat", flat_fee_jpy: 0, by_prefecture: {}, free_over_jpy: null };

export function isPrefecture(s: string): s is Prefecture {
  return (PREFECTURES as readonly string[]).includes(s);
}

/** shops.settings.shipping を安全に読む（壊れていても既定値で動く） */
export function parseShippingSettings(raw: unknown): ShippingSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SHIPPING;
  const r = raw as Record<string, unknown>;
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
  };
}

/** 送料を計算する。prefecture が不明なら flat_fee を使う */
export function shippingFee(settings: ShippingSettings, subtotalJpy: number, prefecture: string | null | undefined): number {
  if (settings.free_over_jpy !== null && subtotalJpy >= settings.free_over_jpy) return 0;
  if (settings.mode === "by_prefecture" && prefecture && isPrefecture(prefecture)) {
    const f = settings.by_prefecture[prefecture];
    if (f !== undefined) return f;
  }
  return settings.flat_fee_jpy;
}

/** ストアフロントの説明文（カート・送料ページ用） */
export function describeShipping(settings: ShippingSettings): { summary: string; freeOver: number | null; table: { prefecture: string; fee: number }[] | null } {
  const table = settings.mode === "by_prefecture" ? PREFECTURES.map((p) => ({ prefecture: p, fee: settings.by_prefecture[p] ?? settings.flat_fee_jpy })) : null;
  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  const summary =
    settings.mode === "by_prefecture"
      ? `送料は都道府県により ${yen(Math.min(...table!.map((t) => t.fee)))}〜${yen(Math.max(...table!.map((t) => t.fee)))}（税込）`
      : settings.flat_fee_jpy === 0
        ? "送料無料"
        : `送料は全国一律 ${yen(settings.flat_fee_jpy)}（税込）`;
  return { summary, freeOver: settings.free_over_jpy, table };
}

/** 税率（表示用）。既定 10% */
export function taxRate(settings: Record<string, unknown>): number {
  const v = settings["tax_rate"];
  return typeof v === "number" && v >= 0 && v <= 100 ? v : 10;
}

/** 税込価格から内税額を求める（切り捨て） */
export function includedTax(priceJpy: number, rate: number): number {
  return Math.floor((priceJpy * rate) / (100 + rate));
}
