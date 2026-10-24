import { createApp } from "../src/app";
import type { Adapters, StorageAdapter } from "../src/adapters/types";
import type { FakeSupabase } from "./fake-supabase";
import type { FakeStripe } from "./fake-stripe";

export const BASE = "http://localhost:8787";

/** 内容を保持するインメモリ StorageAdapter（/media/* の配信テストにも使う） */
export class MemoryStorage implements StorageAdapter {
  readonly objects = new Map<string, { body: ArrayBuffer; contentType: string }>();
  constructor(private baseUrl: string) {}
  async put(key: string, body: ReadableStream | ArrayBuffer | Blob, contentType: string) {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    this.objects.set(key, { body: buf, contentType });
    return { url: `${this.baseUrl}/${key}` };
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.body]).stream(), contentType: o.contentType };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function memoryAdapters(vars: Record<string, string | undefined>, storage?: StorageAdapter): Adapters {
  const mem = new Map<string, unknown>();
  return {
    storage: storage ?? new MemoryStorage(vars["MEDIA_BASE_URL"] ?? `${BASE}/media`),
    config: {
      get: (name) => vars[name],
      secret: (name) => {
        const v = vars[name];
        if (!v) throw new Error(`Missing secret: ${name}`);
        return v;
      },
    },
    cache: {
      get: async <T>(key: string) => (mem.get(key) as T) ?? null,
      set: async (key, value) => void mem.set(key, value),
      delete: async (key) => void mem.delete(key),
    },
    scheduler: { register: () => undefined, runAll: async () => undefined },
  };
}

export const WEBHOOK_SECRET = "whsec_test";

/** テスト内で任意のホストに応答させる（プラグインの偽サーバーなど）。URL 前方一致 */
export const externalHosts = new Map<string, (req: Request) => Promise<Response> | Response>();

export function appWith(supabase: FakeSupabase, overrides: Record<string, string | undefined> = {}, storage?: StorageAdapter, stripe?: FakeStripe) {
  const vars: Record<string, string | undefined> = {
    SUPABASE_URL: supabase.url,
    SUPABASE_ANON_KEY: supabase.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: supabase.serviceRoleKey,
    SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: BASE,
    MEDIA_BASE_URL: `${BASE}/media`,
    ...(stripe ? { STRIPE_SECRET_KEY: stripe.secretKey, STRIPE_CLIENT_ID: stripe.clientId, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } : {}),
    ...overrides,
  };
  const adapters = memoryAdapters(vars, storage);
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (stripe && (url.startsWith("https://api.stripe.com") || url.startsWith("https://connect.stripe.com"))) return stripe.fetch(input, init);
    if (url.startsWith("https://api.github.com")) return Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.0.1" }), { status: 200 }));
    for (const [prefix, handler] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(handler(new Request(input, init)));
    return supabase.fetch(input, init);
  };
  return createApp(() => adapters, { fetch: fetchImpl });
}

