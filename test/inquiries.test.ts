import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase, type Row } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memberLogin, memberMail } from "./helpers";
import { checkInquiry, fillTemplate, inquiryTemplates, openOrderToken, sealOrderToken } from "../src/modules/inquiries";
import { buildCustomerMail, buildShopNotice } from "../src/modules/inquiries/mail";
import { pageKind } from "../src/storefront/mode";

/**
 * お問い合わせ（同梱モジュール inquiries）の画面とヘッドレス API。
 * DB の関数（0061）の規則は test/db/inquiries.test.ts で実 PostgreSQL に対して確かめる。ここでは関数をごく小さく真似て、
 * Worker 側（リンクのトークン・メールの中身・画面の出し分け・Cookie・注文トークン）を確かめる。
 */
let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  externalHosts.clear();
});

interface Ticket {
  id: string;
  shop_id: string;
  number: number;
  category: string;
  status: string;
  origin: string;
  contact_email: string | null;
  verified: boolean;
  customer_id: string | null;
  order_id: string | null;
  claimed: number | null;
  return_to: string | null;
  links: Set<string>;
  messages: { author: "customer" | "shop"; body: string; created_at: string }[];
}

/** 0061 の関数の小さな真似（回数の制限・メールの記録は DB のテストで確かめる） */
function fakeInquiries(sb: FakeSupabase) {
  const tickets: Ticket[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const err = (message: string) => json({ message }, 400);
  const view = (x: Ticket) => {
    const o = sb.tables.orders.find((r) => r["id"] === x.order_id);
    return { id: x.id, number: x.number, status: x.status, category: x.category, created_at: "2026-10-27T00:00:00Z", last_message_at: "2026-10-27T00:00:00Z", verified: x.verified, claimed_order_number: x.claimed, order: o ? { number: o["number"], status: o["status"], created_at: o["created_at"], total_jpy: o["total_jpy"] } : null, messages: x.messages };
  };
  const summary = (o: Row) => ({ number: o["number"], status: o["status"], created_at: o["created_at"], total_jpy: o["total_jpy"], items: [{ name: "Tシャツ", qty: 1 }] });
  const byAccess = (shop: unknown, a: Record<string, unknown>) =>
    "link_hash" in a ? tickets.find((x) => x.shop_id === shop && x.links.has(String(a["link_hash"]))) : tickets.find((x) => x.shop_id === shop && x.number === a["number"] && x.customer_id === a["customer_id"] && x.verified);
  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const fn = u.pathname.replace("/rest/v1/rpc/", "");
    if (u.pathname === "/rest/v1/inquiries") {
      const shop = u.searchParams.get("shop_id")?.replace(/^eq\./, "");
      return json(tickets.filter((x) => x.shop_id === shop).map((x) => ({ id: x.id, number: x.number, status: x.status, category: x.category, contact_email: x.contact_email, contact_name: null, email_verified_at: x.verified ? "2026-10-27T00:00:00Z" : null, order_id: x.order_id, claimed_order_number: x.claimed, last_message_at: "2026-10-27T00:00:00Z", created_at: "2026-10-27T00:00:00Z" })));
    }
    const a = (await req.json()) as Record<string, unknown>;
    const shop = a["p_shop_id"];
    const from = "Shop <shop@example.com>";
    switch (fn) {
      case "inquiry_create": {
        const i = a["p_input"] as Record<string, unknown>;
        let email = String(i["email"] ?? "");
        let verified = false;
        let customer: string | null = null;
        let order: Row | undefined;
        if (i["basis"] === "member") {
          const c = sb.tables.customers.find((r) => r["shop_id"] === shop && r["id"] === i["customer_id"]);
          if (!c) return err("invalid_member");
          email = String(c["email"]);
          verified = true;
          customer = String(c["id"]);
          if (i["order_number"]) order = sb.tables.orders.find((o) => o["shop_id"] === shop && String(o["number"]) === String(i["order_number"]) && o["customer_id"] === customer);
        } else if (i["basis"] === "order") {
          order = sb.tables.orders.find((o) => o["shop_id"] === shop && o["id"] === i["order_id"]);
          if (!order) return err("order_not_found");
          email = String(order["customer_email"]);
          verified = true;
        } else if (i["order_number"]) {
          order = sb.tables.orders.find((o) => o["shop_id"] === shop && String(o["number"]) === String(i["order_number"]) && o["customer_email"] === email);
        }
        const t: Ticket = { id: `inq-${tickets.length + 1}`, shop_id: String(shop), number: tickets.length + 1, category: String(i["category"]), status: "waiting_shop", origin: String(i["basis"]), contact_email: email, verified, customer_id: customer, order_id: order ? String(order["id"]) : null, claimed: order ? null : i["order_number"] ? Number(i["order_number"]) : null, return_to: (i["return_to"] as string | null) ?? null, links: new Set([String(a["p_link_hash"])]), messages: [{ author: "customer", body: String(i["body"]), created_at: "2026-10-27T00:00:00Z" }] };
        tickets.push(t);
        return json({ id: t.id, number: t.number, verified, to: email, mail_from: from, send: true, kind: verified ? "created" : "verify", notify: verified ? { send: true, to: "shop@example.com" } : null });
      }
      case "inquiry_order_check": {
        const o = sb.tables.orders.find((r) => r["shop_id"] === shop && r["number"] === a["p_number"] && r["customer_email"] === a["p_email"]);
        return json(o ? summary(o) : null);
      }
      case "inquiry_order_ref": {
        const ref = a["p_ref"] as Record<string, unknown>;
        const o = sb.tables.orders.find(
          (r) => r["shop_id"] === shop && ((ref["order_id"] && r["id"] === ref["order_id"]) || (ref["email"] && r["number"] === ref["number"] && r["customer_email"] === ref["email"]) || (ref["customer_id"] && r["number"] === ref["number"] && r["customer_id"] === ref["customer_id"])),
        );
        return json(o ? { ...summary(o), order_id: o["id"] } : null);
      }
      case "inquiry_peek": {
        const t = byAccess(shop, { link_hash: a["p_link_hash"] });
        return json(t ? { number: t.number } : null);
      }
      case "inquiry_get": {
        const t = byAccess(shop, a["p_access"] as Record<string, unknown>);
        if (!t) return json(null);
        const first = !t.verified;
        t.verified = true;
        return json({ inquiry: view(t), notify: first ? { send: true, to: "shop@example.com" } : null, mail_from: from });
      }
      case "inquiry_member_list":
        return json(tickets.filter((x) => x.shop_id === shop && x.customer_id === a["p_customer_id"] && x.verified).map((x) => ({ number: x.number, status: x.status, category: x.category, created_at: "2026-10-27T00:00:00Z", last_message_at: "2026-10-27T00:00:00Z", order_number: null })));
      case "inquiry_customer_reply": {
        const t = byAccess(shop, a["p_access"] as Record<string, unknown>);
        if (!t || !t.verified) return err("inquiry_not_found");
        if (t.status === "closed") return err("inquiry_closed");
        t.messages.push({ author: "customer", body: String(a["p_body"]), created_at: "2026-10-27T00:00:00Z" });
        t.status = "waiting_shop";
        return json({ id: t.id, number: t.number, notify: { send: true, to: "shop@example.com" }, mail_from: from });
      }
      case "inquiry_resend_link": {
        const t = tickets.find((x) => x.shop_id === shop && x.number === a["p_number"] && x.contact_email === a["p_email"]);
        if (t) t.links.add(String(a["p_link_hash"]));
        return json({ send: !!t, mail_from: from, to: t?.contact_email ?? null, number: t?.number ?? null });
      }
      case "inquiry_admin_get": {
        const t = tickets.find((x) => x.id === a["p_inquiry_id"]);
        return json(t ? { ...view(t), shop_id: t.shop_id, origin: t.origin, contact_email: t.contact_email, contact_name: null, customer_id: t.customer_id, closed_at: null, masked: false, member_match: false, order: null } : null);
      }
      case "inquiry_reply": {
        const t = tickets.find((x) => x.id === a["p_inquiry_id"])!;
        t.messages.push({ author: "shop", body: String(a["p_body"]), created_at: "2026-10-27T00:00:00Z" });
        t.status = "waiting_customer";
        t.links.add(String(a["p_link_hash"]));
        return json({ number: t.number, send: true, to: t.contact_email, mail_from: from, return_to: t.return_to });
      }
      case "api_inquiry_reply": {
        const t = tickets.find((x) => x.shop_id === sb.tables.shops[0]!["id"] && x.number === a["p_number"])!;
        t.messages.push({ author: "shop", body: String(a["p_body"]), created_at: "2026-10-27T00:00:00Z" });
        t.status = "waiting_customer";
        t.links.add(String(a["p_link_hash"]));
        const shop = sb.tables.shops[0]!;
        return json({ inquiry: { ...view(t), contact: undefined }, mail: { send: true, to: t.contact_email, mail_from: from, return_to: t.return_to, shop: { id: shop["id"], name: shop["name"], slug: shop["slug"], domain: null, settings: shop["settings"] } } });
      }
      case "inquiry_set_status": {
        tickets.find((x) => x.id === a["p_inquiry_id"])!.status = String(a["p_status"]);
        return new Response(null, { status: 204 });
      }
    }
    return json({ message: `unknown ${fn}` }, 404);
  };
  externalHosts.set(`${sb.url}/rest/v1/rpc/inquiry_`, handler);
  externalHosts.set(`${sb.url}/rest/v1/inquiries`, handler);
  externalHosts.set(`${sb.url}/rest/v1/rpc/api_inquiry_reply`, handler);
  return tickets;
}

