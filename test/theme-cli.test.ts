import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { forgetThemes } from "../src/themes/liquid/cache";
import { buildBundle, main, wantedLocale } from "../cli/banto-theme.mjs";

/** CLI（cli/banto-theme.mjs、docs/themes.md「コマンドから」）を、本物の /api/v1/themes に向けて動かす */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "banto-theme-"));
  const put = async (p: string, s: string) => {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), s);
  };
  await put("layout/theme.liquid", "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>");
  await put("templates/index.json", JSON.stringify({ sections: { a: { type: "hero" } }, order: ["a"] }));
  await put("sections/hero.liquid", '<h1 class="cli">{{ shop.name }}</h1>{% schema %}{"name":"hero"}{% endschema %}');
  await put("locales/ja.json", "{}");
  await put("locales/en.default.json", "{}");
  await put("locales/fr.json", "{}");
  await put("assets/theme.css", "body{}");
  await put("assets/app.js", "console.log(1)");
  await put("README.md", "x");
  await put(".git/config", "x");
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(forgetThemes);

async function setup(scopes: string[]) {
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "CLI のお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  sb.tables.shops.find((x) => x["id"] === shop.id)!["domain"] = "shop.example.jp";
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "ci", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  const out: string[] = [];
  const errs: string[] = [];
  const run = (argv: string[], once = false) =>
    main(argv, { env: { BANTO_URL: BASE, BANTO_TOKEN: raw }, fetch: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch, log: (s) => out.push(s), error: (s) => errs.push(s), once });
  return { sb, shop, storage, app, run, out, errs };
}

describe("banto-theme（CLI）", () => {
  it("束ねる: テンプレート・設定・翻訳（既定とデプロイの言語）だけ。資産は assets の直下。ほかと隠しファイルは取り込まない", async () => {
    const r = await buildBundle(dir, "ja");
    expect(Object.keys(r.bundle.files).sort()).toEqual(["layout/theme.liquid", "locales/en.default.json", "locales/ja.json", "sections/hero.liquid", "templates/index.json"]);
    expect(r.bundle.assets.sort()).toEqual(["app.js", "theme.css"]);
    expect(r.skipped).toEqual(["README.md"]);
    expect(wantedLocale("locales/en.default.schema.json", "ja")).toBe(true);
    expect(wantedLocale("locales/ja.schema.json", "ja")).toBe(true);
    expect(wantedLocale("locales/fr.schema.json", "ja")).toBe(false);
    await expect(buildBundle(join(dir, "nope"), "ja")).rejects.toThrow(/フォルダがありません/);
  });

  it("push → プレビューのリンク。--publish で公開してお店の画面が切り替わる。list・unpublish・delete・prune", async () => {
    const { sb, storage, run, out, shop } = await setup(["theme:write", "theme:publish"]);
    expect(await run(["push", dir, "--name", "最初"])).toBe(0);
    const first = sb.tables.theme_versions[0]!;
    expect(first).toMatchObject({ name: "最初", complete: true });
    expect(storage.objects.has(`themes/${shop.id}/${String(first["id"])}/assets/app.js`)).toBe(true);
    expect(out.some((l) => l.startsWith("プレビュー（30 分）: https://shop.example.jp/?preview_theme="))).toBe(true);
    expect(await run(["push", dir, "--publish"])).toBe(0);
    const second = sb.tables.theme_versions[1]!;
    expect(sb.tables.shops.find((x) => x["id"] === shop.id)!["theme_version_id"]).toBe(second["id"]);
    expect(await (await appWith(sb, {}, storage).request("https://shop.example.jp/")).text()).toContain('<h1 class="cli">CLI のお店</h1>');
    out.length = 0;
    expect(await run(["list"])).toBe(0);
    expect(out.filter((l) => l.startsWith("*"))).toHaveLength(1);
    expect(await run(["prune", "--keep", "0"])).toBe(0);
    expect(sb.tables.theme_versions.map((v) => v["id"])).toEqual([second["id"]]);
    expect(await run(["unpublish"])).toBe(0);
    expect(await run(["delete", String(second["id"])])).toBe(0);
    expect(sb.tables.theme_versions).toHaveLength(0);
  });

  it("dev は前の dev の版を消して取り込み直す。誤りは Banto の理由をそのまま出して 1 で終わる", async () => {
    const { sb, run, errs } = await setup(["theme:write"]);
    expect(await run(["dev", dir], true)).toBe(0);
    expect(await run(["dev", dir], true)).toBe(0);
    expect(sb.tables.theme_versions).toHaveLength(2); // 別々に起動したので前の版は知らない
    expect(await run(["push", dir, "--publish"])).toBe(1);
    expect(errs.at(-1)).toMatch(/invalid, expired or insufficiently scoped token/);
    expect(await run(["publish"])).toBe(1);
    expect(await run(["nope"])).toBe(1);
    const bad = await main(["list"], { env: {}, log: () => {}, error: (s) => errs.push(s) });
    expect(bad).toBe(1);
    expect(errs.at(-1)).toMatch(/BANTO_URL/);
  });
});
