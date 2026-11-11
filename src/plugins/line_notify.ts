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
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  // 再送の鍵はまとめた配信の id のうち小さいもの（同じ組で再送したときに LINE が重ねて送らない）
  batchEvents: ["inventory.low"],
  async handleBatch(ctxs) {
    const text = lineLowStockSummary(ctxs);
    if (!text) return;
    await pushText(ctxs[0]!, text, ctxs.map((c) => c.envelope.id).sort()[0]!);
  },
};
