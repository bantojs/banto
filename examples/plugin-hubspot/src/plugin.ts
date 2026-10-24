/**
 * Banto 外部プラグインの実例: 会員を HubSpot の Contacts に写す（Banto → HubSpot の一方向）。
 *
 * Banto 側の契約（docs/hooks.md、docs/ai-access.md §7）:
 *   GET  → マニフェスト（名前・購読イベント・設定項目）を JSON で返す
 *   POST → X-Banto-Signature を検証し、customer.created / customer.updated / customer.deleted を処理して 2xx を返す
 *          （失敗は 5xx で再送してもらう）
 * hooks のペイロードには個人情報が無いので、会員のプロフィールは Banto の API（customers:read）で引く。
 * HubSpot 側の ID は Banto の external_ref（{provider: "hubspot", id}）に書き戻す（customers:write）。これで次からの
 * 突き合わせと、退会のときのアーカイブに使える。
 *
 * 向きは Banto → HubSpot だけ。HubSpot 側で付けた属性（ランク・同意など）を Banto に入れるのは、HubSpot のワークフローの
 * Webhook や中継サーバーから Banto の `POST /api/v1/customers/upsert` を呼ぶ（docs/knowledge/13-external-customer-master.md）。
 * 秘密（HubSpot のトークン、Banto のトークンと署名シークレット）はこのプラグイン自身の環境変数に置く。Banto の DB には入れない。
 */

export interface PluginEnv {
  /** Banto の管理画面 → 連携 → 送信先に表示される「署名シークレット」 */
  BANTO_HOOK_SECRET: string;
  /** https://<Banto の URL>/api/v1 */
  BANTO_API_URL: string;
  /** Banto の AI 用トークン（customers:read。external_ref を書き戻すなら customers:write も） */
  BANTO_API_TOKEN: string;
  /** HubSpot の非公開アプリのアクセストークン（crm.objects.contacts.read / write） */
  HUBSPOT_ACCESS_TOKEN: string;
  /** HubSpot の API の置き場所（テスト用。既定は https://api.hubapi.com） */
  HUBSPOT_API_URL?: string;
}

export interface PluginDeps {
  fetch: typeof fetch;
  /** 署名の時刻検証用（テストで固定する） */
  now?: () => number;
  /** 冪等化に使う配信 ID の記憶。Workers 単体ならメモリで十分（再送は分単位の間隔なので同じ isolate に当たりやすい） */
  seen?: Set<string>;
}

export const MANIFEST = {
  name: "HubSpot 連携",
  version: "1.0.0",
  description: "会員の登録・プロフィールの変更・退会を HubSpot の Contacts に写します（Banto → HubSpot）。HubSpot 側の ID を会員の external_ref に書き戻します。",
  events: ["customer.created", "customer.updated", "customer.deleted"],
  settings: [
    { key: "archive_on_delete", label: "退会したら HubSpot のコンタクトをアーカイブする", type: "boolean" },
    { key: "no_write_back", label: "HubSpot の ID を Banto に書き戻さない（トークンが customers:read だけのとき）", type: "boolean" },
  ],
} as const;

type Settings = { archive_on_delete?: boolean; no_write_back?: boolean };

