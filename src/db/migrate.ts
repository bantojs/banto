/**
 * マイグレーションの適用（セットアップウィザード / アップデート画面専用）。
 *
 * CLAUDE.md §1-8「Workers から直接 Postgres 接続を張らない」の例外。あの規則の目的は通常運用での接続数と
 * 可搬性で、ここは運営者が接続文字列を貼って実行する一回限りの操作。接続文字列は保存しない。
 * node-postgres は Workers（nodejs_compat）と Node の両方で動く。
 *
 * 接続先は Supabase のホスト（と開発用の localhost）と、運営者が設定 DB_MIGRATION_HOSTS で許可したホストに限定する
 * （自前の PostgreSQL、docs/self-hosted-db.md）。owner 未登録のあいだはウィザードが認証なしで呼べるため、
 * 任意ホストへの TCP 接続に使われないようにするため。許可は画面からではなく、デプロイの設定（環境変数）でだけ足せる。
 */
import pg from "pg";
import type { MigrationFile } from "./migrations";

export class MigrationError extends Error {
  constructor(
    public readonly stage: "connect" | "query" | "apply",
    public readonly version: string | null,
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

const ALLOWED_HOST_RE = /(^|\.)supabase\.(com|co)$|^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * DB_MIGRATION_HOSTS（カンマ区切り）→ 許可するホスト。完全一致だけ（ワイルドカードは受け付けない）。
 * 例: "db.example.jp,10.0.0.5,db"（docker compose のサービス名も書ける）
 */
export function migrationHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, ""))
    .filter((h) => /^[a-z0-9.:-]{1,253}$/.test(h));
}

export interface ParsedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  /** Supabase の「Direct connection」（db.<ref>.supabase.co）。IPv6 専用なので接続できない環境がある */
  direct: boolean;
}

// postgresql://user:password@host[:port][/db][?query]
// パスワードは URL エンコードされていないことが多い（Supabase の画面はそのまま貼る前提）ので、
// new URL() ではなく「最後の @ より前」をパスワードとして受け取る。
const CONN_RE = /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::(.*))?@)?(\[[^\]]+\]|[^/?#:@]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/is;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 接続文字列を検証して要点を返す（パスワード込み。画面やログには出さないこと） */
export function parseConnectionString(raw: string, extraHosts: readonly string[] = []): ParsedConnection | { error: "invalid" | "host_not_allowed" } {
  const s = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!/^postgres(ql)?:\/\//i.test(s)) return { error: "invalid" };
  const m = CONN_RE.exec(s);
  if (!m) return { error: "invalid" };
  const [, rawUser, rawPassword, rawHost, rawPort, rawDb, rawQuery] = m;
  const host = (rawHost ?? "").replace(/^\[|\]$/g, "");
  const user = safeDecode(rawUser ?? "");
  if (!host || !user) return { error: "invalid" };
  // "*" はコマンドの migrate（src/entry/migrate.ts、運営者が自分で打つ）だけが渡す。DB_MIGRATION_HOSTS からは入らない（migrationHosts が捨てる）
  if (!ALLOWED_HOST_RE.test(host) && !extraHosts.includes(host.toLowerCase()) && !extraHosts.includes("*")) return { error: "host_not_allowed" };
  const password = safeDecode(rawPassword ?? "");
  // [YOUR-PASSWORD] のまま貼った場合は形式エラーとして案内する
  if (/^\[.*\]$/.test(password)) return { error: "invalid" };
  const params = new URLSearchParams(rawQuery ?? "");
  const sslmode = params.get("sslmode");
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  return {
    host,
    port: Number(rawPort || 5432),
    database: safeDecode((rawDb ?? "").replace(/^\//, "")) || "postgres",
    user,
    password,
    ssl: sslmode ? sslmode !== "disable" : !local,
    direct: /^db\.[a-z0-9]+\.supabase\.co$/i.test(host),
  };
}

/** 接続文字列を表示用に（パスワードを伏せて）要約する */
export function describeConnection(p: ParsedConnection): string {
  return `${p.user}@${p.host}:${p.port}/${p.database}`;
}

export interface ApplyResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyMigrations(connectionString: string, files: readonly MigrationFile[], extraHosts: readonly string[] = []): Promise<ApplyResult> {
  const parsed = parseConnectionString(connectionString, extraHosts);
  if ("error" in parsed) throw new MigrationError("connect", null, parsed.error);

  const client = new pg.Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    // Supabase の pooler は TLS 必須。CA は Supabase 独自のため、一回限りの操作では検証を緩める（verify-full を指定すれば検証する）
    ssl: parsed.ssl ? { rejectUnauthorized: /sslmode=verify-full/.test(connectionString) } : false,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  });

  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Direct connection は IPv6 専用。IPv4 しか出られない環境では pooler（Session / Transaction）を使ってもらう
    throw new MigrationError("connect", null, parsed.direct ? `${msg} [direct_connection]` : msg);
  }

  try {
    let applied: string[] = [];
    try {
      const r = await client.query<{ version: string }>("select version from banto_migrations");
      applied = r.rows.map((x) => x.version);
    } catch (e) {
      if ((e as { code?: string }).code !== "42P01") throw new MigrationError("query", null, e instanceof Error ? e.message : String(e));
    }
    const done = new Set(applied);
    const result: ApplyResult = { applied: [], alreadyApplied: applied };
    for (const file of files) {
      if (done.has(file.version)) continue;
      try {
        await client.query("begin");
        await client.query(file.sql);
        await client.query("commit");
        result.applied.push(file.version);
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw new MigrationError("apply", file.version, e instanceof Error ? e.message : String(e));
      }
    }
    return result;
  } finally {
    await client.end().catch(() => undefined);
  }
}
