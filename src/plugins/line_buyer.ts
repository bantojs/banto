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
import { noticeLine, type NoticeTextRow } from "../notices/templates";
import { tryonNoticeKind } from "../modules/store-tryon/mail";

/** 注文の知らせ。ショップが直した文面（0154）があればそれ、無い・今の決まりに合わなければ既定の文面 */
export function buyerMessage(event: string, r: { number: number; total_jpy: number; shop_name: string }, texts?: readonly NoticeTextRow[] | null): string | null {
  // order.created は未入金の注文（代金引換、0157）の受付。呼び出し側が payment_status で選ぶ
  const kind = event === "order.paid" || event === "order.created" ? "order_paid" : event === "order.shipped" ? "order_shipped" : null;
  if (!kind) return null;
  return noticeLine(kind, texts, { shop_name: r.shop_name, number: String(r.number), total: `¥${Number(r.total_jpy).toLocaleString("ja-JP")}` });
}

/**
 * お店で試着（0025）: 受付・取り置き開始・取り置きの延長（0151）・前日のお知らせ（0152）・取り消しだけ知らせる。
 * ショップが直した文面（0154）があればそれ、無い・今の決まりに合わなければ既定の文面
 */
export function tryonLineMessage(event: string, r: { number: number; status: string; hold_until: string | null; store_name: string; shop_name: string }, opts: { extended?: boolean; reminder?: boolean } = {}, texts?: readonly NoticeTextRow[] | null): string | null {
  // 前日のお知らせ・延長の知らせが届く前に状態が変わっていたら送らない
  if ((opts.reminder || opts.extended) && r.status !== "ready") return null;
  const kind = tryonNoticeKind(event, r.status, opts);
  if (!kind) return null;
  // 期限が無いとき（今の DB では起きない）、前日のお知らせは今までどおり「明日」
  const until = r.hold_until ? `${Number(r.hold_until.slice(5, 7))}月${Number(r.hold_until.slice(8, 10))}日` : kind === "tryon_reminder" ? "明日" : "";
  return noticeLine(kind, texts, { shop_name: r.shop_name, number: String(r.number), store_name: r.store_name, hold_until: until });
}

export const lineBuyerNotify: BundledPlugin = {
  id: "line_buyer_notify",
  manifest: {
    name: "LINE で購入者に知らせる",
    version: "1.1.0",
    description: "LINE でログインした会員に、ショップの LINE 公式アカウントから注文の受付・発送（お店で試着の受付・取り置き）を知らせます。チャネルアクセストークンは管理画面の「LINE 公式アカウント」で入れます。",
    // order.created は代金引換などの未入金の注文の受付だけ（0157）
    events: ["order.created", "order.paid", "order.shipped", "tryon.requested", "tryon.updated"],
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
    const opts = { extended: data["extended"] === true, reminder: data["reminder"] === true };
    const kind = r ? tryonNoticeKind(event, r.status, opts) : null;
    const text = r && kind ? tryonLineMessage(event, r, opts, await ctx.privileged.shopNoticeTexts(shop_id, kind)) : null;
    return r && text ? { to: r.line_user_id, text } : null;
  }
  const orderId = typeof data["order_id"] === "string" ? data["order_id"] : "";
  if (!orderId) return null;
  // 未入金の注文の入金の記録（0156）で出た order.paid には、受付の知らせを重ねて送らない
  if (event === "order.paid" && data["recorded_payment"] === true) return null;
  // 注文の受付: 入金済みの注文は order.paid、未入金の注文（代金引換、0157）は order.created で知らせる
  if (event === "order.created" && data["payment_status"] !== "unpaid") return null;
  if (event !== "order.created" && event !== "order.paid" && event !== "order.shipped") return null;
  const r = await ctx.privileged.orderLineRecipient(orderId, shop_id);
  // 送り先があるときだけ文面を読む（LINE と結びついていない注文で DB の往復を増やさない）
  const kind = event === "order.shipped" ? "order_shipped" : "order_paid";
  const text = r ? buyerMessage(event, r, await ctx.privileged.shopNoticeTexts(shop_id, kind)) : null;
  return r && text ? { to: r.line_user_id, text } : null;
}
