/**
 * マイグレーションを当てるコマンド（Node）。自前の PostgreSQL で、Banto を Cloudflare Workers で動かすとき用
 * （Workers のセットアップの画面からは VPS の DB に届かないため。docs/self-hosted-db.md）。
 *   DATABASE_URL=postgres://... node dist/node/migrate.js
 *   docker compose --profile tools run --rm migrate
 * 同梱のマイグレーションのうち未適用のものを順に当てる（当て済みは飛ばす）。運営者が自分で打つコマンドなので、接続先のホストは絞らない。
 */
import { applyMigrations, describeConnection, MigrationError, parseConnectionString } from "../db/migrate";
import { MIGRATION_FILES } from "../db/migrations";

const url = process.env["DATABASE_URL"] ?? process.argv[2] ?? "";
const parsed = parseConnectionString(url, ["*"]);
if ("error" in parsed) {
  console.error("[banto] DATABASE_URL に postgres://user:password@host:port/db の形で接続先を渡してください");
  process.exit(1);
}
console.log(`[banto] migrating ${describeConnection(parsed)} (${MIGRATION_FILES.length} bundled)`);
try {
  const r = await applyMigrations(url, MIGRATION_FILES, ["*"]);
  console.log(`[banto] applied ${r.applied.length}: ${r.applied.join(", ") || "(none)"}`);
} catch (e) {
  if (e instanceof MigrationError) {
    console.error(`[banto] ${e.stage} failed${e.version ? ` at ${e.version}` : ""}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
