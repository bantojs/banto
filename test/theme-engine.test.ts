import { beforeEach, describe, expect, it } from "vitest";
import { createThemeEngine, SafeHtml, ThemeError, THEME_LIMITS } from "../src/themes/liquid/engine";
import { assetType, checkThemeBundle, stripJsonComments, THEME_BUNDLE_FORMAT } from "../src/themes/liquid/bundle";
import { forgetThemes, loadTheme } from "../src/themes/liquid/cache";
import type { StorageAdapter } from "../src/adapters/types";

const files = {
  "layout/theme.liquid": "<html><body>{{ content_for_layout }}</body></html>",
  "templates/index.liquid": "{% for p in products %}{% render 'card', product: p %}{% endfor %}",
  "snippets/card.liquid": "<b>{{ product.name }}</b>",
};

/** 描いた結果か、投げた ThemeError の種類 */
const outcome = (fn: () => string): string => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ThemeError) return `ThemeError:${e.kind}`;
    throw e;
  }
};

describe("Liquid のテーマの描画の仕組み", () => {
  it("同期で描ける。部品（snippets）は名前だけで render できる", () => {
    const e = createThemeEngine(files);
    const inner = e.render("templates/index", { products: [{ name: "A" }, { name: "B" }] });
    expect(inner).toBe("<b>A</b><b>B</b>");
    expect(e.render("layout/theme", { content_for_layout: inner })).toBe("<html><body>&lt;b&gt;A&lt;/b&gt;&lt;b&gt;B&lt;/b&gt;</body></html>");
    expect(e.render("layout/theme", { content_for_layout: new SafeHtml(inner) })).toBe("<html><body><b>A</b><b>B</b></body></html>");
    expect(e.has("templates/index")).toBe(true);
    expect(e.has("card")).toBe(true);
    expect(outcome(() => e.render("templates/product", {}))).toBe("ThemeError:missing");
  });

  it("既定でエスケープする。escape / escape_once は二重にしない。生で出すのは raw", () => {
    const e = createThemeEngine({});
    const x = { x: `<b>"A&B"</b>` };
    expect(e.renderString("{{ x }}", x)).toBe("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    expect(e.renderString("{{ x | escape }}", x)).toBe("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    expect(e.renderString("{{ x | escape_once }}", { x: "&lt;b&gt; & <i>" })).toBe("&lt;b&gt; &amp; &lt;i&gt;");
    expect(e.renderString("{{ x | raw }}", x)).toBe(`<b>"A&B"</b>`);
    expect(e.renderString('<a title="{{ x }}">', x)).toBe('<a title="&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;">');
    // 本体が作った HTML（SafeHtml）だけはそのまま。フィルターを通すと文字列になるのでエスケープされる
    const page = { content_for_layout: new SafeHtml("<main>ok</main>") };
    expect(e.renderString("{{ content_for_layout }}|{{ content_for_layout | upcase }}", page)).toBe("<main>ok</main>|&lt;MAIN&gt;OK&lt;/MAIN&gt;");
  });

  it("渡したデータの外（constructor・__proto__）に触れない。知らないフィルターは解析で止まる", () => {
    const e = createThemeEngine({});
    const scope = { product: { name: "A" } };
    expect(e.renderString("{{ product.constructor }}|{{ product.__proto__ }}|{{ product.constructor.constructor }}|{{ product.name.constructor }}", scope)).toBe("|||");
    expect(outcome(() => e.renderString("{{ product | nope }}", scope))).toBe("ThemeError:parse");
  });

  it("Shopify と同じ: 空文字と 0 は真、未定義は偽で空、整数どうしの割り算は切り捨て", () => {
    const e = createThemeEngine({});
    expect(e.renderString('{% if "" %}T{% endif %}{% if 0 %}T{% endif %}{% if nope %}T{% else %}F{% endif %}[{{ nope }}]', {})).toBe("TTF[]");
    expect(e.renderString("{{ 10 | divided_by: 4 }} {{ 10 | divided_by: 2.5 }} {{ x | divided_by: 4 }}", { x: 9.0 })).toBe("2 4 2");
    expect(e.renderString("{{ x | divided_by: 4 }}", { x: 9.5 })).toBe("2.375");
  });

  it("量の上限（大きな範囲・文字列の倍々）と、描画の手数の上限（入れ子のループ）で止まる", () => {
    const e = createThemeEngine({});
    expect(outcome(() => e.renderString("{% for i in (1..100000000) %}x{% endfor %}", {}))).toBe("ThemeError:limit");
    expect(outcome(() => e.renderString('{% assign s = "aaaaaaaaaa" %}{% for i in (1..60) %}{% assign s = s | append: s %}{% endfor %}{{ s.size }}', {}))).toBe("ThemeError:limit");
    // 配列の入れ子は量では止まらない（試作で 530 万回回った）。手数で止める
    const xs = Array.from({ length: 48 }, (_, i) => i);
    expect(outcome(() => e.renderString("{% for a in xs %}{% for b in xs %}{% for c in xs %}{% for d in xs %}.{% endfor %}{% endfor %}{% endfor %}{% endfor %}", { xs }))).toBe("ThemeError:limit");
    // 部品（render）の中のループも数える
    const e2 = createThemeEngine({ "snippets/loop.liquid": "{% for a in xs %}{% for b in xs %}{% for c in xs %}.{% endfor %}{% endfor %}{% endfor %}" });
    expect(outcome(() => e2.renderString("{% for d in xs %}{% render 'loop', xs: xs %}{% endfor %}", { xs }))).toBe("ThemeError:limit");
    // 手数は 1 回の描画ごとに数え直す（ふつうのページは何度描いても止まらない）
    const e3 = createThemeEngine({}, { limits: { steps: 500 } });
    for (let i = 0; i < 20; i++) expect(e3.renderString("{% for a in xs %}{{ a }}{% endfor %}", { xs })).toHaveLength(86);
    expect(THEME_LIMITS.steps).toBeGreaterThan(10_000);
  });

  it("出力の大きさの上限", () => {
    const e = createThemeEngine({}, { limits: { outputChars: 1000 } });
    expect(outcome(() => e.renderString("{% for i in (1..200) %}0123456789{% endfor %}", {}))).toBe("ThemeError:limit");
  });

  it("誤りの文はテンプレートの名前と位置だけ（データを含めない）", () => {
    const e = createThemeEngine({ "snippets/bad.liquid": "{% if %}" });
    try {
      e.render("bad", { secret: "s3cret" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ThemeError);
      expect((err as ThemeError).message).not.toContain("s3cret");
      expect((err as ThemeError).message.split("\n")).toHaveLength(1);
    }
  });
});

describe("テーマを束ねたファイルの検査", () => {
  const ok = { format: THEME_BUNDLE_FORMAT, files: { ...files, "config/settings_schema.json": "[]", "locales/ja.json": '/* 注釈 */ {"a": "b"}' }, assets: ["theme.css", "app.js", "logo.webp"] };

  it("形・必須のファイル・JSON・すべての Liquid の解析を確かめる", () => {
    const r = checkThemeBundle(ok);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.bundle!.files)).toHaveLength(5);
  });

  it("壊れたものは理由をつけて断る", () => {
    expect(checkThemeBundle({ format: 2, files: {}, assets: [] }).errors).toEqual(["theme bundle: invalid format"]);
    const bad = checkThemeBundle({ format: 1, files: { "templates/index.liquid": "x", "../etc/passwd.liquid": "x", "snippets/a.html": "x", "config/x.json": "{" }, assets: ["x.svg", "page.html", "../a.css", "ok.css"] });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        "../etc/passwd.liquid: unsupported file name",
        "snippets/a.html: unsupported file name",
        "layout/theme.liquid: required",
        "assets/x.svg: unsupported asset",
        "assets/page.html: unsupported asset",
        "assets/../a.css: unsupported asset",
      ]),
    );
    const parse = checkThemeBundle({ ...ok, files: { ...ok.files, "sections/x.liquid": "{{ a | nope }}", "snippets/y.liquid": "{% for %}" } });
    expect(parse.ok).toBe(false);
    expect(parse.errors.map((e) => e.split(":")[0])).toEqual(["sections/x.liquid", "snippets/y.liquid"]);
    expect(checkThemeBundle({ ...ok, files: { ...ok.files, "config/settings_data.json": "{x" } }).errors).toEqual(["config/settings_data.json: invalid JSON"]);
  });

  it("資産は決まった種類だけ（HTML・SVG は受け付けない）", () => {
    expect(assetType("theme.css")).toMatch(/^text\/css/);
    expect(assetType("a.WOFF2")).toBe("font/woff2");
    expect(assetType("x.svg")).toBeNull();
    expect(assetType("x.html")).toBeNull();
    expect(assetType(".htaccess")).toBeNull();
    expect(stripJsonComments('/* c */\n{"a":1}')).toBe('{"a":1}');
  });
});