function setup(opts: { module?: boolean; members?: boolean; storefront?: string } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: opts.members ?? true, modules: { inquiries: opts.module ?? true }, contact_email: "shop@example.com", headless: { return_origins: ["https://wp.example.com"] }, ...(opts.storefront ? { storefront: { mode: opts.storefront } } : {}) },
  });
  sb.tables.orders.push({ id: "order-1", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 3000, shipping_jpy: 0, customer_email: "guest@example.com", customer_name: "ゲスト", created_at: "2026-10-20T00:00:00Z" });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const tickets = fakeInquiries(sb);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, app, mail, tickets, b: new Browser(app) };
}

describe("お問い合わせの部品（src/modules/inquiries）", () => {
  it("入力: 種類・本文は必須。ゲストはメールアドレスも。注文番号は数字だけにそろえる", () => {
    expect(checkInquiry({ category: "x", body: "a" }, { needEmail: false }).error).toBe("inq.error_category");
    expect(checkInquiry({ category: "order", body: "  " }, { needEmail: false }).error).toBe("inq.error_body");
    expect(checkInquiry({ category: "order", body: "a", email: "nope" }, { needEmail: true }).error).toBe("inq.error_email");
    expect(checkInquiry({ category: "order", body: "a\r\nb", email: "A@Example.com", order_number: "＃１００１" }, { needEmail: true })).toEqual({
      input: { category: "order", body: "a\nb", name: "", email: "a@example.com", order_number: "1001" },
      error: null,
    });
  });

  it("注文トークン: ショップごとに署名し、期限と他のショップでは開けない", async () => {
    const tok = await sealOrderToken("s", "shop-1", 1001, "Guest@Example.com");
    expect(await openOrderToken("s", "shop-1", tok)).toEqual({ number: 1001, email: "guest@example.com" });
    expect(await openOrderToken("s", "shop-2", tok)).toBeNull();
    expect(await openOrderToken("s", "shop-1", tok, Date.now() + 2 * 86_400_000)).toBeNull();
  });

  it("メールに本文を載せない（お知らせとリンクだけ）。運営者へは管理画面へのリンクだけ", () => {
    const shop = { id: "s1", name: "マイショップ", slug: "my-shop" };
    const m = buildCustomerMail("reply", shop, 7, "https://example.com/my-shop/inquiries/open?t=abc");
    expect(m.subject).toContain("受付番号 7");
    expect(m.text).toContain("https://example.com/my-shop/inquiries/open?t=abc");
    expect(m.text).toContain("返信しても届きません");
    const n = buildShopNotice("new", shop, { number: 7, category: "order" }, "https://example.com/admin/x");
    expect(n.subject).toContain("注文・配送について");
    expect(n.text).toContain("https://example.com/admin/x");
  });

  it("定型文: 題と本文のあるものだけ 10 個まで。{name}・{number}・{shop} を置き換える", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, body: `b${i}` }));
    expect(inquiryTemplates([{ title: "", body: "x" }, { title: "a\nb", body: " 本文\r\n " }, ...many])).toHaveLength(10);
    expect(inquiryTemplates([{ title: "a\nb", body: " 本文\r\n2 " }])).toEqual([{ title: "a b", body: "本文\n2" }]);
    expect(fillTemplate("{name} 様（{number}）{shop} {other}", { name: null, number: 3, shop: "マイショップ" })).toBe("お客様 様（3）マイショップ {other}");
  });

  it("お問い合わせの画面は、お店の画面の使い方に関係なく残す", () => {
    for (const p of ["/inquiries", "/inquiries/new", "/inquiries/open", "/inquiries/thread", "/inquiries/reply", "/inquiries/resend"]) expect(pageKind(p)).toBe("system");
  });
});