interface Envelope {
  id: string;
  event: string;
  created_at: string;
  shop_id: string;
  attempt: number;
  data: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

interface BantoCustomer {
  id: string;
  email: string | null;
  name: string | null;
  default_address: Record<string, unknown> | null;
  external_ref: { provider: string; id: string } | null;
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

/** Banto の会員 → HubSpot のコンタクトの標準プロパティ。日本の氏名は分けずに lastname に入れる */
export function contactProperties(c: BantoCustomer): Record<string, string> {
  const a = c.default_address ?? {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out: Record<string, string> = { email: (c.email ?? "").toLowerCase() };
  const name = s(c.name) ?? s(a["name"]);
  if (name) out["lastname"] = name;
  if (s(a["phone"])) out["phone"] = s(a["phone"])!;
  const street = [s(a["line1"]), s(a["line2"])].filter(Boolean).join(" ");
  if (street) out["address"] = street;
  if (s(a["city"])) out["city"] = s(a["city"])!;
  if (s(a["state"])) out["state"] = s(a["state"])!;
  if (s(a["postal_code"])) out["zip"] = s(a["postal_code"])!;
  if (s(a["country"])) out["country"] = s(a["country"])!;
  return out;
}

export async function handleRequest(req: Request, env: PluginEnv, deps: PluginDeps): Promise<Response> {
  if (req.method === "GET") {
    return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.BANTO_HOOK_SECRET || !env.BANTO_API_URL || !env.BANTO_API_TOKEN || !env.HUBSPOT_ACCESS_TOKEN) return new Response("plugin not configured", { status: 500 });

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

  const seen = deps.seen ?? defaultSeen;
  if (seen.has(envelope.id)) return new Response("already processed");

  if (envelope.event === "banto.ping") {
    const s = envelope.settings ?? {};
    settingsByShop.set(envelope.shop_id, { archive_on_delete: s["archive_on_delete"] === true, no_write_back: s["no_write_back"] === true });
    seen.add(envelope.id);
    return new Response("ok");
  }
  const settings = settingsByShop.get(envelope.shop_id) ?? {};
  const customerId = typeof envelope.data["customer_id"] === "string" ? envelope.data["customer_id"] : null;
  if (!customerId) return new Response("ignored");

  const hubspot = (env.HUBSPOT_API_URL ?? "https://api.hubapi.com").replace(/\/$/, "");
  const hsHeaders = { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" };
  const bantoHeaders = { Authorization: `Bearer ${env.BANTO_API_TOKEN}`, "Content-Type": "application/json" };
  const banto = env.BANTO_API_URL.replace(/\/$/, "");

  if (envelope.event === "customer.deleted") {
    const ref = envelope.data["external_ref"] as { provider?: unknown; id?: unknown } | null;
    if (!settings.archive_on_delete || !ref || ref.provider !== "hubspot" || typeof ref.id !== "string") {
      seen.add(envelope.id);
      return new Response("ignored");
    }
    const res = await deps.fetch(`${hubspot}/crm/v3/objects/contacts/${encodeURIComponent(ref.id)}`, { method: "DELETE", headers: hsHeaders });
    if (!res.ok && res.status !== 404) return new Response(`hubspot returned ${res.status}`, { status: 502 });
    seen.add(envelope.id);
    return new Response("ok");
  }
  if (envelope.event !== "customer.created" && envelope.event !== "customer.updated") return new Response("ignored");

  // 会員のプロフィールは Banto の API で引く（hooks には個人情報が無い）
  const got = await deps.fetch(`${banto}/customers/${encodeURIComponent(customerId)}`, { headers: bantoHeaders });
  if (got.status === 404) {
    seen.add(envelope.id); // もう退会している
    return new Response("ignored");
  }
  if (!got.ok) return new Response(`banto returned ${got.status}`, { status: 502 });
  const customer = (await got.json()) as BantoCustomer;
  if (!customer.email) {
    seen.add(envelope.id);
    return new Response("ignored"); // メールアドレスの無い会員（LINE だけ）は HubSpot で突き合わせられない
  }

  // メールアドレスで upsert（無ければ作る）。HubSpot の batch upsert は idProperty で突き合わせる
  const up = await deps.fetch(`${hubspot}/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST",
    headers: hsHeaders,
    body: JSON.stringify({ inputs: [{ idProperty: "email", id: customer.email.toLowerCase(), properties: contactProperties(customer) }] }),
  });
  if (!up.ok) return new Response(`hubspot returned ${up.status}`, { status: 502 });
  const result = (await up.json()) as { results?: { id?: string }[] };
  const hubspotId = result.results?.[0]?.id;

  // HubSpot の ID を Banto に書き戻す（次の突き合わせと退会のアーカイブに使う）。書き戻すと customer.updated がもう 1 回届くが、
  // external_ref が一致するので 2 回目は書き戻さない（ここで止まる）
  if (hubspotId && !settings.no_write_back && (customer.external_ref?.provider !== "hubspot" || customer.external_ref.id !== hubspotId)) {
    const patched = await deps.fetch(`${banto}/customers/${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      headers: bantoHeaders,
      body: JSON.stringify({ external_ref: { provider: "hubspot", id: hubspotId } }),
    });
    // 409 external_ref_taken（同じ HubSpot の ID が別の会員に付いている）は再送しても直らないので、ログに残して進む
    if (!patched.ok && patched.status !== 409 && patched.status !== 401) return new Response(`banto returned ${patched.status}`, { status: 502 });
  }
  seen.add(envelope.id);
  if (seen.size > 5000) seen.clear(); // メモリの上限。長期の冪等化が要るなら KV 等に置く
  return new Response("ok");
}

const defaultSeen = new Set<string>();
