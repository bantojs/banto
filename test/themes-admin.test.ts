import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { THEMES_MIGRATION } from "../src/themes/liquid";

/** 管理画面の「デザイン」（0071、docs/themes.md）: 取り込み・資産・プレビュー・公開・取り下げ・削除 */
const DOMAIN = "https://shop.example.jp";
const bundle = {
  format: 1,
  assets: ["theme.css"],
  files: {
    "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>",
    "templates/index.liquid": "<h1 class=\"liquid\">{{ shop.name }}</h1>",
    "config/settings_schema.json": JSON.stringify([{ name: "theme_info", theme_name: "Minimal", theme_version: "1.2.0", theme_author: "me" }]),
  },
};

function setup() {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "テストのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const base = `/admin/shops/${shop.id}/design`;
  return { sb, shop, storage, app, base, row: sb.tables.shops.find((x) => x["id"] === shop.id)! };
}

/** 取り込んで、資産を送り、置き終えた印を付ける（管理画面のスクリプトと同じ順） */
async function upload(admin: Browser, base: string): Promise<string> {
  const r = (await (await admin.postJson(`${base}/versions`, { name: "v", bundle })).json()) as { id: string; assets: string; complete: string };
  expect((await admin.postRaw(`${r.assets}theme.css`, "body{}", "application/octet-stream")).status).toBe(200);
  expect((await admin.post(r.complete, {})).status).toBe(200);
  return r.id;
}

