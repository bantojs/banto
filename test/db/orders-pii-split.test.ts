import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0173_orders_pii_split: 購入者の個人情報のスコープを分ける。
 * orders:contact = メール・電話、orders:address = 氏名・お届け先、orders:pii = 両方と社内のメモ・お問い合わせの添付（今までどおり）。
 */
describe.skipIf(!dbAvailable)("購入者の個人情報のスコープを分ける（0173_orders_pii_split）", () => {
  let a: Fixture;
  let orgId: string;
  let orderId: string;
  // 決まった鍵のほかに、電話・メール・会社名などの鍵が混じっていても orders:address では返さない
  const addr = { name: "山田 太郎", postal_code: "100-0001", country: "JP", state: "東京都", city: "千代田区", line1: "1-1", line2: null, phone: "03-0000-0000", email: "addr@example.com", tel: "090-0000-0000", company: "山田商店" };

  const rpc = <T = J>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  function issue(uid: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    return asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, uid, hash, raw.slice(0, 12), scopes])).then(() => hash);
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ps-a@example.com", slug: "ps-a", publish: true });
    const pool = getPool();
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await pool.query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true},\"contact_email\":\"shop@example.com\"}'::jsonb where id = $1", [a.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [a.shopId]);
    orderId = (await pool.query<{ id: string }>(
      "insert into orders (shop_id, total_jpy, number, customer_email, customer_name, shipping_address, note) values ($1, 1000, 7001, 'buyer@example.com', '山田 太郎', $2::jsonb, 'メモ') returning id",
      [a.shopId, JSON.stringify(addr)],
    )).rows[0]!.id;
  });
  afterAll(closePool);

  it("注文の customer はスコープの組み合わせで分かれる。メモは orders:pii だけ", async () => {
    const cases: [string[], J, boolean][] = [
      [[], { masked: true, prefecture: "東京都" }, false],
      [["orders:contact"], { name: "山田 太郎", email: "buyer@example.com", phone: "03-0000-0000", prefecture: "東京都" }, false],
      [["orders:address"], { name: "山田 太郎", shipping_address: { name: "山田 太郎", postal_code: "100-0001", country: "JP", state: "東京都", city: "千代田区", line1: "1-1" } }, false],
      [["orders:contact", "orders:address"], { email: "buyer@example.com", name: "山田 太郎", shipping_address: addr }, false],
      // orders:pii は今までどおり（両方とメモ）
      [["orders:pii"], { email: "buyer@example.com", name: "山田 太郎", shipping_address: addr }, true],
      [["orders:pii", "orders:contact"], { email: "buyer@example.com", name: "山田 太郎", shipping_address: addr }, true],
    ];
    for (const [extra, customer, note] of cases) {
      const tok = await issue(a.ownerId, ["orders:read", ...extra]);
      const o = await rpc("api_order_get", [tok, orderId]);
      expect(o["customer"], extra.join(",")).toEqual(customer);
      if (extra.length === 1 && extra[0] === "orders:address") expect(JSON.stringify(o)).not.toMatch(/addr@example|090-0000|山田商店|03-0000/);
      if (note) expect(o["note"]).toBe("メモ");
      else expect(o, extra.join(",")).not.toHaveProperty("note");
      const list = await rpc<{ items: J[]; pii: boolean; pii_parts: J }>("api_orders_list", [tok]);
      expect(list.items[0]!["customer"]).toEqual(customer);
      const c = extra.includes("orders:contact") || extra.includes("orders:pii");
      const ad = extra.includes("orders:address") || extra.includes("orders:pii");
      expect(list.pii).toBe(c && ad);
      expect(list.pii_parts).toEqual({ contact: c, address: ad, note });
    }
  });

  it("一覧の検索: メールは orders:contact、氏名は orders:contact か orders:address があるときだけ", async () => {
    const list = async (scopes: string[], q: string) => (await rpc<{ total: number }>("api_orders_list", [await issue(a.ownerId, ["orders:read", ...scopes]), null, null, null, 50, 0, q])).total;
    expect(await list(["orders:contact"], "buyer@")).toBe(1);
    expect(await list(["orders:contact"], "山田")).toBe(1);
    expect(await list(["orders:address"], "山田")).toBe(1);
    expect(await list(["orders:address"], "buyer@")).toBe(0);
    expect(await list(["orders:pii"], "buyer@")).toBe(1);
    expect(await list(["orders:pii"], "山田")).toBe(1);
    expect(await list([], "buyer@")).toBe(0);
    // 番号はいつも
    expect(await list([], "7001")).toBe(1);
  });

  it("メモを書くのは orders:pii だけ（contact・address の両方でも断る）", async () => {
    const both = await issue(a.ownerId, ["orders:read", "orders:write", "orders:contact", "orders:address"]);
    expect(await expectDbError(() => rpc("api_order_annotate", [both, orderId, null, null, null, "x", true]))).toMatch(/pii_scope_required/);
    const r = await rpc("api_order_annotate", [both, orderId, ["印"], null, null, null, false]);
    expect(r).not.toHaveProperty("note");
    expect(r["customer"]).toMatchObject({ email: "buyer@example.com", name: "山田 太郎" });
  });

  it("お店で試着: 名前・メール・電話は orders:contact、名前は orders:address でも、自由記入は orders:pii だけ", async () => {
    const pool = getPool();
    const store = (await pool.query<{ id: string }>("insert into stores (org_id, name) values ($1, '本店') returning id", [orgId])).rows[0]!.id;
    await pool.query("insert into tryon_requests (shop_id, store_id, number, customer_email, customer_name, customer_phone, note) values ($1, $2, 1, 't@example.com', '試着', '090-1111-1111', '自由記入')", [a.shopId, store]);
    const get = async (scopes: string[]) => rpc("api_tryon_request_get", [await issue(a.ownerId, ["orders:read", ...scopes]), 1]);
    expect(await get([])).not.toHaveProperty("customer");
    expect((await get(["orders:contact"]))["customer"]).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着" });
    expect((await get(["orders:address"]))["customer"]).toEqual({ name: "試着" });
    expect((await get(["orders:contact", "orders:address"]))["customer"]).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着" });
    expect((await get(["orders:pii"]))["customer"]).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着", note: "自由記入" });
    const list = await rpc<{ items: J[]; pii: boolean }>("api_tryon_requests_list", [await issue(a.ownerId, ["orders:read", "orders:contact"])]);
    expect(list.items[0]!["customer"]).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着" });
    expect(list.pii).toBe(false);
    expect((await rpc<{ pii: boolean }>("api_tryon_requests_list", [await issue(a.ownerId, ["orders:read", "orders:pii"])])).pii).toBe(true);
  });

  it("お問い合わせ: メールと名前は orders:contact、名前は orders:address でも、添付のファイル名と中身は orders:pii だけ", async () => {
    const r = await asService(async (c) => (await c.query<{ r: { id: string; number: number } }>("select inquiry_create($1, $2::jsonb, $3, $4) as r",
      [a.shopId, JSON.stringify({ basis: "form", category: "other", body: "質問", email: "q@example.com", name: "質問者" }), sha("link-ps"), sha("ip-ps")])).rows[0]!.r);
    const writer = await issue(a.ownerId, ["inquiries:read", "inquiries:write"]);
    await rpc("api_inquiry_reply", [writer, r.number, "添付です", sha("ps-att"), JSON.stringify([{ key: `inq/${a.shopId}/${"a".repeat(21)}`, filename: "手順.pdf", content_type: "application/pdf", size: 1000 }])]);
    const attId = (await getPool().query<{ id: string }>("select id from inquiry_attachments where inquiry_id = $1", [r.id])).rows[0]!.id;

    const contact = await issue(a.ownerId, ["inquiries:read", "orders:contact"]);
    const pii = await issue(a.ownerId, ["inquiries:read", "orders:pii"]);
    const viaContact = await rpc<J & { messages: { attachments: J[] }[] }>("api_inquiry_get", [contact, r.number]);
    expect(viaContact["contact"]).toEqual({ email: "q@example.com", name: "質問者" });
    expect(viaContact.messages.at(-1)!.attachments[0]).not.toHaveProperty("filename");
    const viaPii = await rpc<J & { messages: { attachments: J[] }[] }>("api_inquiry_get", [pii, r.number]);
    expect(viaPii["contact"]).toEqual({ email: "q@example.com", name: "質問者" });
    expect(viaPii.messages.at(-1)!.attachments[0]).toMatchObject({ filename: "手順.pdf" });
    expect((await rpc("api_inquiry_get", [await issue(a.ownerId, ["inquiries:read", "orders:address"]), r.number]))["contact"]).toEqual({ name: "質問者" });
    expect(await rpc("api_inquiry_get", [await issue(a.ownerId, ["inquiries:read"]), r.number])).not.toHaveProperty("contact");
    const list = await rpc<{ items: J[] }>("api_inquiries_list", [contact]);
    expect(list.items.find((x) => x["number"] === r.number)!["contact"]).toEqual({ email: "q@example.com", name: "質問者" });

    expect(await expectDbError(() => rpc("api_inquiry_attachment_get", [contact, r.number, attId]))).toMatch(/pii_scope_required/);
    expect(await rpc("api_inquiry_attachment_get", [pii, r.number, attId])).toMatchObject({ filename: "手順.pdf" });
  });

  it("発行者の項目: orders:contact・orders:address は customers を持つ人だけ", async () => {
    const staff = await createAuthUser("ps-staff@example.com");
    await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "ps-staff@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["orders", "integrations"] }]), sha("inv-ps")]));
    await withRole("authenticated", { sub: staff, email: "ps-staff@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha("inv-ps")]));
    for (const s of ["orders:contact", "orders:address", "orders:pii"]) {
      expect(await expectDbError(() => issue(staff, ["orders:read", s])), s).toMatch(/scope|forbidden|permission/);
    }
    await issue(staff, ["orders:read"]);
    // 知らないスコープは表の制約で断る
    expect(await expectDbError(() => issue(a.ownerId, ["orders:phone"]))).toMatch(/api_tokens_scopes_valid|check/);
  });

  it("発行した人が customers を失うと、orders:contact のトークンでもマスクに戻る", async () => {
    const staff = await createAuthUser("ps-staff2@example.com");
    await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "ps-staff2@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["orders", "customers", "integrations"] }]), sha("inv-ps2")]));
    await withRole("authenticated", { sub: staff, email: "ps-staff2@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha("inv-ps2")]));
    const tok = await issue(staff, ["orders:read", "orders:contact"]);
    expect((await rpc("api_order_get", [tok, orderId]))["customer"]).toMatchObject({ email: "buyer@example.com" });
    await getPool().query("update org_member_shops set perms = array['orders','integrations'] where user_id = $1 and shop_id = $2", [staff, a.shopId]);
    expect((await rpc("api_order_get", [tok, orderId]))["customer"]).toEqual({ masked: true, prefecture: "東京都" });
  });

  it("新しい関数は anon・authenticated から呼べない", async () => {
    const fns = [
      "banto_order_pii(text[], text)",
      "api_order_json(orders, boolean, boolean, boolean)",
      "api_inquiry_json(inquiries, boolean, boolean, boolean, boolean)",
      "api_tryon_json(tryon_requests, boolean, boolean, boolean)",
    ];
    for (const fn of fns) {
      for (const role of ["anon", "authenticated"]) {
        const ok = (await getPool().query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).rows[0]!.ok;
        expect(ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
