#!/usr/bin/env node
// Worker 本体の圧縮後サイズが予算内か検査する（docs/ARCHITECTURE.md「速度の予算」、CLAUDE.md §7）。
// 測るのは既定のビルド（wrangler.jsonc の minify: true。BANTO_MINIFY=off で縮めずに送るデプロイは Cloudflare の上限だけを守る、docs/setup.md §11）。
// 管理画面に toString() で埋め込むブラウザのコードがビルドの後も動くかは npm run check:client（scripts/check-client-scripts.mjs）。
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

