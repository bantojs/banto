import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0110_mod_dialogs: お店の画面のダイアログの器（形の確かめ・権限・公開のショップ行・行動の中継の種類） */
describe.skipIf(!dbAvailable)("お店の画面のダイアログ（0110_mod_dialogs）", () => {
  let a: Fixture;
  let b: Fixture;

  const insert = (uid: string, shopId: string, row: Record<string, unknown>) =>
    asUser(uid, async (c) => {
      const cols = Object.keys(row);
      const vals = cols.map((k) => (typeof row[k] === "object" && row[k] !== null ? JSON.stringify(row[k]) : row[k]));
      const r = await c.query<{ id: string; pages: unknown; trigger: unknown; buttons: unknown; audience_id: string | null }>(
        `insert into dialogs (shop_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id, pages, trigger, buttons, audience_id`,
        [shopId, ...vals],
      );
      return r.rows[0]!;
    });
  const pub = async (slug: string) => (await asAnon(async (c) => (await c.query<{ r: { dialogs: { id: string }[] } }>("select shop_public_get($1) as r", [slug])).rows[0]!.r)).dialogs;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "dlg-a@example.com", slug: "dlg-a", publish: true });
    b = await createShopFixture({ email: "dlg-b@example.com", slug: "dlg-b", publish: true });
  });
  afterAll(closePool);

  it("形を確かめて組み直す（知らない鍵は落とす・ボタンのリンク・ページの種類・きっかけの範囲）", async () => {
    const r = await insert(a.ownerId, a.shopId, {
      name: "初回", title: "ようこそ",
      pages: { kinds: ["product", "nope"], tags: ["秋"], extra: 1 },
      trigger: { delay_s: 5.7, exit_intent: true, foo: 1 },
      buttons: [{ label: "見る", url: "/products/tee", x: 1 }],
      audience: "guests", audience_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(r.pages).toEqual({ kinds: ["product"], tags: ["秋"] });
    expect(r.trigger).toEqual({ delay_s: 5, exit_intent: true });
    expect(r.buttons).toEqual([{ label: "見る", url: "/products/tee" }]);
    expect(r.audience_id).toBeNull();
    for (const bad of [
      { buttons: [{ label: "x", url: "javascript:alert(1)" }] },
      { buttons: [{ label: "x", url: "//evil.example.com" }] },
      { pages: { kinds: [] } },
      { trigger: { delay_s: 9999 } },
      { trigger: { scroll_pct: "50" } },
      { image_url: "http://example.com/a.png" },
      { coupon_code: "a b" },
      { audience: "audience" },
    ]) {
      expect(await expectDbError(() => insert(a.ownerId, a.shopId, { name: "x", title: "x", ...bad }))).toMatch(/invalid_dialog|violates check constraint/);
    }
  });

  it("書けるのは項目 marketing を持つ人だけ。ほかのショップの条件は選べない", async () => {
    expect(await expectDbError(() => insert(b.ownerId, a.shopId, { name: "x", title: "x" }))).toMatch(/row-level security|permission/);
    const aud = (await getPool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'gold', '{\"member\": true}') returning id", [b.shopId])).rows[0]!.id;
    expect(await expectDbError(() => insert(a.ownerId, a.shopId, { name: "x", title: "x", audience: "audience", audience_id: aud }))).toMatch(/invalid_dialog:audience/);
    const seen = await asUser(b.ownerId, async (c) => (await c.query("select id from dialogs where shop_id = $1", [a.shopId])).rows);
    expect(seen).toEqual([]);
    expect(await expectDbError(() => asAnon((c) => c.query("select id from dialogs")))).toMatch(/permission denied/);
  });

  it("公開のショップ行に、モジュールが ON のとき有効で期間内のものだけ（優先の高い順）", async () => {
    await getPool().query("delete from dialogs");
    await insert(a.ownerId, a.shopId, { name: "低", title: "低", priority: 1 });
    await insert(a.ownerId, a.shopId, { name: "高", title: "高", priority: 9 });
    await insert(a.ownerId, a.shopId, { name: "止め", title: "止め", enabled: false });
    await insert(a.ownerId, a.shopId, { name: "済", title: "済", ends_at: "2000-01-01T00:00:00Z", starts_at: "1999-01-01T00:00:00Z" });
    expect(await pub("dlg-a")).toEqual([]);
    await getPool().query(`update shops set settings = jsonb_set(coalesce(settings, '{}'), '{modules}', coalesce(settings->'modules', '{}') || '{"dialogs": true}') where id = $1`, [a.shopId]);
    expect((await pub("dlg-a")).map((d) => (d as unknown as { title: string }).title)).toEqual(["高", "低"]);
    expect(JSON.stringify(await pub("dlg-a"))).not.toContain('"name"');
  });

  it("1 ショップ 50 まで。行動の中継で dialog_* を渡せる", async () => {
    await getPool().query("delete from dialogs");
    await getPool().query("insert into dialogs (shop_id, name, title) select $1, 'n' || g, 't' from generate_series(1, 50) g", [a.shopId]);
    expect(await expectDbError(() => insert(a.ownerId, a.shopId, { name: "51", title: "x" }))).toMatch(/dialogs_limit/);
    const types = (await getPool().query<{ t: string[] }>("select banto_relay_event_types() as t")).rows[0]!.t;
    expect(types).toEqual(expect.arrayContaining(["dialog_view", "dialog_close", "dialog_click"]));
  });
});
