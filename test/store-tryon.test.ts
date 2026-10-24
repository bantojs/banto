import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memoryAdapters } from "./helpers";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { bundledPluginUrl } from "../src/plugins";
import { addDays, checkTryon, holdUntil, hoursOn, parseRanges, parseSpecialDays, todayHere, tryonSettings, visitDates, weekdayOf, type StoreRow } from "../src/modules/store-tryon";
import { buildTryonMails } from "../src/modules/store-tryon/mail";
import { tryonLineMessage } from "../src/plugins/line_buyer";

afterEach(() => externalHosts.clear());

const store = (over: Partial<StoreRow> = {}): StoreRow => ({
  id: "st-1",
  shop_id: "shop-1",
  name: "渋谷店",
  postal_code: "150-0001",
  address: "東京都渋谷区1-1",
  phone: "03-0000-0000",
  hours: { "0": [["11:00", "19:00"]], "1": [["10:00", "20:00"]], "2": [], "3": [["10:00", "20:00"]], "4": [["10:00", "20:00"]], "5": [["10:00", "13:00"], ["14:00", "20:00"]], "6": [["11:00", "19:00"]] },
  special_days: [],
  note: null,
  tryon: true,
  active: true,
  sort_order: 0,
  ...over,
});

describe("営業時間・定休日・臨時休業（src/modules/store-tryon）", () => {
  it("営業時間の入力を読む（全角・波ダッシュ・昼休み）。読めない・重なる・3 つ以上は null", () => {
    expect(parseRanges("10:00-20:00")).toEqual([["10:00", "20:00"]]);
    expect(parseRanges("１０：００〜２０：００")).toEqual([["10:00", "20:00"]]);
    expect(parseRanges("14:00-20:00, 9:30-13:00")).toEqual([["09:30", "13:00"], ["14:00", "20:00"]]);
    expect(parseRanges("")).toEqual([]);
    expect(parseRanges("定休日")).toEqual([]);
    expect(parseRanges("20:00-10:00")).toBeNull();
    expect(parseRanges("10時から")).toBeNull();
    expect(parseRanges("9:00-10:00,11:00-12:00,13:00-14:00")).toBeNull();
  });

  it("臨時休業・臨時営業を 1 行 1 日で読み、過ぎた日付は捨て、読めない行を返す", () => {
    const r = parseSpecialDays("2026-12-31 休業 年末\n2027/1/2 11:00-17:00 初売り\n2026-10-01 休業\nあした休み\n2026-02-30 休業", "2026-10-17");
    expect(r.days).toEqual([
      { date: "2026-12-31", closed: true, hours: [], note: "年末" },
      { date: "2027-01-02", closed: false, hours: [["11:00", "17:00"]], note: "初売り" },
    ]);
    expect(r.errors).toEqual([4, 5]);
  });

  it("期間（〜 / ~ / ..）を日ごとに展開する。31 日を超える・逆順の期間は読めない行", () => {
    const r = parseSpecialDays("2026-12-30〜2027-01-02 休業 年末年始\n2026-10-16~2026-10-18 11:00-17:00 短縮\n2027-01-01..2027-03-01 休業\n2027-01-05〜2027-01-04 休業", "2026-10-17");
    expect(r.days.map((d) => [d.date, d.closed, d.note])).toEqual([
      ["2026-10-17", false, "短縮"],
      ["2026-10-18", false, "短縮"],
      ["2026-12-30", true, "年末年始"],
      ["2026-12-31", true, "年末年始"],
      ["2027-01-01", true, "年末年始"],
      ["2027-01-02", true, "年末年始"],
    ]);
    expect(r.errors).toEqual([3, 4]);
  });

  it("その日の営業（臨時が曜日より優先）・取り置きの期限は休みの日を避ける・来店日は営業日だけ", () => {
    // 2026-10-20 は火曜（定休日）
    expect(weekdayOf("2026-10-20")).toBe(2);
    const st = store({ special_days: [{ date: "2026-10-21", closed: true, hours: [], note: "棚卸し" }, { date: "2026-10-27", closed: false, hours: [["12:00", "16:00"]], note: null }] });
    expect(hoursOn(st, "2026-10-20")).toMatchObject({ open: false });
    expect(hoursOn(st, "2026-10-21")).toMatchObject({ open: false, special: { note: "棚卸し" } });
    expect(hoursOn(st, "2026-10-27")).toMatchObject({ open: true, ranges: [["12:00", "16:00"]] });
    // 10/13 から 7 日 = 10/20（火・定休）→ 10/21（臨時休業）→ 10/22
    expect(holdUntil(st, "2026-10-13", 7)).toBe("2026-10-22");
    const dates = visitDates(st, { min_days: 1, max_days: 10 }, "2026-10-17");
    expect(dates).not.toContain("2026-10-20");
    expect(dates).not.toContain("2026-10-21");
    expect(dates).toContain("2026-10-27");
    expect(dates[0]).toBe("2026-10-18");
  });

  it("申し込みの入力: 店舗・来店日（visit のとき）・名前・メール・電話を確かめる", () => {
    const st = store();
    const shopMode = tryonSettings({});
    expect(shopMode).toMatchObject({ mode: "shop", hold_days: 7, max_items: 5 });
    const ok = { store: "st-1", customer_name: "山田", customer_email: "A@Example.com", customer_phone: "090-1111-2222", visit_date: "2026-10-20" };
    expect(checkTryon(ok, [st], shopMode, "2026-10-17")).toMatchObject({ error: null, input: { customer_email: "a@example.com", visit_date: "" } });
    const visit = tryonSettings({ store_tryon: { mode: "visit", min_days: 1, max_days: 14 } });
    expect(checkTryon(ok, [st], visit, "2026-10-17").error).toBe("tryon.error_date");
    expect(checkTryon({ ...ok, visit_date: "2026-10-19" }, [st], visit, "2026-10-17").error).toBeNull();
    expect(checkTryon({ ...ok, store: "x" }, [st], shopMode, "2026-10-17").error).toBe("tryon.error_store");
    expect(checkTryon({ ...ok, customer_phone: "abc" }, [st], shopMode, "2026-10-17").error).toBe("tryon.error_phone");
    expect(checkTryon(ok, [store({ tryon: false })], shopMode, "2026-10-17").error).toBe("tryon.error_store");
  });
});