describe("テーマを isolate のメモリに置く", () => {
  beforeEach(forgetThemes);
  const store = (objects: Record<string, string>) => {
    const reads: string[] = [];
    const storage: StorageAdapter = {
      put: async () => ({ url: "" }),
      delete: async () => {},
      get: async (key) => {
        reads.push(key);
        const v = objects[key];
        return v === undefined ? null : { body: new Response(v).body!, contentType: "application/json" };
      },
    };
    return { storage, reads };
  };

  it("版ごとに 1 回だけ読む（同時に読みに来ても 1 回）。無ければ null、壊れていれば ThemeError", async () => {
    const { storage, reads } = store({ "themes/s/v1/bundle.json": JSON.stringify({ format: 1, files, assets: [] }), "themes/s/bad/bundle.json": "{x" });
    const [a, b] = await Promise.all([loadTheme(storage, { id: "v1", storage_key: "themes/s/v1/bundle.json" }), loadTheme(storage, { id: "v1", storage_key: "themes/s/v1/bundle.json" })]);
    expect(a).toBe(b);
    expect(a!.engine.render("templates/index", { products: [{ name: "x" }] })).toBe("<b>x</b>");
    await loadTheme(storage, { id: "v1", storage_key: "themes/s/v1/bundle.json" });
    expect(reads).toEqual(["themes/s/v1/bundle.json"]);
    expect(await loadTheme(storage, { id: "v2", storage_key: "themes/s/v2/bundle.json" })).toBeNull();
    await expect(loadTheme(storage, { id: "bad", storage_key: "themes/s/bad/bundle.json" })).rejects.toBeInstanceOf(ThemeError);
  });
});