describe("お問い合わせ（同梱テーマ）", () => {
  it("モジュールが OFF なら画面もリンクも無い", async () => {
    const { b } = setup({ module: false });
    expect((await b.get("/my-shop/inquiries/new")).status).toBe(404);
    expect(await (await b.get("/my-shop/legal")).text()).not.toContain("/my-shop/inquiries/new");
  });

  it("ゲスト: フォーム → 確認 → 送る → 確認のメール（本文なし）→ リンクの確認画面（GET では開かない）→ 開く → やり取り → 続きを書く", async () => {
    const { app, b, mail, tickets } = setup();
    let html = await (await b.get("/my-shop/legal")).text();
    expect(html).toContain('href="/my-shop/inquiries/new"');
    html = await (await b.get("/my-shop/inquiries/new")).text();
    expect(html).toContain('action="/my-shop/inquiries/confirm"');
    expect(html).toContain('name="email"');

    let res = await b.post("/my-shop/inquiries/confirm", { category: "product", body: "サイズは何がありますか？\n<b>太字</b>", email: "Guest@Example.com", name: "山田", order_number: "" });
    html = await res.text();
    expect(html).toContain('action="/my-shop/inquiries/submit"');
    expect(html).toContain("&lt;b&gt;太字&lt;/b&gt;");

    res = await b.post("/my-shop/inquiries/submit", { category: "product", body: "サイズは何がありますか？", email: "guest@example.com", name: "山田", order_number: "" });
    html = await res.text();
    expect(html).toContain("受付番号 1");
    expect(html).toContain("確認のメールを送りました");
    const m = mail.sent.find((x) => x.to === "guest@example.com")!;
    expect(m.subject).toBe("【マイショップ】お問い合わせを受け付けました（受付番号 1）");
    expect(m.text).not.toContain("サイズ");
    expect(m.html ?? "").not.toContain("サイズ");
    const link = mail.link("guest@example.com");
    expect(link.startsWith(`${BASE}/my-shop/inquiries/open?t=`)).toBe(true);
    // 未確認のうちは運営者に知らせない
    expect(mail.sent.some((x) => x.to === "shop@example.com")).toBe(false);

    // GET は確認画面だけ（確認済みにしない）
    res = await b.get(link.replace(BASE, ""));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    html = await res.text();
    expect(html).toContain('action="/my-shop/inquiries/open"');
    expect(tickets[0]!.verified).toBe(false);

    res = await b.post("/my-shop/inquiries/open", { t: new URL(link).searchParams.get("t")! });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/my-shop/inquiries/thread");
    expect(res.headers.getSetCookie().find((x) => x.startsWith("banto_inq_"))).toContain("HttpOnly");
    html = await (await b.get("/my-shop/inquiries/thread")).text();
    expect(html).toContain("サイズは何がありますか？");
    expect(tickets[0]!.verified).toBe(true);
    // 確認できたので運営者に知らせる（中身は載せず、管理画面へのリンク）
    const notice = mail.sent.find((x) => x.to === "shop@example.com")!;
    expect(notice.subject).toContain("新しいお問い合わせ");
    expect(notice.text).toContain(`${BASE}/admin/shops/`);
    expect(notice.text).not.toContain("サイズ");

    res = await b.post("/my-shop/inquiries/reply", { body: "M はありますか" });
    expect(res.headers.get("location")).toBe("/my-shop/inquiries/thread?flash=sent");
    expect(tickets[0]!.messages.map((x) => x.body)).toEqual(["サイズは何がありますか？", "M はありますか"]);

    // 別の端末（Cookie なし）では開けない。リンクの送り直しは合ったかどうかを言わない
    const other = new Browser(app);
    expect((await other.get("/my-shop/inquiries/thread")).status).toBe(404);
    html = await (await other.post("/my-shop/inquiries/resend", { number: "1", email: "nobody@example.com" })).text();
    expect(html).toContain("合っていれば");
  });

  it("注文照会の結果から: 注文トークンを POST で渡し、注文を決めたフォーム（アドレスは入れない）→ 注文時のアドレスに知らせる", async () => {
    const { b, mail, tickets } = setup();
    let html = await (await b.post("/my-shop/orders/lookup", { number: "1001", email: "guest@example.com" })).text();
    const token = /name="o" value="([^"]+)"/.exec(html)?.[1];
    expect(token).toBeTruthy();
    expect(html).not.toMatch(/inquiries\/new\?[^"]*guest/);
    html = await (await b.post("/my-shop/inquiries/new", { o: token! })).text();
    expect(html).toContain("注文番号 1001");
    expect(html).not.toContain('name="email"');
    html = await (await b.post("/my-shop/inquiries/submit", { o: token!, category: "order", body: "届きません", name: "" })).text();
    expect(html).toContain("ショップからの返事はメールでお知らせします");
    expect(tickets[0]).toMatchObject({ origin: "order", order_id: "order-1", verified: true });
    expect(mail.sent.find((x) => x.to === "guest@example.com")!.subject).toContain("受付番号 1");
    // 改ざんしたトークンは通らない
    html = await (await b.post("/my-shop/inquiries/submit", { o: `${token!}x`, category: "order", body: "x" })).text();
    expect(html).toContain("注文を確かめられませんでした");
  });

  it("会員: 自分の注文から選んで送る（確認のメールなし）。会員ページから履歴とやり取りを開ける", async () => {
    const { sb, shop, b, mail, tickets } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const cid = sb.tables.customers[0]!["id"] as string;
    sb.tables.orders.push({ id: "order-2", shop_id: shop.id, number: 1002, status: "paid", total_jpy: 5000, shipping_jpy: 0, customer_email: "member@example.com", customer_id: cid, created_at: "2026-10-21T00:00:00Z" });
    let html = await (await b.get("/my-shop/account")).text();
    expect(html).toContain('href="/my-shop/inquiries"');
    html = await (await b.get("/my-shop/inquiries/new?order=1002")).text();
    expect(html).not.toContain('name="email"');
    expect(html).toContain('<option value="1002" selected="">');
    html = await (await b.post("/my-shop/inquiries/confirm", { category: "order", body: "会員です", order_number: "1002" })).text();
    expect(html).toContain("注文番号 1002");
    await b.post("/my-shop/inquiries/submit", { category: "order", body: "会員です", order_number: "1002" });
    expect(tickets[0]).toMatchObject({ origin: "member", customer_id: cid, order_id: "order-2", verified: true });
    html = await (await b.get("/my-shop/inquiries")).text();
    expect(html).toContain('href="/my-shop/inquiries/thread?n=1"');
    html = await (await b.get("/my-shop/inquiries/thread?n=1")).text();
    expect(html).toContain("会員です");
    expect(html).toContain('name="n" value="1"');
  });

  it("お店の画面を使わない（off）ショップでも、お問い合わせの画面は出す", async () => {
    const { b } = setup({ storefront: "off" });
    expect((await b.get("/my-shop/inquiries/new")).status).toBe(200);
    expect((await b.get("/my-shop/cart")).status).toBe(404);
  });
});

