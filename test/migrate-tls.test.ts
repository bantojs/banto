import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, MigrationError } from "../src/db/migrate";
import { MIGRATION_FILES } from "../src/db/migrations";
import { startFakeTlsPg, type FakeTlsPg } from "./fake-tls-pg";

/** 接続文字列の道の TLS: 自己署名の証明書の偽の PostgreSQL に、確かめる・確かめないで繋ぐ（openssl が無ければ飛ばす） */
let server: FakeTlsPg | null = null;
beforeAll(async () => {
  server = await startFakeTlsPg();
});
afterAll(async () => {
  await server?.close();
});

describe("接続文字列のマイグレーションの証明書（実際の TLS）", () => {
  it("verify-full では自己署名の証明書を断り、[tls] を付けた connect の誤りにする", async (ctx) => {
    if (!server) return ctx.skip();
    const err = await applyMigrations(`postgres://u:p@127.0.0.1:${server.port}/db?sslmode=verify-full`, MIGRATION_FILES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).stage).toBe("connect");
    expect((err as MigrationError).message).toMatch(/ \[tls\]$/);
    expect(server.handshakes()).toBe(0);
  });

  it("require では証明書を確かめずに TLS まで進む（その先は偽の DB が閉じるので [tls] ではない誤り）", async (ctx) => {
    if (!server) return ctx.skip();
    const before = server.handshakes();
    const err = await applyMigrations(`postgres://u:p@127.0.0.1:${server.port}/db?sslmode=require`, MIGRATION_FILES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).message).not.toMatch(/\[tls\]/);
    expect(server.handshakes()).toBe(before + 1);
  });
});
