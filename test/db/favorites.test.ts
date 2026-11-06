import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0123_mod_favorites: 会員のお気に入り（本人だけが書く・運営者は customers で読む・人数は catalog でも・AI 用 API・hooks） */
describe.skipIf(!dbAvailable)("会員のお気に入り（0123）", () => {
  let f: Fixture;
  let other: Fixture;
  let cid: string;
  let sid: string;
  let hidden: string;
  let catalogOnly: string;
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const set = (product: string, on: boolean, s = sid) => svc<boolean | null>("select member_favorite_set($1, $2, 0, $3, $4, $5) as r", [f.shopId, cid, s, product, on]);
  const list = (s = sid) => svc<{ product_id: string; slug: string }[] | null>("select member_favorites($1, $2, 0, $3) as r", [f.shopId, cid, s]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "fav-owner@example.com", slug: "fav-shop", publish: true });
    other = await createShopFixture({ email: "fav-other@example.com", slug: "fav-other", publish: true });
    const pool = getPool();
    await pool.query("update shops set settings = settings || '{\"members_enabled\": true, \"modules\": {\"favorites\": true}}' where id = $1", [f.shopId]);
    cid = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'fav@example.com') returning id", [f.shopId])).rows[0]!.id;
    sid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [f.shopId, cid]);
    hidden = (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published) values ($1, 'draft', 'draft', false) returning id", [f.shopId])).rows[0]!.id;
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    catalogOnly = await createAuthUser("fav-catalog@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "fav-catalog@example.com", JSON.stringify([{ shop_id: f.shopId, perms: ["catalog", "integrations"] }]), hash("t-cat")]));
    await withRole("authenticated", { sub: catalogOnly, email: "fav-catalog@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-cat")]));
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'p', 'https://plugin.example.com/h', '{favorite.added,favorite.removed}')", [f.shopId]);
  });
  afterAll(closePool);

  it("本人: 足す・外す・一覧。生きていないセッションは null。見えない商品・よその商品は足せない。hooks は ID だけ", async () => {
    expect(await set(f.productId, true)).toBe(true);
    expect(await set(f.productId, true)).toBe(true); // 二度目は何もしない
    expect((await list())!.map((x) => x.product_id)).toEqual([f.productId]);
    expect(await set(f.productId, true, randomUUID())).toBeNull();
    expect(await list(randomUUID())).toBeNull();
    expect(await expectDbError(() => set(hidden, true))).toMatch(/product_not_found/);
    expect(await expectDbError(() => set(other.productId, true))).toMatch(/product_not_found/);
    const hooks = await getPool().query<{ event: string; payload: J }>("select event, payload from hook_deliveries where shop_id = $1 order by created_at", [f.shopId]);
    expect(hooks.rows).toEqual([{ event: "favorite.added", payload: { shop_id: f.shopId, customer_id: cid, product_id: f.productId } }]);
    expect(await set(f.productId, false)).toBe(true);
    expect(await list()).toEqual([]);
    expect((await getPool().query("select event from hook_deliveries where shop_id = $1 order by created_at", [f.shopId])).rows.map((r) => r.event)).toEqual(["favorite.added", "favorite.removed"]);
    // 公開を止めた商品は本人の一覧に出ない（行は残る）
    await set(f.productId, true);
    await getPool().query("update products set published = false where id = $1", [f.productId]);
    expect(await list()).toEqual([]);
    await getPool().query("update products set published = true where id = $1", [f.productId]);
    expect((await list())!.length).toBe(1);
  });

  it("ゲストの分を移す: 見えない・重なる・よその商品は捨て、上限まで", async () => {
    const pool = getPool();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published) values ($1, $2, $2, true) returning id", [f.shopId, `m${i}`])).rows[0]!.id);
    const n = await svc<number>("select member_favorites_merge($1, $2, 0, $3, $4::uuid[]) as r", [f.shopId, cid, sid, [...ids, ids[0], hidden, other.productId, f.productId]]);
    expect(n).toBe(3);
    expect((await list())!.length).toBe(4);
    // よそのショップの会員・商品の組み合わせは作れない
    expect(await expectDbError(() => pool.query("insert into customer_favorites (shop_id, customer_id, product_id) values ($1, $2, $3)", [f.shopId, cid, other.productId]))).toMatch(/foreign key/);
    // 上限（200）を超える分は入らない
    await pool.query("insert into products (shop_id, slug, name, published) select $1, 'z' || g, 'z', true from generate_series(1, 200) g", [f.shopId]);
    await pool.query("insert into customer_favorites (shop_id, customer_id, product_id) select $1, $2, id from products where shop_id = $1 and slug like 'z%' order by slug limit 196", [f.shopId, cid]);
    expect(await expectDbError(() => pool.query("insert into customer_favorites (shop_id, customer_id, product_id) select $1, $2, id from products where slug = 'z99'", [f.shopId, cid]))).toMatch(/favorites_full/);
    const extra = (await pool.query<{ id: string }>("select id from products where shop_id = $1 and slug = 'z99'", [f.shopId])).rows[0]!.id;
    expect(await svc<number>("select member_favorites_merge($1, $2, 0, $3, $4::uuid[]) as r", [f.shopId, cid, sid, [extra]])).toBe(0);
  });

  it("運営者: customers の項目で読める。catalog だけの人は人数だけ。匿名は読めない。書けない", async () => {
    expect((await asUser(f.ownerId, (c) => c.query("select product_id from customer_favorites where customer_id = $1", [cid]))).rows.length).toBe(200);
    expect((await asUser(catalogOnly, (c) => c.query("select product_id from customer_favorites"))).rows).toHaveLength(0);
    const counts = await asUser(catalogOnly, async (c) => (await c.query<{ r: Record<string, number> }>("select product_favorite_counts($1, $2::uuid[]) as r", [f.shopId, [f.productId, hidden]])).rows[0]!.r);
    expect(counts).toEqual({ [f.productId]: 1 });
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select product_favorite_counts($1, $2::uuid[])", [f.shopId, [f.productId]])))).toMatch(/shop_not_found|permission/);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from customer_favorites")))).toMatch(/permission/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("delete from customer_favorites where customer_id = $1", [cid])))).toMatch(/permission/);
  });

  it("AI 用 API（customers:read）: 会員ごとと、足した順にたどる一覧（cursor）。商品で絞る", async () => {
    const raw = `banto_${randomUUID()}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{customers:read}')", [f.shopId, f.ownerId, hash(raw), raw.slice(0, 12)]));
    const api = <T>(fn: string, args: unknown[]) => svc<T>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args);
    const one = await api<{ items: J[] }>("api_customer_favorites", [hash(raw), cid]);
    expect(one.items).toHaveLength(200);
    expect(one.items.find((x) => x["product_id"] === f.productId)).toMatchObject({ customer_id: cid, product_slug: "tee" });
    let seen = 0;
    let cursor: { since: string; after: string } | null = null;
    for (let i = 0; i < 5; i++) {
      const [ac, ap] = cursor ? cursor.after.split(":") : [null, null];
      const page: { items: J[]; has_more: boolean; cursor: { since: string; after: string } | null } = await api("api_favorites_list", [hash(raw), null, cursor?.since ?? null, ac, ap, 90]);
      seen += page.items.length;
      cursor = page.cursor;
      if (!page.has_more) break;
    }
    expect(seen).toBe(200);
    expect((await api<{ items: J[] }>("api_favorites_list", [hash(raw), f.productId, null, null, null, 10])).items).toHaveLength(1);
    expect(await expectDbError(() => api("api_favorites_list", [hash(raw), null, null, cid, null, 10]))).toMatch(/invalid_cursor/);
  });

  it("会員・商品を消すと一緒に消え、そのときは favorite.removed を送らない", async () => {
    const pool = getPool();
    const before = (await pool.query("select count(*)::int as n from hook_deliveries where shop_id = $1 and event = 'favorite.removed'", [f.shopId])).rows[0].n;
    await pool.query("delete from products where id = $1", [f.productId]);
    await pool.query("delete from customers where id = $1", [cid]);
    expect((await pool.query("select count(*)::int as n from customer_favorites where shop_id = $1", [f.shopId])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from hook_deliveries where shop_id = $1 and event = 'favorite.removed'", [f.shopId])).rows[0].n).toBe(before);
  });
});
