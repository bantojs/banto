import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

describe.skipIf(!dbAvailable)("お店で試着（0025_store_tryon）", () => {
  let f: Fixture;
  let other: Fixture;
  let store: string;
  let closedStore: string;
  let orgId: string;
  let staff: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ty@example.com", slug: "ty-shop", publish: true, stock: 3 });
    other = await createShopFixture({ email: "ty-o@example.com", slug: "ty-other", publish: true });
    const hours = JSON.stringify({ "1": [["10:00", "20:00"]], "2": [] });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name, address, email, hours, notify_email) values ($1, '渋谷店', '東京都渋谷区1-1', 'shibuya@example.com', $2::jsonb, true) returning id", [orgId, hours]))).rows[0]!.id;
    closedStore = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '倉庫') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id, sort_order) values ($1, $2, 0), ($1, $3, 1)", [f.shopId, store, closedStore]));
    await asUser(f.ownerId, (c) => c.query("update shop_stores set tryon = false where store_id = $1", [closedStore]));
    // 渋谷店のスタッフ（試着の申し込みを扱う・営業時間を直す）
    staff = await createAuthUser("shibuya-staff@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, 'shibuya-staff@example.com', 'member', $2::jsonb, $3)", [orgId, JSON.stringify([{ store_id: store, perms: ["tryon", "hours", "bogus"] }]), hash("t-staff")]));
    await withRole("authenticated", { sub: staff, email: "shibuya-staff@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-staff")]));
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{tryon.requested,tryon.updated}')", [f.shopId]);
  });
  afterAll(closePool);

  const stock = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
  const request = (items: unknown[], storeId = store, customer: Record<string, unknown> = { customer_email: "Buyer@example.com", customer_name: "山田", customer_phone: "0312345678" }, visit: string | null = null) =>
    asService(async (c) => (await c.query<{ r: { id: string; number: number } }>("select tryon_request($1, $2, $3::jsonb, $4::jsonb, $5::date) as r", [f.shopId, storeId, JSON.stringify(items), JSON.stringify(customer), visit])).rows[0]!.r);

  it("実店舗: 組織の正本をショップに結ぶ。購入者は shop_store_list で公開の列だけ読む（表もメールアドレスも読めない）。他の組織のショップには結べない", async () => {
    const list = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select shop_store_list($1) as r", [f.shopId])).rows[0]!.r);
    expect(list.map((r) => [r.name, r.tryon])).toEqual([["渋谷店", true], ["倉庫", false]]);
    expect(JSON.stringify(list)).not.toContain("shibuya@example.com");
    expect(await expectDbError(() => asAnon((c) => c.query("select id from stores")))).toMatch(/permission denied/);
    expect((await asUser(other.ownerId, (c) => c.query("select id from stores where org_id = $1", [orgId]))).rows).toHaveLength(0);
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [other.shopId, store])))).toMatch(/store_not_in_org|row-level security/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [other.shopId, store])))).toMatch(/store_not_in_org|row-level security/);
    // 割り当ては決まった項目だけ
    expect((await getPool().query("select perms from org_member_stores where user_id = $1", [staff])).rows).toEqual([{ perms: ["hours", "tryon"] }]);
    expect(await asUser(staff, async (c) => (await c.query<{ r: { name: string }[] }>("select banto_my_stores() as r")).rows[0]!.r.map((x) => x.name))).toEqual(["渋谷店"]);
  });

  it("営業時間: hours の項目を持つスタッフは自分の店舗だけ直せる。臨時休業をまとめて登録（同じ日は置き換え・remove で消す）", async () => {
    await asUser(staff, (c) => c.query("select store_set_hours($1, $2::jsonb, '[]'::jsonb)", [store, JSON.stringify({ "1": [["10:00", "19:00"]] })]));
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select store_set_hours($1, '{}'::jsonb, '[]'::jsonb)", [closedStore])))).toMatch(/store_not_found/);
    // スタッフは店舗の行そのもの（名前・メールアドレス）は変えられない
    expect((await asUser(staff, (c) => c.query("update stores set name = 'x' where id = $1 returning id", [store]))).rows).toHaveLength(0);
    const days = [{ date: "2099-12-31", closed: true, hours: [], note: "年末" }, { date: "2100-01-01", closed: true, hours: [], note: "元日" }];
    // owner は全店舗、スタッフは自分の店舗だけ書き換わる
    expect((await asUser(f.ownerId, (c) => c.query<{ n: number }>("select stores_set_special_days($1, $2::uuid[], $3::jsonb) as n", [orgId, [store, closedStore], JSON.stringify(days)]))).rows[0]!.n).toBe(2);
    expect((await asUser(staff, (c) => c.query<{ n: number }>("select stores_set_special_days($1, $2::uuid[], $3::jsonb) as n", [orgId, [store, closedStore], JSON.stringify([{ date: "2099-12-31", closed: false, hours: [["11:00", "16:00"]], note: "短縮" }, { date: "2100-01-01", remove: true }])]))).rows[0]!.n).toBe(1);
    const sp = (await getPool().query<{ id: string; special_days: { date: string; note: string }[] }>("select id, special_days from stores where org_id = $1", [orgId])).rows;
    expect(sp.find((x) => x.id === store)!.special_days.map((d) => [d.date, d.note])).toEqual([["2099-12-31", "短縮"]]);
    expect(sp.find((x) => x.id === closedStore)!.special_days.map((d) => d.date)).toEqual(["2099-12-31", "2100-01-01"]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select stores_set_special_days($1, $2::uuid[], '[{\"date\":\"x\"}]'::jsonb)", [orgId, [store]])))).toMatch(/invalid_days/);
    await getPool().query("update stores set hours = $2::jsonb, special_days = '[]' where id = $1", [store, JSON.stringify({ "1": [["10:00", "20:00"]], "2": [] })]);
  });

  it("申し込み: 在庫を減らし、番号を振り、tryon.requested を送る（個人情報はペイロードに載せない）。足りなければ全体を取り消す", async () => {
    const before = await stock();
    const r = await request([{ sku_id: f.skuId, qty: 2 }]);
    expect(r.number).toBe(1);
    expect(await stock()).toBe(before - 2);
    const row = (await getPool().query("select status, customer_email, store_id from tryon_requests where id = $1", [r.id])).rows[0];
    expect(row).toEqual({ status: "requested", customer_email: "buyer@example.com", store_id: store });
    const hook = (await getPool().query<{ event: string; payload: Record<string, unknown> }>("select event, payload from hook_deliveries where shop_id = $1", [f.shopId])).rows;
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ event: "tryon.requested", payload: { number: 1, status: "requested", store_id: store } });
    expect(JSON.stringify(hook[0]!.payload)).not.toContain("buyer@example.com");

    expect(await expectDbError(() => request([{ sku_id: f.skuId, qty: 5 }]))).toMatch(/insufficient_stock/);
    expect(await stock()).toBe(before - 2);
    expect(await expectDbError(() => request([{ sku_id: f.skuId, qty: 1 }], closedStore))).toMatch(/store_not_available/);
    expect(await expectDbError(() => request([{ sku_id: f.skuId, qty: 1 }], store, { customer_email: "x" }))).toMatch(/invalid_customer/);
    expect(await expectDbError(() => request([{ sku_id: other.skuId, qty: 1 }]))).toMatch(/sku_not_available/);
    // 運営者・購入者は直接呼べない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select tryon_request($1, $2, '[]', '{}')", [f.shopId, store])))).toMatch(/permission denied/);
  });

  it("状態: 発送 → 取り置き（期限つき）→ 購入なし → 在庫を戻す（1 回だけ）。順番の違う遷移は拒否", async () => {
    const r = (await getPool().query<{ id: string }>("select id from tryon_requests where shop_id = $1 and number = 1", [f.shopId])).rows[0]!;
    const update = (status: string, hold: string | null = null, owner = f.ownerId) =>
      asUser(owner, async (c) => (await c.query<{ r: Record<string, unknown> }>("select tryon_update($1, $2, $3, $4::date) as r", [f.shopId, r.id, status, hold])).rows[0]!.r);
    expect(await expectDbError(() => update("purchased"))).toMatch(/invalid_transition/);
    await update("sent");
    expect(await expectDbError(() => update("ready"))).toMatch(/hold_until_required/);
    expect(await update("ready", "2026-10-24")).toMatchObject({ status: "ready", hold_until: "2026-10-24" });
    expect(await expectDbError(() => update("sent", null, other.ownerId))).toMatch(/not_found/);
    // 在庫を戻せるのは終わった申し込みだけ
    const restock = () => asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select tryon_restock($1, $2) as n", [f.shopId, r.id])).rows[0]!.n);
    expect(await expectDbError(restock)).toMatch(/not_restockable/);
    // 実店舗のスタッフ: 申し込みと連絡先は見え、状態を進められるが、在庫は戻せない。注文や在庫は触れない。明細の品名は関数で
    const detail = await asUser(staff, async (c) => (await c.query<{ r: { request: { customer_email: string }; can_restock: boolean; items: { product: string }[] } }>("select tryon_request_detail($1) as r", [r.id])).rows[0]!.r);
    expect(detail).toMatchObject({ request: { customer_email: "buyer@example.com" }, can_restock: false, items: [{ product: "Tシャツ" }] });
    expect((await asUser(staff, (c) => c.query("select id from orders where shop_id = $1", [f.shopId]))).rows).toHaveLength(0);
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select set_stock($1, 99)", [f.skuId])))).toMatch(/not_found/);
    expect((await asUser(staff, (c) => c.query("select id from tryon_requests where id = $1", [r.id]))).rows).toHaveLength(1);
    expect(await asUser(other.ownerId, async (c) => (await c.query("select tryon_request_detail($1) as r", [r.id])).rows[0].r)).toBeNull();
    // 申し込みの一覧に出すショップ名（0027）: その店舗の項目を持つ人にだけ、名前と id だけ
    expect(await asUser(staff, async (c) => (await c.query<{ r: unknown }>("select tryon_store_shops($1) as r", [store])).rows[0]!.r)).toEqual([{ id: f.shopId, name: "Shop ty-shop" }]);
    expect(await asUser(staff, async (c) => (await c.query<{ r: unknown }>("select tryon_store_shops($1) as r", [closedStore])).rows[0]!.r)).toEqual([]);
    expect(await asUser(other.ownerId, async (c) => (await c.query<{ r: unknown }>("select tryon_store_shops($1) as r", [store])).rows[0]!.r)).toEqual([]);
    await update("not_purchased", null, staff);
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select tryon_restock($1, $2)", [f.shopId, r.id])))).toMatch(/shop_not_found/);
    const before = await stock();
    expect(await restock()).toBe(1);
    expect(await stock()).toBe(before + 2);
    expect(await restock()).toBe(0);
    expect(await stock()).toBe(before + 2);
    const events = (await getPool().query<{ payload: { status: string } }>("select payload from hook_deliveries where shop_id = $1 and event = 'tryon.updated' order by created_at", [f.shopId])).rows.map((x) => x.payload.status);
    expect(events).toEqual(["sent", "ready", "not_purchased"]);
  });

  it("期限切れ（Cron）とお知らせ用の連絡先・マスキング", async () => {
    const r = await request([{ sku_id: f.skuId, qty: 1 }]);
    await asUser(f.ownerId, (c) => c.query("select tryon_update($1, $2, 'ready', '2026-10-20')", [f.shopId, r.id]));
    expect(await asService(async (c) => (await c.query<{ n: number }>("select tryon_expire('2026-10-20') as n")).rows[0]!.n)).toBe(0);
    expect(await asService(async (c) => (await c.query<{ n: number }>("select tryon_expire('2026-10-21') as n")).rows[0]!.n)).toBe(1);
    const ct = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select tryon_contact($1, $2) as r", [r.id, f.shopId])).rows[0]!.r);
    expect(ct).toMatchObject({ number: 2, status: "expired", customer_email: "buyer@example.com", store: { name: "渋谷店", email: "shibuya@example.com", notify_email: true }, items: [{ qty: 1 }] });
    expect(await expectDbError(() => asAnon((c) => c.query("select tryon_contact($1, $2)", [r.id, f.shopId])))).toMatch(/permission denied/);
    await getPool().query("update tryon_requests set closed_at = now() - interval '200 days' where id = $1", [r.id]);
    expect(await asService(async (c) => (await c.query<{ n: number }>("select mask_tryon_requests(180) as n")).rows[0]!.n)).toBe(1);
    expect((await getPool().query("select customer_email, customer_name from tryon_requests where id = $1", [r.id])).rows[0]).toEqual({ customer_email: null, customer_name: "[masked]" });
  });

  it("同梱のメール通知・LINE 通知の送信先に試着のイベントを足す（0025 の適用時）", async () => {
    const pool = getPool();
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{order.paid,order.shipped}')", [other.shopId]);
    const sql = (await import("node:fs")).readFileSync(new URL("../../supabase/migrations/0025_store_tryon.sql", import.meta.url), "utf8");
    const update = /update hook_endpoints[\s\S]*?;\n/.exec(sql)![0];
    await pool.query(update);
    const events = (await pool.query<{ events: string[] }>("select events from hook_endpoints where shop_id = $1", [other.shopId])).rows[0]!.events;
    expect(events.sort()).toEqual(["order.paid", "order.shipped", "tryon.requested", "tryon.updated"]);
  });
});
