#!/usr/bin/env node
// supabase/migrations/*.sql を src/db/migrations.generated.ts に埋め込む（Worker からマイグレーションを適用するため）。
// 埋め込むのは注釈を外した SQL（scripts/sql-strip.mjs。Worker の大きさを減らすため。supabase/migrations/ のファイルは注釈つきのまま）。
// 土台（src/db/migration-state.ts の BASELINE_MIGRATION）までのファイルからは、後で同じ形で定義し直される関数の古い定義を外す
// （scripts/sql-squash.mjs。土台までを当てるのは新しい導入だけなので、最後の定義があれば足りる。test/db/squash.test.ts が同じ DB になることを確かめる）。
// 使い方: node scripts/gen-migrations.mjs        … 生成
//         node scripts/gen-migrations.mjs --check … 生成物が最新でなければ exit 1（CI / テスト用）
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSqlComments } from "./sql-strip.mjs";
import { squashMigrations } from "./sql-squash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "supabase", "migrations");
const out = join(root, "src", "db", "migrations.generated.ts");

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const stripped = files.map((f) => ({ version: f.replace(/\.sql$/, ""), sql: stripSqlComments(readFileSync(join(dir, f), "utf8")) }));
const baseline = /BASELINE_MIGRATION = "([^"]+)"/.exec(readFileSync(join(root, "src", "db", "migration-state.ts"), "utf8"))?.[1];
if (!baseline) throw new Error("gen-migrations: BASELINE_MIGRATION not found in src/db/migration-state.ts");
const entries = squashMigrations(stripped, baseline);

const body =
  `// 自動生成: node scripts/gen-migrations.mjs（supabase/migrations/ を編集したら再生成する。手で編集しない。注釈は外してある。土台までは後で定義し直される関数の古い定義も外してある）\n` +
  `export interface MigrationFile {\n  version: string;\n  sql: string;\n}\n\n` +
  `export const MIGRATION_FILES: readonly MigrationFile[] = [\n` +
  entries.map((e) => `  { version: ${JSON.stringify(e.version)}, sql: ${JSON.stringify(e.sql)} },`).join("\n") +
  `\n];\n`;

if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== body) {
    console.error("gen-migrations: src/db/migrations.generated.ts is out of date. Run: node scripts/gen-migrations.mjs");
    process.exit(1);
  }
  console.log("gen-migrations: up to date");
} else {
  writeFileSync(out, body);
  console.log(`gen-migrations: wrote ${entries.length} migration(s) to src/db/migrations.generated.ts`);
}
