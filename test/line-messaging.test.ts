import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { buyerMessage, lineBuyerNotify } from "../src/plugins/line_buyer";
import { lineToken } from "../src/plugins/line_token";
import { LINE_LOW_STOCK_LIST_MAX, LINE_PUSH_URL, lineLowStockSummary, lineNotify } from "../src/plugins/line_notify";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { bundledPluginUrl } from "../src/plugins";
import type { ConfigAdapter } from "../src/adapters/types";
import { sealSecret } from "../src/members/secret-box";
import { authorizeUrl } from "../src/modules/social-login/providers";
import type { PluginContext } from "../src/plugins/types";
import type { PrivilegedDb } from "../src/db/privileged";

const SITE = "site-secret-for-tests";

async function ctxWith(opts: { box?: string | null; recipient?: Record<string, unknown> | null; env?: string; status?: number; event?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const ctx: PluginContext = {
    envelope: { id: "evt-1", event: opts.event ?? "order.paid", created_at: "2026-10-17T00:00:00Z", shop_id: "shop-1", attempt: 1, data: { order_id: "order-1", total_jpy: 3000, items: [{ qty: 1 }] } },
    settings: { to: "Uowner" },
    config: { get: () => undefined, secret: (n: string) => { if (n === "LINE_CHANNEL_ACCESS_TOKEN" && opts.env) return opts.env; throw new Error("missing"); } },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    privileged: {
      shopSecret: async () => opts.box ?? null,
      orderLineRecipient: async () => opts.recipient ?? null,
    } as unknown as PrivilegedDb,
    sessionSecret: SITE,
  };
  return { ctx, calls };
}

describe("LINE の Messaging API（0021）", () => {
  it("トークン: ショップの設定（暗号文）を優先し、無ければ Secret。開けなければ別のチャネルに落とさない", async () => {
    const box = await sealSecret(SITE, "shop-1", "line_messaging", "shop-token-1234567890");
    expect(await lineToken((await ctxWith({ box, env: "env-token" })).ctx)).toBe("shop-token-1234567890");
    expect(await lineToken((await ctxWith({ env: "env-token" })).ctx)).toBe("env-token");
    expect(await lineToken((await ctxWith({})).ctx)).toBeNull();
    const other = await sealSecret(SITE, "shop-2", "line_messaging", "x".repeat(30));
    await expect(lineToken((await ctxWith({ box: other, env: "env-token" })).ctx)).rejects.toThrow(/開けません/);
  });

  it("購入者への通知: LINE と結びついた会員だけ、ショップのトークンで送る。友だちでない（403）は失敗にしない", async () => {
    const box = await sealSecret(SITE, "shop-1", "line_messaging", "shop-token-1234567890");
    const recipient = { line_user_id: "Ubuyer", number: 1001, total_jpy: 3000, shop_name: "マイショップ", status: "paid" };
    const ok = await ctxWith({ box, recipient });
    await lineBuyerNotify.handle!(ok.ctx);
    expect(ok.calls).toHaveLength(1);
    const body = JSON.parse(String(ok.calls[0]!.init.body)) as { to: string; messages: { text: string }[] };
    expect(body.to).toBe("Ubuyer");
    expect(body.messages[0]!.text).toContain("注文番号 1001");
    expect((ok.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer shop-token-1234567890");
    const none = await ctxWith({ box, recipient: null });
    await lineBuyerNotify.handle!(none.ctx);
    expect(none.calls).toHaveLength(0);
    await lineBuyerNotify.handle!((await ctxWith({ box, recipient, status: 403 })).ctx);
    await expect(lineBuyerNotify.handle!((await ctxWith({ box, recipient, status: 500 })).ctx)).rejects.toThrow(/LINE API 500/);
    expect(buyerMessage("order.shipped", recipient)).toContain("発送しました");
    expect(buyerMessage("order.cancelled", recipient)).toBeNull();
  });

  it("運営者への通知（既存のプラグイン）もショップのトークンを使う", async () => {
    const box = await sealSecret(SITE, "shop-1", "line_messaging", "shop-token-1234567890");
    const r = await ctxWith({ box });
    await lineNotify.handle!(r.ctx);
    expect((r.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer shop-token-1234567890");
  });

  it("LINE ログインで友だち追加を促す（bot_prompt）", () => {
    const u = new URL(authorizeUrl("line", "cid", { redirectUri: "https://s/cb", state: "s", nonce: "n", challenge: "c", botPrompt: "aggressive" }));
    expect(u.searchParams.get("bot_prompt")).toBe("aggressive");
    expect(new URL(authorizeUrl("google", "cid", { redirectUri: "https://s/cb", state: "s", nonce: "n", challenge: "c", botPrompt: "aggressive" })).searchParams.get("bot_prompt")).toBeNull();
  });

  it("管理画面: トークンを暗号化して保存し、画面に出さない。形の違うものは断る", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const app = appWith(sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/line-messaging`;
    expect(await (await admin.get(base)).text()).toContain("未設定");
    expect((await admin.post(base, { token: "short" })).headers.get("location")).toBe(`${base}?flash=invalid`);
    const token = "AbCdEf0123456789+/=AbCdEf0123456789";
    expect((await admin.post(base, { token })).headers.get("location")).toBe(`${base}?flash=saved`);
    const row = sb.tables.shop_secret_boxes[0]!;
    expect(String(row["secret_box"])).toMatch(/^v1\./);
    expect(String(row["secret_box"])).not.toContain(token);
    const page = await (await admin.get(base)).text();
    expect(page).toContain("設定済み");
    expect(page).not.toContain(token);
    await admin.post(`${base}/delete`, {});
    expect(sb.tables.shop_secret_boxes).toHaveLength(0);
  });
});

describe("LINE 通知: 在庫僅少をまとめて 1 通に（0141 で人が在庫を減らしたときも届くため）", () => {
  it("同じ回に取り出した inventory.low は送信先ごとに 1 通。ほかの出来事は今までどおり 1 件ずつ", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S" });
    sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: ["order.paid", "inventory.low"], enabled: true, manifest: null, settings: { to: "Uowner" }, created_at: "" });
    for (let i = 0; i < 30; i++) sb.enqueue(shop.id, "inventory.low", { shop_id: shop.id, sku_id: `sku-${String(i).padStart(4, "0")}-xxxx`, available: 1, threshold: 3 });
    sb.enqueue(shop.id, "order.paid", { order_id: "order-1", total_jpy: 3000, items: [{ qty: 1 }] });
    const pushes: { text: string; retry: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === LINE_PUSH_URL) {
        const body = JSON.parse(String(init!.body)) as { messages: { text: string }[] };
        pushes.push({ text: body.messages[0]!.text, retry: (init!.headers as Record<string, string>)["X-Line-Retry-Key"]! });
        return new Response("{}", { status: 200 });
      }
      return sb.fetch(input, init);
    }) as typeof fetch;
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const config = { get: () => undefined, secret: (n: string) => (n === "LINE_CHANNEL_ACCESS_TOKEN" ? "env-token" : undefined) } as unknown as ConfigAdapter;
    const r = await deliverPendingHooks({ db, sessionSecret: SITE, fetch: fetchImpl, config });
    expect(r).toEqual({ claimed: 31, delivered: 31, failed: 0 });
    expect(pushes).toHaveLength(2);
    const low = pushes.find((p) => p.text.includes("残りわずか"))!;
    expect(low.text.split("\n")[0]).toBe("【Banto】在庫が残りわずかな SKU が 30 件あります（閾値 3）");
    expect(low.text.split("\n").filter((l) => l.startsWith("・SKU"))).toHaveLength(LINE_LOW_STOCK_LIST_MAX);
    expect(low.text.endsWith("ほか 10 件")).toBe(true);
    expect(sb.tables.hook_deliveries.every((d) => d["status"] === "delivered")).toBe(true);
  });

  it("まとめた送信に失敗したら、まとめた配信はどれも再送に回る。1 件だけなら今までの文面", async () => {
    const one = lineLowStockSummary([{ envelope: { id: "e1", event: "inventory.low", created_at: "", shop_id: "s", attempt: 1, data: { sku_id: "abcdefgh-1", available: 2, threshold: 3 } } } as unknown as PluginContext]);
    expect(one).toBe("【Banto】在庫が残りわずかです\nSKU: abcdefgh…\n残り 2 点（閾値 3）");
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S" });
    sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: ["inventory.low"], enabled: true, manifest: null, settings: { to: "Uowner" }, created_at: "" });
    for (let i = 0; i < 3; i++) sb.enqueue(shop.id, "inventory.low", { shop_id: shop.id, sku_id: `sku-${i}`, available: 0, threshold: 3 });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === LINE_PUSH_URL) return new Response("quota", { status: 429 });
      return sb.fetch(input, init);
    }) as typeof fetch;
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const config = { get: () => undefined, secret: () => "env-token" } as unknown as ConfigAdapter;
    expect(await deliverPendingHooks({ db, sessionSecret: SITE, fetch: fetchImpl, config })).toEqual({ claimed: 3, delivered: 0, failed: 3 });
    expect(sb.tables.hook_deliveries.map((d) => [d["status"], d["attempts"], String(d["last_error"]).slice(0, 12)])).toEqual(Array(3).fill(["pending", 1, "LINE API 429"]));
  });
});
