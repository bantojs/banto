import { describe, expect, it } from "vitest";
import { Liquid } from "liquidjs/dist/liquid.browser.mjs";
import { createThemeEngine, ThemeError, THEME_LIMITS } from "../src/themes/liquid/engine";
import { dateFormatCacheSize } from "../src/themes/liquid/date";
import { extendShopify } from "../src/themes/liquid/shopify";

/** 描いた結果か、投げた ThemeError の種類 */
const outcome = (fn: () => string): string => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ThemeError) return `ThemeError:${e.kind}`;
    throw e;
  }
};

const timed = (fn: () => string): { ms: number; r: string } => {
  const t0 = performance.now();
  const r = outcome(fn);
  return { ms: performance.now() - t0, r };
};

function engineWith(tpl: string, opts: Parameters<typeof createThemeEngine>[1] = {}) {
  return createThemeEngine({ "layout/theme.liquid": "{{ content_for_layout }}", "templates/index.liquid": tpl, "snippets/x.liquid": "y" }, { extend: extendShopify, ...opts });
}

describe("Liquid の date フィルター（Banto の実装）は liquidjs と同じ出力", () => {
  // 代表的な書式（docs/themes.md に書いた範囲を含む）。%c %x %X は実行環境のロケールで描く
  const formats = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S%:z",
    "%z %Z %:z",
    "%A %a %B %b %h",
    "%j %p %P %I %l %k %e %-d %-m %-H %_m %05Y %^A %#B",
    "%s %L %N %3N %C %y %u %w %U %W %q %t%n%%",
    "%c|%x|%X",
    "%Q %",
    "%d %B %Y at %I:%M %p",
    "",
  ];
  const inputs: unknown[] = [
    "2026-10-28T00:00:00Z",
    "2026-10-28T23:59:59.123+09:00",
    "2024-02-29 12:34:56",
    "2026-01-01",
    "2026-07-04T08:05:00-05:00",
    1761612345,
    "1761612345",
    0,
    new Date("2026-12-31T15:00:00Z"),
    "not a date",
    "",
    null,
    undefined,
    42.5,
  ];
  const zones: (string | number | undefined)[] = [undefined, "Asia/Tokyo", "UTC", "America/New_York", "Europe/London", "Pacific/Chatham", 0, 540, -330];

  const compare = (zone: string | number | undefined, src: string, scope: Record<string, unknown>) => {
    const plain = new Liquid({ ...(zone !== undefined ? { timezoneOffset: zone } : {}), outputEscape: "escape" });
    const ours = createThemeEngine({}, { ...(typeof zone === "string" ? { timezone: zone } : {}) });
    if (typeof zone === "number") ours.liquid.options.timezoneOffset = zone;
    return { expected: String(plain.parseAndRenderSync(src, scope)), got: ours.renderString(src, scope) };
  };

  it("書式 × 入力 × 時間帯（engine の設定）", () => {
    let n = 0;
    for (const zone of zones) {
      for (const input of inputs) {
        for (const format of formats) {
          const { expected, got } = compare(zone, "{{ d | date: f }}", { d: input, f: format });
          expect(got, `zone=${String(zone)} input=${String(input)} format=${format}`).toBe(expected);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("2 つ目の引数（時間帯の上書き）と、書式なし・派生のフィルター", () => {
    for (const zone of ["Asia/Tokyo", undefined]) {
      for (const input of ["2026-10-28T00:00:00Z", 1761612345, "2026-03-08T07:30:00Z"]) {
        for (const tz of ["UTC", "America/Los_Angeles", "Australia/Lindeman", 0, 600, -540]) {
          const { expected, got } = compare(zone, "{{ d | date: '%Y-%m-%d %H:%M %z %Z %A', tz }}", { d: input, tz });
          expect(got, `zone=${String(zone)} input=${String(input)} tz=${String(tz)}`).toBe(expected);
        }
        for (const src of [
          "{{ d | date }}",
          "{{ d | date: nil }}",
          "{{ d | date_to_xmlschema }}",
          "{{ d | date_to_rfc822 }}",
          "{{ d | date_to_string }}",
          "{{ d | date_to_string: 'ordinal' }}",
          "{{ d | date_to_string: 'ordinal', 'US' }}",
          "{{ d | date_to_long_string }}",
          "{{ d | date_to_long_string: 'ordinal' }}",
          "{{ d | date_to_long_string: 'ordinal', 'US' }}",
        ]) {
          const { expected, got } = compare(zone, src, { d: input });
          expect(got, `zone=${String(zone)} input=${String(input)} ${src}`).toBe(expected);
        }
      }
    }
    // 'now' / 'today' は同じ秒なら同じ（秒の境で 1 回だけやり直す）
    for (let i = 0; i < 2; i++) {
      const { expected, got } = compare("Asia/Tokyo", "{{ 'now' | date: '%Y-%m-%d %H:%M:%S %z' }}|{{ 'today' | date: '%A' }}", {});
      if (expected === got || i === 1) {
        expect(got).toBe(expected);
        break;
      }
    }
  });

  it("夏時間の切り替わりの前後（連続した時刻）でも liquidjs と同じ", () => {
    // 1 時間・30 分（Lord Howe）・45 分のずれ（Chatham）の時間帯で、切り替わりの前後 20 分を 1 分ずつ
    const transitions: [string, string][] = [
      ["America/New_York", "2026-03-08T07:00:00Z"],
      ["America/New_York", "2026-11-01T06:00:00Z"],
      ["Europe/London", "2026-03-29T01:00:00Z"],
      ["Australia/Lord_Howe", "2026-04-04T15:00:00Z"],
      ["Australia/Lord_Howe", "2026-10-03T15:30:00Z"],
      ["Pacific/Chatham", "2026-04-04T14:00:00Z"],
    ];
    for (const [zone, at] of transitions) {
      const t = Date.parse(at);
      for (let m = -20; m <= 20; m++) {
        const d = new Date(t + m * 60_000 + 7).toISOString();
        const { expected, got } = compare(zone, "{{ d | date: '%Y-%m-%d %H:%M:%S %z %Z' }}", { d });
        expect(got, `${zone} ${d}`).toBe(expected);
      }
    }
  });

  it("知らない時間帯の名前は描画の誤り（liquidjs と同じ）。幅の指定も量の上限に数える", () => {
    const e = createThemeEngine({});
    expect(outcome(() => e.renderString("{{ d | date: '%Y', 'Mars/Olympus' }}", { d: "2026-01-01" }))).toBe("ThemeError:render");
    expect(outcome(() => e.renderString("{{ d | date: '%999999999Y' }}", { d: "2026-01-01" }))).toBe("ThemeError:limit");
  });
});

describe("Liquid の 1 手の重さの上限", () => {
  it("date を 10 万回呼んでも 2 秒以内（Intl.DateTimeFormat を使い回す）。覚える数は 64 まで", () => {
    // 出力の上限（2,000,000 字）に当たらないよう assign で受ける。日付が毎回違っても（i を UNIX 秒として）同じ
    for (const src of ["{% for i in (1..100000) %}{% assign x = 'now' | date: '%Y-%m-%d %H:%M:%S %z %A %B' %}{% endfor %}{{ x }}", "{% for i in (1..100000) %}{% assign x = i | date: '%Y-%m-%d %H:%M:%S %z %A %B' %}{% endfor %}{{ x }}"]) {
      const e = engineWith(src);
      const { ms, r } = timed(() => e.render("templates/index", {}));
      expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \w+ \w+$/);
      expect(ms, `date x 100000 took ${ms}ms`).toBeLessThan(2000);
    }
    // テーマが時間帯を次々に変えても、覚える Intl.DateTimeFormat は上限まで
    const z = createThemeEngine({});
    const zones = ["Asia/Tokyo", "UTC", "America/New_York", "Europe/Paris", "Australia/Sydney", "Asia/Kolkata", "Africa/Cairo", "America/Sao_Paulo", "Pacific/Auckland", "Asia/Dubai", "Europe/Moscow", "America/Anchorage", "Asia/Seoul", "Asia/Shanghai", "Europe/Berlin", "America/Chicago", "America/Denver", "Asia/Bangkok", "Asia/Jakarta", "Europe/Rome"];
    for (const tz of zones) z.renderString("{{ d | date: '%A %B %c', tz }}", { d: "2026-01-01", tz });
    expect(dateFormatCacheSize()).toBeLessThanOrEqual(64);
  });

  it("範囲 (a..b) は 100,000 まで。超えたら limit で止まる（where・uniq・sort の材料にさせない）", () => {
    expect(THEME_LIMITS.range).toBe(100_000);
    const ok = engineWith("{% assign arr = (1..100000) %}{{ arr | size }}");
    expect(ok.render("templates/index", {})).toBe("100000");
    const cases: Record<string, string> = {
      where_big: "{% assign arr = (1..2000000) %}{{ arr | where: 'x' | size }}",
      uniq_big: "{% assign arr = (1..2000000) %}{{ arr | uniq | size }}",
      sort_big: "{{ (1..2000000) | sort | first }}",
      for_big: "{% for i in (1..100001) %}{% endfor %}",
      tablerow_big: "{% tablerow i in (1..10000000) cols: 1000 %}{% endtablerow %}",
      variable_bounds: "{% assign n = 200000 %}{% assign arr = (1..n) %}{{ arr | size }}",
      negative_low: "{{ (-100000..1) | size }}",
    };
    for (const [name, src] of Object.entries(cases)) {
      const { ms, r } = timed(() => engineWith(src).render("templates/index", {}));
      expect(r, name).toBe("ThemeError:limit");
      expect(ms, `${name} took ${ms}ms`).toBeLessThan(500);
    }
    // 上限は engine の設定で変えられる。ふつうの範囲は変わらない
    const small = engineWith("{{ (1..10) | join: ',' }}|{% for i in (3..5) %}{{ i }}{% endfor %}|{{ (5..1) | size }}", { limits: { range: 10 } });
    expect(small.render("templates/index", {})).toBe("1,2,3,4,5,6,7,8,9,10|345|0");
    expect(outcome(() => engineWith("{{ (1..11) | size }}", { limits: { range: 10 } }).render("templates/index", {}))).toBe("ThemeError:limit");
  });

  it("時計の上限（Node）: 1 ページが timeMs を超えたら limit。Workers では時計が進まないので手数と範囲の上限が守る", () => {
    expect(THEME_LIMITS.timeMs).toBe(2000);
    const slow = "{% for i in (1..100000) %}{{ 'now' | date: '%Y-%m-%d %H:%M:%S %z %A %B' }}{% endfor %}";
    expect(outcome(() => engineWith(slow, { limits: { timeMs: 5 } }).render("templates/index", {}))).toBe("ThemeError:limit");
    // 1 ページの中で分け合う（page() の中の 2 回目で止まる）。ページが変われば引き直す
    const e = engineWith("{% for i in (1..500) %}{{ i | date: '%Y-%m-%d %H:%M:%S %z %A %B' }}{% endfor %}", { limits: { timeMs: 100 } });
    expect(e.render("templates/index", {})).not.toMatch(/^ThemeError/);
    expect(outcome(() => e.page(() => Array.from({ length: 200 }, () => e.render("templates/index", {})).join("")))).toBe("ThemeError:limit");
    expect(e.render("templates/index", {})).not.toMatch(/^ThemeError/);
  });

  it("上限の組み合わせ: 監査で測った重い書き方はどれも 3 秒以内に止まるか終わる", () => {
    const cases: Record<string, string> = {
      nested_for: "{% for a in (1..100000) %}{% for b in (1..100000) %}{% endfor %}{% endfor %}",
      big_range_join: "{{ (1..50000000) | join: ',' | size }}",
      doubling: "{% assign s = 'ab' %}{% for i in (1..60) %}{% assign s = s | append: s %}{% endfor %}{{ s | size }}",
      times_str: "{{ 'a' | times: 1000000000 }}",
      slice_huge: "{{ 'abc' | slice: 0, 1000000000 | size }}",
      date_loop: "{% for i in (1..100000) %}{{ 'now' | date: '%Y-%m-%d %H:%M:%S %z %A %B' }}{% endfor %}",
      sort_loop: "{% assign arr = (1..5000) %}{% for i in (1..100000) %}{% assign x = arr | sort | reverse | first %}{% endfor %}",
      render_loop: "{% for i in (1..1000000) %}{% render 'x' %}{% endfor %}",
      capture_loop: "{% for i in (1..1000000) %}{% capture c %}{{ c }}xxxxxxxxxx{% endcapture %}{% endfor %}{{ c | size }}",
      where_big: "{% assign arr = (1..2000000) %}{{ arr | where: 'x' | size }}",
    };
    for (const [name, src] of Object.entries(cases)) {
      const { ms } = timed(() => engineWith(src).render("templates/index", {}));
      expect(ms, `${name} took ${ms}ms`).toBeLessThan(3000);
    }
  });
});
