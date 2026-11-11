/**
 * LINE 通知: 注文・在庫僅少を LINE Messaging API（push）で運営者に知らせる。
 * チャネルアクセストークンはショップごとの設定（管理画面「LINE 公式アカウント」、0021）か、Secret の LINE_CHANNEL_ACCESS_TOKEN。
 * 送信先ユーザー ID は設定で指定する。個人情報（購入者の氏名等）は送らない。
 */
import type { BundledPlugin, PluginContext } from "./types";
import { lineToken } from "./line_token";

export const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export function lineMessageFor(ctx: PluginContext): string | null {
  const { event, data } = ctx.envelope;
  const yen = (n: unknown) => `¥${Number(n ?? 0).toLocaleString("ja-JP")}`;
  if (event === "order.paid") {
    const items = Array.isArray(data["items"]) ? (data["items"] as { qty?: number }[]) : [];
    const qty = items.reduce((n, i) => n + Number(i.qty ?? 0), 0);
    return `【Banto】新しい注文が入りました\n合計 ${yen(data["total_jpy"])}（${qty} 点）\n注文 ID: ${String(data["order_id"] ?? "").slice(0, 8)}…`;
  }
  if (event === "order.cancelled") return `【Banto】注文がキャンセルされました\n合計 ${yen(data["total_jpy"])}\n注文 ID: ${String(data["order_id"] ?? "").slice(0, 8)}…`;
  if (event === "inventory.low") return `【Banto】在庫が残りわずかです\nSKU: ${String(data["sku_id"] ?? "").slice(0, 8)}…\n残り ${String(data["available"])} 点（閾値 ${String(data["threshold"])}）`;
  return null;
}

/** まとめて知らせるときに並べる SKU の数（LINE の 1 通は 5,000 字まで） */
export const LINE_LOW_STOCK_LIST_MAX = 20;

/** 在庫僅少をまとめた 1 通（棚卸し・取り込みで一度に何百もの SKU が少なくなっても、LINE は 1 回の配信で 1 通） */
export function lineLowStockSummary(ctxs: readonly PluginContext[]): string | null {
  if (ctxs.length === 0) return null;
  if (ctxs.length === 1) return lineMessageFor(ctxs[0]!);
  const lines = ctxs.slice(0, LINE_LOW_STOCK_LIST_MAX).map(({ envelope: { data } }) => `・SKU: ${String(data["sku_id"] ?? "").slice(0, 8)}… 残り ${String(data["available"])} 点`);
  const rest = ctxs.length - lines.length;
  const threshold = String(ctxs[0]!.envelope.data["threshold"]);
  return [`【Banto】在庫が残りわずかな SKU が ${ctxs.length} 件あります（閾値 ${threshold}）`, ...lines, ...(rest > 0 ? [`ほか ${rest} 件`] : [])].join("\n");
}

async function pushText(ctx: PluginContext, text: string, retryKey: string): Promise<void> {
  const to = typeof ctx.settings["to"] === "string" ? ctx.settings["to"].trim() : "";
  if (!to) throw new Error("line_notify: 送信先ユーザー ID が未設定");
  const token = await lineToken(ctx);
  if (!token) throw new Error("line_notify: チャネルアクセストークンが未設定");
  const res = await ctx.fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  // 409 は同じ再送キーを LINE が受け付け済み（送れている。src/line/send.ts の pushLine と同じ）
  if (!res.ok && res.status !== 409) throw new Error(`LINE API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * まとめた配信の再送キー: まとめた id 全部の SHA-256 を UUID の形にする（LINE は UUID の形を求める）。
 * 同じ組の再送は同じキー（LINE が重ねて送らない）、再送のときに新しい配信が加わったら別のキー（加わった分も送る）
 */
export async function batchRetryKey(ids: readonly string[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...ids].sort().join(","))));
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4 の形
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const lineNotify: BundledPlugin = {
  id: "line_notify",
  manifest: {
    name: "LINE 通知",
    version: "1.0.0",
    description: "注文が入ったとき・在庫が少なくなったときに、LINE で運営者に通知します。購入者の個人情報は送りません。",
    events: ["order.paid", "order.cancelled", "inventory.low"],
    settings: [{ key: "to", label: "送信先のユーザー ID（U で始まる）", type: "text", required: true, description: "LINE Developers コンソールのチャネル基本設定「あなたのユーザー ID」" }],
  },
  // トークンはショップごとの設定でもよいので、Secret は必須にしない（lineToken）
  requiredSecrets: [],
  async handle(ctx) {
    const text = lineMessageFor(ctx);
    if (!text) return;
    await pushText(ctx, text, ctx.envelope.id);
  },
  // 在庫僅少は、同じ回に取り出した分を 1 通にまとめる（人が在庫を減らしたときも届くようになったため、0141）。
  // 再送の鍵はまとめた配信の id 全部から作る（batchRetryKey）。1 件だけなら今までどおりその id
  batchEvents: ["inventory.low"],
  async handleBatch(ctxs) {
    const text = lineLowStockSummary(ctxs);
    if (!text) return;
    await pushText(ctxs[0]!, text, ctxs.length === 1 ? ctxs[0]!.envelope.id : await batchRetryKey(ctxs.map((c) => c.envelope.id)));
  },
};
