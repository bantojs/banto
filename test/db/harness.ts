/**
 * 実 PostgreSQL に対する DB テストの共通部品。
 * BANTO_TEST_DB_URL が無ければテストはスキップされる（npm run test:db は既定で Supabase CLI の 54322 を指す）。
 *
 * Supabase CLI（npx supabase start）の DB に対して流す場合は auth スキーマが既にあるので、
 * シムは「auth.users が無いときだけ」適用する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { MIGRATION_FILES } from "../../src/db/migrations";

export const TEST_DB_URL = process.env.BANTO_TEST_DB_URL;
export const dbAvailable = Boolean(TEST_DB_URL);

const ROOT = join(import.meta.dirname, "..", "..");
const SHIM_PATH = join(ROOT, "supabase", "test", "auth_shim.sql");

export type Role = "anon" | "authenticated" | "service_role";

/** 運営者・customers の項目に見せる customers の列（0028。パスワードのハッシュ・世代は見せない。src/routes/admin/export.ts と同じ） */
export const CUSTOMER_COLUMNS = "id,shop_id,email,name,default_address,created_at,updated_at,last_login_at";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!TEST_DB_URL) throw new Error("BANTO_TEST_DB_URL is not set");
  pool ??= new pg.Pool({ connectionString: TEST_DB_URL, max: 20 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** public スキーマを作り直し、シム + 全マイグレーションを順に適用する（Worker が当てるのと同じ、注釈を外した同梱の SQL。scripts/sql-strip.mjs） */
export async function resetDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
    await client.query("grant all on schema public to public");
    const hasAuth = await client.query(
      "select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users'",
    );
    if (hasAuth.rowCount === 0) {
      await client.query(readFileSync(SHIM_PATH, "utf8"));
    } else {
      // Supabase CLI 環境: public を作り直したので既定権限だけ再付与する
      await client.query("grant usage on schema public to anon, authenticated, service_role");
      await client.query("alter default privileges in schema public grant all on tables to anon, authenticated, service_role");
      await client.query("alter default privileges in schema public grant all on sequences to anon, authenticated, service_role");
      await client.query("alter default privileges in schema public grant all on functions to anon, authenticated, service_role");
    }
    for (const m of MIGRATION_FILES) {
      await client.query(m.sql);
    }
  } finally {
    client.release();
  }
}

/** auth.users に行を作り、その id を返す（Supabase Auth のサインアップ相当） */
export async function createAuthUser(email: string): Promise<string> {
  const r = await getPool().query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  return r.rows[0]!.id;
}

/**
 * 指定ロール + JWT クレームで1トランザクションを実行する。PostgREST が各リクエストで行うのと同じ手順
 * （set_config('request.jwt.claims') → set role）を再現する。fn が投げたらロールバック。
 */
export async function withRole<T>(
  role: Role,
  claims: Record<string, unknown>,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
    await client.query(`set local role ${role}`);
    // PostgREST と同じく、リクエストの前の関数を通す（0054 の運営者の二段階認証。適用前の DB では何もしない）
    if ((await client.query("select to_regprocedure('public.banto_pre_request()') is not null as ok")).rows[0].ok) {
      await client.query("select banto_pre_request()");
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export const asAnon = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withRole("anon", {}, fn);
export const asUser = <T>(uid: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withRole("authenticated", { sub: uid }, fn);
export const asService = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withRole("service_role", {}, fn);

/** fn が投げた PostgreSQL エラーのメッセージを返す。投げなければ失敗 */
export async function expectDbError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a database error but the query succeeded");
}

/** テスト用の owner + shop + 商品 + SKU を1式作る */
export interface Fixture {
  ownerId: string;
  shopId: string;
  productId: string;
  skuId: string;
}

export async function createShopFixture(opts: {
  email: string;
  slug: string;
  publish?: boolean;
  stock?: number;
}): Promise<Fixture> {
  const ownerId = await createAuthUser(opts.email);
  // owner の自己登録ゲート（1人目のみ）は rls.test.ts で検証する。フィクスチャは superuser で owner 行を作る。
  await getPool().query("insert into owners (id) values ($1)", [ownerId]);
  return asUser(ownerId, async (c) => {
    const shop = await c.query<{ id: string }>(
      `insert into shops (owner_id, slug, name, legal_notice, privacy_policy, return_policy, published)
       values ($1, $2, $3, '特商法表記', 'プライバシーポリシー', '返品ポリシー', $4) returning id`,
      [ownerId, opts.slug, `Shop ${opts.slug}`, opts.publish ?? false],
    );
    const shopId = shop.rows[0]!.id;
    const product = await c.query<{ id: string }>(
      "insert into products (shop_id, slug, name, published) values ($1, 'tee', 'Tシャツ', $2) returning id",
      [shopId, opts.publish ?? false],
    );
    const productId = product.rows[0]!.id;
    const sku = await c.query<{ id: string }>(
      "insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'TEE-M', 3000) returning id",
      [shopId, productId],
    );
    const skuId = sku.rows[0]!.id;
    if (opts.stock !== undefined) {
      await c.query("select set_stock($1, $2)", [skuId, opts.stock]);
    }
    return { ownerId, shopId, productId, skuId };
  });
}
