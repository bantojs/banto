/**
 * LINE で送る口（0105_ma_ports、メンテナの決定 2026-11-03、docs/line.md §4）。
 *
 * 外部プラグイン（MA など）が「この会員にこの文を」と頼み、Banto がショップの LINE 公式アカウントのトークン（0021）で 1 通送る。
 * - LINE の利用者 ID は Banto の外へ出さない（DB の api_line_message_begin が Worker にだけ返す）
 * - Banto は頼まれた 1 通を送って結果を返すだけ。列・予約の時刻・再送・セグメント・頻度の制御は持たない（プラグインの仕事）
 * - 冪等: 呼ぶ側の Idempotency-Key ごとに記録の行を 1 つ作り、その行の id を LINE の再送キー（X-Line-Retry-Key）にする
 * - 文の形は決まったものだけ（文字・https の画像・https の URL のボタン）を Banto が組み立て直す。LINE の形をそのまま受けない
 */

export const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/** 結果。sent 以外は送っていない（failed は LINE の側の一時的な失敗。同じキーで送り直せる） */
export type LineSendStatus = "sent" | "no_line" | "not_friend" | "quota" | "failed";

export const LINE_TEXT_MAX = 2000;
export const LINE_BUTTONS_TEXT_MAX = 160;
export const LINE_BUTTON_LABEL_MAX = 20;
export const LINE_BUTTONS_MAX = 4;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class LineInputError extends Error {}

type LineMessage =
  | { type: "text"; text: string }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string }
  | { type: "template"; altText: string; template: { type: "buttons"; text: string; actions: { type: "uri"; label: string; uri: string }[] } };

const httpsUrl = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length > 1000 || !/^https:\/\/[^\s<>"'`\\\u0000-\u001f\u007f]+$/.test(v)) throw new LineInputError(`${name} must be an https:// URL of up to 1000 characters`);
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
  } catch {
    throw new LineInputError(`${name} must be an https:// URL of up to 1000 characters`);
  }
  return v;
};

const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== "string") throw new LineInputError(`${name} must be a string`);
  const s = v.replace(/\r\n?/g, "\n").trim();
  if (!s || [...s].length > max) throw new LineInputError(`${name} must be 1 to ${max} characters`);
  return s;
};

/**
 * 頼まれた中身を LINE の形に組み直す。受けるのは
 *   { text, image_url?, buttons?: { text, actions: [{ label, url }] } }
 * だけ（知らない鍵は 400）。
 */
export function lineMessagesFrom(body: Record<string, unknown>): LineMessage[] {
  for (const k of Object.keys(body)) if (!["text", "image_url", "buttons"].includes(k)) throw new LineInputError(`unknown field: ${k} (text, image_url, buttons)`);
  const messages: LineMessage[] = [{ type: "text", text: text(body["text"], "text", LINE_TEXT_MAX) }];
  if (body["image_url"] !== undefined && body["image_url"] !== null) {
    const url = httpsUrl(body["image_url"], "image_url");
    messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  const b = body["buttons"];
  if (b !== undefined && b !== null) {
    if (typeof b !== "object" || Array.isArray(b)) throw new LineInputError("buttons must be an object { text, actions: [{ label, url }] }");
    const bo = b as Record<string, unknown>;
    const acts = bo["actions"];
    if (!Array.isArray(acts) || acts.length < 1 || acts.length > LINE_BUTTONS_MAX) throw new LineInputError(`buttons.actions must have 1 to ${LINE_BUTTONS_MAX} items`);
    const bText = text(bo["text"], "buttons.text", LINE_BUTTONS_TEXT_MAX);
    messages.push({
      type: "template",
      altText: bText,
      template: {
        type: "buttons",
        text: bText,
        actions: acts.map((a, i) => {
          if (!a || typeof a !== "object" || Array.isArray(a)) throw new LineInputError(`buttons.actions[${i}] must be { label, url }`);
          const ao = a as Record<string, unknown>;
          return { type: "uri" as const, label: text(ao["label"], `buttons.actions[${i}].label`, LINE_BUTTON_LABEL_MAX), uri: httpsUrl(ao["url"], `buttons.actions[${i}].url`) };
        }),
      },
    });
  }
  return messages;
}

export const LINE_PROFILE_URL = "https://api.line.me/v2/bot/profile/";

/**
 * LINE へ 1 回送る。
 * LINE の push は、ブロックされた・友だちでない相手にも 200 を返して届けない（公式の Messaging API のリファレンス「Send push message」）。
 * なので先にプロフィールを引き（友だちでない・ブロックされたら 404）、引けた相手にだけ送る。
 * 409 は同じ再送キーを LINE が受け付け済み（送れている）。
 */
export async function pushLine(fetchImpl: typeof fetch, token: string, to: string, retryKey: string, messages: LineMessage[]): Promise<"sent" | "not_friend" | "failed"> {
  try {
    const profile = await fetchImpl(`${LINE_PROFILE_URL}${encodeURIComponent(to)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (profile.status === 404) return "not_friend";
    if (!profile.ok) return "failed";
    const res = await fetchImpl(LINE_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Line-Retry-Key": retryKey },
      body: JSON.stringify({ to, messages }),
    });
    return res.ok || res.status === 409 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