describe("管理画面のデザイン（Liquid のテーマ）", () => {
  beforeEach(forgetThemes);

  it("取り込み: 検査して置き場に置き、版を足す。資産は束ねたファイルに名前があるものだけ。壊れたテーマは理由を返す", async () => {
    const { sb, shop, storage, app, base } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(base)).text();
    expect(page).toContain("デザイン");
    expect(page).toContain("独自ドメイン: 未設定");
    expect(page).toContain("プラン: Workers の有料プラン、または Node");
    const res = await admin.postJson(`${base}/versions`, { name: "最初の版", bundle });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { ok: boolean; id: string; assets: string; next: string };
    expect(r.ok).toBe(true);
    expect(r.next).toBe(`${base}?flash=uploaded`);
    expect(storage.objects.has(`themes/${shop.id}/${r.id}/bundle.json`)).toBe(true);
    expect(sb.tables.theme_versions).toHaveLength(1);
    expect(sb.tables.theme_versions[0]).toMatchObject({ name: "最初の版", manifest: { theme_name: "Minimal", theme_version: "1.2.0", theme_author: "me" } });
    // 資産
    expect((await admin.postRaw(`${r.assets}theme.css`, "body{color:red}", "application/octet-stream")).status).toBe(200);
    expect(storage.objects.get(`themes/${shop.id}/${r.id}/assets/theme.css`)?.contentType).toMatch(/^text\/css/);
    expect((await admin.postRaw(`${r.assets}other.css`, "x", "application/octet-stream")).status).toBe(404);
    expect((await admin.postRaw(`${r.assets}x.svg`, "<svg/>", "application/octet-stream")).status).toBe(400);
    // 壊れたテーマ
    const bad = await admin.postJson(`${base}/versions`, { name: "x", bundle: { format: 1, files: { "templates/index.liquid": "{{ a | nope }}" }, assets: [] } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { errors: string[] }).errors).toContain("layout/theme.liquid: required");
    expect(sb.tables.theme_versions).toHaveLength(1);
    // 一覧に出る
    const list = await (await admin.get(base)).text();
    expect(list).toContain("最初の版");
    expect(list).toContain("Minimal 1.2.0");
  });

  it("公開は独自ドメインのあるショップだけ。公開するとショップのドメインのお店の画面がテーマで描かれ、取り下げると戻る。公開中は消せない", async () => {
    const { sb, shop, storage, app, base, row } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    // 資産を送り終えていない版は公開できない
    const half = (await (await admin.postJson(`${base}/versions`, { name: "途中", bundle })).json()) as { id: string; complete: string };
    row["domain"] = "shop.example.jp";
    expect((await admin.post(`${base}/publish`, { version: half.id })).headers.get("location")).toBe(`${base}?flash=incomplete`);
    expect((await admin.post(half.complete, {})).status).toBe(409); // 資産が揃っていない
    expect((await admin.post(`${base}/versions/${half.id}/delete`, {})).headers.get("location")).toBe(`${base}?flash=deleted`);
    row["domain"] = null;
    const id = await upload(admin, base);
    // 置き終えた版の資産は差し替えさせない
    expect((await admin.postRaw(`${base}/versions/${id}/assets/theme.css`, "x", "application/octet-stream")).status).toBe(409);
    expect((await admin.post(`${base}/publish`, { version: id })).headers.get("location")).toBe(`${base}?flash=requires_domain`);
    row["domain"] = "shop.example.jp";
    expect((await admin.post(`${base}/publish`, { version: id })).headers.get("location")).toBe(`${base}?flash=published`);
    expect((await (await admin.get(base)).text())).toContain("公開中");
    const shopPage = await (await app.request(`${DOMAIN}/`)).text();
    expect(shopPage).toContain('<h1 class="liquid">テストのお店</h1>');
    expect((await admin.post(`${base}/versions/${id}/delete`, {})).headers.get("location")).toBe(`${base}?flash=published_cannot_delete`);
    expect((await admin.post(`${base}/publish`, { version: "" })).headers.get("location")).toBe(`${base}?flash=unpublished`);
    forgetThemes();
    // お客様の画面のショップ行は 30 秒覚えるので、新しい isolate として開き直す
    const again = await (await appWith(sb, {}, storage).request(`${DOMAIN}/`)).text();
    expect(again).not.toContain('class="liquid"');
    expect((await admin.post(`${base}/versions/${id}/delete`, {})).headers.get("location")).toBe(`${base}?flash=deleted`);
    expect([...storage.objects.keys()].filter((k) => k.startsWith(`themes/${shop.id}/`))).toEqual([]);
    expect(sb.tables.theme_versions).toHaveLength(0);
  });

  it("プレビュー: 管理画面から署名付きのリンクでショップのドメインに開く。帯・noindex・覚えさせない。Cookie で続き、off で終わる。偽の券は効かない", async () => {
    const { sb, app, base, row } = setup();
    row["domain"] = "shop.example.jp";
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const id = await upload(admin, base);
    const go = await admin.get(`${base}/versions/${id}/preview`);
    const url = go.headers.get("location")!;
    expect(url).toMatch(new RegExp(`^${DOMAIN}/\\?preview_theme=${id}&preview_token=`));
    const shopper = new Browser(app, DOMAIN);
    const first = await shopper.get(url.replace(DOMAIN, ""));
    const html = await first.text();
    expect(html).toContain('<h1 class="liquid">テストのお店</h1>');
    expect(html).toContain("テーマのプレビュー中です");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(first.headers.get("x-robots-tag")).toBe("noindex");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await (await shopper.get("/")).text()).toContain("テーマのプレビュー中です");
    expect(await (await shopper.get("/?preview_theme=off")).text()).not.toContain('class="liquid"');
    expect(await (await shopper.get("/")).text()).not.toContain('class="liquid"');
    const forged = await new Browser(app, DOMAIN).get(`/?preview_theme=${id}&preview_token=x.y`);
    expect(await forged.text()).not.toContain('class="liquid"');
    // プレビューを出したことは監査ログに残る
    expect(sb.tables.audit_log.filter((a) => a["action"] === "shop.theme_previewed").map((a) => a["detail"])).toEqual([{ version: id }]);
    // 公開していないショップではプレビューを出さない
    row["published"] = false;
    expect((await admin.get(base)).status).toBe(200);
    expect(await (await admin.get(base)).text()).toContain("ショップを公開するまではプレビューできません");
  });

  it("Workers の無料プランでは取り込ませない（画面も送り先も）", async () => {
    const { sb, app, base } = setup();
    sb.sitePlan = "free";
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(base)).text();
    expect(page).toContain("無料プランでは取り込めません");
    expect(page).not.toContain('type="file"');
    expect((await admin.postJson(`${base}/versions`, { name: "v", bundle })).status).toBe(409);
    expect((await admin.postJson(`${base}/versions`, null)).status).toBeGreaterThanOrEqual(400);
    expect(sb.tables.theme_versions).toHaveLength(0);
  });

  it("design の項目の無いスタッフは開けない。0071 が当たるまでは案内だけ", async () => {
    const { sb, shop, app, base } = setup();
    const staff = sb.addUser("staff@example.com", "password-123");
    sb.orgMembers.push({ org_id: String(shop["org_id"]), user_id: staff.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: String(shop["org_id"]), user_id: staff.id, shop_id: shop.id, perms: ["catalog"] });
    const s = await Browser.loggedIn(app, "staff@example.com", "password-123");
    expect((await s.get(base)).status).toBe(404);
    expect((await s.postJson(`${base}/versions`, { name: "x", bundle })).status).toBe(404);
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== THEMES_MIGRATION);
    const owner = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await owner.get(base)).text()).toContain("0071_themes");
  });
});