function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { store_tryon: true }, contact_email: "shop@example.com", ...settings } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const everyDay = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [["10:00", "20:00"]]]));
  const org = String(shop["org_id"]);
  sb.tables.stores.push({ id: "st-1", org_id: org, name: "渋谷店", postal_code: "150-0001", address: "東京都渋谷区1-1", phone: "03-0000-0000", email: "shibuya@example.com", notify_email: true, hours: everyDay, special_days: [], note: "試着室 3 室", active: true, sort_order: 0 });
  sb.tables.stores.push({ id: "st-2", org_id: org, name: "倉庫", email: null, notify_email: false, hours: {}, special_days: [], note: null, active: true, sort_order: 1 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-1", tryon: true, sort_order: 0 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-2", tryon: false, sort_order: 1 });
  const app = appWith(sb);
  return { sb, shop, sku, app, org };
}

describe("お店で試着（ストアフロント）", () => {
  it("カート → 店舗を選ぶ → 連絡先 → 確認 → 申し込み。在庫が減り、カートが空になり、お客様と店舗にメール", async () => {
    const { sb, shop, sku, app } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    const cart = await (await b.get("/my-shop/cart")).text();
    expect(cart).toContain("/my-shop/tryon");
    expect(cart).toContain("お店で試着を申し込む");

    // 店舗の一覧（試着を受け付けない店舗は出さない）と営業時間
    const list = await (await b.get("/my-shop/tryon")).text();
    expect(list).toContain("渋谷店");
    expect(list).not.toContain("倉庫");
    expect(list).toContain("本日の営業 10:00〜20:00");
    expect(list).toContain("試着室 3 室");
    const details = await (await b.get("/my-shop/tryon?store=st-1")).text();
    expect(details).toContain('action="/my-shop/tryon/confirm"');
    expect(details).not.toContain('name="visit_date"'); // おまかせの形では来店日を聞かない

    const form = { store: "st-1", customer_name: "山田 花子", customer_email: "Hanako@example.com", customer_phone: "090-1111-2222", note: "M と L を比べたい" };
    let res = await b.post("/my-shop/tryon/confirm", { ...form, customer_email: "bad" });
    expect(res.status).toBe(400);
    const confirm = await (await b.post("/my-shop/tryon/confirm", form)).text();
    expect(confirm).toContain("お申し込みの内容");
    expect(confirm).toContain("代金をいただきません");
    res = await b.post("/my-shop/tryon/submit", form);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/my-shop/tryon/done?n=1&store=st-1");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(3);
    expect(sb.tables.tryon_requests[0]).toMatchObject({ number: 1, status: "requested", customer_email: "hanako@example.com", store_id: "st-1" });
    expect((await (await b.get("/my-shop/cart")).text())).not.toContain("お店で試着を申し込む"); // カートは空
    const done = await (await b.get(res.headers.get("location")!)).text();
    expect(done).toContain("受付番号 1");

    // メール通知プラグイン: お客様と店舗へ（店舗のメール通知が ON）
    sb.tables.hook_endpoints.push({ id: "ep-mail", shop_id: shop.id, name: "メール", url: bundledPluginUrl("email_resend"), events: ["tryon.requested", "tryon.updated"], enabled: true, manifest: null, settings: { from: "マイショップ <order@example.com>" }, created_at: "" });
    sb.enqueue(shop.id, "tryon.requested", { request_id: sb.tables.tryon_requests[0]!["id"], number: 1, status: "requested" });
    const sent: Record<string, unknown>[] = [];
    externalHosts.set("https://api.resend.com/", async (req) => {
      sent.push((await req.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(h(new Request(input, init)));
      return sb.fetch(input, init);
    };
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    await deliverPendingHooks({ db, sessionSecret: "s", fetch: fetchImpl, config: memoryAdapters({ RESEND_API_KEY: "re_x", PUBLIC_BASE_URL: BASE }).config });
    expect(sent.map((m) => (m["to"] as string[])[0]).sort()).toEqual(["hanako@example.com", "shibuya@example.com"]);
    const toCustomer = sent.find((m) => (m["to"] as string[])[0] === "hanako@example.com")!;
    expect(String(toCustomer["text"])).toContain("東京都渋谷区1-1");
    expect(String(toCustomer["text"])).toContain("10:00〜20:00");
    const toStore = sent.find((m) => (m["to"] as string[])[0] === "shibuya@example.com")!;
    expect(String(toStore["text"])).toContain("090-1111-2222");
    expect(String(toStore["text"])).toContain("M と L を比べたい");
  });

  it("来店日を選ぶ形: 店舗の休業日は選べない。点数の上限を超えると申し込めない", async () => {
    const { sb, sku, app } = setup({ store_tryon: { mode: "visit", min_days: 1, max_days: 10, max_items: 2 } });
    const today = todayHere();
    const closed = addDays(today, 3);
    sb.tables.stores[0]!["special_days"] = [{ date: closed, closed: true, note: "臨時休業" }];
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "3" });
    expect((await b.get("/my-shop/tryon")).status).toBe(409);
    await b.post("/my-shop/cart/update", { sku_id: sku.id, qty: "2" });
    const details = await (await b.get("/my-shop/tryon?store=st-1")).text();
    expect(details).toContain('name="visit_date"');
    expect(details).not.toContain(`value="${closed}"`);
    expect(details).toContain(`value="${addDays(today, 1)}"`);
    const form = { store: "st-1", customer_name: "山田", customer_email: "a@example.com", customer_phone: "0312345678" };
    expect((await b.post("/my-shop/tryon/confirm", { ...form, visit_date: closed })).status).toBe(400);
    const ok = await b.post("/my-shop/tryon/submit", { ...form, visit_date: addDays(today, 1) });
    expect(ok.status).toBe(302);
    expect(sb.tables.tryon_requests[0]).toMatchObject({ visit_date: addDays(today, 1) });
  });

  it("店舗の一覧のページ。モジュールが OFF なら試着も店舗の一覧も無く、カートにボタンも出ない", async () => {
    const { sb, sku, app } = setup();
    const b = new Browser(app);
    const html = await (await b.get("/my-shop/stores")).text();
    expect(html).toContain("渋谷店");
    expect(html).toContain("倉庫");
    expect(html).not.toContain("shibuya@example.com");
    sb.tables.shops[0]!["settings"] = {};
    const app2 = appWith(sb);
    const b2 = new Browser(app2);
    await b2.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect((await (await b2.get("/my-shop/cart")).text())).not.toContain("お店で試着");
    expect((await b2.get("/my-shop/tryon")).status).toBe(404);
    expect((await b2.get("/my-shop/stores")).status).toBe(404);
  });
});

describe("お店で試着（管理画面）", () => {
  it("組織の実店舗を登録（営業時間・臨時休業・期間）、読めない営業時間はエラー。ショップで使う店舗を選ぶ。申し込みを取り置き → 購入なし → 在庫を戻す", async () => {
    const { sb, shop, sku, app, org } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let res = await admin.post(`/admin/stores?org=${org}`, { name: "新宿店", h1: "10時から", h2: "" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("月曜日の営業時間が読めません");
    res = await admin.post(`/admin/stores?org=${org}`, { name: "新宿店", address: "東京都新宿区1-1", email: "shinjuku@example.com", notify_email: "on", active: "on", h1: "10:00-20:00", h2: "", h3: "10:00-13:00, 14:00-20:00", special_days: "2099-12-31〜2100-01-02 休業 年末年始\n2000-01-01 休業" });
    expect(res.status).toBe(302);
    const created = sb.tables.stores.find((x) => x["name"] === "新宿店")!;
    expect(created).toMatchObject({ org_id: org, notify_email: true, hours: { "1": [["10:00", "20:00"]], "2": [], "3": [["10:00", "13:00"], ["14:00", "20:00"]] } });
    expect((created["special_days"] as { date: string }[]).map((d) => d.date)).toEqual(["2099-12-31", "2100-01-01", "2100-01-02"]);

    // ショップで使う店舗: 新宿店を足し、倉庫を外す
    const base = `/admin/shops/${shop.id}/modules/store-tryon`;
    expect(await (await admin.get(base)).text()).toContain("新宿店");
    await admin.post(`${base}/stores`, { "use.st-1": "on", "tryon.st-1": "on", "sort.st-1": "0", [`use.${created["id"]}`]: "on", [`sort.${created["id"]}`]: "5" });
    expect(sb.tables.shop_stores.map((l) => [l["store_id"], l["tryon"]])).toEqual([["st-1", true], [created["id"], false]]);

    // 臨時休業をまとめて（選んだ店舗だけ）
    const multi = new URLSearchParams([["org", org], ["store", "st-1"], ["store", String(created["id"])], ["days", "2099-05-01 休業 棚卸し"], ["mode", "set"]]).toString();
    res = await admin.postRaw("/admin/stores/special-days", multi, "application/x-www-form-urlencoded");
    expect(res.headers.get("location")).toBe("/admin/stores?flash=bulk_saved&n=2");
    expect((sb.tables.stores[0]!["special_days"] as { date: string }[]).map((d) => d.date)).toEqual(["2099-05-01"]);
    await admin.postRaw("/admin/stores/special-days", new URLSearchParams([["org", org], ["store", "st-1"], ["days", "2099-05-01"], ["mode", "remove"]]).toString(), "application/x-www-form-urlencoded");
    expect(sb.tables.stores[0]!["special_days"]).toEqual([]);

    // 申し込み（ストアフロントから）
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/tryon/submit", { store: "st-1", customer_name: "山田", customer_email: "a@example.com", customer_phone: "0312345678" });
    const req = sb.tables.tryon_requests[0]!;
    const list = await (await admin.get(base)).text();
    expect(list).toContain("#1");
    const detail = await (await admin.get(`${base}/requests/${req["id"]}`)).text();
    expect(detail).toContain('name="hold_until"');
    res = await admin.post(`${base}/requests/${req["id"]}/status`, { status: "ready", hold_until: "2099-01-10" });
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(req).toMatchObject({ status: "ready", hold_until: "2099-01-10" });
    expect(sb.tables.hook_deliveries.length).toBe(0); // 送信先が無いショップでは積まれない
    res = await admin.post(`${base}/requests/${req["id"]}/status`, { status: "sent" });
    expect(res.headers.get("location")).toContain("flash=invalid_transition");
    await admin.post(`${base}/requests/${req["id"]}/status`, { status: "not_purchased" });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(4);
    res = await admin.post(`${base}/requests/${req["id"]}/restock`, {});
    expect(res.headers.get("location")).toContain("flash=restocked");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)!["available"]).toBe(5);

    // 設定
    await admin.post(`${base}/settings`, { mode: "visit", hold_days: "3", min_days: "2", max_days: "20", max_items: "4", notice: "3〜5 日でお届けします" });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ store_tryon: { mode: "visit", hold_days: 3, min_days: 2, max_days: 20, max_items: 4, notice: "3〜5 日でお届けします" } });
  });

  it("実店舗のスタッフ: 担当の店舗の申し込みだけ見て状態を進められる（連絡先は見える・在庫は戻せない）。営業時間だけ直せる", async () => {
    const { sb, sku, app, org } = setup();
    const staff = sb.addUser("staff@example.com", "staff-pass-1");
    sb.orgMembers.push({ org_id: org, user_id: staff.id, role: "member", created_at: "" });
    sb.orgMemberStores.push({ org_id: org, user_id: staff.id, store_id: "st-1", perms: ["tryon", "hours"] });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/tryon/submit", { store: "st-1", customer_name: "山田", customer_email: "a@example.com", customer_phone: "0312345678" });
    const req = sb.tables.tryon_requests[0]!;

    const s = await Browser.loggedIn(app, "staff@example.com", "staff-pass-1");
    const dash = await (await s.get("/admin")).text();
    expect(dash).toContain("/admin/stores/st-1/requests");
    const list = await (await s.get("/admin/stores/st-1/requests")).text();
    expect(list).toContain("#1");
    expect(list).toContain("マイショップ"); // どのショップの申し込みか（0027）
    expect((await s.get("/admin/stores/st-2/requests")).status).toBe(404);
    const detail = await (await s.get(`/admin/stores/st-1/requests/${req["id"]}`)).text();
    expect(detail).toContain("a@example.com");
    expect(detail).toContain("Tシャツ");
    await s.post(`/admin/stores/st-1/requests/${req["id"]}/status`, { status: "cancelled" });
    expect(req["status"]).toBe("cancelled");
    expect(await (await s.get(`/admin/stores/st-1/requests/${req["id"]}`)).text()).not.toContain("/restock");
    // 営業時間だけのフォーム（名前・メールアドレスは無い）
    const form = await (await s.get("/admin/stores/st-1")).text();
    expect(form).toContain('name="h1"');
    expect(form).not.toContain('name="email"');
    await s.post("/admin/stores/st-1", { h1: "11:00-19:00", special_days: "" });
    expect(sb.tables.stores[0]!["hours"]).toMatchObject({ "1": [["11:00", "19:00"]], "2": [] });
    // ショップの画面・組織の画面には入れない
    expect((await s.get(`/admin/shops/${sb.tables.shops[0]!["id"]}/modules/store-tryon`)).status).toBe(404);
    expect((await s.get("/admin/org")).headers.get("location")).toBe("/admin?flash=forbidden");
  });
});

