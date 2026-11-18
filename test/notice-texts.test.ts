import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { createPrivilegedDb } from "../src/db/privileged";
import { buildOrderEmail } from "../src/plugins/email_resend";
import { buyerMessage, tryonLineMessage } from "../src/plugins/line_buyer";
import { buildTryonMails, tryonNoticeKind } from "../src/modules/store-tryon/mail";
import { DEFAULT_NOTICE_TEXTS, NOTICE_KINDS, NOTICE_TEXTS_MIGRATION, checkNoticeText, fillNotice, noticeMail, noticeTextErrorOf, staleNoticeTexts } from "../src/notices/templates";

/** お知らせの文面（0154）。DB の決まり・権限は test/db/notice-texts.test.ts */

const contact = {
  order_id: "o1",
  number: 1001,
  status: "paid",
  created_at: "2026-11-18T00:00:00Z",
  total_jpy: 3300,
  shipping_jpy: 300,
  payment_provider: "stripe",
  customer_email: "a@example.com",
  customer_name: "山田",
  shipping_address: { postal_code: "150-0001", state: "東京都", city: "渋谷区", line1: "1-2-3", name: "山田" },
  tracking: { carrier: "yamato", number: "1234" },
  shop: { name: "マイショップ", slug: "my-shop", contact_email: "shop@example.com", return_policy: "到着から 7 日以内" },
  items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000, tax_rate: 10 }],
};

describe("差し込み（src/notices/templates.ts）", () => {
  it("値が空の差し込みだけの行は行ごと消え、空行は重ならない。値の中の {{…}} はもう一度は置き換えない", () => {
    expect(fillNotice("a\n\n{{x}}\n\n{{y}}\n\nb {{x}}!", { x: "", y: "{{x}}" })).toBe("a\n\n{{x}}\n\nb !");
    expect(fillNotice("{{ x }} と {{x}}", { x: "1" })).toBe("1 と 1");
    // 差し込んだ値の中の空行はショップが書いたとおり（返品ポリシーの段落など）
    expect(fillNotice("a\n\n{{p}}\n\nb", { p: "段落1\n\n\n段落2" })).toBe("a\n\n段落1\n\n\n段落2\n\nb");
  });

  it("決まり: 使えない名前・組になっていない括弧・必須の欠け・かたまりの重なり・件名の改行と番号", () => {
    const ok = DEFAULT_NOTICE_TEXTS.order_paid.mail;
    expect(checkNoticeText("order_paid", "mail", ok.subject, ok.body)).toBeNull();
    expect(checkNoticeText("order_paid", "mail", ok.subject, "{{order_details}} {{tracking}}")).toEqual({ code: "body_unknown_tag", tag: "tracking" });
    expect(checkNoticeText("order_paid", "mail", ok.subject, "{{order_details}} {{shop_name}")).toEqual({ code: "body_broken_tag" });
    expect(checkNoticeText("order_paid", "mail", ok.subject, "ありがとうございます")).toEqual({ code: "body_missing_tag", tag: "order_details" });
    expect(checkNoticeText("order_paid", "mail", ok.subject, "{{order_details}}\n{{order_details}}")).toEqual({ code: "body_repeated_tag", tag: "order_details" });
    expect(checkNoticeText("order_shipped", "mail", ok.subject, "{{order_details}}")).toEqual({ code: "body_missing_tag", tag: "tracking" });
    expect(checkNoticeText("order_paid", "mail", "ご注文", ok.body)).toEqual({ code: "subject_missing_tag", tag: "number" });
    expect(checkNoticeText("order_paid", "mail", "{{order_details}} {{number}}", ok.body)).toEqual({ code: "subject_unknown_tag", tag: "order_details" });
    // LINE には氏名・住所の差し込みを使わせない
    expect(checkNoticeText("order_paid", "line", null, "{{customer_name}} {{number}}")).toEqual({ code: "body_unknown_tag", tag: "customer_name" });
    // 改行をまたぐ {{ … }} も組とみなす（DB の正規表現と同じ）。NUL は DB に入らないので画面で断る
    expect(checkNoticeText("order_paid", "mail", ok.subject, "{{order_details\n}}")).toEqual({ code: "body_unknown_tag", tag: "order_details\n".slice(0, 40) });
    expect(checkNoticeText("order_paid", "mail", ok.subject, "{{order_details}}\u0000")).toEqual({ code: "nul" });
    expect(noticeTextErrorOf('invalid_notice_text:body_missing_tag:order_details')).toEqual({ code: "body_missing_tag", tag: "order_details" });
  });

  it("既定の文面はどれも今の決まりに合う", () => {
    for (const k of NOTICE_KINDS) {
      expect(checkNoticeText(k, "mail", DEFAULT_NOTICE_TEXTS[k].mail.subject, DEFAULT_NOTICE_TEXTS[k].mail.body)).toBeNull();
      expect(checkNoticeText(k, "line", null, DEFAULT_NOTICE_TEXTS[k].line)).toBeNull();
    }
  });
});

