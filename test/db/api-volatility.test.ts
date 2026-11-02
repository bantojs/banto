import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, dbAvailable, getPool, resetDatabase } from "./harness";

/**
 * api_require を呼ぶ関数は stable / immutable にしない。
 * PostgREST は stable / immutable の関数を読み取り専用の取引で実行するが、api_require はトークンの最終利用（last_used_at）を書くことがあり、
 * 「読み取り専用の取引では UPDATE できない」で失敗する（0092 の api_image_settings と 0008 の api_categories_list で起きた。0093 で直した）。
 * テストの SQL は読み取り専用の取引で動かないので、関数を呼ぶだけでは気づけない。ここで関数の宣言を見る
 */
describe.skipIf(!dbAvailable)("api_require を呼ぶ関数の volatility", () => {
  beforeAll(resetDatabase);
  afterAll(closePool);

  it("api_require を呼ぶ関数はすべて volatile", async () => {
    const rows = (
      await getPool().query<{ name: string; volatility: string }>(
        `select p.proname as name, p.provolatile as volatility
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname <> 'api_require' and p.prosrc ~ 'api_require\\s*\\('`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.volatility !== "v").map((r) => r.name)).toEqual([]);
  });
});
