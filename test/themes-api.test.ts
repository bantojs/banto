import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { forgetThemes } from "../src/themes/liquid/cache";
import { THEME_API_MIGRATION } from "../src/themes/liquid/versions";

/**
 * /api/v1/themes（theme:write / theme:publish、0072、docs/themes.md）。CLI と GitHub Actions が使う経路。
 * Worker 側の検査（テンプレートの解析・資産の種類・置き場）と流れを確かめる。権限の規則は test/db/theme-api.test.ts（実 PostgreSQL）
 */
const DOMAIN = "https://shop.example.jp";
const bundle = {
  format: 1,
  assets: ["theme.css"],
  files: {
    "layout/theme.liquid": "<html><head>{{ content_for_header }}{{ 'theme.css' | asset_url | stylesheet_tag }}</head><body>{{ content_for_layout }}</body></html>",
    "templates/index.liquid": '<h1 class="api-theme">{{ shop.name }}</h1>',
    "config/settings_schema.json": JSON.stringify([{ name: "theme_info", theme_name: "API", theme_version: "2.0.0" }]),
  },
};

function setup(opts: { plan?: "free" | "paid"; domain?: boolean; priv?: boolean } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = opts.plan ?? "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "テストのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  if (opts.domain !== false) row["domain"] = "shop.example.jp";
  const storage = new MemoryStorage(`${BASE}/media`);
  const priv = opts.priv ? new MemoryStorage(`${BASE}/private`) : undefined;
  const app = appWith(sb, {}, storage, undefined, priv);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "ci", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  const call = async (token: string, method: string, path: string, body?: unknown, raw?: { data: string; type?: string }) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let payload: BodyInit | undefined;
    if (raw) {
      payload = raw.data;
      headers["content-type"] = raw.type ?? "application/octet-stream";
      headers["content-length"] = String(new TextEncoder().encode(raw.data).byteLength);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers, body: payload });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  return { sb, shop, row, storage, priv, app, issue, call };
}

