import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import {
  TRYON_EXTEND_MIGRATION,
  memberExtendable,
  todayHere,
  addDays,
  tryonSettings,
} from "../src/modules/store-tryon";
import { buildTryonMails } from "../src/modules/store-tryon/mail";
import { tryonLineMessage } from "../src/plugins/line_buyer";

/** お店で試着の取り置きの延長（0151）。DB の判定（休みの日・回数）は test/db/tryon-extend.test.ts */

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup(
  tryon: Record<string, unknown> = { extend_max: 1, extend_days: 3 },
) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", {
    owner: true,
  });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: {
      modules: { store_tryon: true },
      members_enabled: true,
      headless: { return_origins: ["https://wp.example.com"] },
      store_tryon: tryon,
    },
  });
  const tee = sb.addProduct(shop.id, {
    slug: "tee",
    name: "Tシャツ",
    published: true,
  });
  const sku = sb.addSku(shop.id, tee.id, {
    code: "TEE-M",
    name: "M",
    price_jpy: 3000,
    available: 5,
  });
  const everyDay = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [["10:00", "20:00"]]]),
  );
  sb.tables.stores.push({
    id: "st-1",
    org_id: String(shop["org_id"]),
    name: "渋谷店",
    address: "東京都渋谷区1-1",
    phone: null,
    email: "shibuya@example.com",
    notify_email: true,
    hours: everyDay,
    special_days: [],
    note: null,
    active: true,
    sort_order: 0,
  });
  sb.tables.shop_stores.push({
    shop_id: shop.id,
    store_id: "st-1",
    tryon: true,
    sort_order: 0,
  });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, sku, app, mail };
}

/** 会員でログインして申し込み、店舗に届いた（ready）ことにする */
async function readyRequest(
  s: ReturnType<typeof setup>,
  hold = addDays(todayHere(), 2),
) {
  const b = new Browser(s.app);
  await memberLogin(b, s.mail, "/my-shop", "hanako@example.com");
  await b.post("/my-shop/cart/add", { sku_id: s.sku.id, qty: "1" });
  await b.post("/my-shop/tryon/submit", {
    store: "st-1",
    customer_name: "山田 花子",
    customer_email: "hanako@example.com",
    customer_phone: "090-1111-2222",
  });
  const r = s.sb.tables.tryon_requests[0]!;
  r["status"] = "ready";
  r["hold_until"] = hold;
  return { b, r };
}

describe("会員ページ", () => {
  it("取り置き中なら「取り置きを延長する」。押すと期限が延び、回数を使い切るとボタンが消える。お客様と店舗に知らせる hooks", async () => {
    const s = setup();
    s.sb.tables.hook_endpoints.push({
      id: "ep-1",
      shop_id: s.shop.id,
      name: "x",
      url: "https://example.com/h",
      events: ["tryon.updated"],
      enabled: true,
    });
    const { b, r } = await readyRequest(s);
    let html = await (await b.get("/my-shop/account")).text();
    expect(html).toContain("/my-shop/account/tryon/1/extend");
    expect(html).toContain("あと 1 回延長できます");
    const res = await b.post("/my-shop/account/tryon/1/extend", {});
    expect(res.headers.get("location")).toBe(
      "/my-shop/account?flash=tryon_extended",
    );
    expect(r["hold_until"]).toBe(addDays(todayHere(), 5));
    expect(r["extend_count"]).toBe(1);
    html = await (await b.get("/my-shop/account?flash=tryon_extended")).text();
    expect(html).toContain("お取り置きの期限を延長しました");
    expect(html).not.toContain("/my-shop/account/tryon/1/extend");
    expect(
      (await b.post("/my-shop/account/tryon/1/extend", {})).headers.get(
        "location",
      ),
    ).toBe("/my-shop/account?error=tryon_not_extendable");
    const hook = s.sb.tables.hook_deliveries
      .filter((d) => d["event"] === "tryon.updated")
      .at(-1);
    expect(hook?.["payload"]).toMatchObject({
      status: "ready",
      extended: true,
      extend_count: 1,
    });
  });

  it("延長の回数が 0（既定）のショップ・0151 を当てる前はボタンを出さず、送っても断る", async () => {
    const off = setup({});
    const a = await readyRequest(off);
    expect(await (await a.b.get("/my-shop/account")).text()).not.toContain(
      "/extend",
    );
    expect(
      (await a.b.post("/my-shop/account/tryon/1/extend", {})).headers.get(
        "location",
      ),
    ).toBe("/my-shop/account?error=tryon_not_extendable");
    const old = setup();
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter(
      (m) => m !== TRYON_EXTEND_MIGRATION,
    );
    const o = await readyRequest(old);
    expect(await (await o.b.get("/my-shop/account")).text()).not.toContain(
      "/extend",
    );
    expect(
      (await o.b.post("/my-shop/account/tryon/1/extend", {})).headers.get(
        "location",
      ),
    ).toBe("/my-shop/account?error=tryon_not_extendable");
    expect(o.r["hold_until"]).toBe(addDays(todayHere(), 2));
  });
});

