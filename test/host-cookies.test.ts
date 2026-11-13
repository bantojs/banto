import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { cartCookieName } from "../src/cart/cart";
import { customerCookieName } from "../src/routes/storefront/members";
import { HOST_PREFIX, readScopedCookie, scopedClearCookies, scopedCookieName, scopedSetCookies } from "../src/util/cookie";

/**
 * Cookie の `__Host-` の接頭辞（src/util/cookie.ts、docs/knowledge/02-decisions.md 2026-11-13）。
 * HTTPS で Path=/ に置く Cookie（ショップのドメインの上のお店の Cookie・管理画面のセッション）は `__Host-` の名前にし、
 * 同じ登録ドメインの別のホストから `Domain=` で差し込まれた古い名前の Cookie は信じない（カートだけは移す間も読む）。
 */

const DOMAIN = "shop.example.jp";
const SHOP_URL = `https://${DOMAIN}`;

describe("名前と見出し（src/util/cookie.ts）", () => {
  const https = { path: "/", secure: true };
  it("HTTPS で Path=/ のときだけ __Host- の名前", () => {
    expect(scopedCookieName("banto_x", https)).toBe("__Host-banto_x");
    expect(scopedCookieName("banto_x", { path: "/", secure: false })).toBe("banto_x");
    expect(scopedCookieName("banto_x", { path: "/my-shop", secure: true })).toBe("banto_x");
  });

  it("__Host- の場面では __Host- の名前だけを読み、同じ名前が 2 つあれば無いものとして扱う。古い名前は頼まれたときだけ", () => {
    expect(readScopedCookie("banto_x=old; __Host-banto_x=new", "banto_x", https)).toBe("new");
    expect(readScopedCookie("banto_x=old", "banto_x", https)).toBeUndefined();
    expect(readScopedCookie("banto_x=old", "banto_x", https, { legacy: true })).toBe("old");
    expect(readScopedCookie("__Host-banto_x=a; __Host-banto_x=b", "banto_x", https)).toBeUndefined();
    expect(readScopedCookie("__Host-banto_x=a; __Host-banto_x=b; banto_x=old", "banto_x", https, { legacy: true })).toBeUndefined();
    // http・スラッグのパスでは今までどおり
    expect(readScopedCookie("banto_x=old", "banto_x", { path: "/my-shop", secure: true })).toBe("old");
    expect(readScopedCookie(undefined, "banto_x", https)).toBeUndefined();
  });

  it("置くとき、古い名前が届いていれば先に消す。パスが変わったものは前のパスで消す", () => {
    expect(scopedSetCookies(undefined, "banto_x", "v", { ...https, maxAge: 60 })).toEqual(["__Host-banto_x=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure"]);
    expect(scopedSetCookies("banto_x=old", "banto_x", "v", { ...https, maxAge: 60 })).toEqual([
      "banto_x=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "__Host-banto_x=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
    ]);
    expect(scopedSetCookies("banto_admin=old", "banto_admin", "v", { path: "/", secure: false, maxAge: 60, legacyPath: "/admin" })).toEqual([
      "banto_admin=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0",
      "banto_admin=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
    ]);
    expect(scopedSetCookies("banto_x=old", "banto_x", "v", { path: "/my-shop", secure: true, maxAge: 60 })).toEqual(["banto_x=v; Path=/my-shop; HttpOnly; SameSite=Lax; Max-Age=60; Secure"]);
    expect(scopedClearCookies("banto_admin", { path: "/", secure: true, legacyPath: "/admin" })).toEqual([
      "__Host-banto_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "banto_admin=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
  });
});

function shopSetup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    domain: DOMAIN,
    settings: { members_enabled: true },
  });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, sku, app };
}

