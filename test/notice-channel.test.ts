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
 *   - LINE で購入者に知らせる: 送れなかったら（友だちでない・ブロック・トークンが無い・最後の再送の失敗）メール通知に配り直す
 */
const SITE = "site-secret-for-tests";

async function lineCtx(opts: { lineOnly: boolean; status?: number; attempt?: number; token?: boolean; throws?: boolean }) {
  const fallbacks: string[] = [];
  const box = opts.token === false ? null : await sealSecret(SITE, "shop-1", "line_messaging", "shop-token-1234567890");
  const ctx: PluginContext = {
    envelope: { id: "del-1", event: "order.paid", created_at: "2026-11-25T00:00:00Z", shop_id: "shop-1", attempt: opts.attempt ?? 1, data: { order_id: "order-1" } },
    settings: {},
    config: { get: () => undefined, secret: () => { throw new Error("missing"); } },
    fetch: (async () => {
      if (opts.throws) throw new Error("network");
      return new Response("{}", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    privileged: {
      shopSecret: async () => box,
      orderLineRecipient: async () => ({ line_user_id: "Ubuyer", number: 1001, total_jpy: 3000, shop_name: "マイショップ", status: "paid", line_only: opts.lineOnly }),
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

describe("LINE で購入者に知らせる: LINE だけのお客様に届かなければメールへ", () => {
  it("送れたら配り直さない", async () => {
    const r = await lineCtx({ lineOnly: true });
    await lineBuyerNotify.handle!(r.ctx);
    expect(r.fallbacks).toEqual([]);
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

  it("トークンが無い: LINE だけならメールへ配り直して終える。そうでなければ今までどおり失敗", async () => {
    const only = await lineCtx({ lineOnly: true, token: false });
    await expect(lineBuyerNotify.handle!(only.ctx)).resolves.toBeUndefined();
    expect(only.fallbacks).toEqual(["del-1"]);
    const both = await lineCtx({ lineOnly: false, token: false });
    await expect(lineBuyerNotify.handle!(both.ctx)).rejects.toThrow(/未設定/);
    expect(both.fallbacks).toEqual([]);
  });

  it("LINE の失敗（500・通信の失敗）: 再送のあいだは待ち、最後の回だけメールへ配り直す（失敗は失敗のまま）", async () => {
    const early = await lineCtx({ lineOnly: true, status: 500, attempt: 4 });
    await expect(lineBuyerNotify.handle!(early.ctx)).rejects.toThrow(/LINE API 500/);
    expect(early.fallbacks).toEqual([]);
    const last = await lineCtx({ lineOnly: true, status: 500, attempt: 5 });
    await expect(lineBuyerNotify.handle!(last.ctx)).rejects.toThrow(/LINE API 500/);
    expect(last.fallbacks).toEqual(["del-1"]);
    const net = await lineCtx({ lineOnly: true, throws: true, attempt: 5 });
    await expect(lineBuyerNotify.handle!(net.ctx)).rejects.toThrow(/network/);
    expect(net.fallbacks).toEqual(["del-1"]);
  });
});

const orderContact = (lineOnly: boolean | undefined) => ({
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
  ...(lineOnly === undefined ? {} : { notice_line_only: lineOnly }),
  shop: { name: "マイショップ", slug: "my-shop", contact_email: "shop@example.com", return_policy: null },
  items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
});

const tryonContact = (lineOnly: boolean) => ({
  request_id: "r1",
  number: 7,
  status: "requested",
  visit_date: null,
  hold_until: null,
  customer_email: "a@example.com",
  customer_name: "山田",
  customer_phone: null,
  note: null,
  notice_line_only: lineOnly,
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

describe("メール通知: LINE だけのお客様", () => {
  it("送り分けの判定", () => {
    expect(noticeRoute(undefined, {})).toBe("all");
    expect(noticeRoute(false, {})).toBe("all");
    expect(noticeRoute(true, {})).toBe("owner_only");
    expect(noticeRoute(true, { line_fallback: true })).toBe("customer_only");
    expect(noticeRoute(false, { line_fallback: true })).toBe("customer_only");
  });

  it("注文: お客様あては送らず控えだけ。当てる前の DB（鍵なし）は今までどおり", async () => {
    const lineOnly = await sendWith("order.paid", { order_id: "order-1" }, orderContact(true));
    expect(lineOnly).not.toContain("a@example.com");
    expect(lineOnly).toContain("shop@example.com");
    const old = await sendWith("order.paid", { order_id: "order-1" }, orderContact(undefined));
    expect(old).toContain("a@example.com");
    // 控えを送らない設定なら何も送らない
    expect(await sendWith("order.paid", { order_id: "order-1" }, orderContact(true), { from: "shop@example.com" })).toBe("[]");
  });

  it("注文: LINE から配り直された知らせはお客様あてだけ（控えは付けない）", async () => {
    const re = JSON.parse(await sendWith("order.paid", { order_id: "order-1", line_fallback: true }, orderContact(true))) as { to: unknown; bcc?: unknown }[];
    expect(re).toHaveLength(1);
    expect(JSON.stringify(re[0]!.to)).toContain("a@example.com");
    expect(re[0]!.bcc).toBeUndefined();
  });

  it("試着: お客様あては送らず、控えと店舗あては送る。配り直しはお客様あてだけ", async () => {
    const first = await sendWith("tryon.requested", { request_id: "r1" }, tryonContact(true));
    expect(first).not.toContain("a@example.com");
    expect(first).toContain("st@example.com");
    expect(first).toContain("shop@example.com");
    const re = await sendWith("tryon.requested", { request_id: "r1", line_fallback: true }, tryonContact(true));
    expect(re).toContain("a@example.com");
    expect(re).not.toContain("st@example.com");
  });
});
