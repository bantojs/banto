import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { parseIdentityCsv, splitDuplicates } from "../src/routes/admin/customer-identities";

/**
 * 会員の LINE・Google の ID の取り込みの画面（0168、メンテナの決定 2026-11-23）。
 * 引き当て・上書きしない判定・権限・監査ログの DB の正しさは test/db/member-identity-import.test.ts
 */
const UID1 = `U${"1".repeat(32)}`;
const UID2 = `U${"2".repeat(32)}`;

function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { members_enabled: true, customer_fields: [{ key: "card_no", label: "会員カード", type: "text" }] } });
  sb.tables.customers.push({ id: "00000000-0000-4000-a000-000000000001", shop_id: shop.id, email: "hanako@example.com", attributes: { card_no: "C001" }, created_at: "2026-10-01T00:00:00Z" });
  sb.tables.customers.push({ id: "00000000-0000-4000-a000-000000000002", shop_id: shop.id, email: "taro@example.com", attributes: { card_no: "C002" }, created_at: "2026-10-02T00:00:00Z" });
  // customers の項目だけのスタッフ
  const staff = sb.addUser("staff@example.com", "password-123");
  const org = String(shop["org_id"]);
  sb.orgMembers.push({ org_id: org, user_id: staff.id, role: "member", created_at: new Date().toISOString() });
  sb.orgMemberShops.push({ org_id: org, user_id: staff.id, shop_id: shop.id, perms: ["customers"] });
  return { sb, shop, app: appWith(sb) };
}

describe("CSV の読み方", () => {
  it("見出しがあれば列の名前で、無ければ key, line, google の順。行の番号は見出しを含む", () => {
    expect(parseIdentityCsv(`google,key,line\n123,C001,${UID1}\n`)).toEqual({ rows: [{ key: "C001", line: UID1, google: "123" }], lines: [2] });
    expect(parseIdentityCsv(`C001,${UID1}\n C002 ,,456\n`)).toEqual({ rows: [{ key: "C001", line: UID1 }, { key: "C002", google: "456" }], lines: [1, 2] });
    expect(parseIdentityCsv("key,line\n")).toBe("empty");
    expect(parseIdentityCsv(Array.from({ length: 5001 }, (_, i) => `C${i},${UID1}`).join("\n"))).toBe("too_many_rows");
  });
});

describe("CSV の中の重なり", () => {
  it("同じ ID・同じ引く値（メールは大文字小文字を問わない）の 2 つ目からを外す", () => {
    const rows = [
      { key: "A@x.jp", line: UID1 },
      { key: "a@x.jp", line: UID2 },
      { key: "b@x.jp", line: UID1 },
      { key: "c@x.jp", google: "1" },
      { key: "d@x.jp", line: UID2, google: "1" },
    ];
    expect(splitDuplicates(rows, "email")).toEqual({ send: [0, 3], duplicates: [1, 2, 4] });
    expect(splitDuplicates([{ key: "A", line: UID1 }, { key: "a", line: UID2 }], "attribute")).toEqual({ send: [0, 1], duplicates: [] });
  });

  it("同じ会員の LINE と Google が別の行なら両方送る。形の誤った行は後の正しい行を止めない", () => {
    expect(splitDuplicates([{ key: "C001", line: UID1 }, { key: "C001", google: "123" }], "attribute")).toEqual({ send: [0, 1], duplicates: [] });
    expect(splitDuplicates([{ key: "C001", line: "Ubad" }, { key: "C001", line: UID1 }, { key: "C002", line: UID1 }], "attribute")).toEqual({ send: [0, 1], duplicates: [2] });
    expect(splitDuplicates([{ key: "C001", google: "a@b.jp" }, { key: "C001", google: "123" }], "attribute")).toEqual({ send: [0, 1], duplicates: [] });
  });
});

