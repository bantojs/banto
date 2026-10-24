import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { buyerMessage, lineBuyerNotify } from "../src/plugins/line_buyer";
import { lineToken } from "../src/plugins/line_token";
import { lineNotify } from "../src/plugins/line_notify";
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