describe("お問い合わせ（管理画面）", () => {
  it("一覧 → 1 件 → 返事（お客様にはリンクだけのメール）→ 完了にするとお客様は書けない", async () => {
    const { app, shop, mail, tickets } = setup();
    const guest = new Browser(app);
    await guest.post("/my-shop/orders/lookup", { number: "1001", email: "guest@example.com" });
    const html0 = await (await guest.post("/my-shop/orders/lookup", { number: "1001", email: "guest@example.com" })).text();
    const token = /name="o" value="([^"]+)"/.exec(html0)![1]!;
    await guest.post("/my-shop/inquiries/submit", { o: token, category: "order", body: "届きません" });

    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain(`href="/admin/shops/${shop.id}/modules/inquiries"`);
    html = await (await admin.get(`/admin/shops/${shop.id}/modules/inquiries`)).text();
    expect(html).toContain(`/admin/shops/${shop.id}/modules/inquiries/inq-1`);
    html = await (await admin.get(`/admin/shops/${shop.id}/modules/inquiries/inq-1`)).text();
    expect(html).toContain("届きません");
    let res = await admin.post(`/admin/shops/${shop.id}/modules/inquiries/inq-1/reply`, { body: "本日発送しました" });
    expect(res.headers.get("location")).toContain("flash=sent");
    const m = mail.sent.filter((x) => x.to === "guest@example.com").at(-1)!;
    expect(m.subject).toContain("返事がありました");
    expect(m.text).not.toContain("本日発送しました");
    expect(m.text).toContain(`${BASE}/my-shop/inquiries/open?t=`);
    expect(tickets[0]!.status).toBe("waiting_customer");

    // 定型文を登録して、返事の欄に差し込む
    res = await admin.post(`/admin/shops/${shop.id}/modules/inquiries/settings`, { notify_email: "", tpl_title_0: "発送のご連絡", tpl_body_0: "{name}、受付番号 {number} の件、{shop} です。", tpl_title_1: "", tpl_body_1: "" });
    expect(res.headers.get("location")).toContain("flash=saved");
    html = await (await admin.get(`/admin/shops/${shop.id}/modules/inquiries/inq-1?template=0`)).text();
    expect(html).toContain("お客様、受付番号 1 の件、マイショップ です。");

    res = await admin.post(`/admin/shops/${shop.id}/modules/inquiries/inq-1/status`, { status: "closed" });
    expect(res.headers.get("location")).toContain("flash=status");
    const link = mail.link("guest@example.com");
    await guest.post("/my-shop/inquiries/open", { t: new URL(link).searchParams.get("t")! });
    html = await (await guest.get("/my-shop/inquiries/thread")).text();
    expect(html).toContain("本日発送しました");
    expect(html).not.toContain('action="/my-shop/inquiries/reply"');
  });
});

