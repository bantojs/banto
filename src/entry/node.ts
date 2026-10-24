/**
 * Node.js 向けエントリ（docs/run-on-node.md）。
 *   npm run build:node && node dist/node/server.js
 * 環境変数は .env ではなく process.env から読む（Docker / systemd の流儀）。
 */
import { serve } from "@hono/node-server";
import { createApp } from "../app";
import { createNodeAdapters } from "../adapters/node";
import { registerJobs } from "../jobs";

// 外から見た URL は必須（docs/run-on-node.md）。無いと Host ヘッダーがメールのリンクや OAuth の戻り先の起点になり、
// リバースプロキシの後ろで Host を偽装されると会員のログインのリンクを攻撃者のサイトに届けられる（監査 M-4）
if (!/^https?:\/\/[^/\s]+/.test(process.env["PUBLIC_BASE_URL"] ?? "")) {
  console.error("[banto] PUBLIC_BASE_URL is required (e.g. https://shop.example). See docs/run-on-node.md");
  process.exit(1);
}

const adapters = createNodeAdapters();
const app = createApp(() => adapters);

registerJobs(adapters);
const interval = Number(process.env["CRON_INTERVAL_SECONDS"] ?? 300);
if (interval > 0) adapters.scheduler.start(interval);

const port = Number(process.env["PORT"] ?? 8787);
const hostname = process.env["HOST"] ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[banto] listening on http://${info.address}:${info.port}`);
});
