import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { NOTICE_KINDS, checkNoticeText, noticeSpec, type NoticeChannel } from "../../src/notices/templates";

/**
 * 0154_notice_texts: お知らせの文面。書くのは notice_text_set だけ（項目 settings）。差し込みの決まりは banto_notice_spec で、
 * Worker の src/notices/templates.ts の noticeSpec / checkNoticeText と同じであることもここで縛る
 */
describe.skipIf(!dbAvailable)("お知らせの文面（0154）", () => {
  let a: Fixture;
  let b: Fixture;
  let settingsMember: string;
  let ordersMember: string;
  const set = (uid: string, shopId: string, kind: string, channel: string, subject: string | null, body: string | null) =>
    asUser(uid, (c) => c.query("select notice_text_set($1, $2, $3, $4, $5)", [shopId, kind, channel, subject, body]));
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, a.shopId, perms]);
    return uid;
  };
  const rows = async (shopId: string) => (await getPool().query("select kind, channel, subject, body from shop_notice_texts where shop_id = $1 order by kind, channel", [shopId])).rows;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "nt-a@example.com", slug: "nt-a" });
    b = await createShopFixture({ email: "nt-b@example.com", slug: "nt-b" });
    settingsMember = await member("nt-settings@example.com", ["settings"]);
    ordersMember = await member("nt-orders@example.com", ["orders"]);
  });
  afterAll(closePool);

  it("決まりは Worker と同じ（知らせ × 送り方のすべて）", async () => {
    for (const kind of NOTICE_KINDS) {
      for (const channel of ["mail", "line"] as NoticeChannel[]) {
        const db = (await asService((c) => c.query<{ s: Record<string, string[]> }>("select banto_notice_spec($1, $2) as s", [kind, channel]))).rows[0]!.s;
        const ts = noticeSpec(kind, channel);
        expect({ kind, channel, ...db }).toEqual({
          kind,
          channel,
          ...(ts.subjectAllowed ? { subject_allowed: ts.subjectAllowed, subject_required: ts.subjectRequired } : {}),
          body_allowed: ts.bodyAllowed,
          body_required: ts.bodyRequired,
          once: ts.once,
        });
      }
    }
  });

  it("保存は項目 settings。改行は LF にそろえて前後を除く。null で消す（既定に戻す）。ほかのショップには書けない", async () => {
    await set(settingsMember, a.shopId, "order_paid", "mail", " ご注文 {{number}} ", "\r\nありがとう\r\n\r\n{{order_details}}\r\n");
    expect(await rows(a.shopId)).toEqual([{ kind: "order_paid", channel: "mail", subject: "ご注文 {{number}}", body: "ありがとう\n\n{{order_details}}" }]);
    await set(a.ownerId, a.shopId, "order_paid", "line", "無視される件名", "{{shop_name}} {{number}}");
    expect((await rows(a.shopId)).find((r) => r["channel"] === "line")).toMatchObject({ subject: null, body: "{{shop_name}} {{number}}" });
    expect(await expectDbError(() => set(ordersMember, a.shopId, "order_paid", "line", null, "{{number}}"))).toMatch(/settings_required/);
    expect(await expectDbError(() => set(b.ownerId, a.shopId, "order_paid", "line", null, "{{number}}"))).toMatch(/settings_required/);
    await set(settingsMember, a.shopId, "order_paid", "line", null, null);
    expect(await rows(a.shopId)).toHaveLength(1);
  });

  it("断る: 必須の欠け・使えない名前・組になっていない括弧・かたまりの重なり・件名の改行と長さ・知らない種類", async () => {
    const cases: [string, string, string | null, string, RegExp][] = [
      ["order_paid", "mail", "x {{number}}", "明細なし", /body_missing_tag:order_details/],
      ["order_shipped", "mail", "x {{number}}", "{{order_details}}", /body_missing_tag:tracking/],
      ["order_paid", "mail", "x {{number}}", "{{order_details}} {{tracking}}", /body_unknown_tag:tracking/],
      ["order_paid", "mail", "x {{number}}", "{{order_details}} {{ shop_name }", /body_broken_tag/],
      ["order_paid", "mail", "x {{number}}", "{{order_details}}\n{{ order_details }}", /body_repeated_tag:order_details/],
      ["order_paid", "mail", "ご注文", "{{order_details}}", /subject_missing_tag:number/],
      ["order_paid", "mail", "a\n{{number}}", "{{order_details}}", /subject_newline/],
      ["order_paid", "mail", "あ".repeat(151) + "{{number}}", "{{order_details}}", /subject_too_long/],
      ["order_paid", "mail", "   ", "{{order_details}}", /subject_empty/],
      ["order_paid", "line", null, "{{customer_name}} {{number}}", /body_unknown_tag:customer_name/],
      ["order_paid", "line", null, "{{number}}" + "あ".repeat(2000), /body_too_long/],
      ["order_paid", "line", null, " \n ", /body_empty/],
      ["order_refunded", "line", null, "{{number}}", /invalid_notice_text:kind/],
    ];
    for (const [kind, channel, subject, body, re] of cases) {
      expect(await expectDbError(() => set(a.ownerId, a.shopId, kind, channel, subject, body))).toMatch(re);
      // 画面の確かめ（Worker）も同じ理由で断る
      if (kind !== "order_refunded") expect(checkNoticeText(kind as never, channel as NoticeChannel, subject, body)?.code).toBe(re.source.split(":")[0]);
    }
  });

  it("読めるのは項目 settings の人だけ。anon と別の項目の人は読めず、直接は書けない", async () => {
    expect((await asUser(settingsMember, (c) => c.query("select 1 from shop_notice_texts where shop_id = $1", [a.shopId]))).rowCount).toBe(1);
    expect((await asUser(ordersMember, (c) => c.query("select 1 from shop_notice_texts where shop_id = $1", [a.shopId]))).rowCount).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select 1 from shop_notice_texts")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update shop_notice_texts set body = 'x' where shop_id = $1", [a.shopId]))) ).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into shop_notice_texts (shop_id, kind, channel, body) values ($1, 'order_paid', 'line', 'x')", [a.shopId])))).toMatch(/permission denied/);
    // 送るとき（service_role）は読める。ショップを消すと消える
    expect((await asService((c) => c.query("select 1 from shop_notice_texts where shop_id = $1", [a.shopId]))).rowCount).toBe(1);
  });
});