/** テスト用の配送先（都道府県は実在のもの） */
export const ADDRESS = { customer_name: "山田 太郎", customer_email: "buyer@example.com", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" };

/** 「購入手続きへ」→ 配送先入力 → 最終確認 → 決済ページへ転送、までを行い、最後の応答を返す */
export async function checkout(b: Browser, shopPath: string, provider: "stripe" | "komoju" = "stripe", address: Record<string, string> = ADDRESS): Promise<Response> {
  const step1 = await b.post(`${shopPath}/checkout`, { provider });
  if (step1.status !== 200) return step1;
  return confirmAddress(b, shopPath, provider, address);
}

/** 配送先を送って最終確認画面を出し、そのまま「注文を確定する」を押す */
export async function confirmAddress(b: Browser, shopPath: string, provider: "stripe" | "komoju", address: Record<string, string>): Promise<Response> {
  const review = await b.post(`${shopPath}/checkout/${provider}`, address);
  if (review.status !== 200) return review;
  return b.post(`${shopPath}/checkout/${provider}`, { quote: quoteFrom(await review.text()) });
}

/** 最終確認画面の HTML から quote を取り出す */
export function quoteFrom(html: string): string {
  const m = /name="quote" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("quote not found in confirmation page");
  return m[1]!;
}

/** ブラウザ風の簡易クライアント: Cookie を保持し、同一オリジンの Origin ヘッダを付ける */
export class Browser {
  cookies = new Map<string, string>();
  /**
   * 最後に開いたページの Referrer-Policy。本物のブラウザは no-referrer のページのフォームの POST に `Origin: null` を付ける
   * （Fetch の仕様。csrfGuard はそれを拒む）。それを真似る（2026-10-23、Chromium で見つけた不具合の再発防止）
   */
  private referrerPolicy: string | null = null;
  /** base: 開く URL の起点（独自ドメインのショップのテストでは https://shop.example.jp） */
  constructor(
    private app: ReturnType<typeof appWith>,
    private base: string = BASE,
  ) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair!.split("=");
      if (attrs.some((a) => a.trim() === "Max-Age=0")) this.cookies.delete(k!);
      else this.cookies.set(k!, v ?? "");
    }
  }

  async get(path: string): Promise<Response> {
    const res = await this.app.request(`${this.base}${path}`, { headers: { cookie: this.cookieHeader() } });
    this.storeCookies(res);
    if ((res.headers.get("content-type") ?? "").includes("text/html")) this.referrerPolicy = res.headers.get("referrer-policy");
    return res;
  }

  async post(path: string, fields: Record<string, string>, opts: { origin?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const body = new URLSearchParams(fields).toString();
    return this.send(path, body, "application/x-www-form-urlencoded", opts);
  }

  async postJson(path: string, body: unknown, opts: { origin?: string } = {}): Promise<Response> {
    return this.send(path, JSON.stringify(body), "application/json", opts);
  }

  async postRaw(path: string, body: string, contentType: string, opts: { origin?: string } = {}): Promise<Response> {
    return this.send(path, body, contentType, opts);
  }

  async postMultipart(path: string, fields: Record<string, string | File>, opts: { origin?: string } = {}): Promise<Response> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return this.send(path, fd, undefined, opts);
  }

  private async send(path: string, body: BodyInit, contentType: string | undefined, opts: { origin?: string; headers?: Record<string, string> }): Promise<Response> {
    const origin = opts.origin ?? (this.referrerPolicy === "no-referrer" ? "null" : this.base);
    const headers: Record<string, string> = { ...(opts.headers ?? {}), cookie: this.cookieHeader(), origin };
    if (contentType) headers["content-type"] = contentType;
    const res = await this.app.request(`${this.base}${path}`, { method: "POST", headers, body });
    this.storeCookies(res);
    return res;
  }

  /** ログイン済みブラウザを作る */
  static async loggedIn(app: ReturnType<typeof appWith>, email: string, password: string): Promise<Browser> {
    const b = new Browser(app);
    const res = await b.post("/admin/login", { email, password });
    if (res.headers.get("location") !== "/admin") throw new Error(`login failed: ${res.headers.get("location")}`);
    return b;
  }
}

export interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * 会員のログインのメール（Resend）の偽物。ショップにメール通知プラグイン（送信元）を付ける。
 * appWith には RESEND_API_KEY を渡すこと。使い終わったら dispose()（externalHosts は共有）
 */
export function memberMail(sb: FakeSupabase, shopId: string) {
  const sent: SentMail[] = [];
  const state = { status: 200 };
  sb.tables.hook_endpoints.push({ id: `ep-mail-${shopId}`, shop_id: shopId, name: "mail", url: "https://banto.invalid/plugins/email_resend", events: [], enabled: true, settings: { from: "Shop <shop@example.com>" } });
  externalHosts.set("https://api.resend.com/", async (req) => {
    if (state.status !== 200) return new Response("rejected", { status: state.status });
    const b = (await req.json()) as { from: string; to: string[]; subject: string; text: string; html?: string };
    sent.push({ from: b.from, to: b.to[0]!, subject: b.subject, text: b.text, ...(b.html ? { html: b.html } : {}) });
    return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200 });
  });
  const last = (to: string) => {
    const m = [...sent].reverse().find((x) => x.to === to);
    if (!m) throw new Error(`no mail to ${to}`);
    return m;
  };
  return {
    sent,
    state,
    code: (to: string) => /([0-9]{6})/.exec(last(to).subject)![1]!,
    link: (to: string) => /(https?:\/\/\S+)/.exec(last(to).text)![1]!,
    dispose: () => externalHosts.delete("https://api.resend.com/"),
  };
}

/** 会員としてログインした Browser（メールのコードで） */
export async function memberLogin(b: Browser, mail: ReturnType<typeof memberMail>, shopPath: string, email: string): Promise<void> {
  await b.post(`${shopPath}/account/login`, { email });
  const res = await b.post(`${shopPath}/account/code`, { code: mail.code(email.toLowerCase()) });
  if (res.headers.get("location") !== `${shopPath}/account`) throw new Error(`member login failed: ${res.headers.get("location")}`);
}

/** 中身の検査（sniffImage）を通る最小の PNG の見出し（署名 + IHDR の幅と高さ）。画像としては描けない */
export function tinyPng(width = 2, height = 3): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
