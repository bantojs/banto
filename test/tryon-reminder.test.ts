import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memoryAdapters } from "./helpers";
import { registerJobs } from "../src/jobs";
import { TRYON_REMINDER_MIGRATION, addDays, hourHere, todayHere, tryonSettings } from "../src/modules/store-tryon";
import { buildTryonMails } from "../src/modules/store-tryon/mail";
import { tryonLineMessage } from "../src/plugins/line_buyer";

/** お店で試着の来店期限の前日のお知らせ（0152）。DB の判定（時刻・1 回だけ・24 時間）は test/db/tryon-reminder.test.ts */

function setup(tryon: Record<string, unknown>) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { store_tryon: true }, store_tryon: tryon } });
  sb.tables.stores.push({ id: "st-1", org_id: String(shop["org_id"]), name: "渋谷店", address: null, phone: null, email: null, notify_email: false, hours: {}, special_days: [], note: null, active: true, sort_order: 0 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-1", tryon: true, sort_order: 0 });
  sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: shop.id, name: "x", url: "https://example.com/h", events: ["tryon.updated"], enabled: true });
  sb.tables.tryon_requests.push({ id: "tr-1", shop_id: shop.id, store_id: "st-1", number: 1, status: "ready", hold_until: addDays(todayHere(), 1), customer_id: null });
  return { sb, shop };
}

async function runTryonJob(sb: FakeSupabase) {
  const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
  const jobs = new Map<string, () => Promise<void>>();
  adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => {} };
  registerJobs(adapters, { fetch: sb.fetch });
  await jobs.get("tryon")!();
}

const reminders = (sb: FakeSupabase) => sb.tables.hook_deliveries.filter((d) => d["event"] === "tryon.updated" && (d["payload"] as Record<string, unknown>)["reminder"] === true);

describe("Cron（tryon）", () => {
  it("時刻の設定を過ぎていれば、期限が明日の取り置きに 1 回だけ積む。0152 を当てる前は呼ばない", async () => {
    const on = setup({ reminder_hour: hourHere() });
    await runTryonJob(on.sb);
    await runTryonJob(on.sb);
    expect(reminders(on.sb)).toHaveLength(1);
    // 設定の時刻から 3 時間のあいだの外（12 時間ずらした時刻）なら積まない
    const away = setup({ reminder_hour: (hourHere() + 12) % 24 });
    await runTryonJob(away.sb);
    expect(reminders(away.sb)).toHaveLength(0);
    const old = setup({ reminder_hour: hourHere() });
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((m) => m !== TRYON_REMINDER_MIGRATION);
    await runTryonJob(old.sb);
    expect(reminders(old.sb)).toHaveLength(0);
  });
});

describe("設定と管理画面", () => {
  it("reminder_hour は 0〜23、それ以外・無しは送らない（null）", () => {
    expect(tryonSettings({ store_tryon: { reminder_hour: 18 } }).reminder_hour).toBe(18);
    expect(tryonSettings({ store_tryon: { reminder_hour: 24 } }).reminder_hour).toBeNull();
    expect(tryonSettings({}).reminder_hour).toBeNull();
  });

  it("設定の画面で時刻を選んで保存、空にすると送らない。0152 を当てる前は欄を出さない", async () => {
    const s = setup({});
    const app = appWith(s.sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${s.shop.id}/modules/store-tryon`;
    expect(await (await admin.get(base)).text()).toContain('name="reminder_hour"');
    const form = { mode: "shop", hold_days: "7", min_days: "3", max_days: "14", max_items: "5", max_open_per_customer: "3", notice: "" };
    await admin.post(`${base}/settings`, { ...form, reminder_hour: "18" });
    const st = () => (s.shop["settings"] as Record<string, Record<string, unknown>>)["store_tryon"]!;
    expect(st()["reminder_hour"]).toBe(18);
    await admin.post(`${base}/settings`, { ...form, reminder_hour: "" });
    expect(st()["reminder_hour"]).toBeNull();
    const old = setup({});
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((m) => m !== TRYON_REMINDER_MIGRATION);
    const admin2 = await Browser.loggedIn(appWith(old.sb), "owner@example.com", "password-123");
    expect(await (await admin2.get(`/admin/shops/${old.shop.id}/modules/store-tryon`)).text()).not.toContain('name="reminder_hour"');
  });
});

describe("お知らせの文", () => {
  it("メールはお客様にだけ「◯月◯日までです」。「ご試着いただけます」は重ねない。LINE も前日の文", () => {
    const contact = {
      request_id: "r1",
      number: 7,
      status: "ready",
      visit_date: null,
      hold_until: "2026-10-27",
      customer_email: "a@example.com",
      customer_name: "山田",
      customer_phone: "0312345678",
      note: null,
      store: { name: "渋谷店", postal_code: null, address: null, phone: null, hours: {}, special_days: [], email: "st@example.com", notify_email: true },
      shop: { name: "マイショップ", slug: "my-shop", contact_email: null },
      items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
    };
    const mails = buildTryonMails("tryon.updated", contact, BASE, { reminder: true });
    expect(mails.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(mails[0]!.subject).toContain("10月27日");
    expect(mails[0]!.subject).not.toContain("ご試着いただけます");
    const r = { number: 7, status: "ready", hold_until: "2026-10-27", store_name: "渋谷店", shop_name: "マイショップ" };
    expect(tryonLineMessage("tryon.updated", r, { reminder: true })).toContain("10月27日までです");
    // 届く前に取り消し・期限切れになっていたら、前日・延長の知らせは送らない（取り消しの知らせを重ねない）
    expect(buildTryonMails("tryon.updated", { ...contact, status: "cancelled" }, BASE, { reminder: true })).toEqual([]);
    expect(buildTryonMails("tryon.updated", { ...contact, status: "expired" }, BASE, { extended: true })).toEqual([]);
    expect(tryonLineMessage("tryon.updated", { ...r, status: "cancelled" }, { reminder: true })).toBeNull();
  });
});
