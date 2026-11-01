import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

const review = (i: number, extra: J = {}) => ({ id: `r${i}`, rating: 5, title: `よい ${i}`, body: `<b>本文</b> ${i}`, author_display: "東京都 T さん", created_at: "2026-10-01T00:00:00Z", ...extra });

/**
 * 0084_app_data: 外部プラグインが商品に付くデータ（reviews.v1）を置き直す器。
 * 書くのは送信先に結んだ app_data:write のトークンだけ（項目 apps）、お客様の画面は product_public_get の app_data
 */
describe.skipIf(!dbAvailable)("拡張データの器（0084）", () => {
  let f: Fixture;
  let other: Fixture;
  let endpointId: string;
  let otherEndpointId: string;
  let appsMember: string;
  let catalogMember: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ad-owner@example.com", slug: "ad-shop", publish: true });
    other = await createShopFixture({ email: "ad-other@example.com", slug: "ad-other", publish: true });
    const pool = getPool();
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    appsMember = await createAuthUser("ad-apps@example.com");
    catalogMember = await createAuthUser("ad-catalog@example.com");
    for (const [uid, email, perms] of [[appsMember, "ad-apps@example.com", ["apps", "integrations"]], [catalogMember, "ad-catalog@example.com", ["catalog", "integrations"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
    endpointId = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'レビュー', 'https://reviews.example/banto', '{}', 'reviews') returning id", [f.shopId]))).rows[0]!.id;
    otherEndpointId = (await asUser(other.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'よそ', 'https://reviews.example/other', '{}', 'reviews') returning id", [other.shopId]))).rows[0]!.id;
  });
  afterAll(closePool);

  const issue = async (uid: string, shopId: string, scopes: string[], endpoint: string | null) => {
    const raw = `banto_${randomUUID()}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, endpoint_id) values ($1, $2, 't', $3, $4, $5, $6)", [shopId, uid, hash(raw), raw.slice(0, 12), scopes, endpoint]));
    return hash(raw);
  };
  const api = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const publicGet = async (shopId: string) => (await asAnon((c) => c.query<{ r: J }>("select product_public_get($1, 'tee') as r", [shopId]))).rows[0]!.r;

  it("置き直す → お客様の画面の商品に載る。知らない鍵は落とし、HTML は文字のまま。非公開・無効な送信先は載らない", async () => {
    const tok = await issue(f.ownerId, f.shopId, ["app_data:write"], endpointId);
    const set = await api<J>("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 4.567, rating_count: 12, items: [review(1, { extra: "x" }), review(2, { incentivized: true })], script: "<x>" }), true]);
    expect(set).toMatchObject({ app: "reviews", kind: "reviews.v1", public: true });
    const data = set["data"] as J;
    expect(data).toEqual({
      rating_avg: 4.57,
      rating_count: 12,
      items: [
        expect.objectContaining({ id: "r1", rating: 5, body: "<b>本文</b> 1", incentivized: false, verified_purchase: false }),
        expect.objectContaining({ id: "r2", incentivized: true }),
      ],
    });
    expect((data["items"] as J[])[0]).not.toHaveProperty("extra");
    const pub = await publicGet(f.shopId);
    expect(pub["app_data"]).toEqual([expect.objectContaining({ app: "reviews", kind: "reviews.v1", data })]);
    // 置き直すと丸ごと入れ替わる
    await api("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 3, rating_count: 1, items: [review(9, { rating: 3 })] }), true]);
    expect(((await publicGet(f.shopId))["app_data"] as J[])[0]!["data"]).toMatchObject({ rating_count: 1, items: [expect.objectContaining({ id: "r9" })] });
    // 非公開にすると載らない
    await api("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 3, rating_count: 1 }), false]);
    expect((await publicGet(f.shopId))["app_data"]).toEqual([]);
    await api("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 3, rating_count: 1 }), true]);
    // 送信先を無効にすると載らない
    await getPool().query("update hook_endpoints set enabled = false where id = $1", [endpointId]);
    expect((await publicGet(f.shopId))["app_data"]).toEqual([]);
    await getPool().query("update hook_endpoints set enabled = true where id = $1", [endpointId]);
    expect((await publicGet(f.shopId))["app_data"]).toHaveLength(1);
    // 一覧と消す
    expect(await api<J>("api_app_data_list", [tok, null, 50, 0])).toMatchObject({ app: "reviews", total: 1 });
    expect(await api<boolean>("api_app_data_delete", [tok, f.productId, "reviews.v1"])).toBe(true);
    expect(await api<boolean>("api_app_data_delete", [tok, f.productId, "reviews.v1"])).toBe(false);
    expect((await publicGet(f.shopId))["app_data"]).toEqual([]);
  });

  it("形の誤りは invalid_app_data_<場所>", async () => {
    const tok = await issue(f.ownerId, f.shopId, ["app_data:write"], endpointId);
    const bad = (d: unknown, kind = "reviews.v1") => expectDbError(() => api("api_app_data_set", [tok, f.productId, kind, JSON.stringify(d), true]));
    expect(await bad({ rating_avg: 4, rating_count: 1 }, "qa.v1")).toMatch(/invalid_app_data_kind/);
    expect(await bad([])).toMatch(/invalid_app_data/);
    expect(await bad({ rating_avg: 6, rating_count: 1 })).toMatch(/invalid_app_data_rating_avg/);
    expect(await bad({ rating_avg: 4, rating_count: 1.5 })).toMatch(/invalid_app_data_rating_count/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1), review(2)] })).toMatch(/invalid_app_data_items/);
    expect(await bad({ rating_avg: 4, rating_count: 30, items: Array.from({ length: 21 }, (_, i) => review(i)) })).toMatch(/invalid_app_data_items/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1, { rating: 0 })] })).toMatch(/invalid_app_data_item_rating/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1, { body: "a".repeat(2001) })] })).toMatch(/invalid_app_data_item_body/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1, { author_display: " " })] })).toMatch(/invalid_app_data_item_author_display/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1, { created_at: "きのう" })] })).toMatch(/invalid_app_data_item_created_at/);
    expect(await bad({ rating_avg: 4, rating_count: 1, items: [review(1, { incentivized: "yes" })] })).toMatch(/invalid_app_data_item_incentivized/);
    // ほかのショップの商品は無いのと同じ
    expect(await expectDbError(() => api("api_app_data_set", [tok, other.productId, "reviews.v1", JSON.stringify({ rating_avg: 4, rating_count: 1 }), true]))).toMatch(/not_found/);
  });

  it("トークン: 送信先に結ばないと発行できない・ほかのショップの送信先には結べない・項目 apps の無い人は発行できない・あとから付け替えられない", async () => {
    expect(await expectDbError(() => issue(f.ownerId, f.shopId, ["app_data:write"], null))).toMatch(/api_tokens_app_data_endpoint|check/);
    expect(await expectDbError(() => issue(f.ownerId, f.shopId, ["app_data:write"], otherEndpointId))).toMatch(/foreign key|api_tokens_endpoint_fkey/);
    expect(await expectDbError(() => issue(catalogMember, f.shopId, ["app_data:write"], endpointId))).toMatch(/scope_not_permitted/);
    const tok = await issue(appsMember, f.shopId, ["app_data:write"], endpointId);
    expect(await api<J>("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 5, rating_count: 1 }), true])).toMatchObject({ app: "reviews" });
    const anotherEp = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'b', 'https://b.example/x', '{}', 'qa') returning id", [f.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update api_tokens set endpoint_id = $1 where token_hash = $2", [anotherEp, tok])))).toMatch(/token_immutable/);
    // 名前を外した送信先には書けない
    const noName = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'c', 'https://c.example/x', '{}') returning id", [f.shopId]))).rows[0]!.id;
    const t2 = await issue(f.ownerId, f.shopId, ["app_data:write"], noName);
    expect(await expectDbError(() => api("api_app_data_set", [t2, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 5, rating_count: 1 }), true]))).toMatch(/app_handle_required/);
    // ほかのスコープのトークンでは書けない
    const ro = await issue(f.ownerId, f.shopId, ["products:read"], null);
    expect(await expectDbError(() => api("api_app_data_set", [ro, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 5, rating_count: 1 }), true]))).toMatch(/unauthorized/);
    // 同じショップで名前は重ならない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update hook_endpoints set app_handle = 'reviews' where id = $1", [anotherEp])))).toMatch(/unique|duplicate/);
  });

  it("読むのは項目 apps の人だけ。anon と authenticated は直接書けない。送信先を消すとトークンとデータも消える", async () => {
    const tok = await issue(f.ownerId, f.shopId, ["app_data:write"], endpointId);
    await api("api_app_data_set", [tok, f.productId, "reviews.v1", JSON.stringify({ rating_avg: 5, rating_count: 1 }), false]);
    expect((await asUser(appsMember, (c) => c.query("select kind from app_data"))).rows).toHaveLength(1);
    expect((await asUser(catalogMember, (c) => c.query("select kind from app_data"))).rows).toHaveLength(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from app_data")))).toMatch(/permission/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into app_data (shop_id, endpoint_id, product_id, kind, data) values ($1, $2, $3, 'reviews.v1', '{}')", [f.shopId, endpointId, f.productId])))).toMatch(/permission/);
    await asUser(f.ownerId, (c) => c.query("delete from hook_endpoints where id = $1", [endpointId]));
    expect((await getPool().query("select 1 from app_data where endpoint_id = $1", [endpointId])).rows).toHaveLength(0);
    expect((await getPool().query("select 1 from api_tokens where endpoint_id = $1", [endpointId])).rows).toHaveLength(0);
    expect(await expectDbError(() => api("api_app_data_list", [tok, null, 50, 0]))).toMatch(/unauthorized/);
  });
});
