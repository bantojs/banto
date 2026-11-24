import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { applyMigrations, describeConnection, isTlsVerifyError, migrationHosts, MigrationError, parseConnectionString, sslOptions, type ParsedConnection } from "../../src/db/migrate";
import { SUPABASE_ROOT_CA_2021 } from "../../src/db/supabase-ca";
import { X509Certificate } from "node:crypto";
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

  it("空の DB に全マイグレーションを順に当て、2回目は何もしない。画面からは持ち時間で区切り、続きから当てる", async () => {
    // 画面から: 持ち時間を過ぎたら次のファイルに進まない（少なくとも 1 つは当てる）
    let clock = 0;
    const step = await applyMigrations(migrateUrl(), MIGRATION_FILES, [], { budgetMs: 1000, now: () => (clock += 1000) });
    expect(step.applied).toEqual(MIGRATION_FILES.slice(0, 1).map((m) => m.version));
    expect(step.remaining).toEqual(MIGRATION_FILES.slice(1).map((m) => m.version));

    const first = await applyMigrations(migrateUrl(), MIGRATION_FILES);
    expect(first.applied).toEqual(MIGRATION_FILES.slice(1).map((m) => m.version));
    expect(first.alreadyApplied).toEqual([MIGRATION_FILES[0]!.version]);
    expect(first.remaining).toEqual([]);
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
    expect(ok).toEqual({ host: "aws-0-ap-northeast-1.pooler.supabase.com", port: 6543, database: "postgres", user: "postgres.abcd", password: "s3cret", ssl: true, tls: "verify-full", supabase: true, direct: false });
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

describe("接続文字列の TLS（DB 不要）", () => {
  const hosts = ["db.example.jp", "db"];
  const tlsOf = (url: string, extra: string[] = hosts) => {
    const p = parseConnectionString(url, extra);
    return "error" in p ? p : { tls: p.tls, ssl: p.ssl, supabase: p.supabase };
  };

  it("Supabase のホストはいつも証明書を確かめる（require でも）。disable は断る。verify-ca は発行元だけ", () => {
    for (const q of ["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-full", "?sslmode=VERIFY-FULL"]) {
      expect(tlsOf(`postgresql://postgres.ref:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres${q}`)).toEqual({ tls: "verify-full", ssl: true, supabase: true });
      expect(tlsOf(`postgresql://postgres:pw@db.ref.supabase.co:5432/postgres${q}`)).toEqual({ tls: "verify-full", ssl: true, supabase: true });
    }
    expect(tlsOf("postgresql://postgres:pw@db.ref.supabase.co:5432/postgres?sslmode=verify-ca")).toEqual({ tls: "verify-ca", ssl: true, supabase: true });
    expect(tlsOf("postgresql://postgres.ref:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=disable")).toEqual({ error: "ssl_required" });
  });

  it("ローカルは書かなければ暗号化しない。書けば libpq と同じ", () => {
    expect(tlsOf("postgres://postgres@127.0.0.1:54329/x")).toEqual({ tls: "off", ssl: false, supabase: false });
    expect(tlsOf("postgres://postgres@localhost:54329/x?sslmode=disable")).toEqual({ tls: "off", ssl: false, supabase: false });
    expect(tlsOf("postgres://postgres@localhost:54329/x?sslmode=require")).toEqual({ tls: "encrypt", ssl: true, supabase: false });
    expect(tlsOf("postgres://postgres@[::1]:54329/x?sslmode=verify-full")).toEqual({ tls: "verify-full", ssl: true, supabase: false });
    expect(tlsOf("postgres://postgres@LOCALHOST:54329/x")).toEqual({ tls: "off", ssl: false, supabase: false });
    // ほかのループバックの書き方・別のアドレスは許さない（許したホストだけ）
    expect(tlsOf("postgres://postgres@[::2]:54329/x", [])).toEqual({ error: "host_not_allowed" });
    expect(tlsOf("postgres://postgres@[0:0:0:0:0:0:0:1]:54329/x", [])).toEqual({ error: "host_not_allowed" });
  });

  it("DB_MIGRATION_HOSTS で許したホストは既定で確かめる。require で暗号化だけ、disable で暗号化なし", () => {
    expect(tlsOf("postgres://banto:pw@db.example.jp:5432/banto")).toEqual({ tls: "verify-full", ssl: true, supabase: false });
    expect(tlsOf("postgres://banto:pw@db.example.jp:5432/banto?sslmode=require")).toEqual({ tls: "encrypt", ssl: true, supabase: false });
    expect(tlsOf("postgres://banto:pw@db.example.jp:5432/banto?sslmode=allow")).toEqual({ tls: "encrypt", ssl: true, supabase: false });
    expect(tlsOf("postgres://banto:pw@db.example.jp:5432/banto?sslmode=verify-ca")).toEqual({ tls: "verify-ca", ssl: true, supabase: false });
    expect(tlsOf("postgres://banto:pw@db/banto?sslmode=disable")).toEqual({ tls: "off", ssl: false, supabase: false });
    // コマンドの migrate（"*"）も同じ決まり
    expect(tlsOf("postgres://banto:pw@vps.example.net/banto", ["*"])).toEqual({ tls: "verify-full", ssl: true, supabase: false });
    // 許していないホスト・知らない sslmode
    expect(tlsOf("postgres://banto:pw@other.example.jp/banto")).toEqual({ error: "host_not_allowed" });
    expect(tlsOf("postgres://banto:pw@db.example.jp/banto?sslmode=no-verify")).toEqual({ error: "invalid" });
  });

  it("node-postgres に渡す設定: 確かめるときは rejectUnauthorized、Supabase は同梱のルート証明書、verify-ca はホスト名を見ない", () => {
    expect(sslOptions({ tls: "off", supabase: false })).toBe(false);
    expect(sslOptions({ tls: "encrypt", supabase: false })).toEqual({ rejectUnauthorized: false });
    expect(sslOptions({ tls: "verify-full", supabase: false })).toEqual({ rejectUnauthorized: true });
    expect(sslOptions({ tls: "verify-full", supabase: true })).toEqual({ rejectUnauthorized: true, ca: SUPABASE_ROOT_CA_2021 });
    const ca = sslOptions({ tls: "verify-ca", supabase: true });
    expect(ca).toMatchObject({ rejectUnauthorized: true, ca: SUPABASE_ROOT_CA_2021 });
    expect(ca && ca.checkServerIdentity?.()).toBeUndefined();
  });

  it("Node では Supabase のホストに公の発行元と同梱のルート証明書の両方を渡す（ホスト名は確かめたまま）", () => {
    const roots = ["-----BEGIN CERTIFICATE-----\nPUBLIC-ROOT-A\n-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\nPUBLIC-ROOT-B\n-----END CERTIFICATE-----"];
    const full = sslOptions({ tls: "verify-full", supabase: true }, roots);
    expect(full).toEqual({ rejectUnauthorized: true, ca: [...roots, SUPABASE_ROOT_CA_2021] });
    expect(full && "checkServerIdentity" in full).toBe(false);
    // 自前の DB は ca を渡さない（Node の既定の発行元のまま）
    expect(sslOptions({ tls: "verify-full", supabase: false }, roots)).toEqual({ rejectUnauthorized: true });
    // 空なら同梱のものだけ
    expect(sslOptions({ tls: "verify-full", supabase: true }, [])).toEqual({ rejectUnauthorized: true, ca: SUPABASE_ROOT_CA_2021 });
  });

  it("証明書の確かめの失敗の誤りを見分ける", () => {
    for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_ALTNAME_FORMAT", "CERT_REVOKED", "INVALID_CA", "CERT_REJECTED", "UNABLE_TO_DECRYPT_CERT_SIGNATURE", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
      expect(isTlsVerifyError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    for (const e of [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), new Error("no code"), "string", null]) expect(isTlsVerifyError(e)).toBe(false);
  });

  it("同梱の Supabase のルート証明書は Supabase Root 2021 CA（指紋で縛る）", () => {
    const cert = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
    expect(cert.ca).toBe(true);
    expect(cert.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
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