describe("注文のメールと LINE", () => {
  it("既定: 今までと同じ文（明細・税・お届け先・返品・照会のリンク・お問い合わせ）", () => {
    const m = buildOrderEmail("paid", contact, "https://shop.example");
    expect(m.subject).toBe("【マイショップ】ご注文ありがとうございます（注文番号 1001）");
    expect(m.text).toBe(
      "山田 様\n\nご注文を承りました。内容をご確認ください。\n\n注文番号: 1001\n\n・Tシャツ / M × 1  ¥3,000\n\n商品合計: ¥3,000\n送料: ¥300\n合計（税込）: ¥3,300\n（10%対象 ¥3,300　内消費税 ¥300）\n\nお届け先:\n150-0001\n東京都\n渋谷区\n1-2-3\n山田\n\n返品について:\n到着から 7 日以内\n\nご注文の状況はこちらで確認できます: https://shop.example/my-shop/orders/lookup?banto_order=1001\n\nお問い合わせ: shop@example.com\n\nマイショップ",
    );
    expect(buildOrderEmail("shipped", contact, undefined).text).toContain("お問い合わせ番号: ヤマト運輸 1234\n配送状況: ");
  });

  it("直した文面で送る。今の決まりに合わない行（必須が欠けた古い文面）は既定で送る", () => {
    const rows = [{ kind: "order_paid", channel: "mail", subject: "{{shop_name}}より #{{number}}", body: "{{customer_name}}さま、ありがとう！\n\n{{order_details}}\n\n{{order_link}}" }];
    const m = buildOrderEmail("paid", contact, undefined, rows);
    expect(m.subject).toBe("マイショップより #1001");
    expect(m.text.startsWith("山田さま、ありがとう！\n\n注文番号: 1001")).toBe(true);
    // 照会のリンクが無い（PUBLIC_BASE_URL も独自ドメインも無い）ので行ごと消える
    expect(m.text.endsWith("山田")).toBe(true);
    const stale = [{ kind: "order_paid", channel: "mail", subject: "x {{number}}", body: "明細なし" }];
    expect(buildOrderEmail("paid", contact, undefined, stale).subject).toBe("【マイショップ】ご注文ありがとうございます（注文番号 1001）");
    expect(staleNoticeTexts(stale)).toHaveLength(1);
    // 別の知らせの行は使わない
    expect(noticeMail("order_shipped", rows, { number: "1", shop_name: "S" }).subject).toBe("【S】商品を発送しました（注文番号 1）");
  });

  it("LINE: 既定は今までの文、直した文面は合計・番号を差し込む", () => {
    const r = { number: 1001, total_jpy: 3300, shop_name: "マイショップ" };
    expect(buyerMessage("order.paid", r)).toBe("【マイショップ】ご注文ありがとうございます。\n注文番号 1001\n合計 ¥3,300\n発送の準備ができしだい、お知らせします。");
    expect(buyerMessage("order.paid", r, [{ kind: "order_paid", channel: "line", subject: null, body: "{{shop_name}}: 注文 {{number}}（{{total}}）を承りました" }])).toBe("マイショップ: 注文 1001（¥3,300）を承りました");
    expect(buyerMessage("order.cancelled", r)).toBeNull();
  });

  it("送るときの読み取り: 0154 を当てる前の DB は読まない（[]）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S" });
    sb.tables.shop_notice_texts.push({ shop_id: shop.id, kind: "order_paid", channel: "line", subject: null, body: "{{number}}" });
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: (i, init) => sb.fetch(i, init) });
    expect(await db.shopNoticeTexts(shop.id, "order_paid")).toHaveLength(1);
    expect(await db.shopNoticeTexts(shop.id, "order_shipped")).toHaveLength(0);
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== NOTICE_TEXTS_MIGRATION);
    expect(await db.shopNoticeTexts(shop.id, "order_paid")).toEqual([]);
    // 読めない（DB の一時的な誤り）ときも既定の文面で送るので [] を返す（知らせを止めない）
    const down = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: async () => new Response("down", { status: 503 }) });
    expect(await down.shopNoticeTexts(shop.id, "order_paid")).toEqual([]);
  });
});