describe("ヘッドレス", () => {
  it("一覧に extendable・extend_left、POST …/extend で延ばす。0151 の前は 409 migration_required", async () => {
    for (const before of [false, true]) {
      const s = setup();
      if (before)
        s.sb.appliedMigrations = s.sb.appliedMigrations.filter(
          (m) => m !== TRYON_EXTEND_MIGRATION,
        );
      await readyRequest(s);
      const call = async (path: string, body: unknown, token?: string) => {
        const res = await s.app.request(`${BASE}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://wp.example.com",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: res.status,
          json: (await res.json()) as Record<string, unknown>,
        };
      };
      const login = await call("/api/shops/my-shop/members/login", {
        email: "hanako@example.com",
      });
      const token = (
        await call("/api/shops/my-shop/members/verify", {
          challenge_id: login.json["challenge_id"],
          code: s.mail.code("hanako@example.com"),
        })
      ).json["access_token"] as string;
      const list = await call(
        "/api/shops/my-shop/members/tryon",
        undefined,
        token,
      );
      if (before) {
        expect(
          (list.json["requests"] as Record<string, unknown>[])[0],
        ).toMatchObject({ extendable: false });
        expect(
          await call("/api/shops/my-shop/members/tryon/1/extend", {}, token),
        ).toMatchObject({ status: 409, json: { error: "migration_required" } });
        continue;
      }
      expect(
        (list.json["requests"] as Record<string, unknown>[])[0],
      ).toMatchObject({ extendable: true, extend_left: 1, extend_count: 0 });
      const r = await call(
        "/api/shops/my-shop/members/tryon/1/extend",
        {},
        token,
      );
      expect(r).toMatchObject({
        status: 200,
        json: { ok: true, extend_count: 1 },
      });
      expect(
        await call("/api/shops/my-shop/members/tryon/1/extend", {}, token),
      ).toMatchObject({ status: 409, json: { error: "limit" } });
    }
  });
});

describe("判定とお知らせ", () => {
  it("memberExtendable: 取り置き中・期限が今日か先・回数が残っているとき。extend_count が無い（0151 の前）なら出さない", () => {
    const conf = { extend_max: 2 };
    expect(
      memberExtendable(
        { status: "ready", hold_until: "2030-01-10", extend_count: 1 },
        conf,
        "2030-01-10",
      ),
    ).toBe(true);
    expect(
      memberExtendable(
        { status: "ready", hold_until: "2030-01-09", extend_count: 0 },
        conf,
        "2030-01-10",
      ),
    ).toBe(false);
    expect(
      memberExtendable(
        { status: "ready", hold_until: "2030-01-10", extend_count: 2 },
        conf,
        "2030-01-10",
      ),
    ).toBe(false);
    expect(
      memberExtendable(
        { status: "sent", hold_until: null, extend_count: 0 },
        conf,
        "2030-01-10",
      ),
    ).toBe(false);
    expect(
      memberExtendable(
        { status: "ready", hold_until: "2030-01-10" },
        conf,
        "2030-01-10",
      ),
    ).toBe(false);
  });

  it("設定: 延長の回数は 0〜5、日数は 1〜30。画面に無い上限（同じ IP・申し込みの期限切れ）は保存し直しても保つ", () => {
    expect(
      tryonSettings({ store_tryon: { extend_max: 9, extend_days: 0 } }),
    ).toMatchObject({ extend_max: 0, extend_days: 3 });
    expect(
      tryonSettings({ store_tryon: { max_open_per_ip: 30, request_days: 7 } }),
    ).toMatchObject({
      max_open_per_ip: 30,
      request_days: 7,
      max_open_per_customer: 3,
    });
  });

  it("メール: お客様に「延長しました」、店舗のメール通知が ON なら店舗にも（前の期限と新しい期限）。LINE も延長の文", () => {
    const contact = {
      request_id: "r1",
      number: 7,
      status: "ready",
      visit_date: null,
      hold_until: "2026-10-27",
      customer_email: "a@example.com",
      customer_name: "山田",
      customer_phone: "0312345678",
      note: null,
      store: {
        name: "渋谷店",
        postal_code: null,
        address: null,
        phone: null,
        hours: {},
        special_days: [],
        email: "st@example.com",
        notify_email: true,
      },
      shop: { name: "マイショップ", slug: "my-shop", contact_email: null },
      items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3000 }],
    };
    const mails = buildTryonMails("tryon.updated", contact, BASE, {
      extended: true,
      previousHoldUntil: "2026-10-24",
    });
    expect(mails.map((m) => m.to)).toEqual(["a@example.com", "st@example.com"]);
    expect(mails[0]!.subject).toContain("延長しました");
    expect(mails[0]!.text).toContain("10月27日");
    expect(mails[1]!.text).toContain("延長前の期限: 10月24日");
    expect(
      buildTryonMails(
        "tryon.updated",
        { ...contact, store: { ...contact.store, notify_email: false } },
        BASE,
        { extended: true },
      ).map((m) => m.to),
    ).toEqual(["a@example.com"]);
    const line = tryonLineMessage(
      "tryon.updated",
      {
        number: 7,
        status: "ready",
        hold_until: "2026-10-27",
        store_name: "渋谷店",
        shop_name: "マイショップ",
      },
      { extended: true },
    );
    expect(line).toContain("10月27日まで延長しました");
  });
});
