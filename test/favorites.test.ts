import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberMail } from "./helpers";
import { favoritesScript, parseFavoriteBody } from "../src/modules/favorites";

/** 会員のお気に入り（同梱モジュール favorites、0123、docs/favorites.md）。DB の規則は test/db/favorites.test.ts */
let dispose = () => {};
afterEach(() => dispose());

function setup(opts: { on?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "お気に入りのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, contact_email: "shop@example.com", modules: { favorites: opts.on ?? true } } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE", name: "M", price_jpy: 3000, available: 5 });
  const cap = sb.addProduct(shop.id, { slug: "cap", name: "帽子", published: true });
  sb.addSku(shop.id, cap.id, { code: "CAP", name: "F", price_jpy: 2000, available: 5 });
  const draft = sb.addProduct(shop.id, { slug: "draft", name: "下書き", published: false });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, new MemoryStorage(`${BASE}/media`), new FakeStripe());
  return { sb, shop, tee, cap, draft, mail, app, b: new Browser(app, BASE) };
}

async function login(b: Browser, mail: ReturnType<typeof memberMail>, email = "hanako@example.com") {
  await b.post("/s/account/login", { email });
  const res = await b.post("/s/account/code", { code: mail.code(email) });
  expect(res.headers.get("location")).toBe("/s/account");
}

describe("お気に入り（お店の画面）", () => {
  it("ON なら商品ページと一覧のカードにボタン、<head> にスクリプト（ゲストはブラウザだけ）。OFF なら何も出さない", async () => {
    const { b, tee } = setup();
    const page = await (await b.get("/s/products/tee")).text();
    expect(page).toContain(`data-banto-favorite="${tee.id}"`);
    expect(page).toContain('"/s/account/favorites",M=false');
    const list = await (await b.get("/s/products")).text();
    expect(list).toContain(`<button type="button" class="banto-fav" data-banto-favorite="${tee.id}" aria-pressed="false"`);
    const off = setup({ on: false });
    const html = await (await off.b.get("/s/products/tee")).text();
    expect(html).not.toContain("data-banto-favorite");
    expect(html).not.toContain("banto_fav_");
    expect((await off.b.get("/s/account/favorites.json")).status).toBe(404);
  });

  it("会員: 足す・一覧（JSON と会員ページ）・外す。ゲストの分をログインで移す。見えない商品は 404。ログインしていなければ 401", async () => {
    const { b, mail, tee, cap, draft, sb } = setup();
    expect(await (await b.get("/s/account/favorites.json")).json()).toEqual({ ids: [], member: false });
    expect((await b.postJson("/s/account/favorites", { product_id: tee.id, on: true })).status).toBe(401);
    await login(b, mail);
    expect((await b.get("/s/products/tee")).ok).toBe(true);
    expect(await (await b.get("/s/products/tee")).text()).toContain(",M=true");
    expect((await b.postJson("/s/account/favorites", { product_id: tee.id, on: true })).status).toBe(200);
    expect((await b.postJson("/s/account/favorites", { product_id: draft.id, on: true })).status).toBe(404);
    expect((await b.postJson("/s/account/favorites", { product_id: "x", on: true })).status).toBe(400);
    // ゲストのときブラウザに覚えた分（重なり・見えない商品は捨てる）
    const merged = await (await b.postJson("/s/account/favorites", { merge: [cap.id, tee.id, draft.id] })).json();
    expect(merged).toEqual({ ok: true, merged: 1 });
    const json = (await (await b.get("/s/account/favorites.json")).json()) as { ids: string[]; member: boolean };
    expect(json.member).toBe(true);
    expect(json.ids.sort()).toEqual([tee.id, cap.id].sort());
    const account = await (await b.get("/s/account")).text();
    expect(account).toContain('<section id="favorites">');
    expect(account).toContain("Tシャツ");
    expect(account).toContain("帽子");
    // 会員ページの「外す」（スクリプトなしのフォーム）
    expect((await b.post("/s/account/favorites/remove", { product_id: tee.id })).headers.get("location")).toBe("/s/account#favorites");
    expect(sb.tables.customer_favorites.map((x) => x["product_id"])).toEqual([cap.id]);
    // 外から（Origin が違う）は断る
    expect((await b.postJson("/s/account/favorites", { product_id: tee.id, on: true }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("ヘッドレス: 会員トークンで一覧・足す・外す・移す", async () => {
    const { app, mail, tee, cap, shop } = setup();
    const sbShop = shop;
    const start = await app.request(`${BASE}/api/shops/s/members/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "taro@example.com" }) });
    expect(start.status).toBe(200);
    const { challenge_id } = (await start.json()) as { challenge_id: string };
    const ver = await app.request(`${BASE}/api/shops/s/members/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id, code: mail.code("taro@example.com") }) });
    const { access_token } = (await ver.json()) as { access_token: string };
    const h = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };
    expect((await app.request(`${BASE}/api/shops/s/members/favorites`, { method: "POST", headers: h, body: JSON.stringify({ product_id: tee.id, on: true }) })).status).toBe(200);
    expect(await (await app.request(`${BASE}/api/shops/s/members/favorites/merge`, { method: "POST", headers: h, body: JSON.stringify({ product_ids: [cap.id] }) })).json()).toEqual({ ok: true, merged: 1 });
    const list = (await (await app.request(`${BASE}/api/shops/s/members/favorites`, { headers: h })).json()) as { items: { slug: string }[] };
    expect(list.items.map((x) => x.slug).sort()).toEqual(["cap", "tee"]);
    expect((await app.request(`${BASE}/api/shops/s/members/favorites`, { method: "POST", headers: h, body: JSON.stringify({ product_id: tee.id, on: false }) })).status).toBe(200);
    expect((await app.request(`${BASE}/api/shops/s/members/favorites`)).status).toBe(401);
    void sbShop;
  });
});

describe("お気に入り（運営者）", () => {
  it("会員ごとのお気に入りの画面と、商品の一覧の人数", async () => {
    const { b, mail, app, tee, sb, shop } = setup();
    await login(b, mail);
    await b.postJson("/s/account/favorites", { product_id: tee.id, on: true });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const cid = String(sb.tables.customers[0]!["id"]);
    expect(await (await owner.get(`/admin/shops/${shop.id}/customers`)).text()).toContain(`/admin/shops/${shop.id}/customers/${cid}/favorites`);
    const page = await (await owner.get(`/admin/shops/${shop.id}/customers/${cid}/favorites`)).text();
    expect(page).toContain(`<a href="/admin/shops/${shop.id}/products/${tee.id}">Tシャツ</a>`);
    const products = await (await owner.get(`/admin/shops/${shop.id}/products`)).text();
    expect(products).toContain("<th>お気に入り</th>");
  });
});

describe("部品", () => {
  it("書き込みの本文の形", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(parseFavoriteBody({ product_id: id, on: true })).toEqual({ kind: "set", productId: id, on: true });
    expect(parseFavoriteBody({ product_id: id })).toBeNull();
    expect(parseFavoriteBody({ merge: [id, id, "x"] })).toEqual({ kind: "merge", productIds: [id] });
    expect(parseFavoriteBody({ merge: Array.from({ length: 51 }, () => id) })).toBeNull();
  });

  it("スクリプトに </script や <!-- が入らない", () => {
    const code = favoritesScript({ url: "/s/account/favorites</script>", member: true, key: "k" });
    expect(code).not.toMatch(/<\/script|<!--/i);
  });
});
