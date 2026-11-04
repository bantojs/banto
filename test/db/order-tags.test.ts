import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0106_order_tags: 注文の印（タグ）と社内のメモ。書くのは order_annotate / api_order_annotate だけ、メモは orders:pii とマスキング */
describe.skipIf(!dbAvailable)("注文の印とメモ（0106_order_tags）", () => {
  let a: Fixture;
  let b: Fixture;
  let orgId: string;
  let orderId: string;
  let bOrderId: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const annotate = (uid: string, shopId: string, id: string, tags: string[] | null, note: string | null, noteSet: boolean) =>
    asUser(uid, async (c) => (await c.query<{ r: Record<string, unknown> }>("select order_annotate($1, $2, $3, $4, $5) as r", [shopId, id, tags, note, noteSet])).rows[0]!.r);
  function issue(uid: string, shopId: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    return asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash, raw.slice(0, 12), scopes])).then(() => hash);
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ot-a@example.com", slug: "ot-a", publish: true });
    b = await createShopFixture({ email: "ot-b@example.com", slug: "ot-b", publish: true });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    orderId = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, customer_email, customer_name) values ($1, 1000, 5001, 'x@example.com', '山田') returning id", [a.shopId])).rows[0]!.id;
    bOrderId = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number) values ($1, 1000, 5001) returning id", [b.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("管理画面: 項目 orders の人が印を置き換え、メモを書く。印は整える（空白・空・重なり）。形が違えば断る", async () => {
    const r = await annotate(a.ownerId, a.shopId, orderId, [" 要確認 ", "", "ギフト", "要確認"], "電話済み", true);
    expect(r).toMatchObject({ tags: ["要確認", "ギフト"], note: "電話済み" });
    // tags を null なら変えない、メモは note_set のときだけ
    expect(await annotate(a.ownerId, a.shopId, orderId, null, null, false)).toMatchObject({ tags: ["要確認", "ギフト"], note: "電話済み" });
    expect(await expectDbError(() => annotate(a.ownerId, a.shopId, orderId, ["x".repeat(41)], null, false))).toMatch(/invalid_tags/);
    expect(await expectDbError(() => annotate(a.ownerId, a.shopId, orderId, ["a,b"], null, false))).toMatch(/invalid_tags/);
    expect(await expectDbError(() => annotate(a.ownerId, a.shopId, orderId, Array.from({ length: 21 }, (_, i) => `t${i}`), null, false))).toMatch(/invalid_tags/);
    expect(await expectDbError(() => annotate(a.ownerId, a.shopId, orderId, null, "x".repeat(2001), true))).toMatch(/orders_note_len|check/);
    // ほかのショップの注文・権限の無い人
    expect(await expectDbError(() => annotate(a.ownerId, a.shopId, bOrderId, ["x"], null, false))).toMatch(/not_found/);
    expect(await expectDbError(() => annotate(b.ownerId, a.shopId, orderId, ["x"], null, false))).toMatch(/forbidden/);
    // 列を直接は書けない
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update orders set tags = '{x}' where id = $1", [orderId])))).toMatch(/permission denied/);
  });

  it("項目 orders を持たないスタッフは書けない", async () => {
    const staff = await createAuthUser("ot-staff@example.com");
    const token = "inv-ot-staff";
    await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "ot-staff@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["catalog"] }]), sha(token)]));
    await withRole("authenticated", { sub: staff, email: "ot-staff@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha(token)]));
    expect(await expectDbError(() => annotate(staff, a.shopId, orderId, ["x"], null, false))).toMatch(/forbidden/);
  });

  it("AI 用 API: 印は足す・外す・置き換え（orders:write）。メモは orders:pii のときだけ読み書き。一覧を印で絞る", async () => {
    const write = await issue(a.ownerId, a.shopId, ["orders:read", "orders:write"]);
    const pii = await issue(a.ownerId, a.shopId, ["orders:read", "orders:write", "orders:pii"]);
    let r = await rpc<Record<string, unknown>>("api_order_annotate", [write, orderId, ["処理済み", "ギフト"], ["要確認"], null, null, false]);
    expect(r["tags"]).toEqual(["ギフト", "処理済み"]);
    expect(r).not.toHaveProperty("note");
    expect(await expectDbError(() => rpc("api_order_annotate", [write, orderId, null, null, null, "x", true]))).toMatch(/pii_scope_required/);
    expect(await expectDbError(() => rpc("api_order_annotate", [write, orderId, ["a"], null, ["b"], null, false]))).toMatch(/invalid_tags/);
    r = await rpc<Record<string, unknown>>("api_order_annotate", [pii, orderId, null, null, ["VIP"], "", true]);
    expect(r).toMatchObject({ tags: ["VIP"], note: null });
    expect(await expectDbError(() => rpc("api_order_annotate", [write, bOrderId, ["a"], null, null, null, false]))).toMatch(/not_found/);
    const list = await rpc<{ items: { id: string }[]; total: number }>("api_orders_list", [write, null, null, null, 50, 0, null, null, null, null, "VIP"]);
    expect(list.items.map((o) => o.id)).toEqual([orderId]);
    expect((await rpc<{ total: number }>("api_orders_list", [write, null, null, null, 50, 0, null, null, null, null, "ない印"])).total).toBe(0);
    // 0105 までの呼び方もそのまま
    expect((await rpc<{ total: number }>("api_orders_list", [write, null, null, null, 50, 0])).total).toBe(1);
  });

  it("個人情報のマスキングでメモも消す（mask_customer・mask_shipped_orders）。印は残す", async () => {
    await annotate(a.ownerId, a.shopId, orderId, ["要確認"], "住所は東京都…", true);
    await asUser(a.ownerId, (c) => c.query("select mask_customer($1, 'x@example.com')", [a.shopId]));
    const row = (await getPool().query("select tags, note, customer_name from orders where id = $1", [orderId])).rows[0];
    expect(row).toMatchObject({ tags: ["要確認"], note: null, customer_name: "[masked]" });
    const o2 = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, customer_name, status, shipped_at, note) values ($1, 1000, 5002, '佐藤', 'shipped', now() - interval '200 days', 'メモ') returning id", [a.shopId])).rows[0]!.id;
    await asService((c) => c.query("select mask_shipped_orders(180)"));
    expect((await getPool().query("select note from orders where id = $1", [o2])).rows[0].note).toBeNull();
  });
});
