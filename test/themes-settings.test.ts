import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { editorModel, parseSettingValue, settingsFromForm, fieldName } from "../src/themes/liquid/editor";

/** テーマの設定の値を管理画面で変える（テーマの段階 3、docs/themes.md「設定を変える」） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body style="--accent: {{ settings.accent }}">{% if settings.show_note %}<p class="note">{{ settings.note }}</p>{% endif %}{% if settings.logo %}<img class="logo" src="{{ settings.logo | image_url: width: 200 }}">{% endif %}{% section 'footer' %}<main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.json": JSON.stringify({ sections: { hero: { type: "hero", settings: { heading: "ファイルの見出し" }, blocks: { b1: { type: "item", settings: { label: "一" } }, b2: { type: "item", settings: { label: "二" } } }, block_order: ["b1", "b2"] } }, order: ["hero"] }),
  "sections/hero.liquid": `<h2 class="hero" data-cols="{{ section.settings.columns }}">{{ section.settings.heading }}</h2>{% for b in section.blocks %}<i>{{ b.settings.label }}</i>{% endfor %}{% schema %}{"name": "t:sections.hero.name", "settings": [{"id": "heading", "type": "text", "label": "t:sections.hero.heading"}, {"id": "columns", "type": "range", "min": 1, "max": 4, "step": 1, "default": 3, "label": "列"}], "blocks": [{"type": "item", "name": "項目", "settings": [{"id": "label", "type": "text", "label": "文字"}]}]}{% endschema %}`,
  "sections/footer.liquid": `<footer>{{ section.settings.copy }}</footer>{% schema %}{"name": "フッター", "settings": [{"id": "copy", "type": "text", "default": "© ファイル"}]}{% endschema %}`,
  "config/settings_schema.json": JSON.stringify([
    { name: "theme_info", theme_name: "S" },
    {
      name: "色と文字",
      settings: [
        { type: "header", content: "色" },
        { id: "accent", type: "color", label: "アクセント", default: "#123456" },
        { id: "show_note", type: "checkbox", label: "お知らせを出す", default: false },
        { id: "note", type: "textarea", label: "お知らせ" },
        { id: "layout", type: "select", label: "並び", options: [{ value: "grid", label: "格子" }, { value: "list", label: "一覧" }], default: "grid" },
        { id: "logo", type: "image_picker", label: "ロゴ" },
        { id: "font", type: "font_picker", label: "書体", default: "system" },
        { id: "unknown", type: "collection", label: "画面では変えない" },
      ],
    },
  ]),
  "locales/ja.schema.json": JSON.stringify({ sections: { hero: { name: "大見出し", heading: "見出し" } } }),
};
const bundle = { format: 1 as const, assets: ["logo.png", "theme.css"], files };

describe("設定の入力の形（editor.ts）", () => {
  it("宣言から入力の形を作る。翻訳の t: を引く。画面で変えない種類は出さない。{% section %} のセクションも出す", () => {
    const m = editorModel(bundle, null, "ja");
    expect(m.global).toHaveLength(1);
    expect(m.global[0]!.settings.map((s) => s.id ?? s.type)).toEqual(["header", "accent", "show_note", "note", "layout", "logo", "font"]);
    expect(m.globalValues).toMatchObject({ accent: "#123456", show_note: false, layout: "grid" });
    expect(m.sections.map((s) => [s.key, s.id, s.name])).toEqual([["templates/index", "hero", "大見出し"], ["static/footer", "footer", "フッター"]]);
    expect(m.sections[0]!.settings[0]!.label).toBe("見出し");
    expect(m.sections[0]!.values).toEqual({ heading: "ファイルの見出し", columns: 3 });
    expect(m.sections[0]!.blocks.map((b) => [b.id, b.values])).toEqual([["b1", { label: "一" }], ["b2", { label: "二" }]]);
    expect(m.imageAssets).toEqual(["logo.png"]);
  });

  it("値の検査: 色・数の範囲・選べる値・URL・長さ・画像は資産から", () => {
    const pick = (o: Record<string, unknown>) => o as never;
    expect(parseSettingValue(pick({ type: "color" }), "#ABCDEF", [])).toEqual({ ok: true, value: "#abcdef" });
    expect(parseSettingValue(pick({ type: "color" }), "red;}", [])).toEqual({ ok: false, reason: "color" });
    expect(parseSettingValue(pick({ type: "range", min: 1, max: 4 }), "5", [])).toEqual({ ok: false, reason: "max:4" });
    expect(parseSettingValue(pick({ type: "select", options: [{ value: "a" }] }), "b", [])).toEqual({ ok: false, reason: "option" });
    expect(parseSettingValue(pick({ type: "url" }), "javascript:alert(1)", [])).toEqual({ ok: false, reason: "url" });
    expect(parseSettingValue(pick({ type: "url" }), "/collections/all", [])).toEqual({ ok: true, value: "/collections/all" });
    expect(parseSettingValue(pick({ type: "text" }), "x".repeat(501), [])).toEqual({ ok: false, reason: "too_long:500" });
    expect(parseSettingValue(pick({ type: "image_picker" }), "logo.png", ["logo.png"])).toEqual({ ok: true, value: "asset:logo.png" });
    expect(parseSettingValue(pick({ type: "image_picker" }), "../x.png", ["logo.png"])).toEqual({ ok: false, reason: "option" });
  });

  it("保存するのはファイルの値と違うものだけ。宣言に無い名前は受け取らない", () => {
    const m = editorModel(bundle, null, "ja");
    const form: Record<string, string> = {
      [fieldName.global("accent")]: "#123456",
      [fieldName.global("layout")]: "list",
      [fieldName.global("font")]: "system",
      [fieldName.section("templates/index", "hero", "heading")]: "ファイルの見出し",
      [fieldName.section("templates/index", "hero", "columns")]: "2",
      [fieldName.block("templates/index", "hero", "b2", "label")]: "に",
      [fieldName.block("templates/index", "hero", "b1", "label")]: "一",
      [fieldName.section("static/footer", "footer", "copy")]: "© ファイル",
      "g|evil": "x",
      __sections: "x",
    };
    const r = settingsFromForm(m, form, { global: m.globalValues, sections: m.sections });
    expect(r).toEqual({ ok: true, settings: { layout: "list", note: "", __sections: { "templates/index": { hero: { settings: { columns: 2 }, blocks: { b2: { label: "に" } } } } } } });
  });
});

function setup(settings: Record<string, unknown> = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "設定のお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  sb.tables.theme_versions.push({ id: VERSION, shop_id: shop.id, name: "版", storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, size_bytes: 10, file_count: 3, manifest: {}, settings, complete: true, created_at: "2026-10-28T00:00:00Z" });
  row["theme_version_id"] = VERSION;
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings };
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify(bundle)).buffer as ArrayBuffer, "application/json");
  const app = appWith(sb, {}, storage);
  return { sb, shop, row, storage, app, url: `/admin/shops/${shop.id}/design/versions/${VERSION}/settings` };
}

describe("管理画面の設定とお店の画面", () => {
  beforeEach(forgetThemes);

  it("画面に宣言どおりの欄が出る。誤りは欄ごとに出して保存しない。保存した値はテーマ全体・セクション・ブロック・画像に効く", async () => {
    const { sb, app, url, storage, row } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(url)).text();
    expect(page).toContain("アクセント");
    expect(page).toContain("大見出し");
    expect(page).toContain('name="b|templates/index|hero|b2|label"');
    expect(page).toContain('<option value="logo.png">logo.png</option>');
    expect(page).not.toContain("画面では変えない");
    // 誤り
    const bad = await admin.post(url, { [fieldName.global("accent")]: "red", [fieldName.global("layout")]: "grid", [fieldName.section("templates/index", "hero", "columns")]: "9" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("#rrggbb の形で入れてください。");
    expect(badHtml).toContain("4 以下にしてください。");
    expect(sb.tables.theme_versions[0]!["settings"]).toEqual({});
    // 保存
    const ok = await admin.post(url, {
      [fieldName.global("accent")]: "#c33",
      [fieldName.global("show_note")]: "on",
      [fieldName.global("note")]: "<b>本日休業</b>",
      [fieldName.global("layout")]: "grid",
      [fieldName.global("logo")]: "logo.png",
      [fieldName.global("font")]: "system",
      [fieldName.section("templates/index", "hero", "heading")]: "画面の見出し",
      [fieldName.section("templates/index", "hero", "columns")]: "2",
      [fieldName.block("templates/index", "hero", "b1", "label")]: "いち",
      [fieldName.block("templates/index", "hero", "b2", "label")]: "二",
      [fieldName.section("static/footer", "footer", "copy")]: "© 画面",
    });
    expect(ok.status).toBe(302);
    const saved = sb.tables.theme_versions[0]!["settings"] as Record<string, unknown>;
    expect(saved).toMatchObject({ accent: "#c33", show_note: true, logo: "asset:logo.png" });
    // お店の画面（公開中の版。テストはショップの行の theme_public に写す）
    row["theme_public"] = { id: VERSION, storage_key: `themes/${String(row["id"])}/${VERSION}/bundle.json`, settings: saved };
    const html = await (await appWith(sb, {}, storage).request(`${DOMAIN}/`)).text();
    expect(html).toContain("--accent: #c33");
    expect(html).toContain('<p class="note">&lt;b&gt;本日休業&lt;/b&gt;</p>');
    expect(html).toContain(`<img class="logo" src="${DOMAIN}/_theme/${VERSION}/assets/logo.png">`);
    expect(html).toContain('<h2 class="hero" data-cols="2">画面の見出し</h2><i>いち</i><i>二</i>');
    expect(html).toContain("<footer>© 画面</footer>");
    // 画面を開き直すと保存した値が入っている
    const again = await (await admin.get(`${url}?flash=saved`)).text();
    expect(again).toContain("設定を保存しました。");
    expect(again).toContain('value="画面の見出し"');
  });

  it("design の項目が無い人・ほかのショップの版は開けない", async () => {
    const { sb, shop, app, url } = setup();
    const staff = sb.addUser("staff@example.com", "password-123");
    sb.orgMembers.push({ org_id: String(shop["org_id"]), user_id: staff.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: String(shop["org_id"]), user_id: staff.id, shop_id: shop.id, perms: ["catalog"] });
    const s = await Browser.loggedIn(app, "staff@example.com", "password-123");
    expect((await s.get(url)).status).toBe(404);
    expect((await s.post(url, {})).status).toBe(404);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(url.replace(VERSION, "99999999-2222-4333-8444-555555555555"))).status).toBe(404);
  });
});
