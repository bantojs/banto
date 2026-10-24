import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0038_site_settings と 0039_mod_woo_import_queue: サイトの設定と、画像を裏で取り込む予約 */
describe.skipIf(!dbAvailable)("サイトの設定と画像の取り込みの予約（0038 / 0039）", () => {
  let a: Fixture;
  let b: Fixture;
  let clerk: string; // orders だけのスタッフ
  let orgId: string;

  const svc = <T = unknown>(sql: string, args: unknown[] = []) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const enqueue = (uid: string, shopId: string, items: unknown) => asUser(uid, async (c) => (await c.query<{ r: Record<string, number> }>("select image_import_enqueue($1, $2) as r", [shopId, JSON.stringify(items)])).rows[0]!.r);
  const claim = () => asService(async (c) => (await c.query<{ id: string; url: string }>("select * from image_import_claim()")).rows);
  const finish = (results: unknown[]) => svc<Record<string, number>>("select image_import_finish($1) as r", [JSON.stringify(results)]);
  const jobs = async () => (await getPool().query<{ id: string; url: string; status: string; attempts: number; last_error: string | null }>("select id, url, status, attempts, last_error from image_import_jobs order by id")).rows;
  const item = (url: string, tag = "/wc-abc.") => ({ url, tag });

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "iq-a@example.com", slug: "iq-a" });
    b = await createShopFixture({ email: "iq-b@example.com", slug: "iq-b" });
    await getPool().query(`update shops set settings = settings || '{"modules":{"woo_import":true}}'::jsonb`);
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    clerk = await createAuthUser("iq-clerk@example.com");
    const token = "inv-iq-clerk";
    await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "iq-clerk@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["orders"] }]), sha(token)]));
    await withRole("authenticated", { sub: clerk, email: "iq-clerk@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha(token)]));
  });
  afterAll(closePool);

  it("サイトの設定: 組織の owner / admin だけが、決まった鍵と値だけ書ける。member と anon は読めない", async () => {
    expect(await asUser(a.ownerId, async (c) => (await c.query("select site_settings_set('workers_plan', '\"paid\"') as r")).rows[0].r)).toEqual({ workers_plan: "paid" });
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"enterprise\"')")))).toMatch(/invalid_value/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select site_settings_set('secret', '\"x\"')")))).toMatch(/invalid_key/);
    expect(await expectDbError(() => asUser(clerk, (c) => c.query("select site_settings_set('workers_plan', '\"free\"')")))).toMatch(/forbidden/);
    expect((await asUser(clerk, (c) => c.query("select * from banto_site_settings"))).rowCount).toBe(0);
    expect((await asAnon((c) => c.query("select * from banto_site_settings"))).rowCount).toBe(0);
    // 直接は書けない（更新のポリシーが無いので 0 行）
    expect((await asUser(a.ownerId, (c) => c.query("update banto_site_settings set settings = '{}'"))).rowCount).toBe(0);
    await asUser(a.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"free\"')"));
  });

  it("予約: catalog の項目が要る。他のショップには入れられない。取り込み済み（目印のキーがある）・Banto に無い商品は飛ばす", async () => {
    expect(await expectDbError(() => enqueue(clerk, a.shopId, [{ slug: "tee", urls: [item("https://old.example/1.png")] }]))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => enqueue(b.ownerId, a.shopId, [{ slug: "tee", urls: [item("https://old.example/1.png")] }]))).toMatch(/shop_not_found/);
    await getPool().query("insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, $3, 0)", [a.shopId, a.productId, `shops/${a.shopId}/products/${a.productId}/wc-done.png`]);
    const r = await enqueue(a.ownerId, a.shopId, [
      { slug: "tee", urls: [item("https://old.example/1.png"), item("https://old.example/2.png"), item("https://old.example/3.png"), item("https://old.example/done.png", "/wc-done."), item("ftp://x/y.png"), item("https://old.example/bad.png", "../")] },
      { slug: "nope", urls: [item("https://old.example/9.png")] },
    ]);
    expect(r).toEqual({ queued: 3, skipped: 3, missing: 1 });
    expect((await enqueue(a.ownerId, a.shopId, [{ slug: "tee", urls: [item("https://old.example/1.png")] }])).skipped).toBe(1);
    // RLS: 読めるのは catalog の項目のある人だけ
    expect((await asUser(clerk, (c) => c.query("select * from image_import_jobs"))).rowCount).toBe(0);
    expect((await asUser(a.ownerId, (c) => c.query("select * from image_import_jobs"))).rowCount).toBe(3);
    expect((await asUser(a.ownerId, (c) => c.query("update image_import_jobs set status = 'done'"))).rowCount).toBe(0);
  });

  it("取り出し: 無料プランは 12 枚。モジュールが OFF のショップは取り出さない。service_role 以外は呼べない", async () => {
    await getPool().query("insert into image_import_jobs (shop_id, product_id, url) select $1, $2, 'https://old.example/b' || g || '.png' from generate_series(1, 20) g", [b.shopId, b.productId]);
    await getPool().query(`update shops set settings = settings || '{"modules":{"woo_import":false}}'::jsonb where id = $1`, [b.shopId]);
    const first = await claim();
    expect(first).toHaveLength(3);
    await getPool().query(`update shops set settings = settings || '{"modules":{"woo_import":true}}'::jsonb where id = $1`, [b.shopId]);
    expect(await claim()).toHaveLength(12);
    await asUser(a.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"paid\"')"));
    expect(await claim()).toHaveLength(8);
    await asUser(a.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"free\"')"));
    for (const role of ["anon", "authenticated"] as const) {
      expect(await expectDbError(() => withRole(role, role === "anon" ? {} : { sub: a.ownerId }, (c) => c.query("select * from image_import_claim()")))).toMatch(/permission denied/);
    }
    // 取り出し中はリースが切れるまで出てこない。切れたらまた出てくる
    expect(await claim()).toHaveLength(0);
    await getPool().query("update image_import_jobs set next_attempt_at = now() - interval '1 second' where shop_id = $1", [b.shopId]);
    expect(await claim()).toHaveLength(12);
    await getPool().query("delete from image_import_jobs where shop_id = $1", [b.shopId]);
  });

  it("結果: 成功は商品の画像の末尾に足す（同じキーは足さない）。一時的な失敗は 3 回まで待ちに戻す。キーが違えば登録しない", async () => {
    const all = await jobs();
    const [j1, j2, j3] = all;
    const key = (n: string) => `shops/${a.shopId}/products/${a.productId}/wc-${n}.png`;
    expect(await finish([{ id: j1!.id, storage_key: key("one") }, { id: j2!.id, error: "http_503" }, { id: j3!.id, error: "http_403" }])).toEqual({ done: 1, retry: 1, failed: 1 });
    const imgs = await getPool().query<{ storage_key: string; sort_order: number }>("select storage_key, sort_order from product_images where product_id = $1 order by sort_order", [a.productId]);
    expect(imgs.rows.map((r) => [r.storage_key, r.sort_order])).toEqual([[key("done"), 0], [key("one"), 1]]);
    expect((await jobs()).map((j) => [j.status, j.last_error])).toEqual([["done", null], ["pending", "http_503"], ["failed", "http_403"]]);
    // 3 回目の一時的な失敗で失敗にする
    for (let i = 0; i < 2; i++) {
      await getPool().query("update image_import_jobs set next_attempt_at = now() - interval '1 second' where id = $1", [j2!.id]);
      await claim();
      await finish([{ id: j2!.id, error: "fetch_failed" }]);
    }
    expect((await jobs())[1]).toMatchObject({ status: "failed", attempts: 3, last_error: "fetch_failed" });
    // 取り出し中でないものには書かない。他の商品の下のキーは登録しない
    expect(await finish([{ id: j1!.id, storage_key: key("again") }])).toEqual({ done: 0, retry: 0, failed: 0 });
    await asUser(a.ownerId, (c) => c.query("select image_import_retry($1)", [a.shopId]));
    await claim();
    expect(await finish([{ id: j2!.id, storage_key: `shops/${b.shopId}/products/${b.productId}/wc-x.png` }, { id: j3!.id, error: "Bad Code!" }])).toEqual({ done: 0, retry: 0, failed: 2 });
    expect((await jobs()).map((j) => j.last_error)).toEqual([null, "invalid_storage_key", "error"]);
    expect((await getPool().query("select 1 from product_images where storage_key like '%wc-x.png'")).rowCount).toBe(0);
  });

  it("縮小して取り込んだら予約を取り込み済みにする（0040）。catalog の項目が要り、他のショップの予約は変えない", async () => {
    await getPool().query("insert into image_import_jobs (shop_id, product_id, url, status, last_error) values ($1, $2, 'https://old.example/huge.png', 'failed', 'too_large')", [a.shopId, a.productId]);
    expect(await expectDbError(() => asUser(clerk, (c) => c.query("select image_import_resolve($1, $2, $3)", [a.shopId, a.productId, "https://old.example/huge.png"])))).toMatch(/shop_not_found/);
    expect(await asUser(b.ownerId, async (c) => (await c.query("select image_import_resolve($1, $2, $3) as r", [b.shopId, a.productId, "https://old.example/huge.png"])).rows[0].r)).toBe(0);
    expect(await asUser(a.ownerId, async (c) => (await c.query("select image_import_resolve($1, $2, $3) as r", [a.shopId, a.productId, "https://old.example/huge.png"])).rows[0].r)).toBe(1);
    expect((await jobs()).at(-1)).toMatchObject({ status: "done", last_error: null });
  });

  it("進み具合・やり直し・取り消し（取り込み済みの記録は残す）", async () => {
    const s = await asUser(a.ownerId, async (c) => (await c.query("select image_import_summary($1) as r", [a.shopId])).rows[0].r);
    expect(s).toMatchObject({ pending: 0, done: 2, failed: 2, batch: 12, plan: "free" });
    expect(s.failures.map((f: { slug: string }) => f.slug)).toEqual(["tee", "tee"]);
    expect(await asUser(b.ownerId, async (c) => (await c.query("select image_import_summary($1) as r", [a.shopId])).rows[0].r)).toBeNull();
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select image_import_cancel($1)", [a.shopId])))).toMatch(/shop_not_found/);
    expect(await asUser(a.ownerId, async (c) => (await c.query("select image_import_cancel($1) as r", [a.shopId])).rows[0].r)).toBe(2);
    expect((await jobs()).map((j) => j.status)).toEqual(["done", "done"]);
  });
});
