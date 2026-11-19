import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts, memberLogin, memberMail } from "./helpers";
import { loginUrlFor, safeShopPath } from "../src/members/return-path";
import { routesObject } from "../src/themes/liquid/objects";

/** ログイン・LINE / Google を結んだ後に戻るお店の中のパス（return_to）。LINE・Google の流れは test/members-password-line.test.ts */
afterEach(() => externalHosts.clear());

describe("戻る先の検査（src/members/return-path.ts）", () => {
  it("同じショップの中のパスだけ。外のサイト・別のショップ・ログインの途中の画面・banto_ の鍵・# は受けない", () => {
    const ok: [string, string][] = [
      ["/my-shop/products/tee", "/my-shop/products/tee"],
      ["/my-shop/products/tee?color=red&size=M", "/my-shop/products/tee?color=red&size=M"],
      ["/my-shop", "/my-shop"],
      ["/my-shop/account", "/my-shop/account"],
      ["/my-shop/account/orders", "/my-shop/account/orders"],
      ["/my-shop/products/%E3%83%86", "/my-shop/products/%E3%83%86"],
      // レジ（POST だけの画面）はカートへ
      ["/my-shop/checkout/stripe", "/my-shop/cart"],
    ];
    for (const [raw, want] of ok) expect([raw, safeShopPath(raw, "/my-shop")]).toEqual([raw, want]);
    const bad = [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "/my-shop/../other-shop/x",
      "/other-shop/products/x",
      "/my-shopx/products",
      "/my-shop/account/login",
      "/my-shop/account/code",
      "/my-shop/account/verify?c=1",
      "/my-shop/account/logout",
      "/my-shop/account/oauth/line",
      "/_oauth/line/callback",
      "/my-shop/products/tee?banto_handoff=x",
      "/my-shop/products/tee?Banto.Handoff=x",
      "/my-shop/products/tee#x",
      "/my-shop/products/tee?a=1;b=2",
      "/my-shop/products/te e",
      "/my-shop/products/tee\n",
      "my-shop/products",
      "",
      `/my-shop/${"a".repeat(1000)}`,
      null,
      42,
    ];
    for (const raw of bad) expect([raw, safeShopPath(raw, "/my-shop")]).toEqual([raw, null]);
    // 独自ドメインの上（ショップのパスが ""）: ドメインの中のパスなら受ける
    expect(safeShopPath("/products/tee", "")).toBe("/products/tee");
    expect(safeShopPath("/account/login", "")).toBeNull();
    expect(safeShopPath("//evil.example", "")).toBeNull();
  });

  it("ログインのリンクに今のページを付ける（戻せないページなら付けない）。Liquid の routes.account_login_url も同じ", () => {
    expect(loginUrlFor("/my-shop", "/my-shop/products/tee?color=red")).toBe("/my-shop/account/login?return_to=%2Fmy-shop%2Fproducts%2Ftee%3Fcolor%3Dred");
    expect(loginUrlFor("/my-shop", "/my-shop/account/login")).toBe("/my-shop/account/login");
    expect(loginUrlFor("/my-shop", undefined)).toBe("/my-shop/account/login");
    expect(routesObject("", { currentPath: "/cart" }).account_login_url).toBe("/account/login?return_to=%2Fcart");
  });
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 10 });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "member@example.com", session_epoch: 0, attributes: {} });
  const mail = memberMail(sb, shop.id);
  const fresh = () => new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
  return { sb, mail, fresh };
}

describe("お店の画面のログイン", () => {
  it("商品ページのヘッダの「ログイン」に今のページ。コードでログインすると、会員ページがそのページへ戻す", async () => {
    const { mail, fresh } = setup();
    const b = fresh();
    const page = await (await b.get("/my-shop/products/tee")).text();
    expect(page).toContain('href="/my-shop/account/login?return_to=%2Fmy-shop%2Fproducts%2Ftee"');
    await b.get("/my-shop/account/login?return_to=%2Fmy-shop%2Fproducts%2Ftee");
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/products/tee");
    // 一度戻したら忘れる
    expect((await b.get("/my-shop/account")).status).toBe(200);
    // ログインしている人がログインのリンクを開いたら、そのまま戻る先へ
    expect((await b.get("/my-shop/account/login?return_to=%2Fmy-shop%2Fcart")).headers.get("location")).toBe("/my-shop/cart");
  });

  it("外のサイトを渡されても戻さない（会員ページのまま）", async () => {
    const { mail, fresh } = setup();
    const b = fresh();
    await b.get("/my-shop/account/login?return_to=https%3A%2F%2Fevil.example%2F");
    await b.get("/my-shop/account/login?return_to=%2F%2Fevil.example");
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect((await b.get("/my-shop/account")).status).toBe(200);
  });

  it("メールのログインのリンクにも戻る先を載せ、別の端末で開いても戻れる", async () => {
    const { mail, fresh } = setup();
    const b = fresh();
    await b.post("/my-shop/account/login", { email: "member@example.com", return_to: "/my-shop/products/tee" });
    const link = mail.link("member@example.com");
    expect(new URL(link).searchParams.get("r")).toBe("/my-shop/products/tee");
    const other = fresh();
    const u = new URL(link);
    const verify = await (await other.get(`${u.pathname}${u.search}`)).text();
    const c = /name="c" value="([^"]+)"/.exec(verify)![1]!;
    const t = /name="t" value="([^"]+)"/.exec(verify)![1]!;
    expect((await other.post("/my-shop/account/verify", { c, t })).headers.get("location")).toBe("/my-shop/account");
    expect((await other.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/products/tee");
  });
});
