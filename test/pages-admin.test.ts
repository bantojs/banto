import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, tinyPng } from "./helpers";
import { PAGES_MIGRATION } from "../src/pages";

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
});
