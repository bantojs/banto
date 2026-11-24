import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith, memoryAdapters } from "./helpers";
import { emailResend, skipOrders, skipTryon } from "../src/plugins/email_resend";
import { withTrackingInfo } from "../src/orders/tracking";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import type { PluginContext } from "../src/plugins/types";
import type { PrivilegedDb } from "../src/db/privileged";

/** 「メール通知」の注文のメール・試着の知らせを止める設定と、AI 用 API の注文のお問い合わせ番号（0172） */

const handle = (c: PluginContext): Promise<void> => emailResend.handle!(c);

function ctx(event: string, data: Record<string, unknown>, settings: Record<string, string | boolean>): PluginContext {
  // 止めたときは送り手も DB も使わない。使ったら分かるように、DB は呼ばれたら失敗させる
  const privileged = new Proxy({}, { get: () => () => Promise.reject(new Error("privileged called")) }) as unknown as PrivilegedDb;
  return {
    envelope: { id: "evt-1", event, created_at: "2026-11-24T00:00:00Z", shop_id: "shop-1", attempt: 1, data },
    settings,
    config: memoryAdapters({ RESEND_API_KEY: "re_test" }).config,
    fetch: (() => Promise.reject(new Error("fetch called"))) as typeof fetch,
    privileged,
  };
}

const tryonContact = {
  request_id: "r1",
  number: 7,
  status: "requested",
  visit_date: null,
  hold_until: null,
  customer_email: "a@example.com",
  customer_name: "山田",
  customer_phone: "0312345678",
  note: null,
  store: { name: "渋谷店", postal_code: null, address: null, phone: null, hours: {}, special_days: [], email: "st@example.com", notify_email: true },
  shop: { name: "マイショップ", slug: "my-shop", contact_email: "shop@example.com" },
  items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
};

describe("メール通知: 注文のメール・試着の知らせを止める", () => {
  it("設定の読み取り: 印を付けたときだけ止める（既定は送る）", () => {
    expect(skipOrders({})).toBe(false);
    expect(skipOrders({ skip_orders: true })).toBe(true);
    expect(skipTryon({ skip_orders: true })).toBe(false);
    expect(skipTryon({ skip_tryon: true })).toBe(true);
    const keys = emailResend.manifest.settings.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["from", "bcc_owner", "skip_orders", "skip_tryon"]));
  });

  it("skip_orders: 受付（代金引換の受付を含む）・入金・発送は送り手にも DB にも触らずに終える。試着は止めない", async () => {
    // 送信元が空なので、止めなければ「送信元が未設定」で失敗する
    const settings = { from: "", skip_orders: true, bcc_owner: true };
    await expect(handle(ctx("order.paid", { order_id: "o1" }, settings))).resolves.toBeUndefined();
    await expect(handle(ctx("order.shipped", { order_id: "o1" }, settings))).resolves.toBeUndefined();
    await expect(handle(ctx("order.created", { order_id: "o1", payment_status: "unpaid" }, settings))).resolves.toBeUndefined();
    await expect(handle(ctx("tryon.requested", { request_id: "r1" }, settings))).rejects.toThrow(/送信元が未設定/);
  });

  it("skip_tryon: 注文のメールは止めない", async () => {
    await expect(handle(ctx("order.paid", { order_id: "o1" }, { from: "", skip_tryon: true }))).rejects.toThrow(/送信元が未設定/);
  });

  it("skip_tryon: お客様あて（と控え）だけ止め、店舗あては送る", async () => {
    const run = async (settings: Record<string, string | boolean>) => {
      const sent: Record<string, unknown>[] = [];
      const c = ctx("tryon.requested", { request_id: "r1" }, settings);
      c.fetch = (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response('{"id":"x"}', { status: 200 });
      }) as unknown as typeof fetch;
      c.privileged = { tryonContact: async () => tryonContact, shopNoticeTexts: async () => [], shopSecret: async () => null } as unknown as PrivilegedDb;
      await handle(c);
      return sent;
    };
    const both = await run({ from: "shop@example.com", bcc_owner: true });
    expect(both).toHaveLength(2);
    expect(JSON.stringify(both)).toContain("a@example.com");
    expect(JSON.stringify(both)).toContain("st@example.com");
    const storeOnly = await run({ from: "shop@example.com", bcc_owner: true, skip_tryon: true });
    expect(storeOnly).toHaveLength(1);
    expect(JSON.stringify(storeOnly[0]!["to"])).toContain("st@example.com");
    expect(storeOnly[0]!["bcc"]).toBeUndefined();
    // 店舗あての本文にはお客様の連絡先が載る（今までどおり）。宛先にお客様は入らない
    expect(storeOnly[0]!["to"]).toEqual(["st@example.com"]);
  });

  it("bcc_owner と skip_orders を両方付けると、注文の控えも送らない（送り手にも DB にも触らない）", async () => {
    await expect(handle(ctx("order.paid", { order_id: "o1" }, { from: "shop@example.com", bcc_owner: true, skip_orders: true }))).resolves.toBeUndefined();
    await expect(handle(ctx("order.created", { order_id: "o1", payment_status: "unpaid" }, { from: "shop@example.com", bcc_owner: true, skip_orders: true }))).resolves.toBeUndefined();
  });

  it("何も付けなければ今までどおり送ろうとする", async () => {
    await expect(handle(ctx("order.paid", { order_id: "o1" }, { from: "" }))).rejects.toThrow(/送信元が未設定/);
  });
});

describe("AI 用 API の注文のお問い合わせ番号（0172）", () => {
  it("withTrackingInfo: 運送会社の名前と照会ページの URL を足す。無ければそのまま", () => {
    const r = withTrackingInfo({ id: "o1", tracking: { carrier: "yamato", number: "123456789012" } });
    expect(r["tracking"]).toEqual({ carrier: "yamato", carrier_label: expect.any(String), number: "123456789012", url: expect.stringContaining("123456789012") });
    expect(withTrackingInfo({ id: "o2", tracking: { carrier: "other", number: "ABCD1234" } })["tracking"]).toMatchObject({ carrier: "other", url: null });
    expect(withTrackingInfo({ id: "o3", tracking: null })).toEqual({ id: "o3", tracking: null });
    expect(withTrackingInfo({ id: "o4" })).toEqual({ id: "o4" });
  });

  it("REST: orders:read で tracking が入る（orders:pii は要らない）。一覧にも", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.tables.orders.push({ id: "00000000-0000-4000-8000-000000000001", shop_id: shop.id, number: 1001, status: "shipped", total_jpy: 1000, shipping_jpy: 0, customer_email: "a@example.com", customer_name: "A", shipping_address: { state: "東京都" }, payment_provider: "stripe", payment_ref: "pi", shipped_at: "2026-11-24T00:00:00Z", created_at: "2026-11-23T00:00:00Z", updated_at: "2026-11-24T00:00:00Z", tracking_carrier: "sagawa", tracking_number: "400012345678" });
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["orders:read"], endpoint_id: null, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const app = appWith(sb);
    const res = await app.request(`${BASE}/api/v1/orders/00000000-0000-4000-8000-000000000001`, { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["tracking"]).toEqual({ carrier: "sagawa", carrier_label: expect.any(String), number: "400012345678", url: expect.stringContaining("400012345678") });
    expect(body["customer"]).toMatchObject({ masked: true });
    const list = await app.request(`${BASE}/api/v1/orders`, { headers: { authorization: `Bearer ${raw}` } });
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items;
    expect(items[0]!["tracking"]).toMatchObject({ carrier: "sagawa", number: "400012345678" });
  });
});