describe("REST /api/v1/themes", () => {
  beforeEach(forgetThemes);

  it("取り込み → 資産 → 置き終える → プレビュー → 公開 → お店の画面がテーマで描かれる → 取り下げ → 削除", async () => {
    const { sb, shop, storage, app, issue, call } = setup();
    const tok = await issue(["theme:write", "theme:publish"]);
    const list0 = await call(tok, "GET", "/themes");
    expect(list0.status).toBe(200);
    expect(list0.json).toMatchObject({ items: [], published_id: null, domain: "shop.example.jp", can_render: true, locale: "ja", max_versions: 20 });

    const created = await call(tok, "POST", "/themes", { name: "CI の版", bundle });
    expect(created.status).toBe(201);
    const id = created.json["id"] as string;
    expect(created.json).toMatchObject({ name: "CI の版", complete: false, published: false, assets: ["theme.css"], manifest: { theme_name: "API", theme_version: "2.0.0" } });
    expect(created.json).not.toHaveProperty("storage_key");
    expect(storage.objects.has(`themes/${shop.id}/${id}/bundle.json`)).toBe(true);

    // 資産が揃う前は公開できない・置き終えられない
    expect((await call(tok, "POST", "/themes/publish", { version_id: id })).json.error?.message).toMatch(/^theme_incomplete/);
    expect((await call(tok, "POST", `/themes/${id}/complete`)).json.error?.message).toBe("asset_missing: theme.css");
    // 資産: 名前があるもの・決まった種類だけ
    expect((await call(tok, "PUT", `/themes/${id}/assets/theme.css`, undefined, { data: "body{color:red}" })).status).toBe(200);
    expect(storage.objects.get(`themes/${shop.id}/${id}/assets/theme.css`)?.contentType).toMatch(/^text\/css/);
    expect((await call(tok, "PUT", `/themes/${id}/assets/other.css`, undefined, { data: "x" })).status).toBe(404);
    expect((await call(tok, "PUT", `/themes/${id}/assets/x.svg`, undefined, { data: "<svg/>" })).status).toBe(400);
    expect((await call(tok, "POST", `/themes/${id}/complete`)).json).toMatchObject({ id, complete: true });
    // 置き終えた版の資産は差し替えさせない
    expect((await call(tok, "PUT", `/themes/${id}/assets/theme.css`, undefined, { data: "body{}" })).json.error?.message).toMatch(/^theme_complete/);

    // プレビューのリンク（監査ログに残る）でショップのドメインに開く
    const prev = await call(tok, "POST", `/themes/${id}/preview`);
    expect(prev.json["expires_in"]).toBe(1800);
    const url = String(prev.json["preview_url"]);
    expect(url).toMatch(new RegExp(`^${DOMAIN}/\\?preview_theme=${id}&preview_token=`));
    expect(sb.tables.audit_log.filter((a) => a["action"] === "shop.theme_previewed").map((a) => a["detail"])).toEqual([{ version: id }]);
    const shopper = new Browser(app, DOMAIN);
    expect(await (await shopper.get(url.replace(DOMAIN, ""))).text()).toContain('<h1 class="api-theme">テストのお店</h1>');

    // 公開
    expect((await call(tok, "POST", "/themes/publish", { version_id: id })).json).toEqual({ published_id: id });
    expect(await (await appWith(sb, {}, storage).request(`${DOMAIN}/`)).text()).toContain('class="api-theme"');
    expect((await call(tok, "GET", "/themes")).json).toMatchObject({ published_id: id, items: [{ id, published: true, complete: true }] });
    expect((await call(tok, "DELETE", `/themes/${id}`)).json.error?.message).toMatch(/^theme_published/);
    // 取り下げ → 削除（置き場のファイルも消える）
    expect((await call(tok, "POST", "/themes/publish", { version_id: null })).json).toEqual({ published_id: null });
    expect((await call(tok, "DELETE", `/themes/${id}`)).json).toEqual({ ok: true });
    expect([...storage.objects.keys()].filter((k) => k.startsWith(`themes/${shop.id}/`))).toEqual([]);
  });

  it("公開しない置き場（PRIVATE）があればテーマはそこに置き、公開の置き場（R2 のカスタムドメイン）には置かない。前からある版は公開の置き場から読み続ける", async () => {
    const { sb, shop, storage, priv, app, issue, call } = setup({ priv: true });
    const tok = await issue(["theme:write", "theme:publish"]);
    const id = (await call(tok, "POST", "/themes", { name: "v", bundle })).json["id"] as string;
    expect((await call(tok, "PUT", `/themes/${id}/assets/theme.css`, undefined, { data: "body{color:red}" })).status).toBe(200);
    expect((await call(tok, "POST", `/themes/${id}/complete`)).json).toMatchObject({ complete: true });
    const ours = (m: MemoryStorage) => [...m.objects.keys()].filter((k) => k.startsWith(`themes/${shop.id}/`)).sort();
    expect(ours(priv!)).toEqual([`themes/${shop.id}/${id}/assets/theme.css`, `themes/${shop.id}/${id}/bundle.json`, `themes/${shop.id}/${id}/sealed`]);
    expect(ours(storage)).toEqual([]);
    expect((await call(tok, "POST", "/themes/publish", { version_id: id })).json).toEqual({ published_id: id });
    expect(await (await app.request(`${DOMAIN}/`)).text()).toContain('class="api-theme"');
    const css = await app.request(`${DOMAIN}/_theme/${id}/assets/theme.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe("body{color:red}");

    // 公開しない置き場ができる前の版（公開の置き場にある）も描け、消すと公開の置き場からも消える
    const old = "11111111-2222-4333-8444-555555555555";
    const oldBundle = { ...bundle, files: { ...bundle.files, "templates/index.liquid": '<h1 class="old-theme">old</h1>' } };
    await storage.put(`themes/${shop.id}/${old}/bundle.json`, new TextEncoder().encode(JSON.stringify(oldBundle)).buffer as ArrayBuffer, "application/json");
    await storage.put(`themes/${shop.id}/${old}/assets/theme.css`, new TextEncoder().encode("body{}").buffer as ArrayBuffer, "text/css");
    sb.tables.theme_versions.push({ id: old, shop_id: shop.id, name: "old", storage_key: `themes/${shop.id}/${old}/bundle.json`, size_bytes: 10, file_count: 4, manifest: {}, settings: {}, complete: true, created_at: "2026-10-01T00:00:00Z" });
    expect((await call(tok, "POST", "/themes/publish", { version_id: old })).json).toEqual({ published_id: old });
    forgetThemes();
    expect(await (await appWith(sb, {}, storage, undefined, priv).request(`${DOMAIN}/`)).text()).toContain('class="old-theme"');
    expect((await app.request(`${DOMAIN}/_theme/${old}/assets/theme.css`)).status).toBe(200);
    expect((await call(tok, "POST", "/themes/publish", { version_id: null })).json).toEqual({ published_id: null });
    expect((await call(tok, "DELETE", `/themes/${old}`)).json).toEqual({ ok: true });
    expect((await call(tok, "DELETE", `/themes/${id}`)).json).toEqual({ ok: true });
    expect(ours(storage)).toEqual([]);
    expect(ours(priv!)).toEqual([]);
  });

  it("theme:write だけでは公開できない。theme:publish だけでは取り込めない。ほかのスコープでは何もできない", async () => {
    const { issue, call } = setup();
    const write = await issue(["theme:write"]);
    const publish = await issue(["theme:publish"]);
    const other = await issue(["products:write", "shop:write"]);
    const { json } = await call(write, "POST", "/themes", { name: "v", bundle });
    const id = json["id"] as string;
    expect((await call(write, "POST", "/themes/publish", { version_id: id })).status).toBe(401);
    expect((await call(publish, "POST", "/themes", { name: "v", bundle })).status).toBe(401);
    expect((await call(publish, "GET", "/themes")).status).toBe(401);
    expect((await call(other, "GET", "/themes")).status).toBe(401);
    expect((await call(other, "POST", `/themes/${id}/preview`)).status).toBe(401);
  });

  it("壊れたテーマはファイルと理由を返す。無料プランでは取り込めない。独自ドメインの無いショップではプレビューできない", async () => {
    const { issue, call, sb } = setup();
    const tok = await issue(["theme:write"]);
    const bad = await call(tok, "POST", "/themes", { name: "x", bundle: { format: 1, files: { "templates/index.liquid": "{{ a | nope }}" }, assets: [] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toMatch(/^invalid_theme: .*layout\/theme\.liquid: required/);
    expect(sb.tables.theme_versions).toHaveLength(0);

    const free = setup({ plan: "free" });
    const ft = await free.issue(["theme:write"]);
    expect((await free.call(ft, "GET", "/themes")).json["can_render"]).toBe(false);
    expect((await free.call(ft, "POST", "/themes", { name: "v", bundle })).json.error?.message).toMatch(/^theme_requires_paid_plan/);

    const nodomain = setup({ domain: false });
    const nt = await nodomain.issue(["theme:write"]);
    const id = (await nodomain.call(nt, "POST", "/themes", { name: "v", bundle })).json["id"] as string;
    expect((await nodomain.call(nt, "POST", `/themes/${id}/preview`)).json.error?.message).toMatch(/^theme_requires_domain/);
    expect((await nodomain.call(nt, "POST", `/themes/not-a-uuid/complete`)).status).toBe(404);
  });

  it("0072 が当たるまでは migration_required。トークンの画面もテーマのスコープを出さない", async () => {
    const { shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${shop.id}/tokens`)).text()).toContain('value="theme:publish"');
    const fresh = setup();
    fresh.sb.appliedMigrations = fresh.sb.appliedMigrations.filter((v) => v !== THEME_API_MIGRATION);
    const t2 = await fresh.issue(["theme:write"]);
    expect((await fresh.call(t2, "GET", "/themes")).json.error?.code).toBe("migration_required");
    const admin2 = await Browser.loggedIn(fresh.app, "owner@example.com", "password-123");
    const page = await (await admin2.get(`/admin/shops/${fresh.shop.id}/tokens`)).text();
    expect(page).not.toContain('value="theme:write"');
    expect(page).toContain('value="products:read"');
  });
});