describe("管理画面（/admin/shops/:id/notices）", () => {
  function setup() {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
    return { sb, shop, app: appWith(sb) };
  }

  it("保存・必須の欠けは書いた文を残して理由を出す・既定に戻す", async () => {
    const s = setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const base = `/admin/shops/${s.shop.id}/notices`;
    const page = await (await admin.get(base)).text();
    expect(page).toContain("お知らせの文面");
    expect(page).toContain("{{order_details}}");
    expect(page).toContain("既定の文面で送っています");

    const bad = await admin.post(base, { kind: "order_paid", channel: "mail", subject: "ご注文 {{number}}", body: "ありがとうございました（明細を消した）", action: "save" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("{{order_details}} を入れてください");
    expect(badHtml).toContain("ありがとうございました（明細を消した）");
    expect(s.sb.tables.shop_notice_texts).toHaveLength(0);

    const ok = await admin.post(base, { kind: "order_paid", channel: "mail", subject: "ご注文 {{number}}", body: "ありがとう\r\n\r\n{{order_details}}", action: "save" });
    expect(ok.status).toBe(302);
    expect(s.sb.tables.shop_notice_texts).toEqual([expect.objectContaining({ kind: "order_paid", channel: "mail", subject: "ご注文 {{number}}", body: "ありがとう\n\n{{order_details}}" })]);
    expect(await (await admin.get(base)).text()).toContain("直した文面で送っています");

    await admin.post(base, { kind: "order_paid", channel: "mail", action: "reset" });
    expect(s.sb.tables.shop_notice_texts).toHaveLength(0);
  });

  it("今の決まりに合わない保存済みの文面には警告。0154 を当てる前は欄を出さない", async () => {
    const s = setup();
    s.sb.tables.shop_notice_texts.push({ shop_id: s.shop.id, kind: "order_shipped", channel: "mail", subject: "発送 {{number}}", body: "{{order_details}}" });
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${s.shop.id}/notices`)).text()).toContain("既定の文面で送っています。直して保存してください");
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== NOTICE_TEXTS_MIGRATION);
    const old = await (await (await Browser.loggedIn(appWith(s.sb), "owner@example.com", "password-123")).get(`/admin/shops/${s.shop.id}/notices`)).text();
    expect(old).toContain("0154");
    expect(old).not.toContain('name="body"');
  });
});

describe("お店で試着の知らせ", () => {
  const tryon = {
    request_id: "r1",
    number: 7,
    status: "ready",
    visit_date: null,
    hold_until: "2026-11-27",
    customer_email: "a@example.com",
    customer_name: "山田",
    customer_phone: "0312345678",
    note: null,
    store: { name: "渋谷店", postal_code: null, address: null, phone: null, hours: {}, special_days: [], email: "st@example.com", notify_email: true },
    shop: { name: "マイショップ", slug: "my-shop", contact_email: null },
    items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
  };

  it("お客様あては直した文面、店舗あては決まった文面のまま。前日・延長・取り消しはそれぞれの文面", () => {
    const rows = [
      { kind: "tryon_extended", channel: "mail", subject: "延長 {{number}}", body: "{{hold_until}}まで延ばしました\n\n{{items}}\n\n{{store_info}}" },
      { kind: "tryon_ready", channel: "mail", subject: "ご用意 {{number}}", body: "{{hold_until}}まで\n{{items}}\n{{store_info}}" },
    ];
    const ext = buildTryonMails("tryon.updated", tryon, undefined, { extended: true, previousHoldUntil: "2026-11-25" }, rows);
    expect(ext.map((m) => [m.key, m.subject])).toEqual([
      ["customer", "延長 7"],
      ["store", "【マイショップ】お店で試着の取り置きの延長（渋谷店・受付番号 7）"],
    ]);
    expect(ext[0]!.text.startsWith("11月27日")).toBe(true);
    expect(ext[0]!.text).toContain("・Tシャツ / M × 1");
    // 前日のお知らせは直していないので既定の文面
    expect(buildTryonMails("tryon.updated", tryon, undefined, { reminder: true }, rows)[0]!.subject).toContain("お取り置きは11月27日（金）までです");
    expect(buildTryonMails("tryon.updated", { ...tryon, status: "cancelled" }, undefined, {}, rows)[0]!.subject).toContain("取り消しました");
    expect(tryonNoticeKind("tryon.updated", "picked_up")).toBeNull();
  });

  it("LINE: 直した文面に店舗名と期限を差し込む", () => {
    const r = { number: 7, status: "ready", hold_until: "2026-11-27", store_name: "渋谷店", shop_name: "マイショップ" };
    expect(tryonLineMessage("tryon.updated", r, { reminder: true }, [{ kind: "tryon_reminder", channel: "line", subject: null, body: "明日{{hold_until}}まで {{store_name}} で #{{number}}" }])).toBe("明日11月27日まで 渋谷店 で #7");
    expect(tryonLineMessage("tryon.updated", r, {}, [{ kind: "tryon_reminder", channel: "line", subject: null, body: "x {{number}} {{hold_until}}" }])).toBe("【マイショップ】渋谷店でご試着いただけます。\n受付番号 7\n11月27日までお取り置きします。");
  });

  it("管理画面: お店で試着が ON のショップだけ試着の知らせを出し、保存できる", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/notices`;
    expect(await (await admin.get(base)).text()).not.toContain('value="tryon_ready"');
    expect((await admin.post(base, { kind: "tryon_ready", channel: "line", body: "{{number}} {{hold_until}}", action: "save" })).status).toBe(400);
    shop["settings"] = { modules: { store_tryon: true } };
    expect(await (await admin.get(base)).text()).toContain('value="tryon_ready"');
    expect((await admin.post(base, { kind: "tryon_ready", channel: "line", body: "{{number}} {{hold_until}}", action: "save" })).status).toBe(302);
    expect(sb.tables.shop_notice_texts).toEqual([expect.objectContaining({ kind: "tryon_ready", channel: "line" })]);
  });
});
