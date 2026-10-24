import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { applyMigrations, describeConnection, migrationHosts, MigrationError, parseConnectionString, type ParsedConnection } from "../../src/db/migrate";
import { MIGRATION_FILES } from "../../src/db/migrations";
import { closePool, dbAvailable, getPool, TEST_DB_URL } from "./harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** テスト DB とは別のデータベースを作って、空の状態から適用する */
const MIGRATE_DB = "banto_migrate_test";

function migrateUrl(): string {
  const u = new URL(TEST_DB_URL!);
  u.pathname = `/${MIGRATE_DB}`;
  u.searchParams.set("sslmode", "disable");
  return u.toString();
}

describe.skipIf(!dbAvailable)("applyMigrations（ウィザード / アップデート画面）", () => {
  beforeAll(async () => {
    await getPool().query(`drop database if exists ${MIGRATE_DB}`);
    await getPool().query(`create database ${MIGRATE_DB}`);
    // Supabase 相当の auth スキーマだけ用意する（本番では存在する）
    const c = new pg.Client({ connectionString: migrateUrl() });
    await c.connect();
    await c.query(readFileSync(join(import.meta.dirname, "..", "..", "supabase", "test", "auth_shim.sql"), "utf8"));
    await c.end();
  });
  afterAll(async () => {
    await getPool().query(`drop database if exists ${MIGRATE_DB}`);
    await closePool();
  });

  it("空の DB に全マイグレーションを順に当て、2回目は何もしない", async () => {
    const first = await applyMigrations(migrateUrl(), MIGRATION_FILES);
    expect(first.applied).toEqual(MIGRATION_FILES.map((m) => m.version));
    expect(first.alreadyApplied).toEqual([]);
    const c = new pg.Client({ connectionString: migrateUrl() });
    await c.connect();
    const r = await c.query<{ version: string }>("select version from banto_migrations order by version");
    expect(r.rows.map((x) => x.version)).toEqual(MIGRATION_FILES.map((m) => m.version));
    const tables = await c.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
    expect(tables.rows[0].n).toBeGreaterThanOrEqual(13);
    await c.end();

    const second = await applyMigrations(migrateUrl(), MIGRATION_FILES);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(MIGRATION_FILES.map((m) => m.version));
  });

  it("失敗したマイグレーションはロールバックされ、version も記録されない", async () => {
    const broken = [{ version: "9999_broken", sql: "create table will_rollback (id int); insert into banto_migrations (version) values ('9999_broken'); select 1/0;" }];
    await expect(applyMigrations(migrateUrl(), broken)).rejects.toMatchObject({ name: "MigrationError", stage: "apply", version: "9999_broken" });
    const c = new pg.Client({ connectionString: migrateUrl() });
    await c.connect();
    const t = await c.query("select to_regclass('public.will_rollback') as t");
    expect(t.rows[0].t).toBeNull();
    const v = await c.query("select 1 from banto_migrations where version = '9999_broken'");
    expect(v.rowCount).toBe(0);
    await c.end();
  });

  it("接続文字列の検証: Supabase 以外のホストは拒否、表示用の要約にパスワードを含めない", () => {
    const ok = parseConnectionString("postgresql://postgres.abcd:s3cret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres");
    expect(ok).toEqual({ host: "aws-0-ap-northeast-1.pooler.supabase.com", port: 6543, database: "postgres", user: "postgres.abcd", password: "s3cret", ssl: true, direct: false });
    expect(describeConnection(ok as ParsedConnection)).toBe("postgres.abcd@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres");
    expect(parseConnectionString("postgres://postgres:pw@db.xyz.supabase.co:5432/postgres?sslmode=verify-full")).toMatchObject({ ssl: true });
    expect(parseConnectionString("postgres://postgres@127.0.0.1:54329/x")).toMatchObject({ host: "127.0.0.1", ssl: false });
    expect(parseConnectionString("postgres://postgres:pw@evil.example.com/postgres")).toEqual({ error: "host_not_allowed" });
    expect(parseConnectionString("postgres://postgres:pw@supabase.com.evil.example/postgres")).toEqual({ error: "host_not_allowed" });
    // 自前の PostgreSQL: 運営者が DB_MIGRATION_HOSTS で許可したホストだけ（完全一致、ワイルドカードなし）。TLS は既定で使う
    const hosts = migrationHosts(" DB.Example.jp , db, *.evil.example, bad host ");
    expect(hosts).toEqual(["db.example.jp", "db"]);
    expect(parseConnectionString("postgres://banto:pw@db.example.jp:5432/banto", hosts)).toMatchObject({ host: "db.example.jp", database: "banto", ssl: true });
    expect(parseConnectionString("postgres://banto:pw@db/banto?sslmode=disable", hosts)).toMatchObject({ host: "db", ssl: false });
    expect(parseConnectionString("postgres://banto:pw@x.db.example.jp/banto", hosts)).toEqual({ error: "host_not_allowed" });
    expect(parseConnectionString("mysql://x@y.supabase.co/db")).toEqual({ error: "invalid" });
    expect(parseConnectionString("")).toEqual({ error: "invalid" });
  });

  it("接続できなければ connect 段階のエラー", async () => {
    await expect(applyMigrations("postgres://nobody:x@127.0.0.1:1/nothing?sslmode=disable", MIGRATION_FILES)).rejects.toMatchObject({ stage: "connect" });
    await expect(applyMigrations("postgres://x:y@evil.example/db", MIGRATION_FILES)).rejects.toBeInstanceOf(MigrationError);
  });
});

describe("parseConnectionString（DB 不要）", () => {
  it("Supabase の画面から貼ったままの文字列を受け付ける（記号入りパスワード、Direct / Session / Transaction）", () => {
    // 記号入りパスワードは URL エンコードされていない前提で、最後の @ より前をパスワードとして取る
    const p = parseConnectionString("postgresql://postgres:p@ss#w%rd/!@db.kqmfujpwiftnsktxfcjj.supabase.co:5432/postgres");
    expect(p).toMatchObject({ host: "db.kqmfujpwiftnsktxfcjj.supabase.co", port: 5432, user: "postgres", password: "p@ss#w%rd/!", database: "postgres", ssl: true, direct: true });
    const session = parseConnectionString("postgresql://postgres.kqmfujpwiftnsktxfcjj:Abc123!@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres");
    expect(session).toMatchObject({ host: "aws-1-ap-northeast-1.pooler.supabase.com", port: 5432, user: "postgres.kqmfujpwiftnsktxfcjj", password: "Abc123!", direct: false });
    const tx = parseConnectionString(" 'postgresql://postgres.ref:x%40y@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require' ");
    expect(tx).toMatchObject({ port: 6543, password: "x@y", ssl: true });
    // [YOUR-PASSWORD] のまま、スキーム違い、ホスト違い
    expect(parseConnectionString("postgresql://postgres:[YOUR-PASSWORD]@db.ref.supabase.co:5432/postgres")).toEqual({ error: "invalid" });
    expect(parseConnectionString("postgresql://postgres:pw@db.ref.supabase.co.evil.example:5432/postgres")).toEqual({ error: "host_not_allowed" });
    expect(parseConnectionString("postgresql://postgres:pw@evil.example/postgres?host=db.ref.supabase.co")).toEqual({ error: "host_not_allowed" });
    expect(parseConnectionString("postgresql://db.ref.supabase.co/postgres")).toEqual({ error: "invalid" });
  });
});
