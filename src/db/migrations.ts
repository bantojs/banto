/**
 * このビルドに同梱されているマイグレーション。supabase/migrations/ から scripts/gen-migrations.mjs で生成した
 * migrations.generated.ts を読む。DB 側の banto_migrations と突き合わせて未適用分を検出し（Step 7）、
 * ウィザード / アップデート画面から適用する（src/db/migrate.ts）。
 */
import { MIGRATION_FILES, type MigrationFile } from "./migrations.generated";

export { MIGRATION_FILES };
export type { MigrationFile };

export const BUNDLED_MIGRATIONS: readonly string[] = MIGRATION_FILES.map((m) => m.version);

export function pendingMigrations(applied: readonly string[]): string[] {
  const done = new Set(applied);
  return BUNDLED_MIGRATIONS.filter((v) => !done.has(v));
}

export function pendingMigrationFiles(applied: readonly string[]): MigrationFile[] {
  const done = new Set(applied);
  return MIGRATION_FILES.filter((m) => !done.has(m.version));
}
