import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberMail } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { issueTokens, openSession, openToken, sealSession } from "../src/members/auth";
import { AUDIENCES_MIGRATION } from "../src/members/audience";

/** 同梱モジュール「会員の条件」（0097、docs/audiences.md）: 管理画面・会員の Cookie とトークンに載る値 */

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

const FIELDS = [
  { key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] },
  { key: "points", label: "ポイント", type: "number" },
  { key: "memo", label: "社内メモ", type: "text" },
];

function setup(opts: { applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { audiences: true }, customer_fields: FIELDS, headless: { return_origins: ["https://wp.example.com"] } } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, app, mail };
}

describe("管理画面", () => {
  it("組み立てで作る（会員 かつ どれか）→ 一覧に説明。開き直すと組み立てに戻る", async () => {
    const { app, shop, sb } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/audiences`;
    expect(await (await b.get(`/admin/shops/${shop.id}/modules`)).text()).toContain('data-module="audiences"');
    const res = await b.post(base, { name: "VIP", member: "on", join: "any", attr_0: "rank", op_0: "in", value_0: "gold、platinum", attr_1: "points", op_1: "gte", value_1: "10000", attr_2: "memo", op_2: "in", value_2: "" });
    expect(res.headers.get("location")).toContain("flash=saved");
    const row = sb.tables.audiences[0]!;
    expect(row["condition"]).toEqual({ all: [{ member: true }, { any: [{ attr: "rank", in: ["gold", "platinum"] }, { attr: "points", gte: 10000 }] }] });
    expect(await (await b.get(base)).text()).toContain("会員 かつ （ランク = gold / platinum または ポイント ≥ 10000）");
    const edit = await (await b.get(`${base}/${row["id"]}`)).text();
    expect(edit).toMatch(/name="value_0" value="gold, platinum"/);
    expect(edit).toMatch(/<input type="radio" name="join" value="any" checked/);
  });

  it("入れ子は JSON の欄で。空・壊れた JSON は保存しない。0097 の前は一覧に出ない", async () => {
    const { app, shop, sb } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/audiences`;
    expect((await b.post(base, { name: "x", join: "all" })).headers.get("location")).toContain("flash=empty");
    expect((await b.post(base, { name: "x", condition_json: "{nope" })).headers.get("location")).toContain("flash=invalid");
    const nested = { all: [{ member: true }, { not: { any: [{ attr: "rank", in: ["silver"] }, { attr: "points", lte: 10 }] } }] };
    await b.post(base, { name: "入れ子", condition_json: JSON.stringify(nested) });
    const row = sb.tables.audiences[0]!;
    expect(row["condition"]).toEqual(nested);
    const edit = await (await b.get(`${base}/${row["id"]}`)).text();
    expect(edit).toContain("<details open");
    const old = setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v !== AUDIENCES_MIGRATION) });
    const b2 = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await b2.get(`/admin/shops/${old.shop.id}/modules`)).text()).not.toContain('data-module="audiences"');
  });
});

describe("会員の Cookie とトークン", () => {
  it("Cookie・access に入れた値は開くと戻る（壊れた鍵は捨てる）", async () => {
    const sealed = await sealSession("s", "shop", { cid: "c", ep: 0, exp: Math.floor(Date.now() / 1000) + 60, email: "", sid: "x", at: { rank: "gold", points: 3 } });
    expect((await openSession("s", "shop", sealed))?.at).toEqual({ rank: "gold", points: 3 });
    const t = await issueTokens("s", "shop", "c", 0, { sid: "x", gen: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, undefined, { rank: "gold" });
    expect((await openToken("s", "shop", t.access_token, "a"))?.at).toEqual({ rank: "gold" });
    expect((await openToken("s", "shop", t.refresh_token, "r"))?.at).toBeUndefined();
  });

  it("ヘッドレス: ログインと refresh で、条件で使っている独自項目の値だけを access に入れる", async () => {
    const { sb, shop, app, mail } = setup();
    sb.tables.audiences.push({ id: "a1", shop_id: shop.id, name: "gold", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "hanako@example.com", session_epoch: 0, attributes: { rank: "gold", memo: "社内のみ" } });
    const call = async (path: string, body: unknown) => (await (await app.request(`${BASE}${path}`, { method: "POST", headers: { origin: "https://wp.example.com", "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, string>;
    const ch = (await call("/api/shops/my-shop/members/login", { email: "hanako@example.com" }))["challenge_id"];
    const tok = await call("/api/shops/my-shop/members/verify", { challenge_id: ch, code: mail.code("hanako@example.com") });
    expect((await openToken("test-session-secret", shop.id, tok["access_token"]!, "a"))?.at).toEqual({ rank: "gold" });
    sb.tables.customers.find((c) => c["email"] === "hanako@example.com")!["attributes"] = { rank: "silver" };
    const next = await call("/api/shops/my-shop/members/refresh", { refresh_token: tok["refresh_token"] });
    expect((await openToken("test-session-secret", shop.id, next["access_token"]!, "a"))?.at).toEqual({ rank: "silver" });
  });
});
