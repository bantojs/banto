import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { TEST_DB_URL, closePool, dbAvailable, getPool, resetDatabase } from "./harness";
import { stripSqlComments } from "../../scripts/sql-strip.mjs";
import { MIGRATION_FILES } from "../../src/db/migrations";

/**
 * Worker に埋め込むマイグレーション（scripts/gen-migrations.mjs）は、土台までのファイルから後で定義し直される関数の古い定義を外している
 * （scripts/sql-squash.mjs）。外したものを当てた DB（このテストの DB、harness が当てる）と、supabase/migrations/ をそのまま全部当てた DB が、
 * 関数（本文・権限・security definer・設定）・表と列・制約・索引・ポリシー・トリガー・ビュー・表の権限・行の数で同じになることを確かめる
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SHIM = readFileSync(join(ROOT, "supabase", "test", "auth_shim.sql"), "utf8");

const SNAPSHOT: Record<string, string> = {
  functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
                     md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') as v
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p')`,
  columns: `select table_name || '.' || column_name as k, data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as v
              from information_schema.columns where table_schema = 'public'`,
  constraints: `select c.conrelid::regclass::text || '.' || c.conname as k, pg_get_constraintdef(c.oid) as v
                  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'`,
  indexes: `select indexname as k, indexdef as v from pg_indexes where schemaname = 'public'`,
  policies: `select tablename || '.' || policyname as k, cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') as v
               from pg_policies where schemaname = 'public'`,
  triggers: `select t.tgrelid::regclass::text || '.' || t.tgname as k, pg_get_triggerdef(t.oid) as v
               from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`,
  relations: `select c.relname as k, c.relkind::text || ' ' || c.relrowsecurity::text || ' ' || coalesce(c.relacl::text, '') as v
                from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S')`,
  views: `select viewname as k, md5(definition) as v from pg_views where schemaname = 'public'`,
};

async function snapshot(q: (sql: string) => Promise<{ rows: { k: string; v: string }[] }>): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [name, sql] of Object.entries(SNAPSHOT)) {
    out[name] = Object.fromEntries((await q(`${sql} order by 1`)).rows.map((r) => [r.k, r.v]));
  }
  // マイグレーションが入れる行（banto_migrations など）の数
  const tables = (await q("select tablename as k, '' as v from pg_tables where schemaname = 'public' order by 1")).rows.map((r) => r.k);
  out["rows"] = {};
  for (const t of tables) out["rows"]![t] = String((await q(`select count(*)::text as v, '' as k from public."${t}"`)).rows[0]!.v);
  return out;
}

describe.skipIf(!dbAvailable)("畳んだマイグレーション（scripts/sql-squash.mjs）", () => {
  const refName = `banto_squash_ref_${process.pid}`;
  let ref: pg.Client | undefined;

  beforeAll(async () => {
    await resetDatabase();
    await getPool().query(`drop database if exists ${refName}`);
    await getPool().query(`create database ${refName}`);
    const url = new URL(TEST_DB_URL!);
    url.pathname = `/${refName}`;
    ref = new pg.Client({ connectionString: url.toString() });
    await ref.connect();
    await ref.query(SHIM);
    const dir = join(ROOT, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await ref.query(stripSqlComments(readFileSync(join(dir, f), "utf8")));
  }, 300_000);

  afterAll(async () => {
    await ref?.end();
    await getPool().query(`drop database if exists ${refName}`).catch(() => undefined);
    await closePool();
  });

  it("同梱のマイグレーションは実際に古い定義を外している（大きさが減っている）", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const full = readdirSync(dir).filter((x) => x.endsWith(".sql")).reduce((n, f) => n + stripSqlComments(readFileSync(join(dir, f), "utf8")).length, 0);
    const bundled = MIGRATION_FILES.reduce((n, m) => n + m.sql.length, 0);
    expect(bundled).toBeLessThan(full * 0.9);
  });

  it("全部を当てた DB と同じ（関数・権限・表・制約・索引・ポリシー・トリガー・ビュー・行の数）", async () => {
    const mine = await snapshot((sql) => getPool().query(sql));
    const theirs = await snapshot((sql) => ref!.query(sql));
    for (const k of Object.keys(SNAPSHOT).concat("rows")) expect({ [k]: mine[k] }).toEqual({ [k]: theirs[k] });
  });
});
