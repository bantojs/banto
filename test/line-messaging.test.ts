import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts } from "./helpers";
import { buyerMessage, lineBuyerNotify } from "../src/plugins/line_buyer";
import { lineToken } from "../src/plugins/line_token";
import { LINE_LOW_STOCK_LIST_MAX, LINE_PUSH_URL, batchRetryKey, lineLowStockSummary, lineNotify } from "../src/plugins/line_notify";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { bundledPluginUrl } from "../src/plugins";
import type { ConfigAdapter } from "../src/adapters/types";
import { sealSecret } from "../src/members/secret-box";
import { authorizeUrl } from "../src/modules/social-login/providers";
import type { PluginContext } from "../src/plugins/types";
import type { PrivilegedDb } from "../src/db/privileged";

const SITE = "site-secret-for-tests";

async function ctxWith(opts: { box?: string | null; recipient?: Record<string, unknown> | null; env?: string; status?: number; body?: string; event?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const ctx: PluginContext = {
    envelope: { id: "evt-1", event: opts.event ?? "order.paid", created_at: "2026-10-17T00:00:00Z", shop_id: "shop-1", attempt: 1, data: { order_id: "order-1", total_jpy: 3000, items: [{ qty: 1 }] } },
    settings: { to: "Uowner" },
    config: { get: () => undefined, secret: (n: string) => { if (n === "LINE_CHANNEL_ACCESS_TOKEN" && opts.env) return opts.env; throw new Error("missing"); } },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(opts.body ?? "{}", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    privileged: {
      shopSecret: async () => opts.box ?? null,
      orderLineRecipient: async () => opts.recipient ?? null,
      shopNoticeTexts: async () => [],
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
    // 友だちでない 400 は失敗にしないが、メッセージの形の誤り（details あり）は失敗にする（黙って止まらないように）
    await lineBuyerNotify.handle!((await ctxWith({ box, recipient, status: 400, body: JSON.stringify({ message: "Failed to send messages" }) })).ctx);
    await expect(lineBuyerNotify.handle!((await ctxWith({ box, recipient, status: 400, body: JSON.stringify({ message: "invalid", details: [{ property: "messages[0]" }] }) })).ctx)).rejects.toThrow(/LINE API 400/);
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

  it("再送キー: まとめた id 全部から UUID の形で作る（順は問わない・組が変われば別のキー）。409 は送れたとして扱う", async () => {
    const k = await batchRetryKey(["b", "a", "c"]);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await batchRetryKey(["c", "a", "b"])).toBe(k);
    expect(await batchRetryKey(["a", "b", "c", "d"])).not.toBe(k);
    // LINE には届いたが応答が落ちた → 再送で 409 → 送れたとして配信済みにする（5 回で failed にしない）
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S" });
    sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: ["inventory.low", "order.paid"], enabled: true, manifest: null, settings: { to: "Uowner" }, created_at: "" });
    for (let i = 0; i < 2; i++) sb.enqueue(shop.id, "inventory.low", { shop_id: shop.id, sku_id: `sku-${i}`, available: 0, threshold: 3 });
    sb.enqueue(shop.id, "order.paid", { order_id: "o", total_jpy: 1, items: [] });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === LINE_PUSH_URL) return new Response("{}", { status: 409 });
      return sb.fetch(input, init);
    }) as typeof fetch;
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const config = { get: () => undefined, secret: () => "env-token" } as unknown as ConfigAdapter;
    expect(await deliverPendingHooks({ db, sessionSecret: SITE, fetch: fetchImpl, config })).toEqual({ claimed: 3, delivered: 3, failed: 0 });
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

  it("管理画面: テスト送信（今の文面に見本の値、先頭に【テスト送信】）。送り先の形・トークンの無いとき・友だちでないときを知らせる。最近の送信の一覧", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const app = appWith(sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/line-messaging`;
    const to = `U${"a".repeat(32)}`;
    const sent: { auth: string | null; body: { to: string; messages: { text: string }[] } }[] = [];
    let status = 200;
    externalHosts.set("https://api.line.me/", async (req) => {
      sent.push({ auth: req.headers.get("Authorization"), body: (await req.json()) as { to: string; messages: { text: string }[] } });
      return new Response("{}", { status });
    });
    try {
      // 送り先の形が違う・トークンが無い
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to: "Uxyz" })).headers.get("location")).toContain("flash=test_invalid");
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_no_token");
      expect(sent).toHaveLength(0);
      await admin.post(base, { token: "AbCdEf0123456789+/=AbCdEf0123456789" });
      const ok = await admin.post(`${base}/test`, { kind: "order_shipped", to });
      expect(ok.headers.get("location")).toContain("flash=test_ok");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.auth).toBe("Bearer AbCdEf0123456789+/=AbCdEf0123456789");
      expect(sent[0]!.body.to).toBe(to);
      expect(sent[0]!.body.messages[0]!.text.startsWith("【テスト送信】")).toBe(true);
      expect(sent[0]!.body.messages[0]!.text).toContain("マイショップ");
      // 知らない種類は送らない
      expect((await admin.post(`${base}/test`, { kind: "tryon_ready", to })).headers.get("location")).toContain("flash=test_invalid");
      status = 400;
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_not_friend");
      status = 401;
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_bad_token");
    } finally {
      externalHosts.delete("https://api.line.me/");
    }
    // 最近の送信: プラグインが無効なら知らせ、あれば配信の一覧（メールへの配り直しの印も）
    expect(await (await admin.get(base)).text()).toContain("有効になっていません");
    sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE", url: bundledPluginUrl("line_buyer_notify"), events: ["order.paid"], enabled: true, settings: {} });
    sb.tables.hook_endpoints.push({ id: "ep-mail", shop_id: shop.id, name: "メール", url: bundledPluginUrl("email_resend"), events: ["order.paid"], enabled: true, settings: {} });
    sb.tables.hook_endpoints.push({ id: "ep-notify", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: [], enabled: true, settings: { to } });
    sb.tables.hook_deliveries.push({ id: "d-1", shop_id: shop.id, endpoint_id: "ep-line", event: "order.paid", status: "delivered", attempts: 1, last_error: null, created_at: "2026-11-25T01:00:00Z", payload: { order_id: "o-1", notice_line_only: true } });
    sb.tables.hook_deliveries.push({ id: "d-2", shop_id: shop.id, endpoint_id: "ep-mail", event: "order.paid", status: "delivered", attempts: 1, last_error: null, created_at: "2026-11-25T01:00:01Z", payload: { order_id: "o-1", fallback_of: "d-1" } });
    const page = await (await admin.get(base)).text();
    expect(page).toContain("注文の受付");
    expect(page).toContain("LINE だけのお客様");
    expect(page).toContain("メールで送りました");
    // 「LINE 通知」の送り先がテスト送信の宛先の初期値
    expect(page).toContain(`value="${to}"`);
  });

  it("お知らせの文面の画面で LINE の見た目をカードに（0179）。テスト送信もカードで、本番と同じリンク", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const app = appWith(sb, { PUBLIC_BASE_URL: "https://banto.example" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const notices = `/admin/shops/${shop.id}/notices`;
    expect(await (await admin.get(notices)).text()).toContain("LINE の注文の知らせの見た目");
    expect((await admin.post(`${notices}/line-style`, { line_style: "fancy" })).status).toBe(400);
    expect((await admin.post(`${notices}/line-style`, { line_style: "card" })).headers.get("location")).toContain("flash=saved");
    expect((sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["line_notice_style"]).toBe("card");
    const base = `/admin/shops/${shop.id}/line-messaging`;
    const to = `U${"c".repeat(32)}`;
    const sent: { messages: Record<string, unknown>[] }[] = [];
    externalHosts.set("https://api.line.me/", async (req) => {
      sent.push((await req.json()) as { messages: Record<string, unknown>[] });
      return new Response("{}", { status: 200 });
    });
    try {
      await admin.post(base, { token: "AbCdEf0123456789+/=AbCdEf0123456789" });
      expect((await admin.post(`${base}/test`, { kind: "order_shipped", to })).headers.get("location")).toContain("flash=test_ok");
      const m = sent[0]!.messages[0]!;
      expect(m["type"]).toBe("flex");
      expect(String(m["altText"]).startsWith("【テスト送信】\n【マイショップ】")).toBe(true);
      const json = JSON.stringify(m["contents"]);
      expect(json).toContain("【テスト送信】");
      expect(json).toContain("https://banto.example/my-shop/orders/lookup?banto_order=1001&banto_member=1");
      expect(json).toContain("配送状況");
      // 文字だけに戻すと、リンクは本文に
      await admin.post(`${notices}/line-style`, { line_style: "text" });
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_ok");
      expect(sent[1]!.messages[0]!["type"]).toBe("text");
      expect(String(sent[1]!.messages[0]!["text"])).toContain("ご注文の状況はこちらで確認できます: https://banto.example/my-shop/orders/lookup?banto_order=1001&banto_member=1");
      // LINE がメッセージの形を断った 400（details あり）は「友だちでない」と分けて知らせる
      externalHosts.set("https://api.line.me/", () => new Response(JSON.stringify({ message: "invalid", details: [{ message: "x", property: "messages[0]" }] }), { status: 400 }));
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_bad_message");
      externalHosts.set("https://api.line.me/", () => new Response(JSON.stringify({ message: "Failed to send messages" }), { status: 400 }));
      expect((await admin.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_not_friend");
    } finally {
      externalHosts.delete("https://api.line.me/");
    }
  });

  it("管理画面のテスト送信: settings の無い人は使えない・LINE の応答ごとの知らせ・開けないトークン・デプロイの変数のトークン", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
    const base = `/admin/shops/${shop.id}/line-messaging`;
    const to = `U${"b".repeat(32)}`;
    let status = 200;
    let calls = 0;
    externalHosts.set("https://api.line.me/", () => {
      calls++;
      return new Response("{}", { status });
    });
    try {
      // デプロイの変数のトークン（ショップのトークンは無い）: 送れて、そのことを知らせる
      const appEnv = appWith(sb, { LINE_CHANNEL_ACCESS_TOKEN: "env-token-1234567890abcdef" });
      const ownerB = await Browser.loggedIn(appEnv, "owner@example.com", "password-123");
      expect((await ownerB.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_ok_env");
      for (const [st, code] of [[403, "test_not_friend"], [429, "test_limit"], [500, "test_failed"]] as const) {
        status = st;
        expect((await ownerB.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain(`flash=${code}`);
      }
      status = 200;
      // integrations だけの人: 画面に欄が出ず、送れない（404）。integrations も無い人も 404
      const app = appWith(sb);
      const member = async (email: string, perms: string[]) => {
        const u = sb.addUser(email, "password-123");
        sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
        sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
        return Browser.loggedIn(app, email, "password-123");
      };
      const before = calls;
      const integ = await member("integ@example.com", ["integrations"]);
      const page = await (await integ.get(base)).text();
      expect(page).not.toContain(`action="${base}/test"`);
      expect((await integ.post(`${base}/test`, { kind: "order_paid", to })).status).toBe(404);
      const none = await member("none@example.com", ["catalog"]);
      expect((await none.post(`${base}/test`, { kind: "order_paid", to })).status).toBe(404);
      expect(calls).toBe(before);
      // 開けないトークン（別のショップの鍵で閉じた暗号文）
      sb.tables.shop_secret_boxes.push({ shop_id: shop.id, purpose: "line_messaging", secret_box: await sealSecret("test-session-secret", "other-shop", "line_messaging", "x".repeat(30)), updated_at: new Date().toISOString() });
      const ownerA = await Browser.loggedIn(app, "owner@example.com", "password-123");
      expect((await ownerA.post(`${base}/test`, { kind: "order_paid", to })).headers.get("location")).toContain("flash=test_token_broken");
      // 決まった知らせ以外の flash は出さない
      expect(await (await ownerA.get(`${base}?flash=test_prefix`)).text()).not.toContain('class="error">【テスト送信】');
    } finally {
      externalHosts.delete("https://api.line.me/");
    }
  });

  it("管理画面のテスト送信: 会員のメールアドレスで宛先を選ぶ（UID は画面に出さない・監査ログ）。customers の無い人は選べない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
    const uid = `U${"c".repeat(32)}`;
    sb.tables.customers.push({ id: "cust-line", shop_id: shop.id, email: "Tester@Example.com", name: "テスト" });
    sb.tables.customers.push({ id: "cust-mail", shop_id: shop.id, email: "mailonly@example.com", name: "メールだけ" });
    sb.memberIdentities.push({ shop_id: shop.id, provider: "line", subject: uid, customer_id: "cust-line" });
    const app = appWith(sb, { LINE_CHANNEL_ACCESS_TOKEN: "env-token-1234567890abcdef" });
    const base = `/admin/shops/${shop.id}/line-messaging`;
    const sent: string[] = [];
    externalHosts.set("https://api.line.me/", async (req) => {
      sent.push(((await req.json()) as { to: string }).to);
      return new Response("{}", { status: 200 });
    });
    try {
      const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
      expect(await (await admin.get(base)).text()).toContain('name="email"');
      const ok = await admin.post(`${base}/test`, { kind: "order_paid", email: "tester@example.com", to: "" });
      expect(ok.headers.get("location")).toContain("flash=test_ok");
      // UID は画面（戻り先の URL）に出さない
      expect(ok.headers.get("location")).not.toContain(uid);
      expect(ok.headers.get("location")).not.toContain("tester");
      expect(sent).toEqual([uid]);
      expect(sb.tables.audit_log.some((r) => r["action"] === "line.test_recipient" && r["target_id"] === "cust-line")).toBe(true);
      // LINE と結びついていない会員・いないアドレス
      expect((await admin.post(`${base}/test`, { kind: "order_paid", email: "mailonly@example.com" })).headers.get("location")).toContain("flash=test_member_not_found");
      expect((await admin.post(`${base}/test`, { kind: "order_paid", email: "nobody@example.com" })).headers.get("location")).toContain("flash=test_member_not_found");
      expect(sent).toHaveLength(1);
      // settings と integrations はあるが customers の無い人: 欄が出ず、メールで送ろうとしても断る
      const u = sb.addUser("staff@example.com", "password-123");
      sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
      sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms: ["integrations", "settings"] });
      const staff = await Browser.loggedIn(app, "staff@example.com", "password-123");
      expect(await (await staff.get(base)).text()).not.toContain('name="email"');
      expect((await staff.post(`${base}/test`, { kind: "order_paid", email: "tester@example.com" })).headers.get("location")).toContain("flash=test_member_needs_customers");
      expect(sent).toHaveLength(1);
    } finally {
      externalHosts.delete("https://api.line.me/");
    }
  });

  it("会員の詳細から: メールアドレスの無い LINE の会員にも会員の id でテスト送信（UID は出さない・結果は会員の詳細に）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const uid = `U${"e".repeat(32)}`;
    const memberId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    sb.tables.customers.push({ id: memberId, shop_id: shop.id, email: null, name: "LINE だけの会員" });
    sb.tables.customers.push({ id: otherId, shop_id: shop.id, email: "x@example.com", name: "メールの会員" });
    sb.memberIdentities.push({ shop_id: shop.id, provider: "line", subject: uid, customer_id: memberId });
    const app = appWith(sb, { LINE_CHANNEL_ACCESS_TOKEN: "env-token-1234567890abcdef" });
    const sent: string[] = [];
    externalHosts.set("https://api.line.me/", async (req) => {
      sent.push(((await req.json()) as { to: string }).to);
      return new Response("{}", { status: 200 });
    });
    try {
      const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
      const detail = `/admin/shops/${shop.id}/customers/${memberId}`;
      const page = await (await admin.get(detail)).text();
      expect(page).toContain('id="line-test"');
      expect(page).not.toContain(uid);
      // LINE と結びついていない会員には欄を出さない
      expect(await (await admin.get(`/admin/shops/${shop.id}/customers/${otherId}`)).text()).not.toContain('id="line-test"');
      const res = await admin.post(`/admin/shops/${shop.id}/line-messaging/test`, { kind: "order_paid", customer_id: memberId });
      expect(res.headers.get("location")).toBe(`${detail}?flash=line_test_ok_env#line-test`);
      expect(sent).toEqual([uid]);
      expect(sb.tables.audit_log.some((r) => r["action"] === "line.test_recipient" && r["target_id"] === memberId)).toBe(true);
      expect(await (await admin.get(`${detail}?flash=line_test_ok_env`)).text()).toContain("デプロイの変数");
      // customers の無い人（integrations・settings はある）: 欄が出ず、送ろうとしても断る
      const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
      const u = sb.addUser("staff2@example.com", "password-123");
      sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
      sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms: ["integrations", "settings"] });
      const staff = await Browser.loggedIn(app, "staff2@example.com", "password-123");
      expect((await staff.post(`/admin/shops/${shop.id}/line-messaging/test`, { kind: "order_paid", customer_id: memberId })).headers.get("location")).toContain("flash=line_test_member_needs_customers");
      // customers・settings はあるが integrations の無い人: 会員の詳細に欄が出ない
      const u2 = sb.addUser("staff3@example.com", "password-123");
      sb.orgMembers.push({ org_id: org, user_id: u2.id, role: "member", created_at: new Date().toISOString() });
      sb.orgMemberShops.push({ org_id: org, user_id: u2.id, shop_id: shop.id, perms: ["customers", "settings"] });
      const staff3 = await Browser.loggedIn(app, "staff3@example.com", "password-123");
      expect(await (await staff3.get(detail)).text()).not.toContain('id="line-test"');
      expect(sent).toHaveLength(1);
      // 結びついていない会員の id は送らない
      expect((await admin.post(`/admin/shops/${shop.id}/line-messaging/test`, { kind: "order_paid", customer_id: otherId })).headers.get("location")).toContain("flash=line_test_member_not_found");
      expect(sent).toHaveLength(1);
    } finally {
      externalHosts.delete("https://api.line.me/");
    }
  });
});

