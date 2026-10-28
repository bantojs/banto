/**
 * 適用済みのマイグレーションで、新しい機能を出すかどうかを決める（docs/upgrade.md「コードと DB の版がずれているあいだ」）。
 *
 * セルフホストでは、運営者がコードを更新してから管理画面で DB を更新するので、「新しいコード × 古い DB」の時間が必ずある。
 * そのあいだも、お客様の画面と既存の機能は止めない。新しいマイグレーションを使う機能だけを、適用されるまで出さない。
 * 機能ごとに「表が無いエラーを受け止める」書き方はしない。判定はここの migrated() 1 つ。
 *
 * v0.3.0 は 0001〜BASELINE を前提にする（セットアップのウィザードが全部当ててから運営者を作らせる）。
 * BASELINE までの版は問い合わせずに「適用済み」とみなす。サポートする古い DB は「ひとつ前のマイナー版まで」で、
 * 次のマイナー版で BASELINE を進め、それまでの migrated() の分岐を消す。
 */
import type { CacheAdapter } from "../adapters/types";
import type { DbClient } from "./client";

/** v0.3.0 の土台（v0.2.0 のセットアップで当たる 0001〜0061）。これ以前のマイグレーションは適用済みとみなす */
export const BASELINE_MIGRATION = "0061_mod_inquiries";

export const APPLIED_MIGRATIONS_CACHE_KEY = "migrations:applied";
/** isolate ごとに覚える秒数。適用した isolate では即座に消すが、ほかの isolate は最大この秒数だけ古い一覧を使う */
const CACHE_SECONDS = 60;

export interface MigrationStateDeps {
  /** anon でよい（banto_setup_state は anon に開いている） */
  db: DbClient;
  cache: CacheAdapter;
}

/** 適用済みの版の一覧（キャッシュ付き） */
export async function appliedMigrations(deps: MigrationStateDeps): Promise<ReadonlySet<string>> {
  const hit = await deps.cache.get<string[]>(APPLIED_MIGRATIONS_CACHE_KEY);
  if (hit) return new Set(hit);
  const state = await deps.db.rpc<{ migrations?: string[] }>("banto_setup_state", {});
  const list = Array.isArray(state?.migrations) ? state.migrations : [];
  await deps.cache.set(APPLIED_MIGRATIONS_CACHE_KEY, list, CACHE_SECONDS);
  return new Set(list);
}

/** その版のマイグレーションが当たっているか。BASELINE までは問い合わせずに true */
export async function migrated(deps: MigrationStateDeps, version: string): Promise<boolean> {
  if (version <= BASELINE_MIGRATION) return true;
  return (await appliedMigrations(deps)).has(version);
}

/** マイグレーションを当てた直後に呼ぶ（この isolate の一覧を捨てる） */
export function forgetAppliedMigrations(cache: CacheAdapter): Promise<void> {
  return cache.delete(APPLIED_MIGRATIONS_CACHE_KEY);
}
