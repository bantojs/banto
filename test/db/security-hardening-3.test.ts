import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0089_security_hardening_3: 守りの締め直し 3。
 * 「できる」と「できない」の両方を、攻撃側の役割（anon・項目の少ないスタッフ・連携に結んだトークン・PostgREST の直接の書き込み）から確かめる。
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し 3（0089_security_hardening_3）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let settingsOnly: string;
  let contentOnly: string;
  let supportOnly: string;
  let intOnly: string;
  let ep: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const invite = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
    await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    return uid;
  };
  const issue = async (uid: string, scopes: string[], endpoint: string | null = null) => {
    const raw = `banto_${randomUUID()}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, endpoint_id) values ($1, $2, 't', $3, $4, $5, $6)", [f.shopId, uid, hash(raw), raw.slice(0, 12), scopes, endpoint]));
    return hash(raw);
  };
  const createInquiry = (input: J, ip = `ip-${Math.random()}`) =>
    rpc<J>("inquiry_create", [f.shopId, JSON.stringify(input), hash(`link-${Math.random()}`), hash(ip)]);
  const auditCount = async (action: string) => (await getPool().query<{ n: number }>("select count(*)::int as n from audit_log where action = $1", [action])).rows[0]!.n;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "h3-owner@example.com", slug: "h3-shop", publish: true, stock: 150 });
    other = await createShopFixture({ email: "h3-other@example.com", slug: "h3-other", publish: true, stock: 3 });
    const pool = getPool();
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await pool.query(
      "update shops set settings = settings || '{\"modules\":{\"inquiries\":true},\"members_enabled\":true,\"contact_email\":\"shop@example.com\"}'::jsonb where id = $1",
      [f.shopId],
    );
    await pool.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    settingsOnly = await invite("h3-settings@example.com", ["settings"]);
    contentOnly = await invite("h3-content@example.com", ["content"]);
    supportOnly = await invite("h3-support@example.com", ["support"]);
    intOnly = await invite("h3-int@example.com", ["integrations", "apps"]);
    ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'ext', 'https://vendor.example/hooks', '{order.shipped}', 'ext') returning id", [f.shopId]))).rows[0]!.id;
  });
  afterAll(closePool);

  // ---------- 1. 在庫 ----------
  it("在庫: anon は inventory を読めず、product_public_stock が公開中のショップ・商品の SKU だけ 0〜99 で返す", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select sku_id, available from inventory where sku_id = $1", [f.skuId])))).toMatch(/permission denied/);
    const stock = (shop: string, ids: string[]) => asAnon((c) => c.query<{ sku_id: string; available: number }>("select * from product_public_stock($1, $2)", [shop, ids]));
    expect((await stock(f.shopId, [f.skuId])).rows).toEqual([{ sku_id: f.skuId, available: 99 }]);
    expect((await stock(other.shopId, [other.skuId])).rows).toEqual([{ sku_id: other.skuId, available: 3 }]);
    // 他ショップの SKU・非公開の商品・非公開のショップは返らない
    expect((await stock(f.shopId, [other.skuId])).rows).toEqual([]);
    await getPool().query("update products set published = false where id = $1", [other.productId]);
    expect((await stock(other.shopId, [other.skuId])).rows).toEqual([]);
    await getPool().query("update products set published = true where id = $1", [other.productId]);
    await getPool().query("update shops set published = false where id = $1", [other.shopId]);
    expect((await stock(other.shopId, [other.skuId])).rows).toEqual([]);
    await getPool().query("update shops set published = true where id = $1", [other.shopId]);
    await getPool().query("update inventory set available = 0 where sku_id = $1", [other.skuId]);
    expect((await stock(other.shopId, [other.skuId])).rows).toEqual([{ sku_id: other.skuId, available: 0 }]);
    await getPool().query("update inventory set available = 3 where sku_id = $1", [other.skuId]);
    expect((await stock(f.shopId, [])).rows).toEqual([]);
    expect(await expectDbError(() => stock(f.shopId, Array.from({ length: 201 }, () => randomUUID())))).toMatch(/too_many_skus/);
  });

  // ---------- 2. お問い合わせ ----------
  it("お問い合わせ: 他人のアドレスで未確認のチケットを作っても、本人（会員・ゲスト）の枠は埋まらない。未確認は 24 時間に 3 件で、超えたら行を作らず同じ形", async () => {
    const memberId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'victim@example.com', '被害者') returning id", [f.shopId])).rows[0]!.id;
    const spam = async () => createInquiry({ basis: "form", category: "other", body: "spam", email: "Victim@example.com" }, "attacker-ip");
    for (let i = 0; i < 3; i++) expect(await spam()).toMatchObject({ verified: false, kind: "verify", send: true });
    for (let i = 0; i < 3; i++) {
      const r = await spam();
      expect(r).toMatchObject({ verified: false, kind: "verify", send: false, number: null, notify: null, to: "victim@example.com", mail_from: "Shop <shop@example.com>" });
      expect(typeof r.id).toBe("string");
    }
    const rows = async () => (await getPool().query("select id from inquiries where shop_id = $1 and contact_email = 'victim@example.com'", [f.shopId])).rows.length;
    expect(await rows()).toBe(3);
    expect((await getPool().query("select count(*)::int as n from inquiry_mails where shop_id = $1 and kind = 'verify'", [f.shopId])).rows[0]!.n).toBe(3);
    // 本人（会員）は作れる（未確認は数えない）。ゲストとしては未確認の枠（24 時間）が明けてから
    const mine = await createInquiry({ basis: "member", category: "order", body: "注文について", customer_id: memberId, epoch: 0 }, "victim-ip");
    expect(mine).toMatchObject({ verified: true, kind: "created" });
    expect(await createInquiry({ basis: "form", category: "other", body: "質問です", email: "victim@example.com" }, "victim-ip-2")).toMatchObject({ send: false, number: null });
    await getPool().query("update inquiries set created_at = now() - interval '25 hours' where shop_id = $1 and contact_email = 'victim@example.com' and email_verified_at is null", [f.shopId]);
    const guest = await createInquiry({ basis: "form", category: "other", body: "質問です", email: "victim@example.com" }, "victim-ip-2");
    expect(guest).toMatchObject({ verified: false, kind: "verify", send: true });
    expect(await rows()).toBe(5);
    // 未確認のまま 7 日で消える（30 日を待たない）
    await getPool().query("update inquiries set created_at = now() - interval '8 days' where shop_id = $1 and contact_email = 'victim@example.com' and email_verified_at is null and id <> $2", [f.shopId, guest.id]);
    expect(await rpc<number>("mask_inquiries", [180])).toBeGreaterThanOrEqual(3);
    expect(await rows()).toBe(2);
  });

  // ---------- 3. hooks の送信先 ----------
  it("hooks: 私設のアドレス・localhost・社内の名前の送信先は直接の INSERT / UPDATE でも復元でも入らない。外部の行を同梱の内部 URL に変えられない", async () => {
    const insert = (url: string) => asUser(intOnly, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', $2, '{order.paid}')", [f.shopId, url]));
    for (const url of [
      "http://10.0.0.5:8080/admin/", "http://172.16.1.1/", "http://192.168.1.1/x", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://0.0.0.0/",
      "http://localhost/", "http://api.localhost/", "http://metadata.internal/latest", "http://nas.local/", "http://printer.home.arpa/", "http://x.lan/",
      "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[::ffff:10.0.0.5]/", "http://[::ffff:a00:5]/", "http://user@10.0.0.5/", "http://999.1.1.1/", "http://2130706433/", "http://127.1/", "http://0x7f.1/", "http://10.0.0.5./", "ftp://x.example/",
    ]) {
      expect(await expectDbError(() => insert(url)), url).toMatch(/invalid_url/);
    }
    for (const url of ["https://vendor.example/hooks2", "http://203.0.113.9/hook", "http://[2001:db8::1]/hook", "https://a.example:8443/x?y=1"]) {
      await insert(url);
    }
    await asUser(f.ownerId, (c) => c.query("delete from hook_endpoints where shop_id = $1 and name = 'x'", [f.shopId]));
    // 更新でも同じ。外部として登録した行は同梱の内部 URL に変えられない
    expect(await expectDbError(() => asUser(intOnly, (c) => c.query("update hook_endpoints set url = 'http://10.0.0.5/hook' where id = $1", [ep])))).toMatch(/invalid_url/);
    expect(await expectDbError(() => asUser(intOnly, (c) => c.query("update hook_endpoints set url = 'https://banto.invalid/plugins/komoju' where id = $1", [ep])))).toMatch(/invalid_url/);
    // 同梱の行は作れる（プラグインの有効化）し、同梱の行の更新（ON / OFF）は通る
    const bundled = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'komoju', 'https://banto.invalid/plugins/komoju', '{}') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = false where id = $1", [bundled]));
    await asUser(f.ownerId, (c) => c.query("delete from hook_endpoints where id = $1", [bundled]));
    // 復元（service_role）も URL の検査を通る（同梱の URL は通す）
    const dst = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'h3-dst', 'Dst') returning id", [f.ownerId])).rows[0]!.id);
    const restore = (endpoints: J[]) => rpc<J>("restore_shop_data", [dst, JSON.stringify({ hook_endpoints: endpoints })]);
    expect(await expectDbError(() => restore([{ name: "bad", url: "http://metadata.internal/latest", events: [] }]))).toMatch(/invalid_url/);
    expect(await restore([{ name: "mail", url: "https://banto.invalid/plugins/email_resend", events: [] }, { name: "crm", url: "https://crm.example/hook", events: ["order.paid"] }])).toMatchObject({ hook_endpoints: 2 });
  });

  // ---------- 4. shops の列 ----------
  it("shops: settings の項目では option_axes を変えられず、採番と判定の列（order_seq / tryon_seq / inquiry_seq / legal_links_state / theme_version_id）は運営者の JWT から書けない", async () => {
    expect(await expectDbError(() => asUser(settingsOnly, (c) => c.query("update shops set option_axes = '[]' where id = $1", [f.shopId])))).toMatch(/admin_required/);
    await asUser(f.ownerId, (c) => c.query("update shops set option_axes = '[]' where id = $1", [f.shopId]));
    await asUser(f.ownerId, (c) => c.query("update shops set option_axes = null where id = $1", [f.shopId]));
    for (const col of ["order_seq = 0", "tryon_seq = 0", "inquiry_seq = 0", "legal_links_state = '{}'", "theme_version_id = null"]) {
      expect(await expectDbError(() => asUser(settingsOnly, (c) => c.query(`update shops set ${col} where id = $1`, [f.shopId]))), col).toMatch(/permission denied/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query(`update shops set ${col} where id = $1`, [f.shopId]))), col).toMatch(/permission denied/);
    }
    // 名前・設定は今までどおり
    expect((await asUser(settingsOnly, (c) => c.query("update shops set name = 'renamed', settings = settings || '{\"notice\":\"hi\"}' where id = $1 returning id", [f.shopId]))).rows).toHaveLength(1);
    // 受付番号は採番が続く
    const r = await createInquiry({ basis: "form", category: "other", body: "q", email: "seq@example.com" });
    expect(r.number).toBeGreaterThan(0);
  });

  // ---------- 5. custom.v1 ----------
  it("custom.v1: スキームの途中にタブ・改行を挟んだ javascript: も受けない", async () => {
    const normalize = (data: unknown) => getPool().query<{ r: J }>("select banto_app_data_normalize('custom.v1', $1::jsonb) as r", [JSON.stringify(data)]).then((r) => r.rows[0]!.r);
    for (const link of ["javascript:alert(1)", "jav\tascript:alert(1)", "java\nscript:alert(1)", "java\r\nscript:alert(1)", " \u0001jav\tascript:alert(1)", "DATA\n:text/html", "vb\tscript:x", "fi\rle:///etc/passwd"]) {
      expect(await expectDbError(() => normalize({ link })), JSON.stringify(link)).toMatch(/invalid_app_data_url/);
    }
    expect(await normalize({ note: "a\tb\nc", link_url: "https://a.example/x" })).toEqual({ note: "a\tb\nc", link_url: "https://a.example/x" });
    expect(await expectDbError(() => normalize({ link_url: "jav\tascript:alert(1)" }))).toMatch(/invalid_app_data_url/);
  });

  // ---------- 6・7. 注文照会 ----------
  it("注文照会: 会員の注文は番号とアドレスでは開けない。外れはアドレスごと・ショップ全体でも数える（IP が無くても上限が効く）", async () => {
    const memberId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'member-o@example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    const order = async (email: string, customer?: string) => {
      const rid = await rpc<string>("reserve_stock", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])]);
      await rpc("attach_reservation_customer", [rid, f.shopId, JSON.stringify({ customer_email: email, customer_name: "買い手", shipping_address: { state: "東京都" }, shipping_jpy: 0, ...(customer ? { customer_id: customer, customer_epoch: 0 } : {}) })]);
      const oid = await rpc<string>("confirm_reservation", [rid, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${rid}`, amount_paid_jpy: 3000, currency: "jpy" })]);
      return (await getPool().query<{ number: number }>("select number from orders where id = $1", [oid])).rows[0]!.number;
    };
    const lookup = (number: number, email: string, ip: string | null, emailHash: string | null = hash(email.toLowerCase())) =>
      rpc<J | null>("order_lookup", [f.shopId, number, email, ip ? hash(ip) : null, emailHash]);
    const memberNo = await order("member-o@example.com", memberId);
    const guestNo = await order("guest-o@example.com");
    expect(await rpc<J | null>("lookup_order", [f.shopId, memberNo, "member-o@example.com"])).toBeNull();
    expect(await lookup(memberNo, "member-o@example.com", "198.51.100.1")).toBeNull();
    expect(await lookup(guestNo, "guest-o@example.com", "198.51.100.1")).toMatchObject({ number: guestNo, status: "paid" });
    expect(await rpc<J>("member_order", [f.shopId, memberId, 0, memberNo])).toMatchObject({ number: memberNo });
    // 4 引数の呼び方（Worker の古い形）もそのまま
    expect(await rpc<J | null>("order_lookup", [f.shopId, guestNo, "guest-o@example.com", null])).toMatchObject({ number: guestNo });

    // IP が無くても、同じアドレスでの外れは 1 時間に 20 回まで
    await getPool().query("delete from order_lookup_failures");
    for (let n = 5000; n < 5020; n++) expect(await lookup(n, "victim-o@example.com", null)).toBeNull();
    expect(await expectDbError(() => lookup(5020, "victim-o@example.com", null))).toMatch(/too_many_requests/);
    expect((await getPool().query("select count(*)::int as n from order_lookup_failures where email_hash = $1", [hash("victim-o@example.com")])).rows[0]!.n).toBe(20);
    // 合った照会は数えない。別のアドレスは別の枠
    expect(await lookup(guestNo, "guest-o@example.com", null)).toMatchObject({ number: guestNo });
    expect(await lookup(5021, "other-o@example.com", null)).toBeNull();
    // ショップ全体で 1 時間に 200 回（設定で変えられる）
    await getPool().query(`update shops set settings = settings || '{"order_lookup":{"per_hour":"25"}}'::jsonb where id = $1`, [f.shopId]);
    for (let n = 6000; n < 6004; n++) expect(await lookup(n, `v${n}@example.com`, null)).toBeNull();
    expect(await expectDbError(() => lookup(6004, "v6004@example.com", null))).toMatch(/too_many_requests/);
    await getPool().query(`update shops set settings = settings - 'order_lookup' where id = $1`, [f.shopId]);
    await getPool().query("delete from order_lookup_failures");
  });

  // ---------- 8. 無効にした連携 ----------
  it("無効にした連携は「つなぐ」もプラグインのデータの書き込みもできない", async () => {
    const tok = await issue(f.ownerId, ["app_data:write"], ep);
    await rpc("api_app_data_set", [tok, f.productId, "custom.v1", JSON.stringify({ a: 1 }), true, "k"]);
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = false where id = $1", [ep]));
    expect(await expectDbError(() => rpc("api_app_data_set", [tok, f.productId, "custom.v1", JSON.stringify({ a: 2 }), true, "k"]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => rpc("api_app_data_list", [tok, null, 50, 0]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select app_connect_begin($1, $2, $3, $4)", [f.shopId, ep, ["shop:read"], hash("t-disabled")])))).toMatch(/not_found/);
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = true where id = $1", [ep]));
    await rpc("api_app_data_set", [tok, f.productId, "custom.v1", JSON.stringify({ a: 3 }), true, "k"]);
    await asUser(f.ownerId, (c) => c.query("select app_connect_begin($1, $2, $3, $4)", [f.shopId, ep, ["shop:read"], hash("t-enabled")]));
  });

  // ---------- 9・10・11・14. ページ・ブログ ----------
  it("ページ・ブログ: モジュールが OFF なら anon は公開中の行も読めない。アイキャッチは置き場の形だけ。物理削除は blog_delete と Cron だけ。検索語の % と _", async () => {
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true,\"pages\":false,\"blog\":false}}'::jsonb where id = $1", [f.shopId]);
    const pid = (await asUser(contentOnly, (c) => c.query<{ id: string }>("insert into pages (shop_id, handle, title, body, published) values ($1, 'plan', '来季の計画', '本文', true) returning id", [f.shopId]))).rows[0]!.id;
    const blogId = (await asUser(contentOnly, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'notes', 'メモ') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(contentOnly, (c) => c.query("insert into articles (shop_id, blog_id, handle, title, body, published) values ($1, $2, 'a1', '記事', '本文', true)", [f.shopId, blogId]));
    const anonCount = async (table: string) => (await asAnon((c) => c.query(`select 1 from ${table} where shop_id = $1`, [f.shopId]))).rows.length;
    expect(await anonCount("pages")).toBe(0);
    expect(await anonCount("blogs")).toBe(0);
    expect(await anonCount("articles")).toBe(0);
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true,\"pages\":true,\"blog\":true}}'::jsonb where id = $1", [f.shopId]);
    expect(await anonCount("pages")).toBe(1);
    expect(await anonCount("blogs")).toBe(1);
    expect(await anonCount("articles")).toBe(1);
    // content の人は OFF でも読める（編集の画面）
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true,\"pages\":false,\"blog\":false}}'::jsonb where id = $1", [f.shopId]);
    expect((await asUser(contentOnly, (c) => c.query("select 1 from pages where shop_id = $1", [f.shopId]))).rows).toHaveLength(1);
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true,\"pages\":true,\"blog\":true}}'::jsonb where id = $1", [f.shopId]);

    // アイキャッチ
    const setImage = (table: string, url: string) => asUser(contentOnly, (c) => c.query(`update ${table} set image_url = $2 where shop_id = $1`, [f.shopId, url]));
    for (const table of ["pages", "articles"]) {
      expect(await expectDbError(() => setImage(table, "https://tracker.example/pixel.png?x=1")), table).toMatch(/check constraint/);
      expect(await expectDbError(() => setImage(table, "https://media.example/products/x.webp")), table).toMatch(/check constraint/);
      expect(await expectDbError(() => setImage(table, `https://media.example/pages/${f.shopId}/x.webp?x=1`)), table).toMatch(/check constraint/);
      await setImage(table, `https://media.example/pages/${f.shopId}/x.webp`);
      await setImage(table, `https://cdn.example/media/pages/${f.shopId}/y.webp`);
      await setImage(table, `/media/pages/${f.shopId}/z.webp`);
    }
    const tok = await issue(f.ownerId, ["content:read", "content:write"]);
    expect(await expectDbError(() => rpc("api_page_save", [tok, JSON.stringify({ id: pid, image_url: "https://evil.example/x.png" })]))).toMatch(/invalid_image_url/);
    expect(await expectDbError(() => rpc("api_article_save", [tok, "notes", JSON.stringify({ handle: "a1", image_url: "https://evil.example/x.png" })]))).toMatch(/invalid_image_url/);
    expect(await rpc<J>("api_page_save", [tok, JSON.stringify({ id: pid, image_url: `/media/pages/${f.shopId}/ok.webp` })])).toMatchObject({ image_url: `/media/pages/${f.shopId}/ok.webp` });

    // 検索語の % と _ はそのままの文字として探す
    await rpc("api_page_save", [tok, JSON.stringify({ handle: "percent", title: "100% cotton" })]);
    await rpc("api_page_save", [tok, JSON.stringify({ handle: "under", title: "a_b" })]);
    const titles = async (q: string) => ((await rpc<{ items: J[] }>("api_pages_list", [tok, "all", q, 50, 0])).items.map((p) => p["title"]) as string[]).sort();
    expect(await titles("%")).toEqual(["100% cotton"]);
    expect(await titles("_")).toEqual(["a_b"]);
    expect(await titles("a_b")).toEqual(["a_b"]);
    const arts = async (q: string) => (await rpc<{ items: J[] }>("api_articles_list", [tok, "notes", "all", q, null, 50, 0])).items.length;
    expect(await arts("%")).toBe(0);
    expect(await arts("記事")).toBe(1);

    // 物理削除
    expect(await expectDbError(() => asUser(contentOnly, (c) => c.query("delete from pages where id = $1", [pid])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("delete from articles where shop_id = $1", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("delete from blogs where id = $1", [blogId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(settingsOnly, (c) => c.query("select blog_delete($1, $2)", [f.shopId, blogId])))).toMatch(/blog_not_found/);
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select blog_delete($1, $2)", [other.shopId, blogId])))).toMatch(/blog_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select blog_delete($1, $2)", [f.shopId, blogId])))).toMatch(/permission denied/);
    await asUser(contentOnly, (c) => c.query("select blog_delete($1, $2)", [f.shopId, blogId]));
    expect((await getPool().query("select 1 from blogs where id = $1", [blogId])).rows).toHaveLength(0);
    expect((await getPool().query("select 1 from articles where blog_id = $1", [blogId])).rows).toHaveLength(0);
    // ゴミ箱と purge は今までどおり
    await asUser(contentOnly, (c) => c.query("update pages set deleted_at = now() - interval '31 days' where id = $1", [pid]));
    expect(await rpc<number>("pages_purge_trash", [30])).toBeGreaterThanOrEqual(1);
    expect((await getPool().query("select 1 from pages where id = $1", [pid])).rows).toHaveLength(0);
  });

  // ---------- 12. 監査ログ ----------
  it("監査ログ: inquiry_delete・mask_customer・テーマの版の settings / complete・AI 用トークンの削除（連携を消した連鎖を含む）。個人情報は入れない", async () => {
    const r = await createInquiry({ basis: "form", category: "other", body: "q", email: "del-h3@example.com" });
    await asUser(supportOnly, (c) => c.query("select inquiry_delete($1)", [r.id]));
    const del = (await getPool().query<{ shop_id: string; actor_id: string; target_id: string; detail: J }>("select shop_id, actor_id, target_id, detail from audit_log where action = 'inquiry.deleted'")).rows;
    expect(del).toEqual([{ shop_id: f.shopId, actor_id: supportOnly, target_id: r.id, detail: { number: r.number } }]);

    await createInquiry({ basis: "form", category: "other", body: "q", email: "mask-h3@example.com" });
    await asUser(f.ownerId, (c) => c.query("select mask_customer($1, 'Mask-h3@example.com')", [f.shopId]));
    const masked = (await getPool().query<{ target_id: string; detail: J }>("select target_id, detail from audit_log where action = 'customer.masked'")).rows;
    expect(masked).toHaveLength(1);
    expect(masked[0]!.target_id).toMatch(/^[0-9a-f]{16}$/);
    expect(masked[0]!.detail).toMatchObject({ email_hash: masked[0]!.target_id, inquiries: 1, orders: 0 });
    expect(JSON.stringify((await getPool().query("select * from audit_log")).rows)).not.toContain("@example.com");

    const vid = randomUUID();
    await asUser(f.ownerId, (c) => c.query("select theme_version_create($1, $2, 'v', 10, 1)", [f.shopId, vid]));
    await asUser(f.ownerId, (c) => c.query("select theme_version_set_settings($1, $2, '{\"color\":\"red\"}')", [f.shopId, vid]));
    await asUser(f.ownerId, (c) => c.query("select theme_version_complete($1, $2)", [f.shopId, vid]));
    await asUser(f.ownerId, (c) => c.query("select theme_version_complete($1, $2)", [f.shopId, vid])); // 変わらなければ書かない
    const theme = (await getPool().query<{ target_id: string; detail: J }>("select target_id, detail from audit_log where action = 'shop.theme_version_updated' order by id")).rows;
    expect(theme.map((t) => t.detail)).toEqual([
      expect.objectContaining({ name: "v", settings_changed: true, complete_changed: false, complete: false, live: false }),
      expect.objectContaining({ name: "v", settings_changed: false, complete_changed: true, complete: true, live: false }),
    ]);
    expect(theme.every((t) => t.target_id === vid)).toBe(true);

    const before = await auditCount("api_token.deleted");
    await issue(f.ownerId, ["shop:read"], ep);
    const tokId = (await getPool().query<{ id: string }>("select id from api_tokens where endpoint_id = $1 order by created_at desc limit 1", [ep])).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("delete from hook_endpoints where id = $1", [ep]));
    expect(await auditCount("api_token.deleted")).toBeGreaterThan(before);
    const d = (await getPool().query<{ shop_id: string; detail: J }>("select shop_id, detail from audit_log where action = 'api_token.deleted' and target_id = $1", [tokId])).rows[0]!;
    expect(d.shop_id).toBe(f.shopId);
    expect(d.detail).toMatchObject({ name: "t", endpoint_id: ep, revoked: false });
    expect(JSON.stringify(d.detail)).not.toMatch(/[0-9a-f]{64}/);
  });

  // ---------- 13. 担当者 ----------
  it("担当者: 一覧と 1 件の assignee は user_id と label（メールの @ より前）だけ。メールアドレスは出ない", async () => {
    const list = await asUser(supportOnly, async (c) => (await c.query<{ r: J[] }>("select inquiry_assignees($1) as r", [f.shopId])).rows[0]!.r);
    expect(list).toContainEqual({ user_id: supportOnly, label: "h3-support" });
    expect(list).toContainEqual({ user_id: f.ownerId, label: "h3-owner" });
    expect(list.map((x) => Object.keys(x).sort())).toEqual(list.map(() => ["label", "user_id"]));
    expect(JSON.stringify(list)).not.toContain("@");
    const r = await createInquiry({ basis: "form", category: "other", body: "q", email: "assign-h3@example.com" });
    await asUser(f.ownerId, (c) => c.query("select inquiry_assign($1, $2)", [r.id, supportOnly]));
    const tok = await issue(f.ownerId, ["inquiries:read"]);
    const got = await rpc<J>("api_inquiry_get", [tok, r.number]);
    expect(got.assignee).toEqual({ user_id: supportOnly, label: "h3-support" });
    expect(JSON.stringify(got)).not.toContain("h3-support@example.com");
    const api = await rpc<J[]>("api_inquiry_assignees", [tok]);
    expect(api).toContainEqual({ user_id: supportOnly, label: "h3-support" });
    expect(JSON.stringify(api)).not.toContain("@");
  });
});
