import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type Result = { counts: Record<string, number>; issues: { row: number; provider?: string; reason: string }[]; dry_run: boolean };

/**
 * 0168_member_identity_import: 運営者が会員の LINE・Google のログインの ID を取り込む（管理画面だけ）。
 * owner / admin だけ、ちょうど 1 人に当たるときだけ・上書きしない、監査ログに ID を入れない
 */
describe.skipIf(!dbAvailable)("会員のログインの ID の取り込み（0168）", () => {
  let f: Fixture;
  let other: Fixture;
  let cardCid: string;
  let refCid: string;
  let mailCid: string;
  let linkedCid: string;
  const uid = (n: number) => `U${n.toString(16).padStart(32, "0")}`;
  const imp = (who: string, match: string, key: string | null, rows: unknown, dry = false, shop = f.shopId) =>
    asUser(who, async (c) => (await c.query<{ r: Result }>("select member_identities_import($1, $2, $3, $4::jsonb, $5) as r", [shop, match, key, JSON.stringify(rows), dry])).rows[0]!.r);
  const identityOf = async (provider: string, subject: string, shop = f.shopId) =>
    (await getPool().query<{ customer_id: string }>("select customer_id from member_identities where shop_id = $1 and provider = $2 and subject = $3", [shop, provider, subject])).rows[0]?.customer_id ?? null;
  const member = async (email: string, role: "admin" | "member", perms: string[]) => {
    const u = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, $3)", [org, u, role]);
    if (role === "member") await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, u, f.shopId, perms]);
    return u;
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mii-owner@example.com", slug: "mii-shop", publish: true });
    other = await createShopFixture({ email: "mii-other@example.com", slug: "mii-other", publish: true });
    const pool = getPool();
    await pool.query(`update shops set settings = settings || '{"members_enabled": true, "modules": {"line_login": true}, "customer_fields": [{"key": "card_no", "label": "会員カード", "type": "text"}, {"key": "rank", "label": "rank", "type": "text"}, {"key": "size", "label": "size", "type": "select", "options": ["S", "M"]}]}' where id = $1`, [f.shopId]);
    const ins = async (shop: string, email: string | null, attrs: object, ref: object | null) =>
      (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes, external_ref) values ($1, $2, $3, $4) returning id", [shop, email, attrs, ref])).rows[0]!.id;
    cardCid = await ins(f.shopId, "card@example.com", { card_no: "C001", rank: "gold" }, null);
    refCid = await ins(f.shopId, "ref@example.com", { rank: "gold" }, { provider: "crm", id: "E001" });
    mailCid = await ins(f.shopId, "Mail@Example.com", {}, null);
    linkedCid = await ins(f.shopId, "linked@example.com", { card_no: "C009" }, null);
    await ins(f.shopId, "dup1@example.com", { card_no: "C777" }, null);
    await ins(f.shopId, "dup2@example.com", { card_no: "C777" }, null);
    // ほかのショップの同じカード番号（混ざらない）
    await ins(other.shopId, "card@example.com", { card_no: "C001" }, null);
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', $2, $3)", [f.shopId, uid(99), linkedCid]);
  });
  afterAll(closePool);

  it("使えるのは組織の owner / admin だけ。customers の項目だけのメンバー・anon・ほかのショップの owner は断る", async () => {
    const admin = await member("mii-admin@example.com", "admin", []);
    const staff = await member("mii-staff@example.com", "member", ["customers", "integrations"]);
    expect(await expectDbError(() => imp(staff, "email", null, []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => imp(other.ownerId, "email", null, []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select member_identities_import($1, 'email', null, '[]'::jsonb, false)", [f.shopId])))).toMatch(/permission denied/);
    expect((await imp(admin, "email", null, [])).counts["linked"]).toBe(0);
  });

  it("独自項目（会員カードの番号）で引いて LINE を結ぶ。2 人に当たる・いない・形の誤りは飛ばして行の番号だけ返す", async () => {
    const r = await imp(f.ownerId, "attribute", "card_no", [
      { key: "C001", line: uid(1) },
      { key: "C777", line: uid(2) },
      { key: "C404", line: uid(3) },
      { key: "C001", line: "not-a-line-uid" },
      { key: "C001" },
      { key: "", line: uid(4) },
      "x",
    ]);
    expect(r.counts).toMatchObject({ linked: 1, ambiguous: 1, not_found: 1, invalid: 4 });
    expect(r.issues).toEqual([
      { row: 1, reason: "ambiguous" },
      { row: 2, reason: "not_found" },
      { row: 3, reason: "invalid" },
      { row: 4, reason: "invalid" },
      { row: 5, reason: "invalid" },
      { row: 6, reason: "invalid" },
    ]);
    expect(JSON.stringify(r)).not.toContain(uid(1));
    expect(await identityOf("line", uid(1))).toBe(cardCid);
    // ほかのショップの同じ番号の会員には結ばない
    expect(await identityOf("line", uid(1), other.shopId)).toBeNull();
  });

  it("external_ref とメールアドレス（大文字小文字を問わない）で引く。Google の ID も", async () => {
    const r1 = await imp(f.ownerId, "external_ref", "crm", [{ key: "E001", line: uid(10), google: "109876543210987654321" }]);
    expect(r1.counts).toMatchObject({ linked: 2 });
    expect(await identityOf("line", uid(10))).toBe(refCid);
    expect(await identityOf("google", "109876543210987654321")).toBe(refCid);
    const r2 = await imp(f.ownerId, "email", null, [{ key: "mail@EXAMPLE.com", line: uid(11) }]);
    expect(r2.counts).toMatchObject({ linked: 1 });
    expect(await identityOf("line", uid(11))).toBe(mailCid);
    // 違う provider の external_ref では当たらない
    expect((await imp(f.ownerId, "external_ref", "hubspot", [{ key: "E001", line: uid(12) }])).counts).toMatchObject({ not_found: 1 });
  });

  it("上書きしない: 同じ組は unchanged、ID が別の会員に結ばれている・会員に別の ID があるのは飛ばす", async () => {
    const r = await imp(f.ownerId, "attribute", "card_no", [
      { key: "C001", line: uid(1) },
      { key: "C001", line: uid(20) },
      { key: "C009", line: uid(1) },
    ]);
    expect(r.counts).toMatchObject({ unchanged: 1, member_has_other: 1, subject_taken: 1, linked: 0 });
    expect(r.issues).toEqual([
      { row: 1, provider: "line", reason: "member_has_other" },
      { row: 2, provider: "line", reason: "subject_taken" },
    ]);
    expect(await identityOf("line", uid(1))).toBe(cardCid);
    expect(await identityOf("line", uid(99))).toBe(linkedCid);
  });

  it("鍵の誤り・行の数の上限・確かめるだけ（書かない）", async () => {
    expect(await expectDbError(() => imp(f.ownerId, "attribute", "nope", []))).toMatch(/invalid_match_key/);
    // 引く値にできるのは文字と数の項目だけ
    expect(await expectDbError(() => imp(f.ownerId, "attribute", "size", []))).toMatch(/invalid_match_key/);
    // Google の ID は sub（数字）だけ
    expect((await imp(f.ownerId, "email", null, [{ key: "card@example.com", google: "card@example.com" }], true)).counts).toMatchObject({ invalid: 1 });
    expect(await expectDbError(() => imp(f.ownerId, "external_ref", "", []))).toMatch(/invalid_match_key/);
    expect(await expectDbError(() => imp(f.ownerId, "phone", null, []))).toMatch(/invalid_match/);
    expect(await expectDbError(() => imp(f.ownerId, "email", null, Array.from({ length: 501 }, () => ({}))))).toMatch(/too_many_rows/);
    const before = (await getPool().query("select count(*)::int as n from audit_log where action = 'customer.identity_imported'")).rows[0]!.n as number;
    const dry = await imp(f.ownerId, "attribute", "rank", [{ key: "gold", line: uid(30) }, { key: "silver", google: "123" }], true);
    expect(dry).toMatchObject({ dry_run: true, counts: { ambiguous: 1, not_found: 1 } });
    const dry2 = await imp(f.ownerId, "email", null, [{ key: "dup1@example.com", line: uid(31) }, { key: "dup2@example.com", line: uid(31) }], true);
    expect(dry2.counts).toMatchObject({ linked: 1, subject_taken: 1 });
    expect(await identityOf("line", uid(31))).toBeNull();
    expect((await getPool().query("select count(*)::int as n from audit_log where action = 'customer.identity_imported'")).rows[0]!.n).toBe(before);
  });

  it("監査ログ: 取り込みで結んだ分だけ・ID は入れない。会員自身の LINE のログインは書かない", async () => {
    const rows = (await getPool().query<{ target_id: string; detail: Record<string, unknown>; actor_kind: string; actor_id: string }>(
      "select target_id, detail, actor_kind, actor_id from audit_log where action = 'customer.identity_imported' order by id")).rows;
    expect(rows.map((x) => [x.target_id, x.detail["provider"]])).toEqual([
      [cardCid, "line"],
      [refCid, "line"],
      [refCid, "google"],
      [mailCid, "line"],
    ]);
    expect(rows.every((x) => x.actor_kind === "user" && x.actor_id === f.ownerId)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/U0{20}/);
    const n = rows.length;
    const fresh = await asService(async (c) => (await c.query<{ r: { ok: boolean; created: boolean } }>("select member_oauth_login($1, 'line', $2, null, false, null, null) as r", [f.shopId, uid(50)])).rows[0]!.r);
    expect(fresh).toMatchObject({ ok: true, created: true });
    expect((await getPool().query("select count(*)::int as n from audit_log where action = 'customer.identity_imported'")).rows[0]!.n).toBe(n);
  });

  it("結んだ後の初めての LINE のログインは、新しい会員を作らずにその会員に入る", async () => {
    const before = (await getPool().query("select count(*)::int as n from customers where shop_id = $1", [f.shopId])).rows[0]!.n as number;
    const r = await asService(async (c) => (await c.query<{ r: { ok: boolean; customer_id: string; created: boolean } }>("select member_oauth_login($1, 'line', $2, null, false, null, null) as r", [f.shopId, uid(1)])).rows[0]!.r);
    expect(r).toMatchObject({ ok: true, customer_id: cardCid, created: false });
    expect((await getPool().query("select count(*)::int as n from customers where shop_id = $1", [f.shopId])).rows[0]!.n).toBe(before);
  });

  it("会員の詳細の「LINE・Google の連携」: 種類だけ・項目 customers", async () => {
    const staff = await member("mii-staff2@example.com", "member", ["customers"]);
    const nope = await member("mii-staff3@example.com", "member", ["orders"]);
    const read = (who: string) => asUser(who, async (c) => (await c.query<{ r: string[] }>("select customer_login_providers($1, $2) as r", [f.shopId, refCid])).rows[0]!.r);
    expect(await read(staff)).toEqual(["google", "line"]);
    expect(await expectDbError(() => read(nope))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select customer_login_providers($1, $2)", [f.shopId, refCid])))).toMatch(/permission denied/);
  });

  it("会員が多くても、1 回の呼び出しで会員をまとめて引く（同じ接続で 6 回以上呼んでも索引を使う）", async () => {
    const big = await createShopFixture({ email: "mii-big@example.com", slug: "mii-big", publish: true });
    const pool = getPool();
    await pool.query(`update shops set settings = settings || '{"customer_fields": [{"key": "card_no", "label": "card", "type": "text"}]}' where id = $1`, [big.shopId]);
    await pool.query(
      `insert into customers (shop_id, email, attributes, external_ref)
       select $1, 'big' || g || '@example.com', jsonb_build_object('card_no', 'K' || g), jsonb_build_object('provider', 'crm', 'id', 'E' || g)
         from generate_series(1, 20000) g`,
      [big.shopId],
    );
    await pool.query("analyze customers");
    const rows = (mode: string) => Array.from({ length: 500 }, (_, i) => ({ key: mode === "email" ? `big${i + 1}@example.com` : mode === "external_ref" ? `E${i + 1}` : `K${i + 1}`, line: uid(100000 + i) }));
    await asUser(big.ownerId, async (c) => {
      for (const [mode, key] of [["email", null], ["external_ref", "crm"], ["attribute", "card_no"]] as const) {
        for (let n = 0; n < 7; n++) {
          const t0 = Date.now();
          const r = (await c.query<{ r: Result }>("select member_identities_import($1, $2, $3, $4::jsonb, true) as r", [big.shopId, mode, key, JSON.stringify(rows(mode))])).rows[0]!.r;
          expect(r.counts["linked"]).toBe(500);
          expect(Date.now() - t0).toBeLessThan(2000);
        }
      }
    });
  }, 120_000);
});
