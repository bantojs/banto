import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberLogin, memberMail } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { issueTokens } from "../src/members/auth";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { AUDIENCES_MIGRATION } from "../src/members/audience";

/** 本文の見せる相手の囲み（0097、docs/audiences.md「本文のブロック」）: お店の画面・Liquid・ヘッドレスの公開 API */

const GOLD = "11111111-1111-4111-8111-111111111111";
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
const BODY = `誰でも\n\n::: audience id=${GOLD} title="ゴールド"\nゴールドだけの案内\n:::\n\nおわり`;

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  forgetThemes();
});

function setup(opts: { modules?: Record<string, boolean>; applied?: string[]; liquid?: Record<string, string> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "S",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: true, modules: opts.modules ?? { pages: true, blog: true, audiences: true }, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }] },
  });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  sb.addPage(shop.id, { handle: "about", title: "案内", body: BODY });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  sb.addArticle(shop.id, blog.id, { handle: "hello", title: "こんにちは", body: BODY });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "silver@example.com", session_epoch: 0, attributes: { rank: "silver" } });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, storage, new FakeStripe());
  return { sb, shop, app, mail, base: opts.liquid ? DOMAIN : BASE };
}

describe("お店の画面", () => {
  it("ゲスト・合わない会員には中身が出ず、合う会員には出る（ページと記事。HTML の覚えは区分けする）", async () => {
    const { app, mail } = setup();
    for (const path of ["/my-shop/pages/about", "/my-shop/blogs/news/hello"]) {
      const guest = await (await new Browser(app, BASE).get(path)).text();
      expect(guest).toContain("誰でも");
      expect(guest).toContain("おわり");
      expect(guest).not.toContain("ゴールドだけ");
      expect(guest).not.toContain("audience");
    }
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    expect(await (await gold.get("/my-shop/pages/about")).text()).toContain("ゴールドだけの案内");
    expect(await (await gold.get("/my-shop/blogs/news/hello")).text()).toContain("ゴールドだけの案内");
    const silver = new Browser(app, BASE);
    await memberLogin(silver, mail, "/my-shop", "silver@example.com");
    expect(await (await silver.get("/my-shop/pages/about")).text()).not.toContain("ゴールドだけ");
    // 覚えた HTML が合う会員の分を返さない（同じ isolate のゲスト）
    expect(await (await new Browser(app, BASE).get("/my-shop/pages/about")).text()).not.toContain("ゴールドだけ");
    // 記事の一覧の抜粋にも出さない
    expect(await (await gold.get("/my-shop/blogs/news")).text()).not.toContain("ゴールドだけ");
  });

  it("モジュールが OFF・0097 の前は、合う会員にも出さない", async () => {
    for (const o of [{ modules: { pages: true, blog: true } }, { applied: BUNDLED_MIGRATIONS.filter((v) => v !== AUDIENCES_MIGRATION) }]) {
      const { app, mail } = setup(o);
      const gold = new Browser(app, BASE);
      await memberLogin(gold, mail, "/my-shop", "gold@example.com");
      const html = await (await gold.get("/my-shop/pages/about")).text();
      expect(html).toContain("おわり");
      expect(html).not.toContain("ゴールドだけ");
    }
  });

  it("Liquid: customer.logged_in・attributes・audiences と、出し分けた page.content", async () => {
    const { app, mail } = setup({
      liquid: {
        "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body>{% if customer %}<p class="c">{{ customer.logged_in }}|{{ customer.attributes.rank }}|{{ customer.audiences | join: "," }}</p>{% endif %}<main>{{ content_for_layout }}</main></body></html>`,
        "templates/index.liquid": "<h1>top</h1>",
        "templates/page.liquid": `<article>{{ page.content }}</article>`,
      },
    });
    const gold = new Browser(app, DOMAIN);
    await memberLogin(gold, mail, "", "gold@example.com");
    const html = await (await gold.get("/pages/about")).text();
    expect(html).toContain('<p class="c">true|gold|ゴールド</p>');
    expect(html).toContain("ゴールドだけの案内");
    const guest = await (await new Browser(app, DOMAIN).get("/pages/about")).text();
    expect(guest).not.toContain('class="c"');
    expect(guest).not.toContain("ゴールドだけ");
  });
});

describe("ヘッドレスの公開 API", () => {
  it("会員トークンの値で本文（body と html）から外す。トークンが無ければゲスト、壊れていれば 401", async () => {
    const { app, shop } = setup();
    const get = (path: string, token?: string) => app.request(`${BASE}/api/shops/my-shop${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const guest = (await (await get("/pages/about")).json()) as { page: { body: string; html: string } };
    expect(guest.page.body).not.toContain("ゴールドだけ");
    expect(guest.page.html).not.toContain("ゴールドだけ");
    const tok = (rank: string) => issueTokens("test-session-secret", shop.id, crypto.randomUUID(), 0, { sid: crypto.randomUUID(), gen: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, undefined, { rank });
    const gold = await get("/pages/about", (await tok("gold")).access_token);
    expect(gold.headers.get("vary")).toContain("Authorization");
    const g = (await gold.json()) as { page: { body: string; html: string } };
    expect(g.page.body).toBe("誰でも\n\nゴールドだけの案内\n\nおわり");
    expect(g.page.html).toContain("ゴールドだけの案内");
    const art = (await (await get("/blogs/news/articles/hello", (await tok("silver")).access_token)).json()) as { article: { body: string } };
    expect(art.article.body).not.toContain("ゴールドだけ");
    expect((await get("/pages/about", "bm1.broken")).status).toBe(401);
  });
});

describe("編集の画面", () => {
  it("条件があるショップだけ、ブロックの一覧に「見せる相手」と条件の名前が出る（OFF なら出ない）", async () => {
    const { app, shop } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/modules/pages/new`)).text();
    const layout = JSON.parse(/data-layout="([^"]*)"/.exec(html)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { schema: Record<string, unknown>; t: Record<string, string> };
    expect(layout.schema["audience"]).toEqual({ id: { values: [GOLD], def: GOLD } });
    expect(layout.t[`opt.id.${GOLD}`]).toBe("ゴールド");
    if (process.env["BANTO_DUMP_EDITOR"]) (await import("node:fs")).writeFileSync(process.env["BANTO_DUMP_EDITOR"], html);
    const off = setup({ modules: { pages: true } });
    const b2 = await Browser.loggedIn(off.app, "owner@example.com", "password-123");
    expect(await (await b2.get(`/admin/shops/${off.shop.id}/modules/pages/new`)).text()).not.toContain(GOLD);
  });
});
