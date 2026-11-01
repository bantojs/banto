import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0088_app_connect: 外部プラグインに「つなぐ」。運営者が許す（app_connect_begin、2 分・1 回限りの券）→
 * プラグインが裏で引き換える（app_connect_exchange、service_role）→ 連携に結んだトークンと接続ごとの署名シークレットの暗号文
 */
describe.skipIf(!dbAvailable)("つなぐ（0088）", () => {
  let f: Fixture;
  let ep: string;
  let integrationsOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cn-owner@example.com", slug: "cn-shop", publish: true });
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    integrationsOnly = await createAuthUser("cn-int@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "cn-int@example.com", JSON.stringify([{ shop_id: f.shopId, perms: ["integrations", "catalog"] }]), hash("t-int")]));
    await withRole("authenticated", { sub: integrationsOnly, email: "cn-int@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-int")]));
    ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'レビュー', 'https://vendor.example/hooks/a', '{order.shipped}', 'reviews') returning id", [f.shopId]))).rows[0]!.id;
  });
  afterAll(closePool);

  const begin = (uid: string, scopes: string[], ticket: string, endpoint = ep) => asUser(uid, (c) => c.query("select app_connect_begin($1, $2, $3, $4) as r", [f.shopId, endpoint, scopes, hash(ticket)]));
  const exchange = async (ticket: string) => {
    const raw = `banto_${randomUUID()}`;
    const r = await asService(async (c) => (await c.query<{ r: J }>("select app_connect_exchange($1, $2, $3, $4) as r", [hash(ticket), hash(raw), raw.slice(0, 12), "v1.aaaa.bbbb"])).rows[0]!.r);
    return { r, raw };
  };

  it("許す → 引き換え: 連携に結んだトークン（許した人・許したスコープ）と暗号文。券は 1 回だけ。監査ログに残る", async () => {
    await begin(f.ownerId, ["products:read", "app_data:write"], "ticket-1");
    const { r, raw } = await exchange("ticket-1");
    expect(r).toMatchObject({ shop_id: f.shopId, shop_slug: "cn-shop", endpoint_id: ep, app: "reviews", scopes: ["products:read", "app_data:write"] });
    const tok = (await getPool().query("select owner_id, scopes, endpoint_id, revoked_at, name from api_tokens where token_hash = $1", [hash(raw)])).rows[0];
    expect(tok).toMatchObject({ owner_id: f.ownerId, scopes: ["products:read", "app_data:write"], endpoint_id: ep, revoked_at: null, name: "連携: レビュー" });
    // そのトークンで拡張データを書ける
    await asService((c) => c.query("select api_app_data_set($1, $2, 'reviews.v1', '{\"rating_avg\":5,\"rating_count\":1}'::jsonb, true)", [hash(raw), f.productId]));
    // 券は 1 回だけ
    expect(await expectDbError(() => exchange("ticket-1"))).toMatch(/invalid_ticket/);
    const conn = (await getPool().query("select ticket_hash, secret_box, connected_at from app_connections where endpoint_id = $1", [ep])).rows[0];
    expect(conn).toMatchObject({ ticket_hash: null, secret_box: "v1.aaaa.bbbb" });
    expect(conn.connected_at).not.toBeNull();
    expect((await getPool().query("select action from audit_log where target_id = $1 order by created_at", [ep])).rows.map((x) => x.action)).toContain("app.connected");
  });

  it("つなぎ直すと前のトークンは取り消し。期限切れの券は使えない", async () => {
    const before = (await getPool().query<{ token_id: string }>("select token_id from app_connections where endpoint_id = $1", [ep])).rows[0]!.token_id;
    await begin(f.ownerId, ["products:read"], "ticket-2");
    const { raw } = await exchange("ticket-2");
    expect((await getPool().query("select revoked_at from api_tokens where id = $1", [before])).rows[0]!.revoked_at).not.toBeNull();
    expect((await getPool().query("select scopes from api_tokens where token_hash = $1", [hash(raw)])).rows[0]!.scopes).toEqual(["products:read"]);
    await begin(f.ownerId, ["products:read"], "ticket-3");
    await getPool().query("update app_connections set ticket_expires_at = now() - interval '1 second' where endpoint_id = $1", [ep]);
    expect(await expectDbError(() => exchange("ticket-3"))).toMatch(/invalid_ticket/);
  });

  it("許せるのは自分の項目までのスコープ・語彙のものだけ。integrations の無い人・ほかのショップの連携・同梱プラグインは不可", async () => {
    expect(await expectDbError(() => begin(integrationsOnly, ["orders:pii"], "t-x"))).toMatch(/scope_not_permitted/);
    expect(await expectDbError(() => begin(integrationsOnly, ["bogus:read"], "t-y"))).toMatch(/invalid_scopes/);
    await begin(integrationsOnly, ["products:read"], "t-z");
    const other = await createShopFixture({ email: "cn-other@example.com", slug: "cn-other", publish: true });
    expect(await expectDbError(() => begin(other.ownerId, ["products:read"], "t-o"))).toMatch(/forbidden/);
    const bundled = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}') returning id", [f.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => begin(f.ownerId, [], "t-b", bundled))).toMatch(/not_found/);
    const noName = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'crm', 'https://crm.example/', '{}') returning id", [f.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => begin(f.ownerId, ["app_data:write"], "t-n", noName))).toMatch(/app_handle_required/);
  });

  it("運営者にも券と暗号文の列は読ませない。引き換えと暗号文の読み出しは service_role だけ", async () => {
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select secret_box from app_connections")))).toMatch(/permission/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select ticket_hash from app_connections")))).toMatch(/permission/);
    expect((await asUser(f.ownerId, (c) => c.query("select endpoint_id, scopes, connected_at from app_connections where endpoint_id = $1", [ep]))).rows).toHaveLength(1);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select app_connect_exchange('x', 'y', 'z', null)")))).toMatch(/permission|service_role/);
    expect(await expectDbError(() => asAnon((c) => c.query("select app_connection_secret_box($1)", [ep])))).toMatch(/permission/);
    expect(await asService(async (c) => (await c.query<{ r: string }>("select app_connection_secret_box($1) as r", [ep])).rows[0]!.r)).toBe("v1.aaaa.bbbb");
  });

  it("配信の取り出しに暗号文が付く。外す（連携を消す）とトークン・接続・拡張データが消え、監査ログに残る", async () => {
    await asService((c) => c.query("select enqueue_hook($1, 'order.shipped', '{}'::jsonb)", [f.shopId]));
    const rows = await asService(async (c) => (await c.query<{ endpoint_id: string; secret_box: string | null }>("select endpoint_id, secret_box from claim_hook_deliveries(10)")).rows);
    expect(rows.find((x) => x.endpoint_id === ep)?.secret_box).toBe("v1.aaaa.bbbb");
    await asUser(f.ownerId, (c) => c.query("delete from hook_endpoints where id = $1", [ep]));
    expect((await getPool().query("select 1 from app_connections where endpoint_id = $1", [ep])).rows).toHaveLength(0);
    expect((await getPool().query("select 1 from api_tokens where endpoint_id = $1", [ep])).rows).toHaveLength(0);
    expect((await getPool().query("select 1 from app_data where endpoint_id = $1", [ep])).rows).toHaveLength(0);
    expect((await getPool().query("select action from audit_log where target_id = $1", [ep])).rows.map((x) => x.action)).toContain("app.disconnected");
  });
});
