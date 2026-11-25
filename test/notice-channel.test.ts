import { describe, expect, it } from "vitest";
import { lineBuyerNotify } from "../src/plugins/line_buyer";
import { emailResend, noticeRoute } from "../src/plugins/email_resend";
import { sealSecret } from "../src/members/secret-box";
import { memoryAdapters } from "./helpers";
import type { PluginContext } from "../src/plugins/types";
import type { PrivilegedDb } from "../src/db/privileged";

/**
 * 0176: お知らせを「LINE だけ」で受け取るお客様。
 *   - メール通知: お客様あては送らず、運営者への控え（と試着の店舗あて）だけ。LINE から配り直された知らせはお客様あてだけ
 *   - LINE で購入者に知らせる: その場で届けられないと分かったら（友だちでない・ブロック・トークンが無い / 開けない / 効かない・
 *     結びつきが外れた）メール通知に配り直す。再送の末の失敗は DB のトリガー（test/db/notice-channel.test.ts）
 */
const SITE = "site-secret-for-tests";

async function lineCtx(opts: { lineOnly: boolean; status?: number; token?: "ok" | "none" | "broken"; recipient?: boolean }) {
  const fallbacks: string[] = [];
  const box = opts.token === "none" ? null : opts.token === "broken" ? await sealSecret(SITE, "other-shop", "line_messaging", "x".repeat(30)) : await sealSecret(SITE, "shop-1", "line_messaging", "shop-token-1234567890");
  const ctx: PluginContext = {
    envelope: { id: "del-1", event: "order.paid", created_at: "2026-11-25T00:00:00Z", shop_id: "shop-1", attempt: 1, data: { order_id: "order-1", ...(opts.lineOnly ? { notice_line_only: true } : {}) } },
    settings: {},
    config: { get: () => undefined, secret: () => { throw new Error("missing"); } },
    fetch: (async () => new Response("{}", { status: opts.status ?? 200 })) as unknown as typeof fetch,
    privileged: {
      shopSecret: async () => box,
      orderLineRecipient: async () => (opts.recipient === false ? null : { line_user_id: "Ubuyer", number: 1001, total_jpy: 3000, shop_name: "マイショップ", status: "paid" }),
      shopNoticeTexts: async () => [],
      noticeLineFallback: async (id: string) => {
        fallbacks.push(id);
        return 1;
      },
    } as unknown as PrivilegedDb,
    sessionSecret: SITE,
  };
  return { ctx, fallbacks };
}

describe("LINE で購入者に知らせる: LINE だけの知らせを届けられなければメールへ", () => {
  it("送れたら配り直さない。409（もう受け付け済み）も届いたとして扱う", async () => {
    for (const status of [200, 409]) {
      const r = await lineCtx({ lineOnly: true, status });
      await expect(lineBuyerNotify.handle!(r.ctx)).resolves.toBeUndefined();
      expect(r.fallbacks).toEqual([]);
    }
  });

  it("友だちでない・ブロック（400 / 403）: LINE だけならメールへ配り直し、失敗にしない。メールと LINE の人は何もしない", async () => {
    for (const status of [400, 403]) {
      const only = await lineCtx({ lineOnly: true, status });
      await lineBuyerNotify.handle!(only.ctx);
      expect(only.fallbacks).toEqual(["del-1"]);
      const both = await lineCtx({ lineOnly: false, status });
      await lineBuyerNotify.handle!(both.ctx);
      expect(both.fallbacks).toEqual([]);
    }
  });

  it("トークンが無い・開けない・効かない（401）: LINE だけならすぐメールへ。そうでなければ今までどおり失敗", async () => {
    for (const token of ["none", "broken"] as const) {
      const only = await lineCtx({ lineOnly: true, token });
      await expect(lineBuyerNotify.handle!(only.ctx)).resolves.toBeUndefined();
      expect(only.fallbacks).toEqual(["del-1"]);
      const both = await lineCtx({ lineOnly: false, token });
      await expect(lineBuyerNotify.handle!(both.ctx)).rejects.toThrow();
      expect(both.fallbacks).toEqual([]);
    }
    const only401 = await lineCtx({ lineOnly: true, status: 401 });
    await lineBuyerNotify.handle!(only401.ctx);
    expect(only401.fallbacks).toEqual(["del-1"]);
    await expect(lineBuyerNotify.handle!((await lineCtx({ lineOnly: false, status: 401 })).ctx)).rejects.toThrow(/LINE API 401/);
  });

  it("LINE の結びつきが外れて送り先が無い: LINE だけならメールへ。知らせない出来事（入金済みの order.created）では配り直さない", async () => {
    const r = await lineCtx({ lineOnly: true, recipient: false });
    await lineBuyerNotify.handle!(r.ctx);
    expect(r.fallbacks).toEqual(["del-1"]);
    const created = await lineCtx({ lineOnly: true, recipient: false });
    created.ctx.envelope = { ...created.ctx.envelope, event: "order.created", data: { order_id: "order-1", payment_status: "paid", notice_line_only: true } };
    await lineBuyerNotify.handle!(created.ctx);
    expect(created.fallbacks).toEqual([]);
  });

  it("LINE の失敗（500）は再送に回す（再送の末の失敗は DB のトリガーがメールへ配り直す）", async () => {
    const r = await lineCtx({ lineOnly: true, status: 500 });
    await expect(lineBuyerNotify.handle!(r.ctx)).rejects.toThrow(/LINE API 500/);
    expect(r.fallbacks).toEqual([]);
  });
});

