/**
 * LINE の注文の知らせのカード（Flex Message、0179、メンテナの決定 2026-11-25、docs/notices.md「LINE のカード」）。
 *
 * ショップが「お知らせの文面」で LINE の見た目を「カード」にしたとき（`shops.settings.line_notice_style = "card"`）、
 * 注文の受付・発送の知らせを、見出し（ショップ名）・本文・ボタン（ご注文の状況・配送状況）のカードで送る。
 *   - 型は Banto が 1 つだけ持つ。ショップが Flex の JSON を書く形は持たない（載せる中身とリンクの先を Banto が確かめるため）
 *   - 本文はショップが直せる LINE の文面（{{order_link}} は空、{{tracking}} は番号だけにして描く。リンクはボタンへ）
 *   - ボタンは https の URL だけ（LINE が受けない URL で 400 になると、届かないのに「友だちでない」と同じ扱いになるため）
 *   - 通知の欄・古い端末に出る代わりの文（altText）は文字だけの知らせと同じ文（リンク入り）を 400 文字まで
 * 組めなければ（本文が空など）呼び出し側が文字だけで送る
 */

export const LINE_NOTICE_STYLES = ["text", "card"] as const;
export type LineNoticeStyle = (typeof LINE_NOTICE_STYLES)[number];

/** ショップの設定の見た目（無い・知らない値は文字だけ） */
export function lineNoticeStyle(v: unknown): LineNoticeStyle {
  return v === "card" ? "card" : "text";
}

/** LINE に送るメッセージ（文字かカード） */
export type LineMessage = { type: "text"; text: string } | { type: "flex"; altText: string; contents: Record<string, unknown> };

const ALT_MAX = 400;
const URI_MAX = 1000;
const TEXT_MAX = 2000;

/** ボタンに使える URL（https・長さの上限・空白なし） */
export function cardUri(u: string | null | undefined): string | null {
  if (!u || u.length > URI_MAX || /\s/.test(u) || !URL.canParse(u)) return null;
  const url = new URL(u);
  return url.protocol === "https:" && url.href.length <= URI_MAX ? url.href : null;
}

export interface OrderCardInput {
  shopName: string;
  /** カードの本文（リンクの行を外して描いた文面） */
  body: string;
  /** 文字だけの知らせと同じ文（altText） */
  plain: string;
  orderUrl?: string | null;
  trackingUrl?: string | null;
  labels: { order: string; tracking: string };
}

/** カードを組む。本文が空なら null（呼び出し側が文字だけで送る） */
export function orderCard(input: OrderCardInput): LineMessage | null {
  const body = input.body.trim();
  const plain = input.plain.trim();
  if (!body || !plain) return null;
  const buttons = [
    { label: input.labels.tracking, uri: cardUri(input.trackingUrl) },
    { label: input.labels.order, uri: cardUri(input.orderUrl) },
  ]
    .filter((b): b is { label: string; uri: string } => b.uri !== null)
    .map((b, i) => ({ type: "button", style: i === 0 ? "primary" : "secondary", height: "sm", action: { type: "uri", label: b.label.slice(0, 40), uri: b.uri } }));
  const contents: Record<string, unknown> = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: (input.shopName.trim() || "-").slice(0, 100), weight: "bold", size: "md", wrap: true },
        { type: "separator" },
        { type: "text", text: [...body].slice(0, TEXT_MAX).join(""), size: "sm", wrap: true },
      ],
    },
    ...(buttons.length > 0 ? { footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons } } : {}),
  };
  return { type: "flex", altText: [...plain].slice(0, ALT_MAX).join(""), contents };
}

/**
 * LINE の 400 のうち、メッセージの形の誤り（応答の details に項目ごとの誤りがある）か。
 * 友だちでない・ブロックの 400 と分けて、形の誤りは黙って捨てずに失敗にする（カードの型の誤りで知らせが止まったと気づけるように）
 */
export function lineMessageShapeError(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const v = JSON.parse(body) as { details?: unknown };
    return Array.isArray(v.details) && v.details.length > 0;
  } catch {
    return false;
  }
}
