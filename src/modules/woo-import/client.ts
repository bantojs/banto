/**
 * WooCommerce の商品 CSV インポーター（同梱モジュール woo_import）のブラウザ側。
 *
 * CSV の解析と Banto への対応付けは**ブラウザで行う**（3 MB 級の CSV を Worker で解析すると Workers 無料プランの CPU 制限に当たる。
 * docs/ARCHITECTURE.md「速度の予算」）。Worker には小分けにした JSON だけを送り、書き込みは import_catalog RPC（0009）が行う。
 *
 * この関数は自己完結に書く（外の変数・import を参照しない）。管理画面は `(${wooImporter.toString()})().mount(...)` としてページに埋め込み、
 * テストは `wooImporter().analyze(...)` などを Node で直接呼ぶ。
 */
export function wooImporter() {
  "use strict";

  // ---------- 型 ----------
  type Row = string[];
  interface FieldCandidate {
    /** 値の出どころ（CSV は "c<列番号>"、REST API は "m:<メタキー>"） */
    source: string;
    header: string;
    key: string;
    label: string;
    type: "text" | "textarea" | "number";
    filled: number;
    sample: string;
    /** 既定で取り込むか（Facebook 連携・埋め込みキャッシュ等の内部用メタと、値がそろっていない列は既定で外す） */
    suggested: boolean;
    /** 数値が多いのに文字が混ざっている列。CSV の列ずれで別の値が入っている可能性が高い */
    unstable: boolean;
  }
  interface SkuPlan {
    code: string;
    name: string | null;
    price_jpy: number;
    compare_at_price_jpy: number | null;
    gtin: string | null;
    options: Record<string, string>;
    available: number;
    /** 税区分（WooCommerce の Tax class。標準は ""、課税しない商品は NO_TAX）。税抜で入力していたショップの換算に使う */
    taxClass: string;
    disabled?: boolean;
  }
  interface ProductPlan {
    wcId: string;
    slug: string;
    name: string;
    description: string | null;
    published: boolean;
    tags: string[];
    brands: string[];
    categoryPaths: string[][];
    skus: SkuPlan[];
    images: string[];
    /** CSV の列ずれ検出で、メタ情報を信用しない商品か */
    metaUnreliable: boolean;
    /** カスタム項目の候補の値（キーは FieldCandidate.source） */
    fields: Record<string, string>;
    /** 旧サイトの商品ページの URL（REST API のときだけ分かる） */
    permalink: string | null;
    variationImages?: string[];
  }
  interface Warning {
    code: string;
    count: number;
    examples: string[];
  }
  interface Analysis {
    header: string[];
    products: ProductPlan[];
    fields: FieldCandidate[];
    warnings: Warning[];
    stats: { rows: number; products: number; skus: number; categories: number; images: number; brands: string[]; taxClasses: { taxClass: string; skus: number }[] };
  }
  interface BuildOptions {
    /** 取り込むカスタム項目（値の出どころ → key / label / type） */
    fields: { source: string; key: string; label: string; type: string }[];
    brandMode: "first" | "last";
    overwriteStock: boolean;
    skipDisabledVariations: boolean;
    includeVariationImages: boolean;
    /** WooCommerce で価格を税抜で入力していた（設定 → 税金 →「税込価格で入力」が「いいえ」）。Banto は税込なので換算する */
    pricesExcludeTax?: { rates: Record<string, number>; rounding: "round" | "floor" | "ceil" };
    /** WooCommerce の税区分 → Banto の商品の区分（0017）。無い区分は defaultTaxClass */
    taxClasses?: Record<string, "standard" | "reduced" | "exempt">;
  }

  // ---------- CSV ----------
  /** RFC 4180 の CSV（ダブルクォート、"" のエスケープ、改行を含むセル、CRLF / LF、先頭の BOM） */
  function parseCsv(text: string): Row[] {
    const rows: Row[] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
  }

  /**
   * ファイルの中身 → 文字列。WooCommerce の書き出しは UTF-8 だが、Excel で開いて保存し直すと Shift_JIS になるので、
   * UTF-8 として読めなければ Shift_JIS で読む（ブラウザ標準の TextDecoder）
   */
  function decode(buf: ArrayBuffer): { text: string; encoding: "utf-8" | "shift_jis" } {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
    } catch {
      return { text: new TextDecoder("shift_jis").decode(buf), encoding: "shift_jis" };
    }
  }

  // ---------- 文字列の整形 ----------
  /** WooCommerce の説明（HTML、改行が「\n」の 2 文字で書き出される）→ プレーンテキスト */
  function htmlToText(input: string): string {
    let s = input.replace(/\r?\\n/g, "\n").replace(/\r\n?/g, "\n");
    s = s.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n").replace(/<\s*li[^>]*>/gi, "・");
    s = s.replace(/<[^>]*>/g, "");
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return named[e.toLowerCase()] ?? m;
    });
    return s
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** FNV-1a（32 bit）→ 36 進 6〜7 文字。カテゴリーやカスタム項目の安定したキーに使う */
  function hash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** URL 用スラッグ（英小文字・数字・ハイフン、64 文字まで）。作れなければ null */
  function slugify(s: string): string | null {
    const v = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) ? v : null;
  }

  function splitList(s: string): string[] {
    return s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }

  /** 「メタ: %e7%9d%80%e4%b8%88_s」→「着丈_s」。末尾で切れた % 列は捨てる */
  function decodeMetaName(name: string): string {
    let s = name.replace(/^Meta\s*:\s*/i, "");
    // 書き出し側で名前が途中で切られ、末尾の UTF-8 が欠けていることがある。欠けた分を 1 つずつ落として読めるところまで戻す
    for (let n = 0; n < 12; n++) {
      try {
        s = decodeURIComponent(s);
        break;
      } catch {
        s = s.replace(/%[0-9a-f]{0,2}$/i, "");
      }
    }
    return s.replace(/^_+/, "").replace(/_+$/, "").trim();
  }

  function fieldKeyFor(label: string, used: Set<string>): string {
    let key = label
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "")
      .slice(0, 40);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || /[^\x20-\x7e]/.test(label)) key = `f_${hash(label)}`;
    let k = key;
    for (let n = 2; used.has(k); n++) k = `${key.slice(0, 36)}_${n}`;
    used.add(k);
    return k;
  }

  // ---------- 列の対応 ----------
  // 列名は英語版だけを見る。WooCommerce の書き出しは列名を管理画面の言語に訳すので、訳の揺れ（バージョン・言語ごとに違う）を追わず、
  // 英語以外なら「プロフィールの言語を English にして書き出し直す」よう案内する（docs/woo-import.md）
  const COLUMNS: Record<string, string> = {
    id: "ID",
    type: "Type",
    sku: "SKU",
    gtin: "GTIN, UPC, EAN, or ISBN",
    name: "Name",
    published: "Published",
    short_description: "Short description",
    description: "Description",
    sale_from: "Date sale price starts",
    sale_to: "Date sale price ends",
    tax_status: "Tax status",
    tax_class: "Tax class",
    in_stock: "In stock?",
    stock: "Stock",
    sale_price: "Sale price",
    regular_price: "Regular price",
    categories: "Categories",
    tags: "Tags",
    images: "Images",
    parent: "Parent",
    brands: "Brands",
    position: "Position",
    // WooGallery など、バリエーションごとの画像を足すプラグインの列
    variation_images: "Variation Images",
    woogallery_images: "WooGallery Variation Images",
  };
  /** 取り込まない標準列（WooCommerce 固有の設定や、Banto に対応する器が無いもの） */
  const IGNORED = new Set([
    "Is featured?", "Visibility in catalog", "Low stock amount", "Backorders allowed?", "Sold individually?", "Weight (kg)", "Length (cm)", "Width (cm)", "Height (cm)",
    "Weight (g)", "Weight (lbs)", "Weight (oz)", "Length (mm)", "Width (mm)", "Height (mm)", "Length (in)", "Width (in)", "Height (in)", "Length (m)", "Width (m)", "Height (m)",
    "Allow customer reviews?", "Purchase note", "Shipping class", "Download limit", "Download expiry days", "Grouped products", "Upsells", "Cross-sells", "External URL", "Button text",
  ]);
  const ATTR_NAME = /^Attribute (\d+) name$/;
  const ATTR_VALUE = /^Attribute (\d+) value\(s\)$/;
  const ATTR_OTHER = /^Attribute \d+ (visible|global|default)$/;
  /** Download 1 name / Download 1 URL など（ダウンロード商品の列） */
  const DOWNLOAD = /^Download \d+ (ID|name|URL)$/;
  /** 外部サービスとの同期・WordPress の内部キャッシュ等。既定で外す */
  const INTERNAL_META = /^_?(oembed|wc_facebook|fb_|wp_old|last_change|members_access|wcgs_|edit_|thumbnail_id|product_image_gallery|wp_)/i;
  /** 課税しない商品（Tax status が none / shipping）の税区分 */
  const NO_TAX = "(none)";
  /** 列名が英語でない（管理画面の言語で訳されている）か。英字・数字・記号以外の文字を含む列が、メタ列以外にあれば訳されている */
  const localizedHeader = (header: string[]) => header.some((h) => !/^Meta\s*:/i.test(h.trim()) && /[^\x20-\x7e]/.test(h.replace(/^\ufeff/, "")));

  function indexColumns(header: string[]) {
    const idx: Record<string, number> = {};
    header.forEach((h, i) => {
      const name = h.trim();
      for (const [k, col] of Object.entries(COLUMNS)) if (idx[k] === undefined && col === name) idx[k] = i;
    });
    const attrs: { n: number; name: number; value: number }[] = [];
    header.forEach((h, i) => {
      const m = ATTR_NAME.exec(h.trim());
      if (m) {
        const n = Number(m[1]);
        const value = header.findIndex((x) => {
          const v = ATTR_VALUE.exec(x.trim());
          return v !== null && Number(v[1]) === n;
        });
        if (value >= 0) attrs.push({ n, name: i, value });
      }
    });
    return { idx, attrs };
  }

  // ---------- 解析（CSV と REST API で共通の形にしてから、Banto への対応付けを 1 か所で行う） ----------
  type Warn = Map<string, Warning>;
  function addWarn(w: Warn, code: string, example: string) {
    const x = w.get(code) ?? { code, count: 0, examples: [] };
    x.count++;
    if (example && x.examples.length < 5) x.examples.push(example);
    w.set(code, x);
  }

  /** WooCommerce の日付（"2026-10-01"、"2026-10-01 00:00:00"、"2026-10-01T00:00:00"）→ 現地時刻。終了日は日付だけならその日の終わりまで */
  function dateOf(v: string, endOfDay: boolean): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
    if (!m) return null;
    if (m[4] === undefined) return endOfDay ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, 23, 59, 59) : new Date(+m[1]!, +m[2]! - 1, +m[3]!);
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  }

  /**
   * 対応付けの前の共通の形。CSV（analyze）と REST API（fetchStore）がそれぞれこの形にする。
   * 価格・在庫・日付は WooCommerce の文字列のまま持ち、解釈は plan() だけが行う
   */
  interface SourceVariation {
    wcId: string;
    sku: string;
    name: string;
    published: boolean;
    price: PriceIn;
    taxClass: string;
    stock: StockIn;
    gtin: string;
    options: Record<string, string>;
    images: string[];
  }
  interface SourceProduct {
    wcId: string;
    type: string;
    sku: string;
    name: string;
    published: boolean;
    shortDescription: string;
    description: string;
    categoryPaths: string[][];
    tags: string[];
    brands: string[];
    images: string[];
    price: PriceIn;
    taxStatus: string;
    taxClass: string;
    stock: StockIn;
    gtin: string;
    /** カスタム項目の候補の値（キーは FieldSource.source） */
    fields: Record<string, string>;
    metaUnreliable: boolean;
    permalink: string | null;
    variations: SourceVariation[];
  }
  interface PriceIn {
    regular: string;
    sale: string;
    from: string;
    to: string;
  }
  /** status: in（在庫あり）/ out（在庫切れ）/ backorder（お取り寄せ可）/ ""（不明） */
  interface StockIn {
    qty: string;
    status: string;
  }
  interface FieldSource {
    source: string;
    header: string;
    label: string;
    meta: boolean;
  }

  function plan(sources: SourceProduct[], fieldSources: FieldSource[], warn: Warn, now: Date, header: string[], rowCount: number): Analysis {
    const usedSlugs = new Set<string>();
    const usedCodes = new Set<string>();
    const brands = new Set<string>();
    const categoryKeys = new Set<string>();
    const uniqueCode = (want: string, fallback: string) => {
      let c = (want || fallback).slice(0, 100);
      if (usedCodes.has(c)) c = `${c.slice(0, 90)}-${hash(fallback)}`;
      usedCodes.add(c);
      return c;
    };
    /** 価格。セール価格は期間内（期間の指定が無ければ常に）だけ販売価格にする。Banto には予約価格が無いので、これからのセールは取り込まない */
    const priceOf = (p: PriceIn, label: string) => {
      const regular = Number.parseInt(p.regular, 10);
      const sale = Number.parseInt(p.sale, 10);
      if (Number.isInteger(sale) && sale >= 0) {
        const from = dateOf(p.from, false);
        const to = dateOf(p.to, true);
        if (from && from > now) addWarn(warn, "sale_scheduled", `${label}（${p.from.slice(0, 10)}〜）`);
        else if (to && to < now) addWarn(warn, "sale_ended", label);
        else return { price: sale, compare: Number.isInteger(regular) && regular > sale ? regular : null };
      }
      return Number.isInteger(regular) && regular >= 0 ? { price: regular, compare: null } : null;
    };
    const stockOf = (s: StockIn, label: string): number | null => {
      const n = Number.parseInt(s.qty, 10);
      if (Number.isInteger(n)) return Math.max(0, n);
      if (s.status === "out") return 0;
      // お取り寄せ可（数量なし）: Banto に取り寄せの器は無いので、在庫数の無い SKU と同じく 0 で取り込む
      addWarn(warn, s.status === "backorder" ? "backorder" : "stock_unknown", label);
      return null;
    };
    const gtinOf = (g: string, code: string): string | null => {
      if (!g) return null;
      if (/^([0-9]{8}|[0-9]{12,14})$/.test(g)) return g;
      addWarn(warn, "bad_gtin", `${code}: ${g}`);
      return null;
    };

    const products: ProductPlan[] = [];
    const pairs: [SourceProduct, ProductPlan, string][] = [];
    for (const s of sources) {
      let slug = slugify(s.sku) ?? `wc-${s.wcId}`;
      if (usedSlugs.has(slug)) slug = `${slug.slice(0, 50)}-${s.wcId}`;
      usedSlugs.add(slug);
      const paths = s.categoryPaths.map((p) => p.slice(0, 3)).filter((p) => p.length > 0);
      paths.forEach((p) => p.forEach((_, d) => categoryKeys.add(p.slice(0, d + 1).join(">"))));
      s.brands.forEach((b) => brands.add(b));
      const description = [htmlToText(s.shortDescription), htmlToText(s.description)].filter(Boolean).join("\n\n");
      const p: ProductPlan = {
        wcId: s.wcId,
        slug,
        name: s.name || s.sku || `#${s.wcId}`,
        description: description || null,
        published: s.published,
        tags: s.tags,
        brands: s.brands,
        categoryPaths: paths,
        skus: [],
        images: s.images,
        metaUnreliable: s.metaUnreliable,
        fields: s.metaUnreliable ? {} : s.fields,
        permalink: s.permalink,
      };
      // 課税しない商品は NO_TAX。バリエーションの課税状態は親に従う（WooCommerce と同じ）
      const taxClass = s.taxStatus === "none" || s.taxStatus === "shipping" ? NO_TAX : s.taxClass;
      if (s.type === "simple") {
        const pr = priceOf(s.price, p.name);
        if (!pr) addWarn(warn, "no_price", p.name);
        else {
          const st = stockOf(s.stock, p.name);
          const code = uniqueCode(s.sku, `wc-${s.wcId}`);
          p.skus.push({ code, name: null, price_jpy: pr.price, compare_at_price_jpy: pr.compare, gtin: gtinOf(s.gtin, code), options: {}, available: st ?? -1, taxClass });
        }
      }
      if (p.metaUnreliable) addWarn(warn, "meta_misaligned", `${p.name}（ID ${s.wcId}）`);
      products.push(p);
      pairs.push([s, p, taxClass]);
    }
    // バリエーション（SKU の品番が重ならないよう、親の商品をすべて並べてから）
    for (const [s, parent, parentClass] of pairs)
      for (const v of s.variations) {
        const label = `${v.name || parent.name}（ID ${v.wcId}）`;
        const pr = priceOf(v.price, label);
        if (!pr) {
          addWarn(warn, "no_price", label);
          continue;
        }
        const st = stockOf(v.stock, label);
        const code = uniqueCode(v.sku, `${parent.slug}-${v.wcId}`);
        const sku: SkuPlan = {
          code,
          name: Object.values(v.options).join(" / ") || null,
          price_jpy: pr.price,
          compare_at_price_jpy: pr.compare,
          gtin: null,
          options: v.options,
          available: st ?? -1,
          taxClass: parentClass === NO_TAX ? NO_TAX : v.taxClass === "parent" ? parentClass : v.taxClass,
        };
        if (!v.published) {
          addWarn(warn, "disabled_variation", label);
          sku.disabled = true;
        }
        sku.gtin = gtinOf(v.gtin, code);
        parent.skus.push(sku);
        for (const u of v.images) {
          const list = (parent.variationImages ??= []);
          if (!list.includes(u)) list.push(u);
        }
      }
    for (const p of products) if (p.skus.length === 0) addWarn(warn, "no_sku", p.name);
    // Banto の税区分は商品ごと。SKU ごとに違う商品は最初の SKU の区分にする
    for (const p of products) if (new Set(p.skus.map((k) => k.taxClass)).size > 1) addWarn(warn, "mixed_tax_class", p.name);

    // カスタム項目の候補（商品の値で判断。バリエーションのメタは同期用のものだけなので見ない）
    const usedKeys = new Set<string>();
    const fields: FieldCandidate[] = [];
    for (const fs of fieldSources) {
      const vals: string[] = [];
      for (const p of products) {
        const v = p.fields[fs.source];
        if (v) vals.push(v);
      }
      if (vals.length === 0) continue;
      const label = fs.label.slice(0, 60) || fs.header;
      const numeric = vals.filter((v) => /^-?[0-9]+(\.[0-9]+)?$/.test(v)).length;
      const type = numeric === vals.length ? "number" : vals.some((v) => v.length > 200 || /\\n|\n/.test(v)) ? "textarea" : "text";
      const unstable = numeric !== vals.length && numeric / vals.length >= 0.6;
      // ACF などが値の横に置く「フィールドの参照」（_項目名 = field_xxxx）は中身ではない
      const reference = vals.every((v) => /^field_[0-9a-f]{6,}$/.test(v));
      fields.push({
        source: fs.source,
        header: fs.header,
        key: fieldKeyFor(label, usedKeys),
        label,
        type,
        filled: vals.length,
        sample: vals[0]!.replace(/\r?\\n/g, " ").slice(0, 80),
        suggested: !unstable && !reference && !(fs.meta && INTERNAL_META.test(label)),
        unstable,
      });
    }

    const images = products.reduce((n, p) => n + p.images.length, 0);
    const skuCount = products.reduce((n, p) => n + p.skus.length, 0);
    const taxCount = new Map<string, number>();
    for (const p of products) for (const k of p.skus) taxCount.set(k.taxClass, (taxCount.get(k.taxClass) ?? 0) + 1);
    return {
      header,
      products,
      fields,
      warnings: [...warn.values()],
      stats: {
        rows: rowCount,
        products: products.length,
        skus: skuCount,
        categories: categoryKeys.size,
        images,
        brands: [...brands].sort(),
        taxClasses: [...taxCount].map(([taxClass, skus]) => ({ taxClass, skus })).sort((a, b) => b.skus - a.skus),
      },
    };
  }

  /** CSV → 共通の形 → 対応付け。now: セール期間の判定に使う日時（既定は今。ブラウザの時刻 = 運営者の地域の時刻で、WooCommerce の日付と同じく現地時刻として比べる） */
  function analyze(text: string, now: Date = new Date()): Analysis {
    const all = parseCsv(text);
    const header = all[0] ?? [];
    const rows = all.slice(1);
    const { idx, attrs } = indexColumns(header);
    const warn: Warn = new Map();
    if (idx["type"] === undefined || idx["name"] === undefined) {
      const code = localizedHeader(header) ? "localized_headers" : "not_woocommerce";
      return { header, products: [], fields: [], warnings: [{ code, count: 1, examples: code === "localized_headers" ? header.slice(0, 5) : [] }], stats: { rows: rows.length, products: 0, skus: 0, categories: 0, images: 0, brands: [], taxClasses: [] } };
    }
    const get = (r: Row, k: string) => (idx[k] === undefined ? "" : (r[idx[k]!] ?? "").trim());

    // カスタム項目の候補: 標準列・属性列・無視する列以外
    const known = new Set<number>(Object.values(idx));
    attrs.forEach((a) => {
      known.add(a.name);
      known.add(a.value);
    });
    const candidateCols: number[] = [];
    header.forEach((h, i) => {
      if (!known.has(i) && !IGNORED.has(h.trim()) && !ATTR_OTHER.test(h.trim()) && !DOWNLOAD.test(h.trim())) candidateCols.push(i);
    });

    // 列ずれの検出: WooCommerce の CSV 書き出しは 50 行ずつの塊で書かれ、商品ごとにメタ項目が違うと、塊ごとにメタ列の並びが変わる
    // （標準列は位置が固定なので影響しない）。そこで「ある列でよく出る値（yes / no、役割名、素材名など）」が別の列に現れたら、
    // その塊のメタ情報は信用しない。数値どうしのずれは見分けられないので、REST API からの取り込みを勧める。
    const BATCH = 50;
    const productRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => {
      const ty = get(r, "type");
      return ty === "variable" || ty === "simple";
    });
    // 値ごとに、どの列に何回出たか（数値は除く。数値どうしのずれは見分けられない）
    const seen = new Map<string, Map<number, number>>();
    for (const { r } of productRows)
      for (const c of candidateCols) {
        const v = (r[c] ?? "").trim();
        if (!v || /^-?[0-9.,～~\- ]+$/.test(v)) continue;
        const m = seen.get(v) ?? new Map<number, number>();
        m.set(c, (m.get(c) ?? 0) + 1);
        seen.set(v, m);
      }
    const peak = new Map<string, number>();
    for (const [v, m] of seen) peak.set(v, Math.max(...m.values()));
    /**
     * 別の列から流れ込んだ値: どこかの列ではよく出る（10 回以上）のに、この列ではその 5% 未満しか出ない値。
     * 全体に対する割合で見ないのは、yes / no のように同じ値を持つ列がたくさんあると、どの列も割合が小さくなるため
     */
    const foreign = (v: string, c: number) => {
      const p = peak.get(v) ?? 0;
      return p >= 10 && (seen.get(v)?.get(c) ?? 0) / p < 0.05;
    };
    const badBatches = new Set<number>();
    for (const { r, i } of productRows)
      for (const c of candidateCols) {
        const v = (r[c] ?? "").trim();
        if (v && foreign(v, c)) {
          badBatches.add(Math.floor(i / BATCH));
          break;
        }
      }

    const priceIn = (r: Row): PriceIn => ({ regular: get(r, "regular_price"), sale: get(r, "sale_price"), from: get(r, "sale_from"), to: get(r, "sale_to") });
    const stockIn = (r: Row): StockIn => {
      const s = get(r, "in_stock");
      return { qty: get(r, "stock"), status: s === "1" ? "in" : s === "0" ? "out" : s === "backorder" ? "backorder" : "" };
    };
    const sources: SourceProduct[] = [];
    const bySku = new Map<string, SourceProduct>();
    const byId = new Map<string, SourceProduct>();
    rows.forEach((r, i) => {
      const type = get(r, "type");
      if (type !== "variable" && type !== "simple") {
        // グループ商品・外部リンク商品など、Banto に対応する器が無い種類（バリエーションは後で親に付ける）
        if (type && type !== "variation") addWarn(warn, "skipped_type", `${get(r, "name") || `ID ${get(r, "id")}`}（${type}）`);
        return;
      }
      const fields: Record<string, string> = {};
      for (const c of candidateCols) {
        const v = (r[c] ?? "").trim();
        if (v) fields[`c${c}`] = v;
      }
      const s: SourceProduct = {
        wcId: get(r, "id"),
        type,
        sku: get(r, "sku"),
        name: get(r, "name"),
        published: get(r, "published") === "1",
        shortDescription: get(r, "short_description"),
        description: get(r, "description"),
        categoryPaths: splitList(get(r, "categories")).map((p) =>
          p
            .split(">")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
        tags: splitList(get(r, "tags")),
        brands: splitList(get(r, "brands")),
        images: splitList(get(r, "images")),
        price: priceIn(r),
        taxStatus: get(r, "tax_status"),
        taxClass: get(r, "tax_class"),
        stock: stockIn(r),
        gtin: get(r, "gtin"),
        fields,
        metaUnreliable: badBatches.has(Math.floor(i / BATCH)),
        permalink: null,
        variations: [],
      };
      sources.push(s);
      if (s.sku) bySku.set(s.sku, s);
      byId.set(s.wcId, s);
    });
    rows.forEach((r) => {
      if (get(r, "type") !== "variation") return;
      const ref = get(r, "parent");
      const parent = ref.startsWith("id:") ? byId.get(ref.slice(3)) : bySku.get(ref);
      if (!parent) {
        addWarn(warn, "orphan_variation", `ID ${get(r, "id")}`);
        return;
      }
      const options: Record<string, string> = {};
      for (const a of [...attrs].sort((x, y) => x.n - y.n)) {
        const k = (r[a.name] ?? "").trim();
        const v = (r[a.value] ?? "").trim();
        if (k && v && Object.keys(options).length < 5) options[k.slice(0, 40)] = v.slice(0, 60);
      }
      parent.variations.push({
        wcId: get(r, "id"),
        sku: get(r, "sku"),
        name: get(r, "name"),
        published: get(r, "published") === "1",
        price: priceIn(r),
        taxClass: get(r, "tax_class"),
        stock: stockIn(r),
        gtin: get(r, "gtin"),
        options,
        images: [...splitList(get(r, "images")), ...splitList(get(r, "variation_images")), ...splitList(get(r, "woogallery_images"))],
      });
    });
    const fieldSources: FieldSource[] = candidateCols.map((c) => {
      const h = header[c]!.trim();
      const meta = /^Meta\s*:/i.test(h);
      return { source: `c${c}`, header: h, label: meta ? decodeMetaName(h) || h : h, meta };
    });
    const a = plan(sources, fieldSources, warn, now, header, rows.length);
    // バリエーション商品があるのに、バリエーションの行が 1 つも無い。WooCommerce の書き出しを「カテゴリー」で絞ると、
    // バリエーション（カテゴリーを持たない）が含まれない
    if (rows.some((r) => get(r, "type") === "variable") && !rows.some((r) => get(r, "type") === "variation")) {
      addWarn(warn, "no_variations_in_csv", "");
      a.warnings = [...warn.values()];
    }
    return a;
  }

  // ---------- REST API（WooCommerce の /wp-json/wc/v3。ブラウザから直接呼び、キーは Banto に送らない） ----------
  interface StoreAccess {
    /** ショップの URL（https://example.com、サブディレクトリに WordPress を置いていればそのパスまで） */
    url: string;
    key: string;
    secret: string;
  }
  class WooApiError extends Error {
    constructor(
      readonly reason: "bad_url" | "network" | "unauthorized" | "not_found" | "http" | "bad_response",
      message: string,
    ) {
      super(message);
    }
  }
  type Json = Record<string, unknown>;
  type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

  /** 貼られた URL をショップの根元にそろえる（管理画面や REST の URL を貼っても受け付ける）。https 以外は受け付けない（キーが平文で流れる） */
  function storeBase(input: string): string {
    let u: URL;
    try {
      u = new URL(input.trim());
    } catch {
      throw new WooApiError("bad_url", input);
    }
    if (u.protocol !== "https:") throw new WooApiError("bad_url", input);
    // /shop は外さない（WordPress を /shop に置いているサイトがある）
    const path = u.pathname.replace(/\/(wp-admin|wp-json|wp-login\.php|index\.php)(\/.*)?$/, "").replace(/\/+$/, "");
    return `${u.origin}${path}`;
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : []);

  /** WooCommerce の REST API を呼ぶ（認証・/wp-json/ と ?rest_route= の切り替え・エラーの説明・件数を減らしての読み直し） */
  function wcClient(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void) {
    const base = storeBase(access.url);
    let queryStyle = false;
    const url = (path: string, params: Record<string, string>) => {
      const q = new URLSearchParams({ ...params, consumer_key: access.key.trim(), consumer_secret: access.secret.trim() });
      return queryStyle ? `${base}/?rest_route=/wc/v3/${path}&${q}` : `${base}/wp-json/wc/v3/${path}?${q}`;
    };
    /** どの呼び出しで何が返ったかをエラーに残す（キーは載せない） */
    const describe = (path: string, params: Record<string, string>, status: number, detail: string) => {
      const shown = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      return `[${path}${shown ? `?${shown}` : ""} → HTTP ${status}] ${detail}`.slice(0, 400);
    };
    const call = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
      for (;;) {
        let res: Awaited<ReturnType<FetchLike>>;
        let body: string;
        try {
          res = await fetchImpl(url(path, params), { headers: { accept: "application/json" } });
          body = await res.text();
        } catch (e) {
          throw new WooApiError("network", (e as Error).message);
        }
        if (res.status === 404 && !queryStyle) {
          queryStyle = true;
          continue;
        }
        const snippet = body.replace(/\s+/g, " ").trim().slice(0, 160);
        if (res.status === 401 || res.status === 403) throw new WooApiError("unauthorized", describe(path, params, res.status, snippet));
        if (res.status === 404) throw new WooApiError("not_found", describe(path, params, res.status, snippet));
        if (!res.ok) throw new WooApiError("http", describe(path, params, res.status, snippet));
        // 空の本文や HTML（PHP のメモリ・時間切れ、キャッシュ・セキュリティ系のプラグインの応答）は JSON として読めない
        try {
          return JSON.parse(body.replace(/^\ufeff/, "")) as unknown;
        } catch {
          const type = res.headers?.get("content-type") ?? "";
          throw new WooApiError("bad_response", describe(path, params, res.status, body.length === 0 ? `empty body ${type}` : `${type} ${body.length} bytes: ${snippet}`));
        }
      }
    };
    /**
     * 全件を読む（offset で送る）。step を渡すと進み具合を知らせる（バリエーションは商品単位で別に知らせる）。
     * 遅い・メモリの少ないサーバーは 100 件の応答を作りきれず、空の本文や 5xx を返すことがあるので、
     * そのときは件数を 100 → 25 → 5 と減らして同じ位置から読み直す
     */
    const SIZES = [100, 25, 5];
    const all = async (path: string, params: Record<string, string>, step?: string): Promise<Json[]> => {
      const out: Json[] = [];
      let size = 0;
      for (let n = 0; n < 5000; n++) {
        if (step) onProgress(step, out.length, 0);
        const per = SIZES[size]!;
        let rows: Json[];
        try {
          rows = list(await call(path, { ...params, per_page: String(per), offset: String(out.length) }));
        } catch (e) {
          const retryable = e instanceof WooApiError && (e.reason === "bad_response" || e.reason === "http");
          if (retryable && size < SIZES.length - 1) {
            size++;
            continue;
          }
          throw e;
        }
        out.push(...rows);
        if (rows.length < per) break;
      }
      return out;
    };
    return { call, all };
  }

  /**
   * WooCommerce の REST API から商品・バリエーション・カテゴリーを読み、CSV と同じ対応付けにかける。
   * 認証はクエリ文字列（consumer_key / consumer_secret、https のみ）。Authorization ヘッダーはサーバーの設定で落ちることが多く、
   * ヘッダーを付けないほうがブラウザの事前確認（CORS のプリフライト）も起きない。
   * パーマリンク設定が「基本」のサイトは /wp-json/ が使えないので、404 なら ?rest_route= の形で呼び直す。
   */
  async function fetchStore(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void = () => {}, now: Date = new Date()): Promise<{ analysis: Analysis; pricesExcludeTax: boolean | null }> {
    const { call, all } = wcClient(access, fetchImpl, onProgress);
    /** 使う項目だけを返してもらう（WooCommerce は関連商品などの重い計算を、頼まれた項目だけ行う） */
    const PRODUCT_FIELDS = [
      "id", "type", "sku", "name", "status", "permalink", "short_description", "description", "categories", "tags", "brands", "images", "regular_price", "sale_price",
      "date_on_sale_from", "date_on_sale_to", "tax_status", "tax_class", "manage_stock", "stock_quantity", "stock_status", "global_unique_id", "meta_data",
    ].join(",");
    const VARIATION_FIELDS = [
      "id", "sku", "name", "status", "regular_price", "sale_price", "date_on_sale_from", "date_on_sale_to", "tax_class", "manage_stock", "stock_quantity", "stock_status",
      "global_unique_id", "attributes", "image",
    ].join(",");

    // 最初の呼び出しで /wp-json/ と ?rest_route= のどちらが使えるかが決まる
    const cats = new Map<number, { name: string; parent: number }>();
    for (const c of await all("products/categories", { _fields: "id,name,parent" }, "categories")) cats.set(Number(c["id"]), { name: str(c["name"]), parent: Number(c["parent"] ?? 0) });

    // 税込 / 税抜の設定（読めなければ null。運営者が画面で選ぶ）
    let pricesExcludeTax: boolean | null = null;
    try {
      const calc = str(((await call("settings/general/woocommerce_calc_taxes")) as Json)["value"]);
      const incl = str(((await call("settings/tax/woocommerce_prices_include_tax")) as Json)["value"]);
      if (calc && incl) pricesExcludeTax = calc === "yes" && incl === "no";
    } catch (e) {
      if (e instanceof WooApiError && e.reason === "network") throw e;
    }
    const pathOf = (id: number): string[] => {
      const out: string[] = [];
      for (let cur = cats.get(id), n = 0; cur && n < 10; cur = cats.get(cur.parent), n++) out.unshift(cur.name);
      return out;
    };

    const items = await all("products", { status: "any", orderby: "id", order: "asc", _fields: PRODUCT_FIELDS }, "products");
    const warn: Warn = new Map();
    const sources: SourceProduct[] = [];
    const fieldSources = new Map<string, FieldSource>();
    const priceIn = (j: Json): PriceIn => ({ regular: str(j["regular_price"]), sale: str(j["sale_price"]), from: str(j["date_on_sale_from"]), to: str(j["date_on_sale_to"]) });
    const stockIn = (j: Json): StockIn => {
      const s = str(j["stock_status"]);
      const qty = typeof j["stock_quantity"] === "number" && j["manage_stock"] !== false ? String(j["stock_quantity"]) : "";
      return { qty, status: s === "instock" ? "in" : s === "outofstock" ? "out" : s === "onbackorder" ? "backorder" : "" };
    };
    const names = (v: unknown) => list(v).map((x) => str(x["name"])).filter(Boolean);
    for (const j of items) {
      const type = str(j["type"]);
      if (type !== "simple" && type !== "variable") {
        addWarn(warn, "skipped_type", `${str(j["name"]) || `ID ${str(j["id"])}`}（${type}）`);
        continue;
      }
      const fields: Record<string, string> = {};
      for (const m of list(j["meta_data"])) {
        const key = str(m["key"]);
        const v = m["value"];
        // 文字列・数値・真偽値だけ（配列やオブジェクトは他のプラグインの内部データ）
        const value = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "yes" : "no") : "";
        if (!key || !value) continue;
        const source = `m:${key}`;
        fields[source] = value;
        if (!fieldSources.has(source)) fieldSources.set(source, { source, header: key, label: key.replace(/^_+/, "") || key, meta: true });
      }
      sources.push({
        wcId: str(j["id"]),
        type,
        sku: str(j["sku"]).trim(),
        name: str(j["name"]).trim(),
        published: str(j["status"]) === "publish",
        shortDescription: str(j["short_description"]),
        description: str(j["description"]),
        categoryPaths: list(j["categories"]).map((c) => pathOf(Number(c["id"]))).filter((p) => p.length > 0),
        tags: names(j["tags"]),
        brands: names(j["brands"]),
        images: list(j["images"]).map((i) => str(i["src"])).filter(Boolean),
        price: priceIn(j),
        taxStatus: str(j["tax_status"]),
        taxClass: str(j["tax_class"]),
        stock: stockIn(j),
        gtin: str(j["global_unique_id"]).trim(),
        fields,
        metaUnreliable: false,
        permalink: str(j["permalink"]) || null,
        variations: [],
      });
    }

    // バリエーション（商品ごとに 1 回。同時に 4 本まで）
    const variable = sources.filter((s) => s.type === "variable");
    let done = 0;
    const queue = [...variable];
    onProgress("variations", 0, variable.length);
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        for (const v of await all(`products/${s.wcId}/variations`, { orderby: "id", order: "asc", _fields: VARIATION_FIELDS })) {
          const options: Record<string, string> = {};
          for (const a of list(v["attributes"])) {
            const k = str(a["name"]).trim();
            const o = str(a["option"]).trim();
            if (k && o && Object.keys(options).length < 5) options[k.slice(0, 40)] = o.slice(0, 60);
          }
          const image = v["image"] && typeof v["image"] === "object" ? str((v["image"] as Json)["src"]) : "";
          s.variations.push({
            wcId: str(v["id"]),
            sku: str(v["sku"]).trim(),
            name: str(v["name"]).trim(),
            published: str(v["status"]) === "publish",
            price: priceIn(v),
            taxClass: str(v["tax_class"]),
            stock: stockIn(v),
            gtin: str(v["global_unique_id"]).trim(),
            options,
            images: image ? [image] : [],
          });
        }
        s.variations.sort((a, b) => Number(a.wcId) - Number(b.wcId));
        onProgress("variations", ++done, variable.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, variable.length) }, worker));

    const analysis = plan(sources, [...fieldSources.values()], warn, now, [], items.length);
    return { analysis, pricesExcludeTax };
  }

  // ---------- WordPress のパスワード ----------
  /** bcrypt の形式（6.8 以降の $wp$2y$… と $2y$…）。$P$…（phpass）は移さない */
  const BCRYPT_RE = /^(\$wp)?\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/;
  /** wp_users の CSV から { email, hash } を取り出す。列が無ければ null */
  function passwordRows(text: string): { rows: { email: string; hash: string }[]; old: number } | null {
    const all = parseCsv(text);
    const header = (all[0] ?? []).map((h) => h.trim().toLowerCase());
    const ei = header.indexOf("user_email");
    const pi = header.indexOf("user_pass");
    if (ei < 0 || pi < 0) return null;
    const rows: { email: string; hash: string }[] = [];
    const seen = new Set<string>();
    let old = 0;
    for (const r of all.slice(1)) {
      const email = (r[ei] ?? "").trim().toLowerCase();
      const hash = (r[pi] ?? "").trim();
      if (!email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      if (BCRYPT_RE.test(hash)) rows.push({ email, hash });
      else if (hash) old++;
    }
    return { rows, old };
  }

  // ---------- 会員 ----------
  interface CustomerPlan {
    email: string;
    name: string | null;
    default_address: { name: string; phone: string; postal_code: string; state: string; city: string; line1: string; line2: string } | null;
  }
  /** 都道府県（JIS X 0401 の順。WooCommerce は JP01〜JP47 で持つ） */
  const PREFS = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
  ];
  function prefectureOf(state: string): string | null {
    const m = /^JP(\d{2})$/.exec(state.trim());
    if (m) return PREFS[Number(m[1]) - 1] ?? null;
    return PREFS.includes(state.trim()) ? state.trim() : null;
  }
  /** WooCommerce の顧客 1 件を Banto の会員に。住所は配送先（無ければ請求先）で、日本の住所だけ */
  function mapCustomer(j: Json): CustomerPlan | null {
    const email = str(j["email"]).trim().toLowerCase();
    if (!email.includes("@")) return null;
    const fullName = (first: string, last: string) => [last.trim(), first.trim()].filter(Boolean).join(" ");
    const billing = (j["billing"] && typeof j["billing"] === "object" ? j["billing"] : {}) as Json;
    const shipping = (j["shipping"] && typeof j["shipping"] === "object" ? j["shipping"] : {}) as Json;
    const name = fullName(str(j["first_name"]), str(j["last_name"])) || fullName(str(billing["first_name"]), str(billing["last_name"])) || null;
    const addrOf = (a: Json): CustomerPlan["default_address"] => {
      const country = str(a["country"]) || "JP";
      const state = prefectureOf(str(a["state"]));
      if (country !== "JP" || !state || !str(a["address_1"]).trim()) return null;
      return {
        name: fullName(str(a["first_name"]), str(a["last_name"])) || name || "",
        phone: str(a["phone"]).trim() || str(billing["phone"]).trim(),
        postal_code: str(a["postcode"]).trim(),
        state,
        city: str(a["city"]).trim(),
        line1: str(a["address_1"]).trim(),
        line2: str(a["address_2"]).trim(),
      };
    };
    return { email, name, default_address: addrOf(shipping) ?? addrOf(billing) };
  }
  /** 会員（WooCommerce の権限グループ「顧客」）を読む。パスワードは REST API からは読めない（読めても移さない） */
  async function fetchCustomers(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void = () => {}): Promise<{ customers: CustomerPlan[]; skipped: number }> {
    const { all } = wcClient(access, fetchImpl, onProgress);
    const rows = await all("customers", { role: "customer", orderby: "id", order: "asc", _fields: "id,email,first_name,last_name,billing,shipping" }, "customers");
    const seen = new Set<string>();
    const customers: CustomerPlan[] = [];
    let skipped = 0;
    for (const r of rows) {
      const c = mapCustomer(r);
      if (!c || seen.has(c.email)) {
        skipped++;
        continue;
      }
      seen.add(c.email);
      customers.push(c);
    }
    return { customers, skipped };
  }

  // ---------- クーポン ----------
  interface CouponPlan {
    /** WooCommerce のクーポンの ID（Banto の external_ref。コードを持たないキャンペーンでも二重に作らない） */
    wc_id: string;
    code: string;
    name: string;
    kind: "percent" | "fixed" | "free_shipping";
    value: number;
    ends_at: string | null;
    usage_limit: number | null;
    per_customer_limit: number | null;
    combinable: boolean;
    active: boolean;
    conditions: {
      min_subtotal_jpy?: number;
      max_subtotal_jpy?: number;
      exclude_sale?: boolean;
      /** 商品は Banto の slug に写すため、WooCommerce の ID と SKU を送る（サーバーが slug を探す） */
      products?: { id: string; sku: string }[];
      exclude_products?: { id: string; sku: string }[];
      category_slugs?: string[];
      exclude_category_slugs?: string[];
      /** ブランド（WooCommerce 本体のブランド機能。名前に直して写す） */
      brands?: string[];
      exclude_brands?: string[];
      /** 除くブランドは、2 つ目以降のブランド（取り込みでタグにしたもの）も除けるようタグでも除く */
      exclude_tags?: string[];
    };
    /** 使った人（使った回数だけ並ぶ）。WooCommerce の used_by は会員の ID かメールアドレス。fetchCoupons がメールアドレスにそろえる */
    used_by: string[];
    /** 使える人をメールアドレスで絞ったクーポンの、その人たち（ワイルドカードを除く）。サーバーがその人ごとの発行済みクーポンにする */
    restricted_emails: string[];
    /**
     * WooCommerce 本体の項目ではない設定（プラグインが meta_data に書いたもの）。Banto では同じ動きか確かめられないので、
     * 1 つでもあれば既定では作らない（作るなら無効で）。どのプラグインかは問わない
     */
    plugin_meta: { key: string; value: unknown }[];
  }
  /** WordPress 本体が投稿に書く、値引きに関係しない meta */
  const HARMLESS_META = new Set(["_edit_lock", "_edit_last", "_wp_old_slug", "_wp_old_date", "_wp_desired_post_slug", "_wp_trash_meta_status", "_wp_trash_meta_time"]);
  /** 空・オフの値（プラグインが既定値を書いているだけのもの）。止めすぎを減らすため。1 つでも中身があれば空ではない */
  function emptyMeta(v: unknown): boolean {
    if (v === null || v === undefined || v === false || v === 0) return true;
    if (typeof v === "string") return ["", "no", "0", "off", "false", "a:0:{}"].includes(v.trim().toLowerCase());
    if (Array.isArray(v)) return v.every(emptyMeta);
    if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(emptyMeta);
    return false;
  }
  /** クーポンの meta_data のうち、WooCommerce 本体の項目ではなく、中身があるもの（skip は Banto が写した鍵） */
  function pluginMeta(j: Json, skip: readonly string[] = []): { key: string; value: unknown }[] {
    const meta = Array.isArray(j["meta_data"]) ? (j["meta_data"] as Json[]) : [];
    return meta.map((m) => ({ key: str(m["key"]), value: m["value"] })).filter((m) => m.key && !HARMLESS_META.has(m.key) && !skip.includes(m.key) && !emptyMeta(m.value));
  }
  /** WooCommerce 本体のブランドの条件（REST の項目か meta_data。版によってどちらかに入る） */
  const BRAND_KEYS = ["product_brands", "exclude_product_brands"] as const;
  function brandIds(j: Json, key: (typeof BRAND_KEYS)[number]): number[] {
    const meta = Array.isArray(j["meta_data"]) ? (j["meta_data"] as Json[]) : [];
    const raw = Array.isArray(j[key]) ? j[key] : meta.find((m) => str(m["key"]) === key)?.["value"];
    return (Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  /**
   * WooCommerce のクーポン 1 件を Banto のキャンペーンに。移せないものは null と理由。
   * 商品・カテゴリーで絞ったクーポンは、Banto で対象が見つからなければサーバーが「無効」で作る（値引きの対象を広げない）
   */
  function mapCoupon(j: Json, catPath: (id: number) => string[], skuOf: (id: number) => string, now: Date, brandName: (id: number) => string | null = () => null): { plan: CouponPlan; notes: string[] } | { skip: string } {
    const raw = str(j["code"]).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(raw)) return { skip: "code" };
    const type = str(j["discount_type"]);
    const amount = Number(str(j["amount"]) || "0");
    const free = j["free_shipping"] === true;
    const notes: string[] = [];
    let kind: CouponPlan["kind"];
    let value = 0;
    if (type === "percent" && amount > 0) {
      kind = "percent";
      value = Math.min(100, Math.max(1, Math.round(amount)));
    } else if (type === "fixed_cart" && amount > 0) {
      kind = "fixed";
      value = Math.round(amount);
    } else if (free && amount === 0) {
      kind = "free_shipping";
    } else if (type === "fixed_product") return { skip: "fixed_product" };
    else return { skip: "amount" };
    if (free && kind !== "free_shipping") notes.push("free_shipping_dropped");
    const expires = str(j["date_expires_gmt"]) || str(j["date_expires"]);
    const ends = expires ? new Date(/Z|[+-]\d\d:?\d\d$/.test(expires) ? expires : `${expires}Z`) : null;
    if (ends && !Number.isNaN(ends.getTime()) && ends.getTime() < now.getTime()) return { skip: "expired" };
    const limit = typeof j["usage_limit"] === "number" ? (j["usage_limit"] as number) : null;
    const used = Number(j["usage_count"] ?? 0);
    if (limit !== null && limit - used <= 0) return { skip: "exhausted" };
    const perUser = typeof j["usage_limit_per_user"] === "number" ? (j["usage_limit_per_user"] as number) : null;
    const usedBy = Array.isArray(j["used_by"]) ? (j["used_by"] as unknown[]).map((v) => String(v).trim()).filter(Boolean) : [];
    if (perUser !== null && usedBy.length > 0) notes.push("history_moved");
    // 使える人をメールアドレスで絞ったクーポンは、その人ごとの発行済みクーポンにする（コードは人ごとに変わる）。
    // ワイルドカード（*@example.com）は人を決められないので移さない。決められる人がいなければ「無効」で作る（誰でも使えるようにしない）
    const restrictions = Array.isArray(j["email_restrictions"]) ? (j["email_restrictions"] as unknown[]).map((v) => String(v).trim().toLowerCase()).filter(Boolean) : [];
    const restricted = restrictions.filter((e) => e.includes("@") && !e.includes("*"));
    const emailOnly = restrictions.length > 0 && restricted.length === 0;
    if (restricted.length > 0) notes.push("email_grants");
    if (restricted.length < restrictions.length) notes.push(emailOnly ? "email_restricted" : "email_wildcard_dropped");
    const ids = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);
    const ref = (id: number) => ({ id: String(id), sku: skuOf(id) });
    const cats = (v: unknown) => ids(v).map((id) => catPath(id).slice(0, 3)).filter((p) => p.length > 0).map((p) => categorySlug(p));
    const min = Number(str(j["minimum_amount"]) || "0");
    const max = Number(str(j["maximum_amount"]) || "0");
    const conditions: CouponPlan["conditions"] = {};
    if (min > 0) conditions.min_subtotal_jpy = Math.round(min);
    if (max > 0) conditions.max_subtotal_jpy = Math.round(max);
    if (j["exclude_sale_items"] === true) conditions.exclude_sale = true;
    if (ids(j["product_ids"]).length > 0) conditions.products = ids(j["product_ids"]).map(ref);
    if (ids(j["excluded_product_ids"]).length > 0) conditions.exclude_products = ids(j["excluded_product_ids"]).map(ref);
    if (ids(j["product_categories"]).length > 0) conditions.category_slugs = cats(j["product_categories"]);
    if (ids(j["excluded_product_categories"]).length > 0) conditions.exclude_category_slugs = cats(j["excluded_product_categories"]);
    // ブランド: 名前がわかったものだけ写す。1 つでもわからなければ写さず、プラグインの設定と同じく要確認に残す（条件を落とさない）
    const mappedBrandKeys: string[] = [];
    const unmappedBrands: { key: string; value: unknown }[] = [];
    for (const key of BRAND_KEYS) {
      const idsOf = brandIds(j, key);
      if (idsOf.length === 0) continue;
      const names = idsOf.map(brandName);
      if (names.some((n) => !n)) {
        unmappedBrands.push({ key, value: idsOf });
        continue;
      }
      mappedBrandKeys.push(key);
      if (key === "product_brands") conditions.brands = names as string[];
      else {
        conditions.exclude_brands = names as string[];
        conditions.exclude_tags = names as string[];
      }
    }
    return {
      plan: {
        wc_id: String(j["id"] ?? ""),
        code: raw,
        name: (str(j["description"]).trim() || raw).slice(0, 100),
        kind,
        value,
        ends_at: ends && !Number.isNaN(ends.getTime()) ? ends.toISOString() : null,
        usage_limit: limit !== null ? Math.min(100000, limit - used) : null,
        per_customer_limit: perUser !== null ? Math.min(1000, Math.max(1, perUser)) : null,
        combinable: j["individual_use"] !== true,
        active: str(j["status"]) === "publish" && !emailOnly,
        conditions,
        used_by: usedBy,
        restricted_emails: restricted,
        // 写せなかったブランドの条件は、REST の項目で来ても要確認に入れる（meta_data にあれば二重にしない）
        plugin_meta: [...pluginMeta(j, [...mappedBrandKeys, ...unmappedBrands.map((b) => b.key)]), ...unmappedBrands],
      },
      notes,
    };
  }
  /**
   * クーポンを読む（商品やカテゴリーで絞ったものがあれば、その対応付けに要る SKU とカテゴリーも読む）。
   * プラグイン独自の設定があるものは coupons に入れず review に分ける（既定では作らない。CSV で直して Banto の取り込みから入れる）
   */
  async function fetchCoupons(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void = () => {}, now: Date = new Date()): Promise<{ coupons: CouponPlan[]; review: CouponPlan[]; skipped: { code: string; reason: string }[]; notes: { code: string; note: string }[] }> {
    const { all } = wcClient(access, fetchImpl, onProgress);
    const rows = await all("coupons", { orderby: "id", order: "asc" }, "coupons");
    const has = (v: unknown) => Array.isArray(v) && v.length > 0;
    const needProducts = rows.some((r) => has(r["product_ids"]) || has(r["excluded_product_ids"]));
    const needCats = rows.some((r) => has(r["product_categories"]) || has(r["excluded_product_categories"]));
    const needBrands = rows.some((r) => BRAND_KEYS.some((k) => brandIds(r, k).length > 0));
    // ブランド（WooCommerce 9.6 から本体）。読めなければ空のまま（そのクーポンは要確認に残る）
    const brands = new Map<number, string>();
    if (needBrands)
      try {
        for (const b of await all("products/brands", { orderby: "id", order: "asc", _fields: "id,name" }, "brands")) brands.set(Number(b["id"]), htmlToText(str(b["name"])).trim());
      } catch {
        /* 古い WooCommerce・ブランドのプラグインが別のもの */
      }
    const skus = new Map<number, string>();
    if (needProducts) for (const p of await all("products", { orderby: "id", order: "asc", _fields: "id,sku" }, "products")) skus.set(Number(p["id"]), str(p["sku"]).trim());
    const parent = new Map<number, { name: string; parent: number }>();
    if (needCats) for (const c of await all("products/categories", { orderby: "id", order: "asc", _fields: "id,name,parent" }, "categories")) parent.set(Number(c["id"]), { name: htmlToText(str(c["name"])), parent: Number(c["parent"] ?? 0) });
    const catPath = (id: number): string[] => {
      const out: string[] = [];
      for (let cur = parent.get(id), n = 0; cur && n < 10; cur = parent.get(cur.parent), n++) out.unshift(cur.name);
      return out;
    };
    const coupons: CouponPlan[] = [];
    const skipped: { code: string; reason: string }[] = [];
    const notes: { code: string; note: string }[] = [];
    for (const r of rows) {
      const m = mapCoupon(r, catPath, (id) => skus.get(id) ?? "", now, (id) => brands.get(id) || null);
      if ("skip" in m) skipped.push({ code: str(r["code"]), reason: m.skip });
      else {
        coupons.push(m.plan);
        for (const n of m.notes) notes.push({ code: m.plan.code, note: n });
      }
    }
    // used_by の会員の ID をメールアドレスに（ゲストの購入はメールアドレスのまま入っている）
    if (coupons.some((c) => c.used_by.some((u) => /^[0-9]+$/.test(u)))) {
      const emails = new Map<string, string>();
      for (const c of await all("customers", { orderby: "id", order: "asc", role: "all", _fields: "id,email" }, "customers")) emails.set(String(c["id"]), str(c["email"]).trim().toLowerCase());
      for (const c of coupons) c.used_by = c.used_by.map((u) => (/^[0-9]+$/.test(u) ? (emails.get(u) ?? "") : u.toLowerCase())).filter((u) => u.includes("@"));
    } else for (const c of coupons) c.used_by = c.used_by.map((u) => u.toLowerCase()).filter((u) => u.includes("@"));
    // メールアドレスで絞ったクーポン: 1 人あたりの上限まで使い終えた人には発行しない
    for (const c of coupons) {
      if (c.restricted_emails.length === 0) continue;
      const count = new Map<string, number>();
      for (const u of c.used_by) count.set(u, (count.get(u) ?? 0) + 1);
      const limit = c.per_customer_limit ?? Infinity;
      c.restricted_emails = c.restricted_emails.filter((e) => (count.get(e) ?? 0) < limit);
    }
    return { coupons: coupons.filter((c) => c.plugin_meta.length === 0), review: coupons.filter((c) => c.plugin_meta.length > 0), skipped, notes };
  }

  /**
   * WooCommerce の顧客 ID とメールアドレスの対応表（CSV）。プラグインが顧客 ID で絞ったクーポンを、人や AI が
   * Banto のクーポン CSV の member_emails に直すときに使う。個人情報なので、このブラウザで作って保存するだけ（Banto へは送らない）
   */
  async function customerIdTable(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void = () => {}): Promise<string> {
    const { all } = wcClient(access, fetchImpl, onProgress);
    const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = (await all("customers", { orderby: "id", order: "asc", role: "all", _fields: "id,email" }, "customers"))
      .map((c) => [String(c["id"] ?? ""), str(c["email"]).trim().toLowerCase()] as const)
      .filter(([id, email]) => id && email.includes("@"));
    return `\ufeffwc_customer_id,email\r\n${rows.map((r) => r.map(q).join(",")).join("\r\n")}\r\n`;
  }

  // ---------- 過去の注文 ----------
  interface OrderPlan {
    ref: string;
    number: number;
    status: "paid" | "shipped" | "cancelled" | "refunded";
    created_at: string | null;
    shipped_at: string | null;
    total_jpy: number;
    shipping_jpy: number;
    discount_jpy: number;
    shipping_tax_rate: number | null;
    customer_email: string | null;
    customer_name: string | null;
    shipping_address: CustomerPlan["default_address"];
    payment_ref: string | null;
    items: { sku: string; name: string; variant: string | null; qty: number; unit_price_jpy: number; discount_jpy: number; tax_rate: number | null }[];
  }
  /** WooCommerce の注文の状態 → Banto。売上にならなかった注文（保留・支払い待ち・失敗・下書き）は移さない */
  const ORDER_STATUS: Record<string, OrderPlan["status"]> = { completed: "shipped", processing: "paid", cancelled: "cancelled", refunded: "refunded" };
  /** 税額 / 税抜の金額 → 税率（%）。日本の 8% / 10% に近ければそろえる */
  function rateOf(tax: number, base: number): number | null {
    if (!(tax > 0) || !(base > 0)) return null;
    const r = (tax / base) * 100;
    for (const std of [8, 10]) if (Math.abs(r - std) < 0.6) return std;
    return Math.round(r * 100) / 100;
  }
  /**
   * WooCommerce の注文 1 件を Banto の注文に。WooCommerce は明細・送料・値引きを税抜と税額に分けて持つので、税込に足し直す。
   * 合計は WooCommerce の total をそのまま使う（端数で明細の和と 1 円ずれることがある）
   */
  function mapOrder(j: Json): { plan: OrderPlan } | { skip: string } {
    const status = ORDER_STATUS[str(j["status"])];
    if (!status) return { skip: `status_${str(j["status"]) || "unknown"}` };
    if (str(j["currency"]) && str(j["currency"]) !== "JPY") return { skip: "currency" };
    const num = (v: unknown) => Number(str(v) || "0") || 0;
    const id = str(j["id"]);
    const numberRaw = str(j["number"]).trim();
    const number = /^[0-9]{1,9}$/.test(numberRaw) ? Number(numberRaw) : Number(id);
    if (!Number.isInteger(number) || number <= 0 || number > 999_999_999) return { skip: "number" };
    const billing = (j["billing"] && typeof j["billing"] === "object" ? j["billing"] : {}) as Json;
    const shippingAddr = (j["shipping"] && typeof j["shipping"] === "object" ? j["shipping"] : {}) as Json;
    const customer = mapCustomer({ email: billing["email"], first_name: billing["first_name"], last_name: billing["last_name"], billing, shipping: shippingAddr });
    const items: OrderPlan["items"] = [];
    for (const li of Array.isArray(j["line_items"]) ? (j["line_items"] as Json[]) : []) {
      const qty = Math.round(num(li["quantity"]));
      if (qty <= 0) continue;
      const gross = num(li["subtotal"]) + num(li["subtotal_tax"]);
      const net = num(li["total"]) + num(li["total_tax"]);
      const meta = Array.isArray(li["meta_data"]) ? (li["meta_data"] as Json[]) : [];
      const variant = meta
        .filter((m) => !str(m["key"]).startsWith("_") && str(m["display_value"] ?? m["value"]).trim())
        .map((m) => htmlToText(str(m["display_value"] ?? m["value"])))
        .join(" / ");
      items.push({
        sku: str(li["sku"]).trim(),
        name: htmlToText(str(li["name"])).slice(0, 200) || "-",
        variant: variant ? variant.slice(0, 200) : null,
        qty,
        unit_price_jpy: Math.max(0, Math.round(gross / qty)),
        discount_jpy: Math.max(0, Math.round(gross - net)),
        tax_rate: rateOf(num(li["subtotal_tax"]), num(li["subtotal"])),
      });
    }
    const date = (v: unknown) => {
      const s2 = str(v);
      if (!s2) return null;
      const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s2) ? s2 : `${s2}Z`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    return {
      plan: {
        ref: `woocommerce:${id}`,
        number,
        status,
        created_at: date(j["date_created_gmt"]),
        shipped_at: status === "shipped" ? (date(j["date_completed_gmt"]) ?? date(j["date_created_gmt"])) : null,
        total_jpy: Math.max(0, Math.round(num(j["total"]))),
        shipping_jpy: Math.max(0, Math.round(num(j["shipping_total"]) + num(j["shipping_tax"]))),
        discount_jpy: Math.max(0, Math.round(num(j["discount_total"]) + num(j["discount_tax"]))),
        shipping_tax_rate: rateOf(num(j["shipping_tax"]), num(j["shipping_total"])),
        customer_email: customer?.email ?? null,
        customer_name: customer?.name ?? null,
        shipping_address: customer?.default_address ?? null,
        payment_ref: str(j["transaction_id"]).trim().slice(0, 200) || null,
        items,
      },
    };
  }
  /** 注文を古い順に読む（状態はすべて。移さないものは理由ごとに数える） */
  async function fetchOrders(access: StoreAccess, fetchImpl: FetchLike, onProgress: (step: string, done: number, total: number) => void = () => {}): Promise<{ orders: OrderPlan[]; skipped: Record<string, number> }> {
    const { all } = wcClient(access, fetchImpl, onProgress);
    const rows = await all(
      "orders",
      { status: "any", orderby: "id", order: "asc", _fields: "id,number,status,currency,date_created_gmt,date_completed_gmt,total,shipping_total,shipping_tax,discount_total,discount_tax,billing,shipping,transaction_id,line_items" },
      "orders",
    );
    const orders: OrderPlan[] = [];
    const skipped: Record<string, number> = {};
    for (const r of rows) {
      const m = mapOrder(r);
      if ("skip" in m) skipped[m.skip] = (skipped[m.skip] ?? 0) + 1;
      else orders.push(m.plan);
    }
    return { orders, skipped };
  }

  /** 旧サイトの URL → Banto の URL の一覧（CSV）。旧サーバーやドメインの転送設定に使う */
  function redirectsCsv(analysis: Analysis, bantoBase: string): string {
    const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ["old_url,new_url"];
    for (const p of analysis.products) if (p.permalink) lines.push(`${q(p.permalink)},${q(`${bantoBase.replace(/\/+$/, "")}/p/${p.slug}`)}`);
    return `${lines.join("\r\n")}\r\n`;
  }

  // ---------- 送信する形に組み立てる ----------
  function categorySlug(path: string[]): string {
    return `c-${hash(path.join(">"))}`;
  }

  /** 税率の既定（%）。WooCommerce の既定の税区分名と、日本の標準 10% / 軽減 8% に合わせる。運営者が画面で変えられる */
  function defaultTaxRate(taxClass: string): number {
    if (taxClass === NO_TAX || taxClass === "zero-rate") return 0;
    if (taxClass === "reduced-rate" || /reduced|軽減/i.test(decodeMetaName(taxClass))) return 8;
    return 10;
  }

  /** WooCommerce の税区分 → Banto の区分の既定。課税しない・ゼロ税率は非課税、軽減は軽減、ほかは標準 */
  function defaultTaxClass(taxClass: string): "standard" | "reduced" | "exempt" {
    if (taxClass === NO_TAX || taxClass === "zero-rate") return "exempt";
    if (taxClass === "reduced-rate" || /reduced|軽減/i.test(decodeMetaName(taxClass))) return "reduced";
    return "standard";
  }

  /** 税抜で入力していたショップの価格 → 税込（Banto の価格はすべて税込） */
  function withTax(price: number, taxClass: string, opts: BuildOptions): number {
    const ex = opts.pricesExcludeTax;
    if (!ex) return price;
    const rate = taxClass === NO_TAX ? 0 : (ex.rates[taxClass] ?? defaultTaxRate(taxClass));
    // 1000 * 1.1 = 1100.0000000000002 のような浮動小数の誤差で切り上げがずれないよう、割り切れる値はそのまま使う
    const v = (price * (100 + rate)) / 100;
    const n = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : ex.rounding === "floor" ? Math.floor(v) : ex.rounding === "ceil" ? Math.ceil(v) : Math.round(v);
    return Math.max(0, n);
  }

  function build(analysis: Analysis, opts: BuildOptions) {
    const cats = new Map<string, { slug: string; name: string; parent_slug: string | null; depth: number }>();
    for (const p of analysis.products)
      for (const path of p.categoryPaths)
        path.forEach((name, d) => {
          const sub = path.slice(0, d + 1);
          const slug = categorySlug(sub);
          if (!cats.has(slug)) cats.set(slug, { slug, name: name.slice(0, 100), parent_slug: d > 0 ? categorySlug(path.slice(0, d)) : null, depth: d });
        });
    const categories = [...cats.values()].sort((a, b) => a.depth - b.depth).map(({ depth: _d, ...c }) => c);

    const products = analysis.products.map((p) => {
      // 主カテゴリー: いちばん深いもの。祖先でない他のカテゴリーは追加カテゴリーにする
      // （0042 より前の DB では、サーバーが extra_category_names をタグに写す）
      const deepest = [...p.categoryPaths].sort((a, b) => b.length - a.length)[0] ?? null;
      const extraPaths = p.categoryPaths.filter((path) => deepest && !deepest.slice(0, path.length).every((n, i) => n === path[i]));
      const brand = opts.brandMode === "last" ? p.brands[p.brands.length - 1] : p.brands[0];
      const otherBrands = p.brands.filter((b) => b !== brand);
      const attributes: Record<string, string | number> = {};
      if (!p.metaUnreliable)
        for (const f of opts.fields) {
          const raw = (p.fields[f.source] ?? "").trim();
          if (!raw) continue;
          if (f.type === "number" && /^-?[0-9]+(\.[0-9]+)?$/.test(raw)) attributes[f.key] = Number(raw);
          else attributes[f.key] = (f.type === "textarea" ? htmlToText(raw) : raw.replace(/\r?\\n/g, " ")).slice(0, f.type === "textarea" ? 500 : 200);
        }
      const skus = p.skus
        .filter((k) => !(opts.skipDisabledVariations && k.disabled))
        .map((k) => {
          const price = withTax(k.price_jpy, k.taxClass, opts);
          const compare = k.compare_at_price_jpy === null ? null : withTax(k.compare_at_price_jpy, k.taxClass, opts);
          return {
            code: k.code,
            name: k.name,
            price_jpy: price,
            compare_at_price_jpy: compare !== null && compare > price ? compare : null,
            gtin: k.gtin,
            options: k.options,
            // 在庫の数量が無い行（在庫管理していない）は 0 にする。取り込み後に管理画面で入れる
            available: k.disabled ? 0 : Math.max(0, k.available),
          };
        });
      const variationImages = p.variationImages ?? [];
      const wcClass = p.skus[0]?.taxClass;
      return {
        payload: {
          tax_class: wcClass === undefined ? "standard" : (opts.taxClasses?.[wcClass] ?? defaultTaxClass(wcClass)),
          slug: p.slug,
          name: p.name,
          description: p.description,
          published: p.published,
          tags: [...new Set([...p.tags, ...otherBrands])],
          brand: brand ?? null,
          attributes,
          category_slug: deepest ? categorySlug(deepest) : null,
          extra_category_slugs: [...new Set(extraPaths.map((path) => categorySlug(path)))],
          extra_category_names: [...new Set(extraPaths.map((path) => path[path.length - 1]!))],
          skus,
        },
        images: [...new Set([...p.images, ...(opts.includeVariationImages ? variationImages : [])])],
      };
    });
    return { categories, products, overwrite_stock: opts.overwriteStock };
  }

  /**
   * 画像の取り込み要求（1 回 20 枚まで。サーバー側の上限と同じ）。20 枚を超える商品は複数回に分ける
   * （1 回目だけ送ると 21 枚目以降が取り込まれず、押し直しても同じ 20 枚を飛ばすだけになっていた）
   */
  function imageRequests(products: { payload: { slug: string }; images: string[] }[], perRequest = 20): { slug: string; urls: string[] }[] {
    const out: { slug: string; urls: string[] }[] = [];
    for (const p of products) for (let i = 0; i < p.images.length; i += perRequest) out.push({ slug: p.payload.slug, urls: p.images.slice(i, i + perRequest) });
    return out;
  }

  /** 送信用に小分けする（1 回の POST を小さく保つ。目安 60 商品か 200 KB） */
  function chunk<T>(items: T[], maxItems = 60, maxBytes = 200_000): T[][] {
    const out: T[][] = [];
    let cur: T[] = [];
    let size = 0;
    for (const it of items) {
      const s = JSON.stringify(it).length;
      if (cur.length > 0 && (cur.length >= maxItems || size + s > maxBytes)) {
        out.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(it);
      size += s;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  // ---------- 画面 ----------
  // Worker 側の型（@cloudflare/workers-types）には DOM が無いので、使う分だけを構造的に宣言する
  interface El {
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    append(...nodes: (El | string)[]): void;
    replaceChildren(...nodes: (El | string)[]): void;
    querySelector(selector: string): El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
    addEventListener(type: string, listener: () => void): void;
    checked: boolean;
    value: string;
    disabled: boolean;
    files?: ArrayLike<{ arrayBuffer(): Promise<ArrayBuffer> }> | null;
    field?: FieldCandidate;
  }
  interface MountConfig {
    /** POST 先（/admin/shops/:id/modules/woo-import） */
    base: string;
    /** ストアフロントのショップのトップの URL（https://…/my-shop か独自ドメイン）。旧 URL → 新 URL の一覧に使う */
    shopUrl: string;
    t: Record<string, string>;
    /** 画像を裏で取り込める（0039 が当たっている） */
    queue?: boolean;
    /** 裏の取り込みで大きすぎて止まった画像（このページで縮小して取り込む） */
    large?: { slug: string; url: string }[];
    /** クーポンの CSV 取り込みの画面（同梱モジュール coupons、0043）。要確認のクーポンを直したら、ここから入れる */
    couponImport?: string;
  }

  function mount(root: El, cfg: MountConfig) {
    const doc = (globalThis as unknown as { document: { createElement(tag: string): El } }).document;
    const t = (k: string, vars: Record<string, string | number> = {}) => (cfg.t[k] ?? k).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ""));
    const el = (tag: string, attrs: Record<string, string> = {}, ...kids: (El | string)[]): El => {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      for (const c of kids) e.append(c);
      return e;
    };
    const checkbox = (attrs: Record<string, string>, checked: boolean): El => {
      const e = el("input", { type: "checkbox", ...attrs });
      e.checked = checked;
      return e;
    };
    const textInput = (attrs: Record<string, string>, value: string): El => {
      const e = el("input", { type: "text", ...attrs });
      e.value = value;
      return e;
    };
    const fileInput = root.querySelector("input[type=file]")!;
    const out = root.querySelector("[data-out]")!;
    let encoding: "utf-8" | "shift_jis" = "utf-8";
    let analysis: Analysis | null = null;
    /** REST API で読んだとき、WooCommerce の設定から分かった税抜入力か（CSV や読めなかったときは null） */
    let detectedExcludeTax: boolean | null = null;

    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`${cfg.base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    };

    /** 取り込めなかった画像: 理由ごとの枚数、全件の一覧、CSV */
    const imageFailureReason = (code: string): string => {
      const http = /^http_(\d+)$/.exec(code);
      if (http) {
        const status = Number(http[1]);
        const key = status === 403 || status === 401 ? "img_fail_http_blocked" : status === 404 || status === 410 ? "img_fail_http_missing" : status === 429 ? "img_fail_http_busy" : status >= 500 ? "img_fail_http_server" : "img_fail_http";
        return t(key, { status });
      }
      const req = /^request(?:_(\d+))?$/.exec(code);
      if (req) return t("img_fail_request", { status: req[1] ?? "-" });
      return cfg.t[`img_fail_${code}`] !== undefined ? t(`img_fail_${code}`) : code;
    };
    const imageFailureReport = (failures: { slug: string; url: string; code: string }[]): El[] => {
      const byReason = new Map<string, number>();
      for (const f of failures) byReason.set(imageFailureReason(f.code), (byReason.get(imageFailureReason(f.code)) ?? 0) + 1);
      const reasons = el("ul");
      for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) reasons.append(el("li", {}, t("img_fail_count", { reason, n })));
      const list = el("ul");
      failures.forEach((f) => list.append(el("li", {}, `${f.slug}: ${f.url || "-"} — ${imageFailureReason(f.code)}`)));
      const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = `\ufeffslug,url,reason\r\n${failures.map((f) => [f.slug, f.url, imageFailureReason(f.code)].map(q).join(",")).join("\r\n")}\r\n`;
      const a = el("a", { download: "banto-image-failures.csv", href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` }, t("img_failures_download"));
      return [el("h4", {}, t("img_failures_title", { n: failures.length })), reasons, el("details", {}, el("summary", {}, t("img_show_list")), list), el("p", {}, a), el("p", { class: "muted" }, t("img_failures_hint"))];
    };

    /**
     * 5MB を超える画像を、このブラウザで縮小して取り込む（サーバーでは縮小しない）。
     * 元の画像は Banto が中継し（旧サイトの画像はブラウザから直接読めないため）、長辺 1600px と 400px の WebP にして送る。
     * メモリを使うので 1 枚ずつ。
     */
    interface Bitmap {
      width: number;
      height: number;
      close?(): void;
    }
    interface Canvas {
      width: number;
      height: number;
      getContext(kind: "2d"): { drawImage(img: Bitmap, x: number, y: number, w: number, h: number): void } | null;
      toBlob(cb: (b: Blob | null) => void, type: string, quality: number): void;
    }
    const g = globalThis as unknown as { createImageBitmap?: (b: Blob) => Promise<Bitmap>; document: { createElement(tag: "canvas"): Canvas } };
    const shrink = (bmp: Bitmap, max: number, quality: number) =>
      new Promise<Blob>((ok, ng) => {
        const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const cv = g.document.createElement("canvas");
        cv.width = Math.max(1, Math.round(bmp.width * r));
        cv.height = Math.max(1, Math.round(bmp.height * r));
        const ctx = cv.getContext("2d");
        if (!ctx) return ng(new Error("resize"));
        ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        cv.toBlob((b) => (b && b.type === "image/webp" ? ok(b) : ng(new Error("resize"))), "image/webp", quality);
      });
    const resizeLarge = async (items: { slug: string; url: string }[], onProgress: (done: number) => void): Promise<{ added: number; failures: { slug: string; url: string; code: string }[] }> => {
      let added = 0;
      const failures: { slug: string; url: string; code: string }[] = [];
      for (const [i, it] of items.entries()) {
        const fail = (code: string) => failures.push({ ...it, code });
        try {
          const res = await fetch(`${cfg.base}/images/original?url=${encodeURIComponent(it.url)}`, { credentials: "same-origin" });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            fail(body.error ?? `request_${res.status}`);
          } else {
            let bmp: Bitmap | null = null;
            try {
              bmp = g.createImageBitmap ? await g.createImageBitmap(await res.blob()) : null;
            } catch {
              bmp = null;
            }
            if (!bmp) fail("decode");
            else {
              let main: Blob | null = null;
              let thumb: Blob | null = null;
              try {
                main = await shrink(bmp, 1600, 0.82);
                thumb = await shrink(bmp, 400, 0.8);
              } catch {
                main = null;
              } finally {
                bmp.close?.();
              }
              if (!main || !thumb) fail("resize");
              else if (main.size > 5 * 1024 * 1024) fail("too_large");
              else {
                const fd = new FormData();
                fd.append("slug", it.slug);
                fd.append("url", it.url);
                fd.append("image", main, "image.webp");
                fd.append("thumbnail", thumb, "thumbnail.webp");
                const up = await fetch(`${cfg.base}/images/resized`, { method: "POST", body: fd, credentials: "same-origin" });
                if (up.ok) added++;
                else fail(`request_${up.status}`);
              }
            }
          }
        } catch {
          fail("request");
        }
        onProgress(i + 1);
      }
      return { added, failures };
    };

    // 裏の取り込みの欄（ページの上、サーバーが描く）の「大きすぎる画像を縮小して取り込む」
    const resizeBtn = (globalThis as unknown as { document: { querySelector(sel: string): El | null } }).document.querySelector("[data-resize-large]");
    const resizeOut = (globalThis as unknown as { document: { querySelector(sel: string): El | null } }).document.querySelector("[data-resize-out]");
    resizeBtn?.addEventListener("click", () => {
      const items = cfg.large ?? [];
      if (!resizeOut || items.length === 0) return;
      resizeBtn.disabled = true;
      const prog = el("p");
      resizeOut.replaceChildren(prog);
      void resizeLarge(items, (done) => (prog.textContent = t("resize_step", { done, total: items.length }))).then((r) => {
        resizeOut.append(el("p", { class: "notice" }, t("resize_done", { added: r.added, failed: r.failures.length })));
        if (r.failures.length > 0) resizeOut.append(...imageFailureReport(r.failures));
        resizeOut.append(el("p", {}, el("a", { href: `${cfg.base}#image-queue` }, t("queue_reload"))));
      });
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      out.replaceChildren(el("p", {}, t("analyzing")));
      void file.arrayBuffer().then((buf) => {
        const d = decode(buf);
        encoding = d.encoding;
        analysis = analyze(d.text);
        detectedExcludeTax = null;
        render();
      });
    });

    // REST API から読む（キーはこのブラウザから WooCommerce に送るだけで、Banto には送らない）
    const wcLoad = root.querySelector("[data-wc-load]");
    wcLoad?.addEventListener("click", () => {
      const access = { url: root.querySelector("[data-wc-url]")!.value, key: root.querySelector("[data-wc-key]")!.value, secret: root.querySelector("[data-wc-secret]")!.value };
      wcLoad.disabled = true;
      out.replaceChildren(el("p", {}, t("rest_loading")));
      const status = el("p", { class: "muted" });
      out.append(status);
      const progress = (step: string, done: number, total: number) => (status.textContent = t(`rest_step_${step}`, { done, total }));
      void fetchStore(access, (u, i) => fetch(u, i), progress)
        .then((r) => {
          encoding = "utf-8";
          analysis = r.analysis;
          detectedExcludeTax = r.pricesExcludeTax;
          render();
        })
        .catch((e: unknown) => {
          const reason = e instanceof WooApiError ? e.reason : "http";
          out.replaceChildren(el("p", { class: "error" }, `${t(`rest_${reason}`)} ${(e as Error).message}`));
        })
        .finally(() => (wcLoad.disabled = false));
    });

    // 会員（REST API のときだけ。会員機能が OFF のショップではボタンを出さない）
    const wcCustomers = root.querySelector("[data-wc-customers]");
    const customersOut = root.querySelector("[data-customers-out]");
    wcCustomers?.addEventListener("click", () => {
      if (!customersOut) return;
      const access = { url: root.querySelector("[data-wc-url]")!.value, key: root.querySelector("[data-wc-key]")!.value, secret: root.querySelector("[data-wc-secret]")!.value };
      wcCustomers.disabled = true;
      const status = el("p", { class: "muted" }, t("rest_loading"));
      customersOut.replaceChildren(status);
      void fetchCustomers(access, (u, i) => fetch(u, i), (step, done) => (status.textContent = t(`rest_step_${step}`, { done })))
        .then((r) => {
          const withAddress = r.customers.filter((x) => x.default_address).length;
          const go = el("button", { type: "button" }, t("customers_start", { n: r.customers.length }));
          const log = el("div");
          customersOut.replaceChildren(
            el("h3", {}, t("customers_summary")),
            el("p", {}, t("customers_line", { n: r.customers.length, address: withAddress, skipped: r.skipped })),
            el("p", { class: "muted" }, t("customers_password_note")),
            el("p", {}, go),
            log,
          );
          if (r.customers.length === 0) go.disabled = true;
          go.addEventListener("click", () => void importCustomers(r.customers, go, log));
        })
        .catch((e: unknown) => {
          const reason = e instanceof WooApiError ? e.reason : "http";
          customersOut.replaceChildren(el("p", { class: "error" }, `${t(`rest_${reason}`)} ${(e as Error).message}`));
        })
        .finally(() => (wcCustomers.disabled = false));
    });

    // クーポン（REST API のときだけ。クーポンのモジュールが OFF のショップではボタンを出さない）
    const wcCoupons = root.querySelector("[data-wc-coupons]");
    const couponsOut = root.querySelector("[data-coupons-out]");
    wcCoupons?.addEventListener("click", () => {
      if (!couponsOut) return;
      const access = { url: root.querySelector("[data-wc-url]")!.value, key: root.querySelector("[data-wc-key]")!.value, secret: root.querySelector("[data-wc-secret]")!.value };
      wcCoupons.disabled = true;
      const status = el("p", { class: "muted" }, t("rest_loading"));
      couponsOut.replaceChildren(status);
      void fetchCoupons(access, (u, i) => fetch(u, i), (step, done) => (status.textContent = t(`rest_step_${step}`, { done })))
        .then((r) => {
          const go = el("button", { type: "button" }, "");
          const log = el("div");
          const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
          // 移せないもの（理由ごとの件数と、全件のコード）と、取り込むけれど変わるものを分けて出す。全件は CSV でも保存できる
          const parts: El[] = [el("h3", {}, t("coupons_summary")), el("p", {}, t("coupons_line", { n: r.coupons.length, skipped: r.skipped.length }))];
          if (r.skipped.length > 0) {
            const byReason = new Map<string, number>();
            for (const x of r.skipped) byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + 1);
            const reasons = el("ul");
            for (const [reason, n] of byReason) reasons.append(el("li", {}, t("coupons_skip_count", { reason: t(`coupon_skip_${reason}`), n })));
            const codes = el("ul");
            r.skipped.forEach((x) => codes.append(el("li", {}, `${x.code}: ${t(`coupon_skip_${x.reason}`)}`)));
            parts.push(el("h4", {}, t("coupons_skipped_title", { n: r.skipped.length })), reasons, el("details", {}, el("summary", {}, t("coupons_show_codes")), codes));
          }
          if (r.notes.length > 0) {
            const codes = el("ul");
            r.notes.forEach((x) => codes.append(el("li", {}, `${x.code}: ${t(`coupon_note_${x.note}`)}`)));
            parts.push(el("h4", {}, t("coupons_notes_title", { n: r.notes.length })), el("details", {}, el("summary", {}, t("coupons_show_codes")), codes));
          }
          if (r.skipped.length + r.notes.length > 0) {
            const rows = [...r.skipped.map((x) => [x.code, t("coupons_csv_skipped"), t(`coupon_skip_${x.reason}`)]), ...r.notes.map((x) => [x.code, t("coupons_csv_note"), t(`coupon_note_${x.note}`)])];
            const csv = `﻿code,status,detail\r\n${rows.map((row) => row.map(q).join(",")).join("\r\n")}\r\n`;
            parts.push(el("p", {}, el("a", { download: "coupon-import-check.csv", href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` }, t("coupons_list_download"))));
          }
          // プラグイン独自の設定があるクーポン: 既定では作らない。Banto のクーポン CSV に書き出し、人や AI が直して取り込む
          const reviewMode = el("select", {}, el("option", { value: "skip" }, t("coupons_review_skip")), el("option", { value: "inactive" }, t("coupons_review_inactive")));
          const targets = () => (reviewMode.value === "inactive" ? [...r.coupons, ...r.review] : r.coupons);
          if (r.review.length > 0) {
            const keys = el("ul");
            r.review.forEach((x) => keys.append(el("li", {}, `${x.code}: ${x.plugin_meta.map((m) => m.key).join(", ")}`)));
            const reviewLink = el("button", { type: "button" }, t("coupons_review_download", { n: r.review.length }));
            const idsLink = el("button", { type: "button" }, t("coupons_review_ids"));
            const reviewLog = el("span", { class: "muted" });
            // 作れたら保存のリンクを出す（ほかの一覧と同じく data: の URL）
            const save = (name: string, csv: string) => reviewLog.replaceChildren(el("a", { download: name, href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` }, t("coupons_review_save", { name })));
            reviewLink.addEventListener("click", async () => {
              reviewLink.disabled = true;
              try {
                const res = await fetch(`${cfg.base}/coupons/review.csv`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coupons: r.review.map(({ used_by: _u, ...c }) => c) }), credentials: "same-origin" });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                save("coupons-needs-review.csv", await res.text());
              } catch (e) {
                reviewLog.textContent = `${t("failed")} ${(e as Error).message}`;
              }
              reviewLink.disabled = false;
            });
            idsLink.addEventListener("click", async () => {
              idsLink.disabled = true;
              try {
                save("woocommerce-customer-ids.csv", await customerIdTable(access, (u, i) => fetch(u, i), (step, done) => (reviewLog.textContent = t(`rest_step_${step}`, { done }))));
              } catch (e) {
                reviewLog.textContent = `${t("failed")} ${(e as Error).message}`;
              }
              idsLink.disabled = false;
            });
            parts.push(
              el("h4", {}, t("coupons_review_title", { n: r.review.length })),
              el("p", {}, t("coupons_review_intro")),
              el("details", {}, el("summary", {}, t("coupons_show_codes")), keys),
              el("p", {}, reviewLink, " ", idsLink, " ", reviewLog),
              el("p", { class: "muted" }, t("coupons_review_next"), " ", cfg.couponImport ? el("a", { href: cfg.couponImport }, t("coupons_review_import_link")) : t("coupons_review_needs_update")),
              el("label", {}, t("coupons_review_mode"), " ", reviewMode),
            );
          }
          couponsOut.replaceChildren(...parts, el("p", {}, go), log);
          const count = () => {
            go.textContent = t("coupons_start", { n: targets().length });
            go.disabled = targets().length === 0;
          };
          reviewMode.addEventListener("change", count);
          count();
          go.addEventListener("click", async () => {
            go.disabled = true;
            const totals = { created: 0, existing: 0, inactive: 0, grants_members: 0 };
            const grantCodes: { coupon: string; email: string; code: string }[] = [];
            const list = targets();
            try {
              for (let i = 0; i < list.length; i += 20) {
                log.replaceChildren(el("p", {}, t("coupons_step", { done: i, total: list.length })));
                // used_by は大きいことがあるので、キャンペーンの作成には載せず下で別に送る。プラグインの設定は鍵の名前だけ（サーバーが無効で作る）
                const slice = list.slice(i, i + 20).map(({ used_by: _u, plugin_meta, ...c }) => ({ ...c, plugin_keys: plugin_meta.map((m) => m.key) }));
                const res = await fetch(`${cfg.base}/coupons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coupons: slice }), credentials: "same-origin" });
                const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                if (!res.ok) throw new Error(body["error"] === "coupons_disabled" ? t("coupons_disabled") : `HTTP ${res.status}`);
                for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(body[k] ?? 0);
                if (Array.isArray(body["grant_codes"])) grantCodes.push(...(body["grant_codes"] as { coupon: string; email: string; code: string }[]));
              }
              // 1 人ごとの使用回数（1 人あたりの上限のあるクーポンだけ。2,000 件ずつ、最初の回で入れ直す）
              const withUsage = list.filter((c) => c.per_customer_limit !== null && c.used_by.length > 0 && c.restricted_emails.length === 0);
              let uses = 0;
              for (const [n, c] of withUsage.entries()) {
                log.replaceChildren(el("p", {}, t("coupons_usage_step", { done: n, total: withUsage.length })));
                for (let j = 0; j < c.used_by.length; j += 2000) {
                  const res = await fetch(`${cfg.base}/coupons/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c.code, emails: c.used_by.slice(j, j + 2000), reset: j === 0 }), credentials: "same-origin" });
                  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  uses += Number(body["uses"] ?? 0);
                }
              }
              log.replaceChildren(el("p", { class: "notice" }, t("coupons_done", totals)));
              if (withUsage.length > 0) log.append(el("p", {}, t("coupons_usage_done", { coupons: withUsage.length, uses })));
              if (grantCodes.length > 0) {
                // 会員でない人に発行したコード（Banto からは知らせないので、運営者が渡す）
                const csv = `\ufeffcoupon,email,code\r\n${grantCodes.map((g) => [g.coupon, g.email, g.code].map(q).join(",")).join("\r\n")}\r\n`;
                const a = el("a", { download: "coupon-codes.csv", href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` }, t("coupons_grant_codes_download", { n: grantCodes.length }));
                log.append(el("p", {}, t("coupons_grant_codes", { n: grantCodes.length }), " ", a));
              }
            } catch (e) {
              log.append(el("p", { class: "error" }, `${t("failed")} ${(e as Error).message}`));
            }
            go.disabled = false;
          });
        })
        .catch((e: unknown) => {
          const reason = e instanceof WooApiError ? e.reason : "http";
          couponsOut.replaceChildren(el("p", { class: "error" }, `${t(`rest_${reason}`)} ${(e as Error).message}`));
        })
        .finally(() => (wcCoupons.disabled = false));
    });

    // 過去の注文（REST API のときだけ）。在庫・クーポン・通知には触らず、記録として入れる
    const wcOrders = root.querySelector("[data-wc-orders]");
    const ordersOut = root.querySelector("[data-orders-out]");
    wcOrders?.addEventListener("click", () => {
      if (!ordersOut) return;
      const access = { url: root.querySelector("[data-wc-url]")!.value, key: root.querySelector("[data-wc-key]")!.value, secret: root.querySelector("[data-wc-secret]")!.value };
      wcOrders.disabled = true;
      const status = el("p", { class: "muted" }, t("rest_loading"));
      ordersOut.replaceChildren(status);
      void fetchOrders(access, (u, i) => fetch(u, i), (step, done) => (status.textContent = t(`rest_step_${step}`, { done })))
        .then((r) => {
          const go = el("button", { type: "button" }, t("orders_start", { n: r.orders.length }));
          const log = el("div");
          const lines = el("ul");
          for (const [reason, n] of Object.entries(r.skipped)) lines.append(el("li", {}, `${reason.startsWith("status_") ? t("orders_skip_status", { status: reason.slice(7) }) : t(`orders_skip_${reason}`)}: ${n}`));
          ordersOut.replaceChildren(el("h3", {}, t("orders_summary")), el("p", {}, t("orders_line", { n: r.orders.length, skipped: Object.values(r.skipped).reduce((a, b) => a + b, 0) })), lines, el("p", { class: "muted" }, t("orders_note")), el("p", {}, go), log);
          if (r.orders.length === 0) go.disabled = true;
          go.addEventListener("click", async () => {
            go.disabled = true;
            const totals = { created: 0, existing: 0, invalid: 0, items_without_sku: 0 };
            const conflicts: number[] = [];
            try {
              for (let i = 0; i < r.orders.length; i += 100) {
                log.replaceChildren(el("p", {}, t("orders_step", { done: i, total: r.orders.length })));
                const res = await fetch(`${cfg.base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orders: r.orders.slice(i, i + 100) }), credentials: "same-origin" });
                const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(body[k] ?? 0);
                if (Array.isArray(body["conflicts"])) conflicts.push(...(body["conflicts"] as number[]));
              }
              log.replaceChildren(el("p", { class: "notice" }, t("orders_done", totals)));
              if (conflicts.length > 0) log.append(el("p", { class: "error" }, t("orders_conflicts", { numbers: conflicts.slice(0, 50).join(", ") })));
            } catch (e) {
              log.append(el("p", { class: "error" }, `${t("failed")} ${(e as Error).message}`));
            }
            go.disabled = false;
          });
        })
        .catch((e: unknown) => {
          const reason = e instanceof WooApiError ? e.reason : "http";
          ordersOut.replaceChildren(el("p", { class: "error" }, `${t(`rest_${reason}`)} ${(e as Error).message}`));
        })
        .finally(() => (wcOrders.disabled = false));
    });

    // WordPress のパスワード（wp_users の CSV）。ハッシュはこのブラウザで読み、bcrypt の形式だけを送る
    const pwInput = root.querySelector("[data-wc-passwords]");
    const pwOut = root.querySelector("[data-passwords-out]");
    pwInput?.addEventListener("change", () => {
      const file = pwInput.files?.[0];
      if (!file || !pwOut) return;
      void file.arrayBuffer().then((buf) => {
        const parsed = passwordRows(decode(buf).text);
        if (!parsed) {
          pwOut.replaceChildren(el("p", { class: "error" }, t("passwords_no_columns")));
          return;
        }
        const go = el("button", { type: "button" }, t("passwords_start", { n: parsed.rows.length }));
        if (parsed.rows.length === 0) go.disabled = true;
        const log = el("div");
        pwOut.replaceChildren(el("p", {}, t("passwords_summary", { bcrypt: parsed.rows.length, old: parsed.old })), el("p", {}, go), log);
        go.addEventListener("click", () => {
          go.disabled = true;
          const progress = el("p");
          log.replaceChildren(progress);
          const totals = { imported: 0, created: 0, skipped_has_password: 0 };
          void (async () => {
            try {
              for (let i = 0; i < parsed.rows.length; i += 100) {
                progress.textContent = t("passwords_step", { done: i, total: parsed.rows.length });
                const res = await fetch(`${cfg.base}/customers/passwords`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: parsed.rows.slice(i, i + 100) }), credentials: "same-origin" });
                const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                if (!res.ok) throw new Error(r["error"] === "password_disabled" ? t("customers_password_disabled") : `HTTP ${res.status}`);
                for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(r[k] ?? 0);
              }
              progress.textContent = t("passwords_step", { done: parsed.rows.length, total: parsed.rows.length });
              log.append(el("p", { class: "notice" }, t("passwords_done", totals)), el("p", { class: "error" }, t("passwords_delete_file")));
            } catch (e) {
              log.append(el("p", { class: "error" }, `${t("failed")} ${(e as Error).message}`));
              go.disabled = false;
            }
          })();
        });
      });
    });

    async function importCustomers(list: CustomerPlan[], button: El, log: El) {
      button.disabled = true;
      const totals = { customers_created: 0, customers_updated: 0 };
      const errors: { email: string; message: string }[] = [];
      const progress = el("p");
      log.replaceChildren(progress);
      const batches: CustomerPlan[][] = [];
      for (let i = 0; i < list.length; i += 100) batches.push(list.slice(i, i + 100));
      try {
        for (let i = 0; i < batches.length; i++) {
          progress.textContent = t("customers_step", { done: i * 100, total: list.length });
          const res = await fetch(`${cfg.base}/customers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customers: batches[i] }), credentials: "same-origin" });
          const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (!res.ok) {
            const code = String(r["error"] ?? "");
            throw new Error(["members_disabled", "not_configured"].includes(code) ? t(`customers_${code}`) : `HTTP ${res.status}`);
          }
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(r[k] ?? 0);
          errors.push(...((r["errors"] as { email: string; message: string }[] | undefined) ?? []));
        }
        progress.textContent = t("customers_step", { done: list.length, total: list.length });
        log.append(el("p", { class: "notice" }, t("customers_done", totals)), el("p", { class: "muted" }, t("customers_next")));
        if (errors.length > 0) {
          const ul = el("ul");
          errors.slice(0, 50).forEach((e) => ul.append(el("li", {}, `${e.email}: ${e.message}`)));
          log.append(el("p", { class: "error" }, t("errors", { n: errors.length })), ul);
        }
      } catch (e) {
        log.append(el("p", { class: "error" }, `${t("failed")} ${(e as Error).message}`));
      }
      button.disabled = false;
    }

    function render() {
      const a = analysis!;
      out.replaceChildren();
      if (a.warnings.some((w) => w.code === "localized_headers")) {
        out.append(el("p", { class: "error" }, t("localized_headers")), el("p", {}, t("localized_headers_fix")));
        return;
      }
      if (a.warnings.some((w) => w.code === "not_woocommerce")) {
        out.append(el("p", { class: "error" }, t("not_woocommerce")));
        return;
      }
      if (encoding === "shift_jis") out.append(el("p", { class: "error" }, t("encoding_sjis")));
      out.append(
        el("h2", {}, t("summary")),
        el("p", {}, t("summary_line", { rows: a.stats.rows, products: a.stats.products, skus: a.stats.skus, categories: a.stats.categories, images: a.stats.images })),
        el("p", { class: "muted" }, `${t("brands")}: ${a.stats.brands.join(" / ") || "-"}`),
      );
      if (a.warnings.length > 0) {
        const ul = el("ul");
        for (const w of a.warnings) ul.append(el("li", {}, `${t(`w_${w.code}`)}: ${w.count}${w.examples.length ? `（${t("example")}: ${w.examples.join("、")}）` : ""}`));
        out.append(el("h3", {}, t("warnings")), ul);
      }
      const brandSel = el("select", { name: "brandMode" }, el("option", { value: "first" }, t("brand_first")), el("option", { value: "last" }, t("brand_last")));
      const option = (name: string, checked: boolean, label: string) => el("label", {}, checkbox({ name }, checked), ` ${label}`);
      out.append(
        el("h3", {}, t("options")),
        el("label", {}, `${t("brand_mode")} `, brandSel),
        option("overwriteStock", true, t("overwrite_stock")),
        option("skipDisabledVariations", true, t("skip_disabled")),
        option("includeVariationImages", true, t("variation_images")),
      );
      // 税抜で入力していたショップ: 税区分ごとの税率と端数の扱い。CSV からは WooCommerce の設定が分からないので、運営者が選ぶ
      const taxBox = el("div", { "data-tax": "" });
      for (const c of a.stats.taxClasses) {
        const name = c.taxClass === NO_TAX ? t("tax_none") : c.taxClass === "" ? t("tax_standard") : decodeMetaName(c.taxClass);
        const input = el("input", { type: "number", min: "0", max: "100", step: "0.1", style: "width:5rem", "data-rate": c.taxClass });
        input.value = String(defaultTaxRate(c.taxClass));
        if (c.taxClass === NO_TAX) input.disabled = true;
        const cls = el("select", { "data-class": c.taxClass }, ...(["standard", "reduced", "exempt"] as const).map((v) => el("option", { value: v }, t(`tax_class_${v}`))));
        cls.value = defaultTaxClass(c.taxClass);
        taxBox.append(el("p", {}, el("label", {}, `${name}（SKU ${c.skus}）: `, input, " %"), " ", el("label", {}, `${t("tax_class")} `, cls)));
      }
      taxBox.append(
        el("label", {}, `${t("tax_rounding")} `, el("select", { name: "taxRounding" }, el("option", { value: "round" }, t("tax_round")), el("option", { value: "floor" }, t("tax_floor")), el("option", { value: "ceil" }, t("tax_ceil")))),
      );
      out.append(
        option("pricesExcludeTax", detectedExcludeTax === true, t("prices_exclude_tax")),
        el("p", { class: "muted" }, detectedExcludeTax === null ? t("prices_exclude_tax_hint") : t(detectedExcludeTax ? "tax_detected_exclusive" : "tax_detected_inclusive")),
        taxBox,
      );
      const tbody = el("tbody");
      for (const f of a.fields) {
        const tr = el("tr", { "data-source": f.source });
        tr.append(
          el("td", {}, checkbox({ "data-use": "" }, f.suggested)),
          el("td", {}, textInput({ "data-label": "", maxlength: "60" }, f.label)),
          el("td", {}, textInput({ "data-key": "", pattern: "[a-z][a-z0-9_]{0,39}", style: "width:9rem" }, f.key)),
          el("td", {}, f.type),
          el("td", {}, String(f.filled)),
          el("td", { class: "muted" }, f.unstable ? `⚠ ${t("unstable")} ${f.sample}` : f.sample),
        );
        tr.field = f;
        tbody.append(tr);
      }
      const table = el(
        "table",
        {},
        el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, t("f_label")), el("th", {}, t("f_key")), el("th", {}, t("f_type")), el("th", {}, t("f_filled")), el("th", {}, t("f_sample")))),
        tbody,
      );
      out.append(el("h3", {}, t("fields")), el("p", { class: "muted" }, t("fields_hint")), table);
      const go = el("button", { type: "button" }, t("start"));
      const log = el("div");
      go.addEventListener("click", () => void run(go, log));
      out.append(el("p", {}, go), log);
    }

    function selectedOptions(): BuildOptions {
      const fields: BuildOptions["fields"] = [];
      const trs = out.querySelectorAll("tr[data-source]");
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i]!;
        if (!tr.querySelector("[data-use]")!.checked || !tr.field) continue;
        const key = tr.querySelector("[data-key]")!.value.trim();
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
        fields.push({ source: tr.field.source, key, label: tr.querySelector("[data-label]")!.value.trim() || key, type: tr.field.type });
      }
      const val = (n: string) => out.querySelector(`[name=${n}]`)!;
      const rates: Record<string, number> = {};
      const rateInputs = out.querySelectorAll("[data-rate]");
      for (let i = 0; i < rateInputs.length; i++) {
        const r = Number(rateInputs[i]!.value);
        // 入力欄は stats.taxClasses と同じ順に並べている
        const key = analysis!.stats.taxClasses[i]?.taxClass ?? "";
        if (Number.isFinite(r) && r >= 0 && r <= 100) rates[key] = r;
      }
      const taxClasses: Record<string, "standard" | "reduced" | "exempt"> = {};
      const classSelects = out.querySelectorAll("[data-class]");
      for (let i = 0; i < classSelects.length; i++) {
        const v = classSelects[i]!.value;
        const key = analysis!.stats.taxClasses[i]?.taxClass ?? "";
        if (v === "standard" || v === "reduced" || v === "exempt") taxClasses[key] = v;
      }
      const rounding = val("taxRounding").value;
      return {
        taxClasses,
        fields,
        brandMode: val("brandMode").value === "last" ? "last" : "first",
        overwriteStock: val("overwriteStock").checked,
        skipDisabledVariations: val("skipDisabledVariations").checked,
        includeVariationImages: val("includeVariationImages").checked,
        pricesExcludeTax: val("pricesExcludeTax").checked ? { rates, rounding: rounding === "floor" || rounding === "ceil" ? rounding : "round" } : undefined,
      };
    }

    async function run(button: El, log: El) {
      button.disabled = true;
      const opts = selectedOptions();
      const plan = build(analysis!, opts);
      const line = (s: string, cls = "") => log.append(el("p", cls ? { class: cls } : {}, s));
      const totals = { products_created: 0, products_updated: 0, skus_created: 0, skus_updated: 0 };
      const errors: { slug: string; message: string }[] = [];
      try {
        line(t("step_fields", { n: opts.fields.length }));
        await post("fields", { fields: opts.fields.map((f) => ({ key: f.key, label: f.label, type: f.type })) });
        line(t("step_categories", { n: plan.categories.length }));
        await post("batch", { categories: plan.categories, products: [], overwrite_stock: plan.overwrite_stock });
        const batches = chunk(plan.products.map((p) => p.payload));
        const progress = el("p");
        log.append(progress);
        for (let i = 0; i < batches.length; i++) {
          progress.textContent = t("step_products", { done: i, total: batches.length });
          const r = await post("batch", { products: batches[i], overwrite_stock: plan.overwrite_stock });
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(r[k] ?? 0);
          errors.push(...((r["errors"] as { slug: string; message: string }[] | undefined) ?? []));
        }
        progress.textContent = t("step_products", { done: batches.length, total: batches.length });
        line(t("done_products", totals), "notice");
        if (errors.length > 0) {
          const ul = el("ul");
          errors.slice(0, 50).forEach((e) => ul.append(el("li", {}, `${e.slug}: ${e.message}`)));
          log.append(el("p", { class: "error" }, t("errors", { n: errors.length })), ul);
        }
        // 旧サイトの URL → Banto の URL（REST API で読んだときだけ分かる）
        if (analysis!.products.some((p) => p.permalink)) {
          const csv = redirectsCsv(analysis!, cfg.shopUrl);
          const a = el("a", { download: "banto-redirects.csv", href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` }, t("download_redirects"));
          log.append(el("p", {}, a), el("p", { class: "muted" }, t("redirects_hint")));
        }
        // 画像（やり直せる: 取り込み済みの URL はサーバー側で飛ばす）
        const requests = imageRequests(plan.products);
        const products = new Set(requests.map((r) => r.slug)).size;
        const imageCount = requests.reduce((n, r) => n + r.urls.length, 0);
        const imgBtn = el("button", { type: "button" }, t("start_images", { n: imageCount }));
        const queueBtn = el("button", { type: "button" }, t("queue_images", { n: imageCount }));
        if (cfg.queue) {
          log.append(el("p", {}, t("images_choice")), el("ul", {}, el("li", {}, t("images_choice_browser")), el("li", {}, t("images_choice_queue"))), el("p", {}, imgBtn, " ", queueBtn));
        } else {
          log.append(el("p", {}, imgBtn));
        }
        imgBtn.addEventListener("click", () => {
          imgBtn.disabled = true;
          queueBtn.disabled = true;
          const prog = el("p");
          log.append(prog);
          void (async () => {
            let added = 0;
            let skipped = 0;
            const failures: { slug: string; url: string; code: string }[] = [];
            const done = new Set<string>();
            const show = () => (prog.textContent = t("step_images", { done: done.size, total: products, added, skipped, failed: failures.length }));
            // 商品ごとにまとめ、4 商品ずつ同時に進める（同じ商品の画像は順番に送る: 並び順と取り込み済みの判定がずれないように）
            const bySlug = new Map<string, { slug: string; urls: string[] }[]>();
            for (const req of requests) bySlug.set(req.slug, [...(bySlug.get(req.slug) ?? []), req]);
            const queue = [...bySlug.values()];
            const worker = async () => {
              for (let reqs = queue.shift(); reqs; reqs = queue.shift()) {
                for (const req of reqs) {
                  try {
                    const r = await post("images", req);
                    added += Number(r["added"] ?? 0);
                    skipped += Number(r["skipped"] ?? 0);
                    for (const f of (r["failures"] as { url: string; code: string }[] | undefined) ?? []) failures.push({ slug: req.slug, url: f.url, code: f.code });
                  } catch (e) {
                    // 1 商品分のリクエストごと失敗（Banto 側の時間切れ・通信の切断など）
                    const code = /^HTTP (\d+)/.exec((e as Error).message)?.[1];
                    for (const url of req.urls) failures.push({ slug: req.slug, url, code: code ? `request_${code}` : "request" });
                  }
                  show();
                }
                done.add(reqs[0]!.slug);
                show();
              }
            };
            show();
            await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
            show();
            // 5MB を超えて取れなかった画像は、このブラウザで縮小して取り込む
            const large = failures.filter((f) => f.code === "too_large");
            if (large.length > 0) {
              const rest = failures.filter((f) => f.code !== "too_large");
              const r = await resizeLarge(large, (n) => (prog.textContent = t("resize_step", { done: n, total: large.length })));
              added += r.added;
              failures.splice(0, failures.length, ...rest, ...r.failures);
              line(t("resize_done", { added: r.added, failed: r.failures.length }), "notice");
              show();
            }
            line(t("done_images"), "notice");
            if (failures.length > 0) log.append(...imageFailureReport(failures));
            imgBtn.disabled = false;
            queueBtn.disabled = false;
          })();
        });
        // 裏で取り込む（0039）: URL の一覧を予約するだけ。100 商品ずつ送る
        queueBtn.addEventListener("click", () => {
          imgBtn.disabled = true;
          queueBtn.disabled = true;
          const prog = el("p");
          log.append(prog);
          void (async () => {
            const bySlug = new Map<string, string[]>();
            for (const req of requests) bySlug.set(req.slug, [...(bySlug.get(req.slug) ?? []), ...req.urls].slice(0, 50));
            const items = [...bySlug].map(([slug, urls]) => ({ slug, urls }));
            const totals = { queued: 0, skipped: 0, missing: 0 };
            try {
              for (let i = 0; i < items.length; i += 100) {
                prog.textContent = t("queue_step", { done: i, total: items.length });
                const r = await post("images/queue", { items: items.slice(i, i + 100) });
                for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(r[k] ?? 0);
              }
              prog.textContent = t("queue_step", { done: items.length, total: items.length });
              line(t("queue_done", totals), "notice");
              if (totals.missing > 0) line(t("queue_missing", { n: totals.missing }), "error");
              log.append(el("p", {}, el("a", { href: `${cfg.base}#image-queue` }, t("queue_reload"))));
            } catch (e) {
              line(`${t("failed")} ${(e as Error).message}`, "error");
              imgBtn.disabled = false;
              queueBtn.disabled = false;
            }
          })();
        });
      } catch (e) {
        line(`${t("failed")} ${(e as Error).message}`, "error");
        button.disabled = false;
      }
    }
  }

  return { parseCsv, decode, htmlToText, decodeMetaName, analyze, fetchStore, fetchCustomers, mapCustomer, mapCoupon, fetchCoupons, customerIdTable, mapOrder, fetchOrders, passwordRows, storeBase, redirectsCsv, build, chunk, imageRequests, defaultTaxRate, defaultTaxClass, mount };
}
