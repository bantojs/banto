#!/usr/bin/env node
// 管理画面がブラウザへ渡すスクリプト（関数の toString()）が、本番の Workers バンドルのままで動くか確かめる。
// wrangler のビルドは関数の中にヘルパー（__name など）を差し込むことがあり、テスト環境（vitest）では再現しないため、
// dist/workers/index.js から関数を取り出し、ページと同じ前置きを付けて、DOM の無い VM で解析を 1 回走らせる。
// 先に npm run build:workers を実行しておくこと。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "dist", "workers", "index.js");
if (!existsSync(bundlePath)) {
  console.error("check-client-scripts: dist/workers/index.js がありません。先に npm run build:workers を実行してください");
  process.exit(1);
}
const bundle = readFileSync(bundlePath, "utf8");

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in the bundle`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const preludeMatch = /export const CLIENT_PRELUDE = '([^']*)';/.exec(readFileSync(join(root, "src", "modules", "woo-import", "admin.tsx"), "utf8"));
if (!preludeMatch) throw new Error("CLIENT_PRELUDE not found");
const prelude = preludeMatch[1].replace(/\\n/g, "\n");
const fn = extractFunction(bundle, "wooImporter");
const csv = "﻿ID,Type,SKU,Name,Published,Regular price,Parent,Stock\r\n1,variable,A,商品,1,,,\r\n2,variation,A-1,商品 - M,1,1000,A,3\r\n";
const sandbox = { csv, result: null, URL, URLSearchParams };
vm.createContext(sandbox);
// CSV の解析と組み立て、REST API の読み込み（偽の WooCommerce）を、本番のバンドルから取り出した関数で走らせる
const run = vm.runInContext(
  `${prelude}(async () => {
     const w = (${fn})(); const a = w.analyze(csv);
     const plan = w.build(a, { fields: [], brandMode: "first", overwriteStock: true, skipDisabledVariations: true, includeVariationImages: true, pricesExcludeTax: { rates: {}, rounding: "round" } });
     const page = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
     const fake = async (u) =>
       u.includes("/settings/") ? page({ value: "yes" })
       : u.includes("/products/categories") ? page([])
       : u.includes("/variations") ? page([{ id: 2, sku: "A-1", status: "publish", regular_price: "1000", attributes: [] }])
       : page([{ id: 1, type: "variable", sku: "A", name: "商品", status: "publish", permalink: "https://old.example/a/" }]);
     const rest = await w.fetchStore({ url: "https://old.example", key: "ck", secret: "cs" }, fake);
     result = { ...a.stats, price: plan.products[0].payload.skus[0].price_jpy, restSkus: rest.analysis.stats.skus, redirects: w.redirectsCsv(rest.analysis, "https://b.example/s").split(String.fromCharCode(10)).length };
   })()`,
  sandbox,
  { timeout: 5000 },
);
await run;
if (!sandbox.result || sandbox.result.products !== 1 || sandbox.result.skus !== 1 || sandbox.result.price !== 1100 || sandbox.result.restSkus !== 1 || sandbox.result.redirects !== 3) {
  console.error("check-client-scripts: wooImporter の解析結果が想定と違います", sandbox.result);
  process.exit(1);
}
// 送り状 CSV の Shift_JIS への変換（同梱モジュール shipping_labels）
const labelsFn = extractFunction(bundle, "shippingLabelsClient");
const box = { out: null, TextDecoder };
vm.createContext(box);
vm.runInContext(`${prelude}const e = (${labelsFn})().encodeSjis("山田ｱ～A"); out = Array.from(e.bytes).join(",") + "|" + e.unmappable.length;`, box, { timeout: 5000 });
if (box.out !== "142,82,147,99,177,129,96,65|0") {
  console.error("check-client-scripts: shippingLabelsClient の Shift_JIS 変換が想定と違います", box.out);
  process.exit(1);
}
// 送り状番号の取り込み: Shift_JIS の CSV（B2 クラウドの書き出しの形）を読んで列を推測する
vm.runInContext(
  `${prelude}const L = (${labelsFn})(); const bytes = L.encodeSjis("お客様管理番号,送り状種類,伝票番号\\r\\n1001,0,1234-5678-9012\\r\\n").bytes; const rows = L.parseCsv(L.decodeBytes(bytes)); const c = L.detectColumns(rows[0]); out = JSON.stringify(L.trackingItems(rows, c.number, c.tracking, c.carrier));`,
  box,
  { timeout: 5000 },
);
if (box.out !== '[{"number":"1001","carrier":"yamato","tracking":"1234-5678-9012"}]') {
  console.error("check-client-scripts: shippingLabelsClient の送り状番号の読み取りが想定と違います", box.out);
  process.exit(1);
}
// ページの見たままの編集（同梱モジュール pages）: 編集の領域の節 → 決まった書式（DOM の代わりに同じ形の偽物を渡す）
const editorFn = extractFunction(bundle, "pageEditorClient");
const pbox = { out: null };
vm.createContext(pbox);
vm.runInContext(
  `${prelude}const E = (${editorFn})();
   const t = (s) => ({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: s });
   const el = (n, kids, attrs) => ({ nodeType: 1, nodeName: n, childNodes: kids, textContent: kids.map((k) => k.textContent).join(""), getAttribute: (k) => (attrs || {})[k] ?? null });
   out = E.toMarkdown(el("DIV", [el("H2", [t("見出し")]), el("P", [el("B", [t("太")]), t(" と "), el("A", [t("送料")], { href: "/shipping" })]), el("UL", [el("LI", [t("一")]), el("LI", [t("二")])])]));`,
  pbox,
  { timeout: 5000 },
);
if (pbox.out !== "## 見出し\n\n**太** と [送料](/shipping)\n\n- 一\n- 二") {
  console.error("check-client-scripts: pageEditorClient の書式への変換が想定と違います", JSON.stringify(pbox.out));
  process.exit(1);
}
console.log(`check-client-scripts: ok（wooImporter ${(fn.length / 1024).toFixed(1)} KiB、shippingLabelsClient ${(labelsFn.length / 1024).toFixed(1)} KiB、pageEditorClient ${(editorFn.length / 1024).toFixed(1)} KiB${/__name\(/.test(fn + labelsFn + editorFn) ? "、__name を前置きで補完" : ""}）`);
