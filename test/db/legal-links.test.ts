import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0062_legal_links: 法務のページを連携サイトに向ける。
 * - 設定は settings.headless.legal_links（integrations の項目。0055 のガード）
 * - 結果は legal_links_state。書けるのは legal_links_record だけ（authenticated は integrations、Cron は service_role）
 * - 公開の形の legal_links は、最後の確認で生きていて確認した URL が今の設定と同じものだけ
 * - legal_links_due は期限の来たショップ（未確認・設定と違う・間隔を過ぎた）だけ
 */
describe.skipIf(!dbAvailable)("法務のページの外の URL（0062_legal_links）", () => {
  let a: Fixture;
  let staff: string;
  const WP = "https://wp.example";
  const setLinks = (links: Record<string, unknown>) =>
    getPool().query(`update shops set settings = jsonb_set(settings, '{headless}', $2::jsonb) where id = $1`, [a.shopId, JSON.stringify({ return_origins: [WP], legal_links: links })]);
  const publicLinks = async () => (await asAnon(async (c) => (await c.query<{ j: { legal_links: Record<string, string> } }>("select shop_public_get($1) as j", ["legal-a"])).rows[0]!.j)).legal_links;
  const due = async () => (await asService(async (c) => (await c.query<{ j: { shop_id: string; urls: Record<string, string> }[] }>("select legal_links_due(10) as j")).rows[0]!.j)).filter((d) => d.shop_id === a.shopId);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "legal-a@example.com", slug: "legal-a", publish: true });
    staff = await createAuthUser("legal-staff@example.com");
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, staff]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [orgId, staff, a.shopId, ["settings"]]);
  });
  afterAll(closePool);

  it("確かめるまでは公開の形に出さず、期限の来たショップに挙がる", async () => {
    await setLinks({ legal: `${WP}/legal`, privacy: `${WP}/privacy`, returns: "http://wp.example/returns", check_hours: 24 });
    expect(await publicLinks()).toEqual({});
    const d = await due();
    expect(d).toHaveLength(1);
    // https でない URL は使わない
    expect(d[0]!.urls).toEqual({ legal: `${WP}/legal`, privacy: `${WP}/privacy` });
  });

  it("結果は設定と同じ URL のものだけ残り、生きているものだけ公開の形に出る。確かめた後は期限まで挙がらない", async () => {
    const state = await asService(async (c) =>
      (await c.query<{ s: Record<string, { ok: boolean }> }>("select legal_links_record($1, $2::jsonb) as s", [
        a.shopId,
        JSON.stringify({ legal: { url: `${WP}/legal`, ok: true }, privacy: { url: `${WP}/privacy`, ok: false }, returns: { url: `${WP}/returns`, ok: true }, extra: { url: "x", ok: true } }),
      ])).rows[0]!.s,
    );
    expect(Object.keys(state).sort()).toEqual(["legal", "privacy"]);
    expect(await publicLinks()).toEqual({ legal: `${WP}/legal` });
    expect(await due()).toHaveLength(0);
    // 設定の URL を変えたら、確かめ直すまで出さない
    await setLinks({ legal: `${WP}/legal-new`, privacy: `${WP}/privacy`, check_hours: 24 });
    expect(await publicLinks()).toEqual({});
    expect(await due()).toHaveLength(1);
    // 間隔を過ぎたら挙がる
    await setLinks({ legal: `${WP}/legal`, privacy: `${WP}/privacy`, check_hours: 1 });
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('banto.legal_links_record', 'on', true)");
      await client.query(`update shops set legal_links_state = jsonb_set(legal_links_state, '{legal,checked_at}', to_jsonb(now() - interval '2 hours')) where id = $1`, [a.shopId]);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await due()).toHaveLength(1);
  });

  it("legal_links_state は直接書けない。legal_links_record は integrations の項目が要り、anon は呼べない", async () => {
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query(`update shops set legal_links_state = '{"legal":{"url":"https://wp.example/legal","ok":true}}' where id = $1`, [a.shopId])))).toContain("legal_links_state_readonly");
    expect(await expectDbError(() => asService((c) => c.query(`update shops set legal_links_state = '{}' where id = $1`, [a.shopId])))).toContain("legal_links_state_readonly");
    // 運営者（owner）は書ける
    await asUser(a.ownerId, (c) => c.query("select legal_links_record($1, $2::jsonb)", [a.shopId, JSON.stringify({ legal: { url: `${WP}/legal`, ok: true } })]));
    // settings の項目だけのスタッフは書けない・法務の URL も変えられない
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select legal_links_record($1, '{}'::jsonb)", [a.shopId])))).toContain("forbidden");
    expect(await expectDbError(() => asUser(staff, (c) => c.query(`update shops set settings = jsonb_set(settings, '{headless,legal_links,legal}', '"https://wp.example/x"') where id = $1`, [a.shopId])))).toContain("integrations_required");
    expect(await expectDbError(() => asAnon((c) => c.query("select legal_links_record($1, '{}'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select legal_links_due(1)")))).toMatch(/permission denied/);
    // anon は列を読めない
    expect(await expectDbError(() => asAnon((c) => c.query("select legal_links_state from shops")))).toMatch(/permission denied/);
  });
});
