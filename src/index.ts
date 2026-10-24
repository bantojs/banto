/**
 * Cloudflare Workers 向けエントリ（wrangler.jsonc の main）。
 * ここと src/adapters/workers/ 以外で Cloudflare 固有の型を使わない（CLAUDE.md §1-1）。
 */
import { createApp } from "./app";
import { createWorkersAdapters, type WorkersEnv } from "./adapters/workers";
import { registerJobs } from "./jobs";

const app = createApp((bindings) => createWorkersAdapters(bindings as unknown as WorkersEnv));

export default {
  fetch: app.fetch,
  // Cron Trigger → SchedulerAdapter（在庫予約の期限解放・個人情報マスキング）
  async scheduled(_event: ScheduledEvent, env: WorkersEnv, ctx: ExecutionContext) {
    const adapters = createWorkersAdapters(env);
    registerJobs(adapters);
    ctx.waitUntil(adapters.scheduler.runAll());
  },
};