describe("LINE・Google の ID の取り込みの画面", () => {
  it("会員の一覧から入れる。確かめる → 結ぶ。画面に ID を出さず、行の番号と理由だけ", async () => {
    const { sb, shop, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/import/identities`;
    expect(await (await b.get(`/admin/shops/${shop.id}/customers`)).text()).toContain(`href="${base}"`);
    const page = await (await b.get(base)).text();
    expect(page).toContain("会員カード（card_no）");

    const csv = `key,line\nC001,${UID1}\nC404,${UID2}\nC002,bad\n`;
    const check = await (await b.postMultipart(base, { step: "check", match: "attribute", field: "card_no", csv })).text();
    expect(check).toContain("確かめた結果（まだ結んでいません）");
    expect(check).toContain("1 件を結ぶ");
    expect(check).toContain("<td>3</td><td></td><td>会員がいない</td>");
    expect(check).toContain("<td>4</td><td></td><td>形の誤り");
    expect(check.split(UID1).length - 1).toBe(1); // 次の段に渡す CSV（hidden の textarea）の中だけ
    expect(sb.memberIdentities).toHaveLength(0);

    const done = await (await b.post(base, { step: "import", match: "attribute", match_key: "card_no", csv })).text();
    expect(done).toContain("取り込みの結果");
    expect(sb.memberIdentities).toEqual([{ shop_id: shop.id, provider: "line", subject: UID1, customer_id: "00000000-0000-4000-a000-000000000001" }]);
    // もう一度: 変わらない
    const again = await (await b.post(base, { step: "import", match: "attribute", match_key: "card_no", csv })).text();
    expect(again).toContain("もう結ばれている: 1");
  });

  it("引き方の誤り・空の CSV は案内だけ", async () => {
    const { shop, app } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/import/identities`;
    expect(await (await b.postMultipart(base, { step: "check", match: "external_ref", provider: "", csv: `C001,${UID1}` })).text()).toContain("外部の連携先の名前か、独自項目を選んでください。");
    expect(await (await b.postMultipart(base, { step: "check", match: "email", csv: "" })).text()).toContain("CSV に行がありません。");
    expect(await (await b.postMultipart(base, { step: "check", match: "attribute", field: "nope", csv: `C001,${UID1}` })).text()).toContain("外部の連携先の名前か、独自項目を選んでください。");
  });

  it("customers の項目だけのスタッフには出さない・使わせない。0168 の前は出さない", async () => {
    const { sb, shop, app } = setup();
    const staff = await Browser.loggedIn(app, "staff@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/import/identities`;
    expect(await (await staff.get(`/admin/shops/${shop.id}/customers`)).text()).not.toContain(base);
    expect((await staff.get(base)).status).not.toBe(200);
    expect((await staff.post(base, { step: "import", match: "email", csv: `hanako@example.com,${UID1}` })).status).not.toBe(200);
    expect(sb.memberIdentities).toHaveLength(0);

    const old = setup({ migrations: BUNDLED_MIGRATIONS.filter((m) => m !== "0168_member_identity_import") });
    const b = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await b.get(`/admin/shops/${old.shop.id}/customers`)).text()).not.toContain("/customers/import/identities");
    expect((await b.get(`/admin/shops/${old.shop.id}/customers/import/identities`)).status).toBe(404);
  });

  it("500 行を超える CSV: 塊をまたぐ重なりも、確かめるときと結ぶときで同じ結果（重なりは DB に渡さない）。画面は覚えさせない", async () => {
    const { sb, shop, app } = setup();
    for (let i = 3; i <= 700; i++) sb.tables.customers.push({ id: `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`, shop_id: shop.id, email: `m${i}@example.com`, attributes: { card_no: `C${String(i).padStart(3, "0")}` }, created_at: "2026-10-03T00:00:00Z" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/import/identities`;
    const uid = (i: number) => `U${i.toString(16).padStart(32, "0")}`;
    const lines = ["key,line"];
    for (let i = 3; i <= 700; i++) lines.push(`C${String(i).padStart(3, "0")},${uid(i)}`);
    lines.push(`C001,${uid(10)}`); // 10 行目の ID と重なる（2 つ目の塊）
    const csv = lines.join("\n");
    const res = await b.postMultipart(base, { step: "check", match: "attribute", field: "card_no", csv });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const check = await res.text();
    expect(check).toContain("698 件を結ぶ");
    expect(check).toContain("CSV の中で重なっている（同じ ID・同じ引く値の 2 つ目から。最初の行だけを使う）: 1");
    expect(check).toContain(`<td>${lines.length}</td><td></td><td>CSV の中で重なっている`);
    expect(sb.memberIdentities).toHaveLength(0);
    const done = await (await b.post(base, { step: "import", match: "attribute", match_key: "card_no", csv })).text();
    expect(done).toContain("結んだ（結ぶ）: 698");
    expect(sb.memberIdentities).toHaveLength(698);
  });

  it("途中の塊で DB が失敗したら、そこまでの結果と案内を出し、確かめるときは「結ぶ」を出さない", async () => {
    const { sb, shop, app } = setup();
    for (let i = 3; i <= 600; i++) sb.tables.customers.push({ id: `00000000-0000-4000-b000-${String(i).padStart(12, "0")}`, shop_id: shop.id, email: `n${i}@example.com`, attributes: { card_no: `D${i}` }, created_at: "2026-10-03T00:00:00Z" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/customers/import/identities`;
    const csv = ["key,line", ...Array.from({ length: 598 }, (_, k) => `D${k + 3},U${(k + 3).toString(16).padStart(32, "0")}`)].join("\n");
    sb.identityImportFailAfter = 1;
    const check = await (await b.postMultipart(base, { step: "check", match: "attribute", field: "card_no", csv })).text();
    expect(check).toContain("取り込めませんでした");
    expect(check).toContain("結んだ（結ぶ）: 500");
    expect(check).not.toContain("件を結ぶ</button>");
    expect(check).not.toContain('name="step" value="import"');
  });

  it("会員の詳細に LINE・Google の連携（種類だけ）を出す", async () => {
    const { sb, shop, app } = setup();
    sb.memberIdentities.push({ shop_id: shop.id, provider: "line", subject: UID1, customer_id: "00000000-0000-4000-a000-000000000001" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/customers/00000000-0000-4000-a000-000000000001`)).text();
    expect(html).toContain("LINE・Google の連携");
    expect(html).toContain("<dd>LINE</dd>");
    expect(html).not.toContain(UID1);
  });
});
