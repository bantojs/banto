import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, tinyPng } from "./helpers";
import { PAGES_MIGRATION, handleFromTitle } from "../src/pages";
import { PAGE_BLOCKS_SCRIPT } from "../src/modules/pages/blocks-script";

/** ショップのページの管理画面（同梱モジュール pages、0079）。扱えるのは content の項目を持つ人。本文は決まった書式でプレビューできる */
function setup(opts: { enabled?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: opts.enabled === false ? {} : { modules: { pages: true } } });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  return { sb, shop, app, storage, base: `/admin/shops/${shop.id}/modules/pages` };
}

async function staff(sb: FakeSupabase, app: ReturnType<typeof appWith>, shop: { id: string; org_id?: unknown }, email: string, perms: string[]) {
  const u = sb.addUser(email, "password-123");
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
  sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
  return Browser.loggedIn(app, email, "password-123");
}

const form = { title: "私たちについて", handle: "about", body: "## 店のこと\n\n**手しごと**の店です。<b>x</b>", nav: "header", sort_order: "0", published: "on", action: "save" };

describe("ショップのページの管理画面", () => {
  it("モジュールの一覧に出て ON にでき、0079 が当たるまでは出ない", async () => {
    const { sb, app, shop } = setup({ enabled: false });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`/admin/shops/${shop.id}/modules`)).text()).toContain('data-module="pages"');
    await owner.post(`/admin/shops/${shop.id}/modules/pages/enabled`, { enabled: "on" });
    expect(((sb.tables.shops[0]!["settings"] as Record<string, unknown>)["modules"] as Record<string, unknown>)["pages"]).toBe(true);
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== PAGES_MIGRATION);
    const fresh = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await fresh.get(`/admin/shops/${shop.id}/modules`)).text()).not.toContain('data-module="pages"');
    expect((await fresh.post(`/admin/shops/${shop.id}/modules/pages/enabled`, { enabled: "on" })).status).toBe(404);
  });

  it("content の項目の人が作り・直し・消せる。プレビューは保存しない。タブに出る", async () => {
    const { sb, app, shop, base } = setup();
    const writer = await staff(sb, app, shop, "writer@example.com", ["content"]);
    const list = await (await writer.get(base)).text();
    expect(list).toContain(`href="/admin/shops/${shop.id}/modules/pages"`);
    const preview = await writer.post(base, { ...form, action: "preview" });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("<h2>店のこと</h2>");
    expect(html).toContain("<strong>手しごと</strong>の店です。&lt;b&gt;x&lt;/b&gt;");
    expect(sb.tables.pages).toHaveLength(0);
    const created = await writer.post(base, form);
    expect(created.status).toBe(302);
    const page = sb.tables.pages[0]!;
    expect(page).toMatchObject({ shop_id: shop.id, handle: "about", title: "私たちについて", nav: "header", published: true, template_suffix: null });
    expect(created.headers.get("location")).toBe(`${base}/${String(page["id"])}?flash=saved`);
    expect(await (await writer.get(`${base}/${String(page["id"])}`)).text()).toContain('value="about"');
    await writer.post(`${base}/${String(page["id"])}`, { ...form, title: "店について", published: "", template_suffix: "FAQ" });
    expect(page).toMatchObject({ title: "店について", published: false, template_suffix: "faq" });
    await writer.post(`${base}/${String(page["id"])}/delete`, {});
    expect(sb.tables.pages).toHaveLength(0);
  });

  it("入れた値の誤りは入れた値を残したまま知らせる（ハンドル・タイトル・重なり）", async () => {
    const { sb, app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const bad = await owner.post(base, { ...form, handle: "legal", body: "残す本文" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain('class="error"');
    expect(badHtml).toContain("残す本文");
    expect((await owner.post(base, { ...form, title: " " })).status).toBe(400);
    await owner.post(base, form);
    const dup = await owner.post(base, form);
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain("この URL の名前はもう使われています。");
    expect(sb.tables.pages).toHaveLength(1);
  });

  it("ほかの項目の人とモジュールが OFF のショップでは開けない", async () => {
    const { sb, app, shop, base } = setup();
    const catalog = await staff(sb, app, shop, "catalog@example.com", ["catalog"]);
    expect((await catalog.get(base)).status).toBe(404);
    expect((await catalog.post(base, form)).status).toBe(404);
    const off = setup({ enabled: false });
    const owner = await Browser.loggedIn(off.app, "owner@example.com", "password-123");
    expect((await owner.get(off.base)).status).toBe(404);
  });

  it("画像は中身で種類を確かめて pages/<ショップ>/ に置き、JSON で URL を返す。SVG は置けない", async () => {
    const { app, base, shop, storage } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const json = await owner.postMultipart(`${base}/images`, { file: new File([tinyPng()], "a.webp", { type: "image/webp" }) }, { headers: { accept: "application/json" } });
    expect(json.status).toBe(200);
    const { url } = (await json.json()) as { url: string };
    // 申告の Content-Type ではなく中身（PNG）で拡張子を決める
    expect(url).toMatch(new RegExp(`^${BASE}/media/pages/${shop.id}/[0-9a-f]+\\.png$`));
    expect(await storage.get(url.slice(`${BASE}/media/`.length))).not.toBeNull();
    // JS の無いブラウザ: 直していたページへ戻り、貼る行を出す
    const plain = await owner.postMultipart(`${base}/images`, { file: new File([tinyPng()], "a.png", { type: "image/png" }), back: `${base}/new` });
    expect(plain.headers.get("location")).toMatch(new RegExp(`^${base}/new\\?image=`));
    const svg = await owner.postMultipart(`${base}/images`, { file: new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], "x.png", { type: "image/png" }) });
    expect(svg.headers.get("location")).toContain("flash=image_error");
  });

  it("編集の画面: 上のバーのボタンで下書き保存・公開・更新・下書きに戻す。プレビューは新しいタブで保存しない", async () => {
    const { sb, app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const blank = await (await owner.get(`${base}/new`)).text();
    // 新しいページ: 下書き保存（Ctrl+S の先）と公開。プレビューは新しいタブ
    expect(blank).toMatch(/<button[^>]*name="action"[^>]*value="draft"[^>]*data-save="1"/);
    expect(blank).toMatch(/<button[^>]*name="action"[^>]*value="publish"/);
    expect(blank).toMatch(/<button[^>]*value="preview"[^>]*formtarget="_blank"/);
    expect(blank).toContain('data-auto="1"');
    const { published: _p, ...draftForm } = form;
    await owner.post(base, { ...draftForm, action: "draft" });
    const page = sb.tables.pages[0]!;
    expect(page["published"]).toBe(false);
    const id = String(page["id"]);
    // 公開 → 公開中の画面は「更新」と「下書きに戻す」
    await owner.post(`${base}/${id}`, { ...draftForm, action: "publish" });
    expect(page["published"]).toBe(true);
    const live = await (await owner.get(`${base}/${id}`)).text();
    expect(live).toMatch(/<button[^>]*value="update"[^>]*data-save="1"/);
    expect(live).toMatch(/<button[^>]*value="draft"[^>]*>下書きに戻す/);
    expect(live).toContain("/my-shop/pages/about");
    await owner.post(`${base}/${id}`, { ...draftForm, published: "on", action: "update", title: "更新した" });
    expect(page).toMatchObject({ title: "更新した", published: true });
    await owner.post(`${base}/${id}`, { ...draftForm, title: "更新した", published: "on", action: "draft" });
    expect(page["published"]).toBe(false);
    // プレビューは保存せず、本文をお店の画面と同じ変換で見せる
    const preview = await (await owner.post(`${base}/${id}`, { ...draftForm, title: "見るだけ", action: "preview" })).text();
    expect(preview).toContain("<h1>見るだけ</h1>");
    expect(preview).toContain("<h2>店のこと</h2>");
    expect(page["title"]).toBe("更新した");
  });

  it("URL の名前が空ならタイトルから作り、作れなければ page-xxxxxx。重なったら作り直す", async () => {
    const { sb, app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await owner.post(base, { ...form, title: "About Us!", handle: "" });
    await owner.post(base, { ...form, title: "About us", handle: "" });
    await owner.post(base, { ...form, title: "私たちについて", handle: "" });
    await owner.post(base, { ...form, title: "Shipping", handle: "" });
    const handles = sb.tables.pages.map((p) => String(p["handle"]));
    expect(handles[0]).toBe("about-us");
    expect(handles[1]).toMatch(/^page-[a-z0-9]{6}$/);
    expect(handles[2]).toMatch(/^page-[a-z0-9]{6}$/);
    expect(handles[3]).toMatch(/^page-[a-z0-9]{6}$/);
    expect(handleFromTitle("Café Été 2026")).toBe("cafe-ete-2026");
    expect(handleFromTitle("cart")).toBe("");
    // 手で入れた名前が重なったら作り直さずに知らせる
    expect((await owner.post(base, { ...form, title: "x", handle: "about-us" })).status).toBe(409);
  });

  it("ブロックの操作のスクリプトは文として正しく、文言は画面から受け取る", async () => {
    expect(() => new Function(PAGE_BLOCKS_SCRIPT)).not.toThrow();
    const { app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await owner.get(`${base}/new`)).text();
    expect(html).toContain('data-t-add="ブロックを追加"');
    expect(html).toContain('data-reserved="legal,privacy,returns,shipping,cart,checkout,account,search,orders,inquiries"');
    expect(html).toContain('id="blk-add-end"');
  });
});
