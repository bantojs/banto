/**
 * LINE で購入者に知らせる（同梱プラグイン、0021、docs/line.md）。
 * LINE でログインした会員の注文だけ、ショップの LINE 公式アカウント（Messaging API）から「受け付けました」「発送しました」を送る。
 * 送り先は会員の LINE の利用者 ID（LINE ログインのチャネルと Messaging API のチャネルが同じプロバイダーのとき同じ値）。
 * 公式アカウントを友だちに追加していない人には届かない（LINE ログインの画面で友だち追加を促せる）。
 * 文に載せるのは注文番号・合計・ショップ名だけ（住所・氏名は載せない）。
 */
import type { BundledPlugin, PluginContext } from "./types";
import { LINE_PUSH_URL } from "./line_notify";
import { lineToken } from "./line_token";

export function buyerMessage(event: string, r: { number: number; total_jpy: number; shop_name: string }): string | null {
  const yen = `¥${Number(r.total_jpy).toLocaleString("ja-JP")}`;
  if (event === "order.paid") return `【${r.shop_name}】ご注文ありがとうございます。\n注文番号 ${r.number}\n合計 ${yen}\n発送の準備ができしだい、お知らせします。`;
  if (event === "order.shipped") return `【${r.shop_name}】ご注文の商品を発送しました。\n注文番号 ${r.number}\n到着までしばらくお待ちください。`;
  return null;
}

/** お店で試着（0025）: 受付・取り置き開始・取り消しだけ知らせる */
export function tryonLineMessage(event: string, r: { number: number; status: string; hold_until: string | null; store_name: string; shop_name: string }): string | null {
  if (event === "tryon.requested") return `【${r.shop_name}】お店で試着のお申し込みを承りました。\n受付番号 ${r.number}\n店舗 ${r.store_name}\n店舗でご用意ができしだい、お知らせします。`;
  if (event === "tryon.updated" && r.status === "ready") {
    const until = r.hold_until ? `\n${Number(r.hold_until.slice(5, 7))}月${Number(r.hold_until.slice(8, 10))}日までお取り置きします。` : "";
    return `【${r.shop_name}】${r.store_name}でご試着いただけます。\n受付番号 ${r.number}${until}`;
  }
  if (event === "tryon.updated" && r.status === "cancelled") return `【${r.shop_name}】お店で試着のお申し込み（受付番号 ${r.number}）を取り消しました。`;
  return null;
}

export const lineBuyerNotify: BundledPlugin = {
  id: "line_buyer_notify",
  manifest: {
    name: "LINE で購入者に知らせる",
    version: "1.0.0",
    description: "LINE でログインした会員に、ショップの LINE 公式アカウントから注文の受付・発送（お店で試着の受付・取り置き）を知らせます。チャネルアクセストークンは管理画面の「LINE 公式アカウント」で入れます。",
    events: ["order.paid", "order.shipped", "tryon.requested", "tryon.updated"],
    settings: [],
  },
  requiredSecrets: [],
  async handle(ctx: PluginContext) {
    const text = await messageFor(ctx);
    if (!text) return;
    const token = await lineToken(ctx);
    if (!token) throw new Error("line_buyer_notify: チャネルアクセストークンが未設定");
    const res = await ctx.fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Line-Retry-Key": ctx.envelope.id },
      body: JSON.stringify({ to: text.to, messages: [{ type: "text", text: text.text }] }),
    });
    // 友だちでない・ブロックされた人には送れない（400/403）。再送しても届かないので、失敗にしない
    if (res.status === 400 || res.status === 403) return;
    if (!res.ok) throw new Error(`LINE API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

/** 送り先と文（LINE と結びついていない会員・ゲスト、知らせない状態なら null） */
async function messageFor(ctx: PluginContext): Promise<{ to: string; text: string } | null> {
  const { event, data, shop_id } = ctx.envelope;
  if (event.startsWith("tryon.")) {
    const id = typeof data["request_id"] === "string" ? data["request_id"] : "";
    if (!id || (event === "tryon.updated" && !["ready", "cancelled"].includes(String(data["status"])))) return null;
    const r = await ctx.privileged.tryonLineRecipient(id, shop_id);
    const text = r ? tryonLineMessage(event, r) : null;
    return r && text ? { to: r.line_user_id, text } : null;
  }
  const orderId = typeof data["order_id"] === "string" ? data["order_id"] : "";
  if (!orderId) return null;
  const r = await ctx.privileged.orderLineRecipient(orderId, shop_id);
  const text = r ? buyerMessage(event, r) : null;
  return r && text ? { to: r.line_user_id, text } : null;
}
