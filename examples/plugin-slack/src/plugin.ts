/**
 * Banto 外部プラグインの実例: 注文・在庫のイベントを Slack に通知する。
 *
 * ランタイムに依存しない 1 関数（handleRequest）にしてあり、index.ts が Cloudflare Workers に載せる。
 * Node / Deno / Bun でも `Request` → `Response` を渡せる環境ならそのまま動く。
 *
 * Banto 側の契約（docs/hooks.md）:
 *   GET  → マニフェスト（名前・購読イベント・設定項目）を JSON で返す
 *   POST → X-Banto-Signature を検証し、イベントを処理して 2xx を返す（失敗は 5xx で再送してもらう）
 * 秘密（Slack の Webhook URL、署名シークレット）はこのプラグイン自身の環境変数に置く。Banto の DB には入れない。
 */

export interface PluginEnv {
  /** Banto の管理画面 → 連携 → 送信先に表示される「署名シークレット」 */
  BANTO_HOOK_SECRET: string;
  /** Slack の Incoming Webhook URL（https://hooks.slack.com/services/...） */
  SLACK_WEBHOOK_URL: string;
}

export interface PluginDeps {
  fetch: typeof fetch;
  /** 署名の時刻検証用（テストで固定する） */
  now?: () => number;
  /** 冪等化に使う配信 ID の記憶。Workers 単体ならメモリで十分（再送は分単位の間隔なので同じ isolate に当たりやすい） */
  seen?: Set<string>;
}

export const MANIFEST = {
  name: "Slack 通知",
  version: "1.0.0",
  description: "注文・発送・キャンセル・在庫僅少を Slack のチャンネルに投稿します（Incoming Webhook）。",
  events: ["order.paid", "order.shipped", "order.cancelled", "inventory.low"],
  settings: [
    { key: "mention", label: "先頭に付けるメンション（例: <!channel> や <@U123>）", type: "text" },
    { key: "include_items", label: "注文の明細（SKU と数量）も投稿する", type: "boolean" },
    { key: "lang", label: "言語", type: "select", options: [{ value: "ja", label: "日本語" }, { value: "en", label: "English" }] },
  ],
} as const;

type Settings = { mention?: string; include_items?: boolean; lang?: "ja" | "en" };

interface Envelope {
  id: string;
  event: string;
  created_at: string;
  shop_id: string;
  attempt: number;
  data: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** docs/hooks.md §3 のとおり。Banto 本体の src/hooks/signing.ts と同じ計算 */
export async function verifySignature(secret: string, body: string, header: string | null, now: number, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

/** 設定は banto.ping（テスト送信）のときだけ届くので、最後に受け取ったものをショップごとに覚えておく */
const settingsByShop = new Map<string, Settings>();

const yen = (n: unknown) => `¥${Number(n ?? 0).toLocaleString("ja-JP")}`;

export function formatMessage(env: Envelope, s: Settings): string | null {
  const d = env.data;
  const en = s.lang === "en";
  const head = s.mention ? `${s.mention} ` : "";
  const items = s.include_items && Array.isArray(d["items"]) ? "\n" + (d["items"] as { sku_id?: string; qty?: number }[]).map((i) => `• ${i.sku_id ?? "?"} × ${i.qty ?? "?"}`).join("\n") : "";
  switch (env.event) {
    case "order.paid":
      return head + (en ? `:tada: New order #${d["order_number"]} — ${yen(d["total_jpy"])} (${d["payment_provider"]})` : `:tada: 新しい注文 #${d["order_number"]} ${yen(d["total_jpy"])}（${d["payment_provider"]}）`) + items;
    case "order.shipped":
      return head + (en ? `:package: Order #${d["order_number"]} shipped` : `:package: 注文 #${d["order_number"]} を発送済みにしました`);
    case "order.cancelled":
      return head + (en ? `:x: Order #${d["order_number"]} ${d["refunded"] ? "refunded" : "cancelled"} (${yen(d["total_jpy"])})` : `:x: 注文 #${d["order_number"]} を${d["refunded"] ? "返金" : "キャンセル"}しました（${yen(d["total_jpy"])}）`);
    case "inventory.low":
      return head + (en ? `:warning: Low stock: SKU ${d["sku_id"]} has ${d["available"]} left (threshold ${d["threshold"]})` : `:warning: 在庫僅少: SKU ${d["sku_id"]} 残り ${d["available"]}（しきい値 ${d["threshold"]}）`);
    case "banto.ping":
      return (en ? ":white_check_mark: Banto is connected to this channel." : ":white_check_mark: Banto からの接続テストです。このチャンネルに通知が届きます。");
    default:
      return null; // 購読していないイベントは無視（200 を返す）
  }
}

export async function handleRequest(req: Request, env: PluginEnv, deps: PluginDeps): Promise<Response> {
  if (req.method === "GET") {
    return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.BANTO_HOOK_SECRET || !env.SLACK_WEBHOOK_URL) return new Response("plugin not configured", { status: 500 });

  const body = await req.text();
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  if (!(await verifySignature(env.BANTO_HOOK_SECRET, body, req.headers.get("X-Banto-Signature"), now))) {
    return new Response("bad signature", { status: 400 });
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(body) as Envelope;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!envelope || typeof envelope.id !== "string" || typeof envelope.event !== "string") return new Response("bad envelope", { status: 400 });

  // 再送は同じ id で届く。すでに Slack に投稿済みなら 200 だけ返す（二重投稿しない）
  const seen = deps.seen ?? defaultSeen;
  if (seen.has(envelope.id)) return new Response("already processed");

  if (envelope.event === "banto.ping" && envelope.settings) {
    const s = envelope.settings;
    settingsByShop.set(envelope.shop_id, {
      mention: typeof s["mention"] === "string" ? s["mention"] : undefined,
      include_items: s["include_items"] === true,
      lang: s["lang"] === "en" ? "en" : "ja",
    });
  }
  const text = formatMessage(envelope, settingsByShop.get(envelope.shop_id) ?? {});
  if (text === null) return new Response("ignored");

  const slack = await deps.fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!slack.ok) {
    // 5xx を返せば Banto が 2, 4, 8, 16 分後に再送してくれる
    return new Response(`slack returned ${slack.status}`, { status: 502 });
  }
  seen.add(envelope.id);
  if (seen.size > 5000) seen.clear(); // メモリの上限。長期の冪等化が要るなら KV 等に置く
  return new Response("ok");
}

const defaultSeen = new Set<string>();