describe("ショップのドメイン（https）の Cookie", () => {
  it("会員のログインは __Host- の名前だけを信じる。古い名前に写した値・重なった名前ではログインしていないことになる", async () => {
    const { sb, shop, app } = shopSetup();
    const mail = memberMail(sb, shop.id);
    try {
      const b = new Browser(app, SHOP_URL);
      await memberLogin(b, mail, "", "m@example.com");
      const name = customerCookieName(shop.id);
      const value = b.cookies.get(`${HOST_PREFIX}${name}`)!;
      expect(value).toBeTruthy();
      expect((await b.get("/account")).status).toBe(200);

      // 同じ登録ドメインの別のホストが Domain= で置ける古い名前に、正しい値を置いても使わない
      const forged = new Browser(app, SHOP_URL);
      forged.cookies.set(name, value);
      const res = await forged.get("/account");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/account/login");

      // __Host- の名前が 2 つ届いたら（差し込みと本物の区別がつかない）、無いものとして扱う
      const twice = await app.request(`${SHOP_URL}/account`, { headers: { cookie: `${HOST_PREFIX}${name}=${value}; ${HOST_PREFIX}${name}=${value}` }, redirect: "manual" });
      expect(twice.status).toBe(302);
    } finally {
      mail.dispose();
    }
  });

  it("カートは移す間も古い名前を読み、次に書くときに __Host- へ移して古い名前を消す", async () => {
    const { shop, sku, app } = shopSetup();
    const http = new Browser(app, SHOP_URL);
    await http.post("/cart/add", { sku_id: sku.id, qty: "1" });
    const name = cartCookieName(shop.id);
    const sealed = http.cookies.get(`${HOST_PREFIX}${name}`)!;
    expect(sealed).toBeTruthy();

    const old = new Browser(app, SHOP_URL);
    old.cookies.set(name, sealed);
    expect(await (await old.get("/cart")).text()).toContain("Tシャツ");
    const res = await old.post("/cart/add", { sku_id: sku.id, qty: "1" });
    const set = res.headers.getSetCookie();
    expect(set[0]).toBe(`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
    expect(set.some((c) => c.startsWith(`${HOST_PREFIX}${name}=`) && c.includes("Secure"))).toBe(true);
    expect(old.cookies.has(name)).toBe(false);
    expect(old.cookies.has(`${HOST_PREFIX}${name}`)).toBe(true);
  });

  it("Banto の URL（/<スラッグ>）の Cookie は、今までどおりの名前とパス", async () => {
    const { sb, shop, sku, app } = shopSetup();
    sb.tables.shops.find((s) => s["id"] === shop.id)!["domain"] = null;
    const b = new Browser(app);
    const res = await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${cartCookieName(shop.id)}=`))).toContain("Path=/my-shop;");
  });
});

describe("管理画面のセッション（https）", () => {
  const ADMIN = "https://admin.example.com";
  function adminSetup() {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const app = appWith(sb, { PUBLIC_BASE_URL: ADMIN });
    return { app };
  }

  it("__Host-banto_admin（Path=/・Secure）に置き、古い Path=/admin の Cookie は消す。古い名前ではログインしていないことになる", async () => {
    const { app } = adminSetup();
    const b = new Browser(app, ADMIN);
    b.cookies.set("banto_admin", "stale");
    const res = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" }, { origin: ADMIN });
    expect(res.headers.get("location")).toBe("/admin");
    const set = res.headers.getSetCookie();
    expect(set).toContain("banto_admin=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    expect(set.some((c) => c.startsWith("__Host-banto_admin=") && c.includes("Path=/;") && c.includes("Secure"))).toBe(true);
    expect((await b.get("/admin")).status).toBe(200);

    const value = b.cookies.get("__Host-banto_admin")!;
    const forged = new Browser(app, ADMIN);
    forged.cookies.set("banto_admin", value);
    const page = await forged.get("/admin");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toMatch(/^\/admin\/(login|setup)/);
  });

  it("http（手元の確認）では今までの名前のまま、パスはホスト全体", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    const res = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.headers.getSetCookie().find((c) => c.startsWith("banto_admin="))).toContain("Path=/;");
    expect(b.cookies.has("banto_admin")).toBe(true);
    expect(BASE.startsWith("http://")).toBe(true);
  });
});
