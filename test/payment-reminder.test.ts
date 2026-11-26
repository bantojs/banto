import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, memoryAdapters, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { registerJobs } from "../src/jobs";
import { checkNoticeText, DEFAULT_NOTICE_TEXTS } from "../src/notices/templates";
import { openResumeToken, payUntilLabel, sealResumeToken } from "../src/commerce/payment-resume";

/** お支払いのお願い（0181）: 24 時間たった未払いの KOMOJU の予約に翌日 1 回。リンクの先でお支払いに進む・取りやめる */
afterEach(() => externalHosts.clear());

function setup(opts: { reminder?: boolean; skipOrders?: boolean } = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { shipping: { mode: "flat", flat_fee_jpy: 500 }, contact_email: "shop@example.com", ...(opts.reminder ? { payment_reminder: true } : {}) },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.tables.hook_endpoints.push({ id: "ep-komoju", shop_id: shop.id, name: "KOMOJU 決済", url: bundledPluginUrl("komoju"), events: [], enabled: true, manifest: null, settings: { payment_types: "bank_transfer" }, created_at: "" });
  sb.tables.hook_endpoints.push({ id: "ep-mail", shop_id: shop.id, name: "メール", url: bundledPluginUrl("email_resend"), events: ["order.paid", "checkout.payment_pending"], enabled: true, manifest: null, settings: { from: "Shop <shop@example.com>", ...(opts.skipOrders ? { skip_orders: true } : {}) }, created_at: "" });
  const mails: { to: string; subject: string; text: string }[] = [];
  const sessions = new Map<string, { id: string; status: string; expired?: boolean }>();
  let created = 0;
  const route = (req: Request): Response | Promise<Response> => {
    const u = new URL(req.url);
    if (u.host === "api.resend.com") {
      return req.json().then((b) => {
        const m = b as { to: string[]; subject: string; text: string };
        mails.push({ to: m.to[0]!, subject: m.subject, text: m.text });
        return Response.json({ id: `em_${mails.length}` });
      });
    }
    if (req.method === "POST" && u.pathname === "/api/v1/sessions") {
      const id = `ses_${++created}`;
      sessions.set(id, { id, status: "pending" });
      return Response.json({ id, session_url: `https://komoju.com/sessions/${id}`, status: "pending" });
    }
    const m = /^\/api\/v1\/sessions\/([^/]+)$/.exec(u.pathname);
    if (m && sessions.has(m[1]!)) return Response.json({ ...sessions.get(m[1]!), session_url: `https://komoju.com/sessions/${m[1]}` });
    return new Response("{}", { status: 404 });
  };
  externalHosts.set("https://komoju.com/", route);
  externalHosts.set("https://api.resend.com/", route);
  const env = { KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju", RESEND_API_KEY: "re_test" };
  const app = appWith(sb, env, undefined, stripe);
  const cron = async () => {
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, ...env });
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => {} };
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(h(new Request(input, init)));
      return sb.fetch(input, init);
    };
    registerJobs(adapters, { fetch: fetchImpl });
    await jobs.get("payment_reminders")!();
    await jobs.get("deliver_hooks")!();
  };
  return { sb, shop, sku, app, mails, sessions, cron, b: new Browser(app) };
}

async function placeKomoju(b: Browser, skuId: string) {
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty: "1" });
  await b.post("/my-shop/checkout", { provider: "komoju" });
  const review = await b.post("/my-shop/checkout/komoju", ADDRESS);
  return b.post("/my-shop/checkout/komoju", { quote: quoteFrom(await review.text()) });
}

const age = (sb: FakeSupabase, hours: number) => {
  const r = sb.tables.reservations[0]!;
  r["created_at"] = new Date(Date.now() - hours * 3600_000).toISOString();
};

describe("お支払いのお願い（0181）", () => {
  it("設定が ON のショップだけ、24 時間たった未払いの予約に 1 回メール。リンクの先でお支払いに進める", async () => {
    const { sb, sku, mails, sessions, cron, app, b } = setup({ reminder: true });
    await placeKomoju(b, sku.id);
    age(sb, 2);
    await cron();
    expect(mails).toHaveLength(0);
    age(sb, 25);
    await cron();
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.subject).toMatch(/^【マイショップ】お支払いのお願い（.+まで）$/);
    expect(mail.text).toContain("山田 太郎 様");
    expect(mail.text).toContain("合計（税込）: ¥3,500");
    // 2 回目は送らない
    await cron();
    expect(mails).toHaveLength(1);
    const link = /(https?:\/\/\S+\/checkout\/resume\?t=\S+)/.exec(mail.text)![1]!;
    const page = await (await new Browser(app).get(link.replace(BASE, ""))).text();
    expect(page).toContain("お支払いに進む");
    expect(page).toContain('name="t"');
    // 決済ページの期限は切れている（翌日）→ 作り直して進む
    sessions.get("ses_1")!.expired = true;
    const t = new URL(link).searchParams.get("t")!;
    const pay = await new Browser(app).post("/my-shop/checkout/payment", { t, action: "pay" });
    expect(pay.headers.get("location")).toBe("https://komoju.com/sessions/ses_2");
    // 券をいじると何もしない
    expect((await new Browser(app).post("/my-shop/checkout/payment", { t: `${t}x`, action: "cancel" })).status).toBe(404);
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
    const bad = await (await new Browser(app).get(`/my-shop/checkout/resume?t=${encodeURIComponent(t)}x`)).text();
    expect(bad).not.toContain("お支払いに進む");
  });

  it("設定が OFF（既定）・メールを外部プラグインに任せる店は送らない。確定・解放した予約にも送らない", async () => {
    const off = setup();
    await placeKomoju(off.b, off.sku.id);
    age(off.sb, 25);
    await off.cron();
    expect(off.mails).toHaveLength(0);
    externalHosts.clear();
    const skip = setup({ reminder: true, skipOrders: true });
    await placeKomoju(skip.b, skip.sku.id);
    age(skip.sb, 25);
    await skip.cron();
    expect(skip.mails).toHaveLength(0);
    externalHosts.clear();
    const released = setup({ reminder: true });
    await placeKomoju(released.b, released.sku.id);
    age(released.sb, 25);
    released.sb.tables.reservations[0]!["status"] = "released";
    await released.cron();
    expect(released.mails).toHaveLength(0);
  });

  it("文面の既定は決まりに合う。券は予約と期限に結ぶ。期限の文は運営者の時間帯", async () => {
    expect(checkNoticeText("payment_reminder", "mail", DEFAULT_NOTICE_TEXTS.payment_reminder.mail.subject, DEFAULT_NOTICE_TEXTS.payment_reminder.mail.body)).toBeNull();
    expect(checkNoticeText("payment_reminder", "line", null, DEFAULT_NOTICE_TEXTS.payment_reminder.line)).toBeNull();
    expect(checkNoticeText("payment_reminder", "mail", "件名", "リンクなし {{total}}")).toEqual({ code: "body_missing_tag", tag: "payment_link" });
    const exp = new Date(Date.now() + 3600_000).toISOString();
    const tok = await sealResumeToken("secret", "shop-1", "res-1", exp);
    expect(await openResumeToken("secret", "shop-1", tok)).toEqual({ reservationId: "res-1" });
    expect(await openResumeToken("secret", "shop-2", tok)).toBeNull();
    expect(await openResumeToken("other", "shop-1", tok)).toBeNull();
    expect(await openResumeToken("secret", "shop-1", tok, Date.now() + 2 * 3600_000)).toBeNull();
    expect(payUntilLabel("2026-11-28T06:00:00Z")).toBe("11月28日（土）15:00");
  });
});
