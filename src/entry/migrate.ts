/**
 * マイグレーションを当てるコマンド（Node）。自前の PostgreSQL で、Banto を Cloudflare Workers で動かすとき用
 * （Workers のセットアップの画面からは VPS の DB に届かないため。docs/self-hosted-db.md）。
 *   DATABASE_URL=postgres://... node dist/node/migrate.js
 *   docker compose --profile tools run --rm migrate
 * 同梱のマイグレーションのうち未適用のものを順に当てる（当て済みは飛ばす）。運営者が自分で打つコマンドなので、接続先のホストは絞らない。
 */
import { applyMigrations, describeConnection, MigrationError, parseConnectionString } from "../db/migrate";
import { MIGRATION_FILES } from "../db/migrations";
import { rootCertificates } from "node:tls";

const url = process.env["DATABASE_URL"] ?? process.argv[2] ?? "";
const parsed = parseConnectionString(url, ["*"]);
if ("error" in parsed) {
  console.error(
    parsed.error === "ssl_required"
      ? "[banto] Supabase のデータベースへは暗号化して接続します。DATABASE_URL から sslmode=disable を外してください"
      : "[banto] DATABASE_URL に postgres://user:password@host:port/db の形で接続先を渡してください（sslmode は disable / require / verify-ca / verify-full）",
  );
  process.exit(1);
}
console.log(`[banto] migrating ${describeConnection(parsed)} (${MIGRATION_FILES.length} bundled)`);
try {
  const r = await applyMigrations(url, MIGRATION_FILES, ["*"], { budgetMs: Infinity, systemRoots: rootCertificates });
  console.log(`[banto] applied ${r.applied.length}: ${r.applied.join(", ") || "(none)"}`);
} catch (e) {
  if (e instanceof MigrationError) {
    console.error(`[banto] ${e.stage} failed${e.version ? ` at ${e.version}` : ""}: ${e.message}`);
    if (e.message.endsWith("[tls]")) {
      console.error("[banto] 証明書を確かめられませんでした。信頼する発行元の証明書を使っていない自前の PostgreSQL なら、DATABASE_URL に sslmode=require を足すと証明書を確かめずに暗号化だけで接続します");
    }
    process.exit(1);
  }
  throw e;
}
