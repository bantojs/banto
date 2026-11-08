#!/usr/bin/env node
// Worker 本体の圧縮後サイズが予算内か検査する（docs/ARCHITECTURE.md「速度の予算」、CLAUDE.md §7）。
// 測るのは既定のビルド（wrangler.jsonc の minify: true。BANTO_MINIFY=off で縮めずに送るデプロイは Cloudflare の上限だけを守る、docs/setup.md §11）。
// あわせて、管理画面に toString() で埋め込むブラウザのコード（woo-import など）がビルドの後もそれだけで動くかを確かめる。
// 先に npm run build:workers を実行しておくこと。上限を上げるときは理由を docs/knowledge/02-decisions.md に書く。
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Script, runInNewContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_BYTES = 1024 * 1024; // 1 MiB（gzip 後）。Workers 無料プランの上限は 3 MB
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "dist", "workers", "index.js");
if (!existsSync(file)) {
  console.error("check-size: dist/workers/index.js がありません。先に npm run build:workers を実行してください");
  process.exit(1);
}
// 古いビルドを測らない（src/ のほうが新しければ止める。2026-11-04 に古い成果物の大きさを報告してしまったため）
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((t, e) => Math.max(t, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
if (newest(join(root, "src")) > statSync(file).mtimeMs) {
  console.error("check-size: dist/workers/index.js が src/ より古いビルドです。先に npm run build:workers を実行してください");
  process.exit(1);
}
const raw = readFileSync(file);
const gz = gzipSync(raw, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const line = `check-size: ${kb(raw.length)}（gzip 後 ${kb(gz)} / 予算 ${kb(BUDGET_BYTES)}、${((gz / BUDGET_BYTES) * 100).toFixed(0)}%）`;
if (gz > BUDGET_BYTES) {
  console.error(`${line}\ncheck-size: 予算を超えています。増えた依存を見直すか、理由を docs/knowledge/02-decisions.md に書いて予算を上げてください`);
  process.exit(1);
}
console.log(line);

// 埋め込むブラウザのコード: `(${fn.toString()})()` の fn を取り出し、外の名前を使っていないか（縮めたときの補助 __name の改名など）を動かして確かめる
const text = raw.toString("utf8");
const names = [...new Set([...text.matchAll(/\$\{([A-Za-z_$][\w$]*)\.toString\(\)\}\)\(\)/g)].map((m) => m[1]))];
let broken = 0;
for (const name of names) {
  const start = text.search(new RegExp(`function ${name.replace(/\$/g, "\\$")}\\(`));
  let src = null;
  for (let i = text.indexOf("}", start); start >= 0 && i > 0; i = text.indexOf("}", i + 1)) {
    try {
      new Script(`(${text.slice(start, i + 1)})`);
      src = text.slice(start, i + 1);
      break;
    } catch {
      // まだ閉じていない
    }
  }
  // 管理画面の CLIENT_PRELUDE と同じく __name だけは用意する（縮めないビルドの補助）
  const ctx = { document: {}, console, TextDecoder, TextEncoder, setTimeout, fetch: () => Promise.reject(new Error("offline")) };
  ctx.window = ctx;
  try {
    if (!src) throw new Error("関数が見つかりません");
    runInNewContext(`var __name = function (t) { return t; }; (${src})()`, ctx, { timeout: 2000 });
  } catch (e) {
    broken++;
    console.error(`check-size: 埋め込むブラウザのコード ${name} がビルドの後に動きません: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (names.length === 0 || broken > 0) {
  if (names.length === 0) console.error("check-size: 埋め込むブラウザのコードが見つかりません（`(${fn.toString()})()` の形）");
  process.exit(1);
}
console.log(`check-size: 埋め込むブラウザのコード ${names.length} 個はビルドの後もそれだけで動く`);
