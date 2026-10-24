/**
 * hooks の署名。送信先ごとの秘密は DB に保存せず、SESSION_SECRET と送信先 ID から導出する
 * （CLAUDE.md §1-5: シークレットを DB に置かない）。管理画面でいつでも再表示できる。
 * ヘッダ形式は Stripe と同じ: X-Banto-Signature: t=<epoch秒>,v1=<hex(HMAC-SHA256(secret, `${t}.${body}`))>
 */
const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** 送信先の署名用シークレット（64 桁 hex） */
export function endpointSecret(sessionSecret: string, endpointId: string): Promise<string> {
  return hmacHex(sessionSecret, `banto-hook-endpoint:${endpointId}`);
}

export async function signHookPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** 受信側（プラグイン）用の検証。docs/hooks.md のサンプル実装と同じ */
export async function verifyHookSignature(secret: string, body: string, header: string | undefined, opts: { toleranceSeconds?: number; now?: number } = {}): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