describe("お店で試着（お知らせの文）", () => {
  const contact = {
    request_id: "r1",
    number: 7,
    status: "ready",
    visit_date: null,
    hold_until: "2026-10-24",
    customer_email: "a@example.com",
    customer_name: "山田",
    customer_phone: "0312345678",
    note: null,
    store: { ...store(), email: "st@example.com", notify_email: false },
    shop: { name: "マイショップ", slug: "my-shop", contact_email: null },
    items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
  };
  it("取り置き開始はお客様にだけ。店舗のメール通知が OFF なら申し込みのメールも店舗に送らない。それ以外の状態は送らない", () => {
    const ready = buildTryonMails("tryon.updated", contact, BASE);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.text).toContain("10月24日");
    expect(ready[0]!.text).toContain("火 定休日");
    expect(buildTryonMails("tryon.requested", contact, BASE).map((m) => m.to)).toEqual(["a@example.com"]);
    expect(buildTryonMails("tryon.updated", { ...contact, status: "purchased" }, BASE)).toEqual([]);
  });
  it("LINE: 受付・取り置き開始・取り消しだけ", () => {
    const r = { number: 7, status: "ready", hold_until: "2026-10-24", store_name: "渋谷店", shop_name: "マイショップ" };
    expect(tryonLineMessage("tryon.updated", r)).toContain("10月24日まで");
    expect(tryonLineMessage("tryon.updated", { ...r, status: "sent" })).toBeNull();
    expect(tryonLineMessage("tryon.requested", r)).toContain("受付番号 7");
  });
});