describe("お問い合わせ（AI 用 API）", () => {
  it("返事を書くと、お客様にはリンクだけのメール。宛先は応答に出さない", async () => {
    const { app, mail } = setup();
    const res0 = await app.request(`${BASE}/api/shops/my-shop/inquiries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "other", body: "質問", email: "ai-guest@example.com" }) });
    expect(res0.status).toBe(201);
    const res = await app.request(`${BASE}/api/v1/inquiries/1/reply`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer banto_${"a".repeat(43)}` }, body: JSON.stringify({ body: "AI からの返事です" }) });
    const r = (await res.json()) as Record<string, unknown>;
    expect(r).toMatchObject({ number: 1, status: "waiting_customer", mail_sent: true });
    expect(JSON.stringify(r)).not.toContain("ai-guest@example.com");
    const m = mail.sent.filter((x) => x.to === "ai-guest@example.com").at(-1)!;
    expect(m.subject).toContain("返事がありました");
    expect(m.text).not.toContain("AI からの返事です");
    expect(m.text).toContain(`${BASE}/my-shop/inquiries/open?t=`);
  });
});

describe("お問い合わせ（ヘッドレス API）", () => {
  const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://wp.example.com", ...headers }, body: JSON.stringify(body) });

  it("送る（リンクは許可リストの連携サイトへ）→ トークンで読む・続きを書く。許可リストに無い戻り先は Banto の画面", async () => {
    const { app, mail } = setup();
    let res = await post(app, "/api/shops/my-shop/inquiries", { category: "other", body: "質問です", email: "api@example.com", return_to: "https://wp.example.com/contact/thread" });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ number: 1, verified: false, mail_sent: true });
    const link = mail.link("api@example.com");
    expect(link.startsWith("https://wp.example.com/contact/thread?banto_inquiry=")).toBe(true);
    const token = new URL(link).searchParams.get("banto_inquiry")!;

    res = await post(app, "/api/shops/my-shop/inquiries/view", { token });
    const v = (await res.json()) as { inquiry: { number: number; messages: { body: string }[]; can_reply: boolean } };
    expect(v.inquiry).toMatchObject({ number: 1, can_reply: true, messages: [{ body: "質問です" }] });
    res = await post(app, "/api/shops/my-shop/inquiries/reply", { token, body: "追記です" });
    expect(await res.json()).toEqual({ number: 1 });
    expect((await post(app, "/api/shops/my-shop/inquiries/view", { token: "x".repeat(43) })).status).toBe(404);

    await post(app, "/api/shops/my-shop/inquiries", { category: "other", body: "b", email: "evil@example.com", return_to: "https://evil.example.com/x" });
    expect(mail.link("evil@example.com").startsWith(`${BASE}/my-shop/inquiries/open?t=`)).toBe(true);

    expect((await post(app, "/api/shops/my-shop/inquiries", { category: "other", body: "" , email: "a@example.com" })).status).toBe(400);
  });

  it("注文を確かめる → 注文トークンで送る（注文時のアドレスへ）。合わなければ order: null", async () => {
    const { app, tickets } = setup();
    let res = await post(app, "/api/shops/my-shop/inquiries/order-check", { number: 1001, email: "Guest@example.com" });
    const r = (await res.json()) as { order: { number: number } | null; order_token: string | null };
    expect(r.order).toMatchObject({ number: 1001 });
    res = await post(app, "/api/shops/my-shop/inquiries", { category: "order", body: "x", order_token: r.order_token });
    expect(await res.json()).toMatchObject({ number: 1, verified: true });
    expect(tickets[0]).toMatchObject({ order_id: "order-1", contact_email: "guest@example.com" });
    res = await post(app, "/api/shops/my-shop/inquiries/order-check", { number: 1001, email: "wrong@example.com" });
    expect(await res.json()).toEqual({ order: null, order_token: null });
    expect((await post(app, "/api/shops/my-shop/inquiries", { category: "order", body: "x", order_token: "bogus" })).status).toBe(400);
  });

  it("モジュールが OFF なら 404", async () => {
    const { app } = setup({ module: false });
    expect((await post(app, "/api/shops/my-shop/inquiries", { category: "other", body: "x", email: "a@example.com" })).status).toBe(404);
  });
});
