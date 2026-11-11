import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { embedScript } from "../src/modules/embed/script";
import { embedSnippets } from "../src/modules/embed/admin";

/** 貼れるタグ（同梱モジュール embed）。スクリプトの配信と、貼るコードの画面。docs/embed.md */
function setup(opts: { enabled?: boolean; settings?: Record<string, unknown> } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const settings = { ...(opts.enabled === false ? {} : { modules: { embed: true } }), ...(opts.settings ?? {}) };
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: 'Tシャツ"><script>alert(1)</script>', published: true });
  sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.addProduct(shop.id, { slug: "draft", name: "下書き", published: false });
  const app = appWith(sb);
  return { sb, shop, app, base: `/admin/shops/${shop.id}/modules/embed` };
}

describe("貼れるタグのスクリプト", () => {
  it("/api/embed/v1.js を DB に問い合わせずに配る（モジュールの ON/OFF に関係なく）。構文として読める", async () => {
    const { app, sb } = setup({ enabled: false });
    sb.calls.length = 0;
    const res = await app.request(`${BASE}/api/embed/v1.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    expect(sb.calls).toEqual([]);
    const js = await res.text();
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('"addToCart":"カートに入れる"');
    for (const name of ["banto-product", "banto-products", "banto-buy-button", "banto-cart"]) expect(js).toContain(`define("${name}"`);
  });

  it("運営者の文字列は textContent だけ。会員の API・AI 用の API は呼ばない", () => {
    const js = embedScript(BASE, "ja");
    expect(js).not.toContain("innerHTML");
    expect(js).not.toContain("insertAdjacentHTML");
    expect(js).not.toContain("/members");
    expect(js).not.toContain("/api/v1");
    expect(js).not.toContain("credentials");
  });

  it("文言はロケールごと。< と行区切りはエスケープして埋める", () => {
    expect(embedScript(BASE, "en")).toContain('"addToCart":"Add to cart"');
    expect(embedScript(BASE, "ja")).not.toContain("__BANTO_I18N__");
    // 問い合わせ先はサーバーが書き込む（読み込み方に左右されない）
    expect(embedScript("https://banto.example/x", "ja")).toContain('var BASE="https://banto.example";');
  });
});

describe("貼るコードの画面", () => {
  it("OFF なら 404、ON なら読み込みのタグと公開中の商品の部品を出す。商品名はエスケープ", async () => {
    let { app, base } = setup({ enabled: false });
    let b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await b.get(base)).status).toBe(404);
    ({ app, base } = setup());
    b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await b.get(base);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`&lt;script src=&quot;${BASE}/api/embed/v1.js&quot; defer&gt;&lt;/script&gt;`);
    expect(html).toContain("&lt;banto-product shop=&quot;my-shop&quot; product=&quot;tee&quot;&gt;");
    expect(html).not.toContain('product=&quot;draft&quot;');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("お店の画面を使わない設定なら、タグのレジが使えないと知らせる", async () => {
    const { app, base } = setup({ settings: { modules: { embed: true }, storefront: { mode: "off", site_url: "https://wp.example/" } } });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(base)).text()).toContain("「使わない」");
  });

  it("商品を扱う項目（catalog）の無いスタッフには出さない", async () => {
    const { sb, app, shop, base } = setup();
    const u = sb.addUser("s@example.com", "password-123");
    const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms: ["orders"] });
    const staff = await Browser.loggedIn(app, "s@example.com", "password-123");
    expect((await staff.get(base)).status).toBe(403);
  });

  it("貼るコードの属性は引用符を逃がさない", () => {
    const s = embedSnippets('https://x.example/"a', 'sh"op');
    expect(s.loader).toBe('<script src="https://x.example/&quot;a/api/embed/v1.js" defer></script>');
    expect(s.product('p"<')).toBe('<banto-product shop="sh&quot;op" product="p&quot;&lt;"></banto-product>');
  });
});
