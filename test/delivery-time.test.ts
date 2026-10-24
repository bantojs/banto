import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, quoteFrom } from "./helpers";
import { checkDelivery, deliveryDates, deliveryOptions, deliverySettings, deliveryText, todayIn } from "../src/modules/delivery-time";

// 2026-10-16 23:30（日本時間）= 14:30 UTC。日本ではもう 16 日なので、最短 2 日後は 18 日
const NOW = Date.parse("2026-10-16T14:30:00Z");
const on = (o: Record<string, unknown> = {}) => ({ modules: { delivery_time: true }, delivery_time: o });

describe("配送日時の指定（src/modules/delivery-time）", () => {
  it("お届け日は時間帯（Asia/Tokyo）の今日から数える", () => {
    expect(todayIn("Asia/Tokyo", Date.parse("2026-10-16T15:30:00Z"))).toBe("2026-10-17");
    const dates = deliveryDates(deliverySettings(on({ min_days: 2, max_days: 4 }))!, NOW, "Asia/Tokyo");
    expect(dates.map((d) => d.value)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(dates[0]!.label).toBe("10月18日（日）");
  });

  it("範囲外の日・選べない時間帯は invalid。モジュールが OFF なら指定なし", () => {
    const s = on({ min_days: 2, max_days: 4, slots: ["am", "19-21"] });
    expect(checkDelivery(s, "2026-10-18", "am", NOW, "Asia/Tokyo")).toEqual({ ok: true, request: { date: "2026-10-18", slot: "am" } });
    expect(checkDelivery(s, "", "", NOW, "Asia/Tokyo")).toEqual({ ok: true, request: null });
    expect(checkDelivery(s, "2026-10-17", "14-16", NOW, "Asia/Tokyo")).toEqual({ ok: false, invalid: ["delivery_date", "delivery_slot"] });
    expect(checkDelivery({}, "2026-10-17", "am", NOW, "Asia/Tokyo")).toEqual({ ok: true, request: null });
    expect(deliveryText({ date: "2026-10-18", slot: "am" })).toBe("10月18日（日） 午前中");
    expect(deliveryText({ date: null, slot: "19-21" })).toBe("日付指定なし 19〜21時");
  });
});

describe("ヘッドレス: カートの応答の delivery（連携側が追加の呼び出しなしに選択肢を出せる）", () => {
  function setup(settings: Record<string, unknown>) {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_x", settings });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
    const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 3000, available: 5 });
    const app = appWith(sb, {}, undefined, new FakeStripe());
    const cart = (body: unknown) => app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json", origin: "https://wp.example.com" }, body: JSON.stringify(body) });
    return { sku, cart, settings };
  }

  it("モジュールが ON なら dates（value と表示）と slots、OFF なら null。同梱テーマの配送先の画面と同じ計算", async () => {
    const on3 = setup(on({ min_days: 2, max_days: 4, slots: ["am", "19-21"] }));
    const v = (await (await on3.cart({ op: "add", sku_id: on3.sku.id, qty: 1 })).json()) as { delivery: { dates: { value: string; label: string }[]; slots: { value: string; label: string }[] } | null; cart: string };
    expect(v.delivery).not.toBeNull();
    expect(v.delivery!.dates).toHaveLength(3);
    for (const d of v.delivery!.dates) expect(d).toMatchObject({ value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), label: expect.stringMatching(/^\d{1,2}月\d{1,2}日（.）$/) });
    expect(v.delivery!.slots).toEqual([{ value: "am", label: "午前中" }, { value: "19-21", label: "19〜21時" }]);
    expect(v.delivery).toEqual(deliveryOptions(on3.settings));
    // GET でも同じ
    const got = (await (await appWithCart(on3, v.cart)).json()) as { delivery: unknown };
    expect(got.delivery).toEqual(v.delivery);
    // OFF なら null（キーは出す）
    const off = setup({});
    expect(((await (await off.cart({ op: "add", sku_id: off.sku.id, qty: 1 })).json()) as { delivery: unknown }).delivery).toBeNull();
  });
  const appWithCart = (s: ReturnType<typeof setup>, token: string) => s.cart({ op: "set", cart: token, sku_id: s.sku.id, qty: 1 });
});

describe("チェックアウトと注文（0018）", () => {
  function setup(settings: Record<string, unknown>) {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_x", settings });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
    const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 3000, available: 5 });
    const stripe = new FakeStripe();
    return { sb, shop, sku, stripe, app: appWith(sb, {}, undefined, stripe) };
  }

  it("配送先の画面で選び、確認画面に出て、注文の画面に残る", async () => {
    const { sb, shop, sku, stripe, app } = setup(on({ min_days: 1, max_days: 30, slots: ["am", "18-20"] }));
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const form = await (await b.post("/my-shop/checkout", { provider: "stripe" })).text();
    expect(form).toContain('name="delivery_date"');
    expect(form).toContain('<option value="am">午前中</option>');
    expect(form).not.toContain("14〜16時");
    const date = /<option value="(\d{4}-\d{2}-\d{2})"/.exec(form)![1]!;
    // 選べない時間帯は配送先の画面に戻す
    const bad = await b.post("/my-shop/checkout/stripe", { ...ADDRESS, delivery_date: date, delivery_slot: "14-16" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("お届け希望日・時間帯を選び直してください");
    const confirm = await (await b.post("/my-shop/checkout/stripe", { ...ADDRESS, delivery_date: date, delivery_slot: "am" })).text();
    expect(confirm).toContain("お届け希望日時");
    expect(confirm).toContain("午前中");
    expect(confirm).toContain(`name="delivery_date" value="${date}"`);
    const done = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(confirm) });
    expect(done.status).toBe(303);
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    const order = sb.tables.orders[0]!;
    expect(order["delivery"]).toEqual({ date, slot: "am" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}`)).text()).toContain("午前中");
  });

  it("モジュールが OFF なら欄も無く、送られても使わない", async () => {
    const { sku, app } = setup({});
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await (await b.post("/my-shop/checkout", { provider: "stripe" })).text()).not.toContain("delivery_date");
    const confirm = await (await b.post("/my-shop/checkout/stripe", { ...ADDRESS, delivery_date: "2099-01-01", delivery_slot: "am" })).text();
    expect(confirm).not.toContain("お届け希望日時");
  });

  it("管理画面で範囲と時間帯を保存する", async () => {
    const { sb, shop, app } = setup(on());
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${shop.id}/modules/delivery-time`)).status).toBe(200);
    await admin.post(`/admin/shops/${shop.id}/modules/delivery-time`, { min_days: "5", max_days: "2", slot_am: "on" });
    expect((sb.tables.shops[0]!["settings"] as Record<string, unknown>)["delivery_time"]).toEqual({ min_days: 5, max_days: 5, slots: ["am"] });
  });
});
