import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_MIGRATIONS, MIGRATION_FILES, pendingMigrations } from "../src/db/migrations";
import { stripSqlComments } from "../scripts/sql-strip.mjs";

const root = join(import.meta.dirname, "..");

describe("同梱マイグレーション", () => {
  it("supabase/migrations/ のファイル一覧と一致し、生成物が最新である", () => {
    const files = readdirSync(join(root, "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    expect([...BUNDLED_MIGRATIONS]).toEqual(files);
    expect(() => execFileSync(process.execPath, [join(root, "scripts", "gen-migrations.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("各マイグレーションは末尾で自分の version を banto_migrations に記録する", () => {
    for (const m of MIGRATION_FILES) {
      expect(m.sql, m.version).toContain(`insert into banto_migrations (version) values ('${m.version}')`);
    }
  });

  it("pendingMigrations は未適用だけを順に返す", () => {
    expect(pendingMigrations([])).toEqual([...BUNDLED_MIGRATIONS]);
    expect(pendingMigrations([...BUNDLED_MIGRATIONS])).toEqual([]);
    expect(pendingMigrations(["0001_init"])).toEqual(BUNDLED_MIGRATIONS.filter((v) => v !== "0001_init"));
  });

  it("同梱の SQL は注釈を外してある。文字列・識別子・ドル引用の中の -- と字下げは残す", () => {
    const src = [
      "-- 頭の注釈",
      "create table t (",
      "  a text default 'x -- y''s', -- 行末の注釈",
      '  "b--c" int',
      ");",
      "",
      "",
      "create function f() returns text language plpgsql as $$",
      "begin",
      "  -- 本文の注釈",
      "  return E'it\\'s -- ok' || $q$ -- 残す $q$ || '",
      "    複数行の -- 文字列';",
      "end $$;",
    ].join("\n");
    expect(stripSqlComments(src)).toBe(
      [
        "create table t (",
        "a text default 'x -- y''s',",
        '"b--c" int',
        ");",
        "create function f() returns text language plpgsql as $$",
        "begin",
        "return E'it\\'s -- ok' || $q$ -- 残す $q$ || '",
        "    複数行の -- 文字列';",
        "end $$;",
        "",
      ].join("\n"),
    );
    expect(() => stripSqlComments("select 1 /* x */")).toThrow(/not supported/);
    expect(() => stripSqlComments("select 'x")).toThrow(/unterminated/);
    for (const m of MIGRATION_FILES) expect(stripSqlComments(m.sql), m.version).toBe(m.sql);
  });
});
