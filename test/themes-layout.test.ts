import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { editorModel, layoutFieldName, layoutsFromForm, sectionLayoutsOf, type SectionLayouts } from "../src/themes/liquid/editor";
import type { ThemeBundle } from "../src/themes/liquid/bundle";

/** セクションの並べ替え・外す・足す（管理画面の設定、テーマの段階 3 の続き） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>`,
  "templates/index.json": JSON.stringify({ sections: { a: { type: "text", settings: { t: "A" } }, b: { type: "text", settings: { t: "B" } }, c: { type: "text", settings: { t: "C" } } }, order: ["a", "b", "c"] }),
  "sections/text.liquid": `<p>{{ section.settings.t }}</p>{% schema %}{"name":"文字","settings":[{"id":"t","type":"text"}],"presets":[{"name":"文字の段","settings":{"t":"ひな形"}}]}{% endschema %}`,
  "sections/plain.liquid": `<p>plain</p>{% schema %}{"name":"ひな形なし"}{% endschema %}`,
};
const bundle: ThemeBundle = { format: 1, files, assets: [] };

describe("セクションの並び（editor.ts）", () => {
  it("並びの画面: 今の並び・足せる種類（ひな形のあるものだけ）", () => {
    const m = editorModel(bundle, null, "ja");
    expect(m.layouts).toHaveLength(1);
    expect(m.layouts[0]!.items.map((x) => `${x.id}:${x.shown}`)).toEqual(["a:true", "b:true", "c:true"]);
    expect(m.layouts[0]!.available).toEqual([{ type: "text", name: "文字の段" }]);
  });

  it("フォームから: 番号の順、チェックを外したものは外し、足すとひな形の種類だけ末尾に。ファイルのままなら置かない", () => {
    const m = editorModel(bundle, null, "ja");
    const k = "templates/index";
    const f = (o: Record<string, string>) => o;
    const base = f({ [layoutFieldName.present(k)]: "1", [layoutFieldName.position(k, "a")]: "1", [layoutFieldName.shown(k, "a")]: "on", [layoutFieldName.position(k, "b")]: "2", [layoutFieldName.shown(k, "b")]: "on", [layoutFieldName.position(k, "c")]: "3", [layoutFieldName.shown(k, "c")]: "on" });
    expect(Object.keys(layoutsFromForm(m, base))).toEqual([]);
    const moved = layoutsFromForm(m, { ...base, [layoutFieldName.position(k, "c")]: "0", [layoutFieldName.shown(k, "b")]: "", [layoutFieldName.add(k)]: "text" }, () => "text-new1");
    expect(JSON.parse(JSON.stringify(moved))).toEqual({ [k]: { order: ["c", "a", "text-new1"], added: { "text-new1": { type: "text" } } } });
    // ひな形の無い種類・知らない種類は足さない
    expect(layoutsFromForm(m, { ...base, [layoutFieldName.add(k)]: "plain" })).toEqual({});
    // 並びの欄を出していないフォーム（印が無い）は、今の並びのまま
    const saved = editorModel(bundle, { __layout: { [k]: { order: ["b", "a"] } } }, "ja");
    expect(JSON.parse(JSON.stringify(layoutsFromForm(saved, {})))).toEqual({ [k]: { order: ["b", "a"] } });
  });

  it("保存した並びは形を確かめて読む（id・種類の形の合わないもの、__proto__ は捨てる）", () => {
    const v = sectionLayoutsOf({ __layout: { "templates/index": { order: ["a", "__proto__", "../x", 3], added: { "x-1": { type: "text" }, __proto__: { type: "text" }, bad: { type: 1 } } }, nope: "x" } });
    expect(JSON.parse(JSON.stringify(v))).toEqual({ "templates/index": { order: ["a"], added: { "x-1": { type: "text" } } } });
  });
});

describe("お店の画面に並びを当てる", () => {
  beforeEach(forgetThemes);

  function setup(layouts: SectionLayouts, extra: Record<string, unknown> = {}) {
    forgetThemes();
    const sb = new FakeSupabase();
    sb.sitePlan = "paid";
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "並びのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: { __layout: layouts, ...extra } };
    const storage = new MemoryStorage(`${BASE}/media`);
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify(bundle)).buffer as ArrayBuffer, "application/json");
    return new Browser(appWith(sb, {}, storage), DOMAIN);
  }

  it("並びの順に描き、外したものは描かず、足したものはひな形の中身（値を変えれば上書き）", async () => {
    const b = setup({ "templates/index": { order: ["c", "a", "text-new1"], added: { "text-new1": { type: "text" } } } });
    const html = await (await b.get("/")).text();
    expect(html.replace(/\s+/g, "")).toContain('<divid="shopify-section-c"class="shopify-section"><p>C</p></div><divid="shopify-section-a"class="shopify-section"><p>A</p></div><divid="shopify-section-text-new1"class="shopify-section"><p>ひな形</p></div>');
    expect(html).not.toContain("<p>B</p>");
    // 足したセクションも Section Rendering API で引ける。外したものは引けない
    const json = (await (await b.get("/?sections=text-new1,b")).json()) as Record<string, string | null>;
    expect(json["text-new1"]).toContain("ひな形");
    expect(json["b"]).toBeNull();
    const over = setup({ "templates/index": { order: ["text-new1"], added: { "text-new1": { type: "text" } } } }, { __sections: { "templates/index": { "text-new1": { settings: { t: "変えた" } } } } });
    expect(await (await over.get("/")).text()).toContain("<p>変えた</p>");
  });
});

describe("管理画面の並びの欄", () => {
  beforeEach(forgetThemes);

  it("並びの欄が出て、保存した並びがお店の画面に効く", async () => {
    forgetThemes();
    const sb = new FakeSupabase();
    sb.sitePlan = "paid";
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "並びのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    sb.tables.theme_versions.push({ id: VERSION, shop_id: shop.id, name: "版", storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, size_bytes: 10, file_count: 3, manifest: {}, settings: {}, complete: true, created_at: "2026-10-28T00:00:00Z" });
    const storage = new MemoryStorage(`${BASE}/media`);
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify(bundle)).buffer as ArrayBuffer, "application/json");
    const app = appWith(sb, {}, storage);
    const url = `/admin/shops/${shop.id}/design/versions/${VERSION}/settings`;
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(url)).text();
    const k = "templates/index";
    expect(page).toContain(`name="${layoutFieldName.present(k)}" value="1"`);
    expect(page).toContain(`name="${layoutFieldName.add(k)}"`);
    expect(page).toContain('<option value="text">文字の段</option>');
    const res = await admin.post(url, {
      [layoutFieldName.present(k)]: "1",
      [layoutFieldName.position(k, "a")]: "3",
      [layoutFieldName.shown(k, "a")]: "on",
      [layoutFieldName.position(k, "b")]: "1",
      [layoutFieldName.shown(k, "b")]: "on",
      [layoutFieldName.position(k, "c")]: "2",
      // 値の欄は画面と同じくそのまま送る（変えていない）
      "s|templates/index|a|t": "A",
      "s|templates/index|b|t": "B",
      "s|templates/index|c|t": "C",
    });
    expect(res.status).toBe(302);
    expect(sb.tables.theme_versions[0]!["settings"]).toEqual({ __layout: { [k]: { order: ["b", "a"] } } });
  });
});