const orderContact = () => ({
  order_id: "order-1",
  number: 1001,
  status: "paid",
  created_at: "2026-11-25T00:00:00Z",
  total_jpy: 3000,
  shipping_jpy: 0,
  payment_provider: "stripe",
  customer_email: "a@example.com",
  customer_name: "山田",
  shipping_address: null,
  member: true,
  shop: { name: "マイショップ", slug: "my-shop", contact_email: "shop@example.com", return_policy: null },
  items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
});

const tryonContact = () => ({
  request_id: "r1",
  number: 7,
  status: "requested",
  visit_date: null,
  hold_until: null,
  customer_email: "a@example.com",
  customer_name: "山田",
  customer_phone: null,
  note: null,
  store: { name: "渋谷店", postal_code: null, address: null, phone: null, hours: {}, special_days: [], email: "st@example.com", notify_email: true },
  shop: { name: "マイショップ", slug: "my-shop", contact_email: "shop@example.com" },
  items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
});

async function sendWith(event: string, data: Record<string, unknown>, contact: Record<string, unknown>, settings: Record<string, string | boolean> = { from: "shop@example.com", bcc_owner: true }) {
  const sent: { to: unknown; bcc?: unknown }[] = [];
  const ctx: PluginContext = {
    envelope: { id: "del-2", event, created_at: "2026-11-25T00:00:00Z", shop_id: "shop-1", attempt: 1, data },
    settings,
    config: memoryAdapters({ RESEND_API_KEY: "re_test" }).config,
    fetch: (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { to: unknown; bcc?: unknown };
      sent.push({ to: b.to, ...(b.bcc ? { bcc: b.bcc } : {}) });
      return new Response('{"id":"x"}', { status: 200 });
    }) as unknown as typeof fetch,
    privileged: { orderContact: async () => contact, tryonContact: async () => contact, shopNoticeTexts: async () => [], shopSecret: async () => null } as unknown as PrivilegedDb,
  };
  await emailResend.handle!(ctx);
  return JSON.stringify(sent);
}

describe("メール通知: LINE だけのお客様（hooks の notice_line_only）", () => {
  it("送り分けの判定", () => {
    expect(noticeRoute({})).toBe("all");
    expect(noticeRoute({ notice_line_only: false })).toBe("all");
    expect(noticeRoute({ notice_line_only: true })).toBe("owner_only");
    expect(noticeRoute({ notice_line_only: true, line_fallback: true })).toBe("customer_only");
  });

  it("注文: お客様あては送らず控えだけ。印の無い知らせ（当てる前の DB・メールと LINE の人）は今までどおり", async () => {
    const lineOnly = await sendWith("order.paid", { order_id: "order-1", notice_line_only: true }, orderContact());
    expect(lineOnly).not.toContain("a@example.com");
    expect(lineOnly).toContain("shop@example.com");
    expect(await sendWith("order.paid", { order_id: "order-1" }, orderContact())).toContain("a@example.com");
    // 控えを送らない設定なら何も送らない
    expect(await sendWith("order.paid", { order_id: "order-1", notice_line_only: true }, orderContact(), { from: "shop@example.com" })).toBe("[]");
  });

  it("注文: LINE から配り直された知らせはお客様あてだけ（控えは付けない）。注文のメールを外部に任せる店では送らない", async () => {
    const data = { order_id: "order-1", notice_line_only: true, line_fallback: true };
    const re = JSON.parse(await sendWith("order.paid", data, orderContact())) as { to: unknown; bcc?: unknown }[];
    expect(re).toHaveLength(1);
    expect(JSON.stringify(re[0]!.to)).toContain("a@example.com");
    expect(re[0]!.bcc).toBeUndefined();
    expect(await sendWith("order.paid", data, orderContact(), { from: "shop@example.com", skip_orders: true })).toBe("[]");
  });

  it("試着: お客様あては送らず、控えと店舗あては送る。配り直しはお客様あてだけ", async () => {
    const first = await sendWith("tryon.requested", { request_id: "r1", notice_line_only: true }, tryonContact());
    expect(first).not.toContain("a@example.com");
    expect(first).toContain("st@example.com");
    expect(first).toContain("shop@example.com");
    const re = await sendWith("tryon.requested", { request_id: "r1", notice_line_only: true, line_fallback: true }, tryonContact());
    expect(re).toContain("a@example.com");
    expect(re).not.toContain("st@example.com");
  });
});
