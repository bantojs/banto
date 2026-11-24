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
import { SUPABASE_ROOT_CA_2021 } from "./supabase-ca";

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

const ALLOWED_HOST_RE = /(^|\.)supabase\.(com|co)$|^(localhost|127\.0\.0\.1|::1)$/i;

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

/**
 * TLS の扱い（libpq の sslmode に合わせる）。
 * off = 暗号化しない、encrypt = 暗号化するが証明書は確かめない、verify-ca = 発行元だけ確かめる、verify-full = 発行元とホスト名を確かめる
 */
export type TlsMode = "off" | "encrypt" | "verify-ca" | "verify-full";

export interface ParsedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  /**
   * 証明書の確かめ方。Supabase のホストは必ず確かめる（Supabase のルート証明書で、既定はホスト名まで）。
   * ローカル（localhost）は sslmode の書いたとおり（既定は暗号化しない）。DB_MIGRATION_HOSTS で許したホストは既定で確かめ、
   * 確かめずに暗号化だけするときは sslmode=require を書く
   */
  tls: TlsMode;
  /** Supabase のホスト（*.supabase.com / *.supabase.co）。証明書は同梱の Supabase のルート証明書で確かめる */
  supabase: boolean;
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
export function parseConnectionString(raw: string, extraHosts: readonly string[] = []): ParsedConnection | { error: "invalid" | "host_not_allowed" | "ssl_required" } {
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
  const sslmode = params.get("sslmode")?.trim().toLowerCase() ?? null;
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  const supabase = SUPABASE_HOST_RE.test(host);
  const tls = tlsModeOf(sslmode, { local, supabase });
  if (tls === "invalid") return { error: "invalid" };
  if (tls === "ssl_required") return { error: "ssl_required" };
  return {
    host,
    port: Number(rawPort || 5432),
    database: safeDecode((rawDb ?? "").replace(/^\//, "")) || "postgres",
    user,
    password,
    ssl: tls !== "off",
    tls,
    supabase,
    direct: /^db\.[a-z0-9]+\.supabase\.co$/i.test(host),
  };
}

const SUPABASE_HOST_RE = /(^|\.)supabase\.(com|co)$/i;

/**
 * sslmode → 証明書の確かめ方。
 * - Supabase のホスト: 暗号化は必須（disable は断る）。verify-ca なら発行元だけ、それ以外（書かない・require・verify-full など）はホスト名まで確かめる
 *   （libpq の require は確かめないが、Supabase は同梱のルート証明書で確かめられるので、ここでは緩めない）
 * - ローカル（localhost・127.0.0.1・::1）: 書かなければ暗号化しない。書けば下と同じ扱い
 * - DB_MIGRATION_HOSTS で許したホスト: 書かなければホスト名まで確かめる。disable は暗号化しない。allow・prefer・require は暗号化して確かめない
 *   （libpq と違い、allow・prefer でも暗号化に失敗したときに暗号化なしへ戻らない）
 */
function tlsModeOf(sslmode: string | null, h: { local: boolean; supabase: boolean }): TlsMode | "invalid" | "ssl_required" {
  if (sslmode !== null && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) return "invalid";
  if (h.supabase) {
    if (sslmode === "disable") return "ssl_required";
    return sslmode === "verify-ca" ? "verify-ca" : "verify-full";
  }
  if (sslmode === null) return h.local ? "off" : "verify-full";
  if (sslmode === "disable") return "off";
  if (sslmode === "verify-ca" || sslmode === "verify-full") return sslmode;
  return "encrypt";
}

/**
 * node-postgres に渡す ssl の設定。Node では証明書を確かめる（Supabase は同梱のルート証明書、ほかは Node の既定の信頼する発行元）。
 * Workers では node-postgres が TLS を実行環境の startTls に任せる（pg-cloudflare）ため、ここの ca・rejectUnauthorized は使われない
 */
export function sslOptions(
  p: Pick<ParsedConnection, "tls" | "supabase">,
  systemRoots?: readonly string[],
): false | { rejectUnauthorized: boolean; ca?: string | string[]; checkServerIdentity?: () => undefined } {
  if (p.tls === "off") return false;
  if (p.tls === "encrypt") return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    // Supabase: 同梱の Supabase のルート証明書に加えて、公の発行元（Node の tls.rootCertificates。Node の入口が渡す）も信頼する。
    // ca を渡すと Node の既定の発行元が置き換わるので、両方を並べる（Supabase がどちらの発行元の証明書を出しても確かめられる）
    ...(p.supabase ? { ca: systemRoots && systemRoots.length > 0 ? [...systemRoots, SUPABASE_ROOT_CA_2021] : SUPABASE_ROOT_CA_2021 } : {}),
    // verify-ca: 発行元だけ確かめ、ホスト名は見ない（libpq と同じ）
    ...(p.tls === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
  };
}

/** 証明書を確かめられなかったときの node の誤り（自己署名・発行元が分からない・ホスト名が合わない・期限切れ・失効など、TLS の握手の失敗） */
export function isTlsVerifyError(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  return (
    /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_UNTRUSTED|CERT_SIGNATURE_FAILURE|CERT_REVOKED|CERT_REJECTED|INVALID_CA|UNABLE_TO_DECRYPT_CERT_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|ERR_TLS_CERT_ALTNAME_FORMAT)$/.test(code) ||
    /^ERR_SSL_/.test(code)
  );
}

/** 接続文字列を表示用に（パスワードを伏せて）要約する */
export function describeConnection(p: ParsedConnection): string {
  return `${p.user}@${p.host}:${p.port}/${p.database}`;
}

/**
 * 1 回のリクエストで当て続ける持ち時間。これを過ぎたら次のファイルには進まず、残りを返す（画面が続けて送る）。
 * 応答が長く返らないと、ブラウザとのあいだの接続が途中で切られるため
 */
export const MIGRATION_STEP_BUDGET_MS = 20_000;

export interface ApplyResult {
  applied: string[];
  alreadyApplied: string[];
  /** 持ち時間・回数の上限で、このリクエストでは当てなかった版（空なら全部済み） */
  remaining: string[];
}

/** step: 画面から当てるときの持ち時間（MIGRATION_STEP_BUDGET_MS）。コマンド（src/entry/migrate.ts）は省略して最後まで当てる */
export async function applyMigrations(
  connectionString: string,
  files: readonly MigrationFile[],
  extraHosts: readonly string[] = [],
  step: { budgetMs: number; now?: () => number; /** 公の発行元（Node の tls.rootCertificates）。Node の入口・アダプタが渡す（Workers では使われない） */ systemRoots?: readonly string[] } = { budgetMs: Infinity },
): Promise<ApplyResult> {
  const now = step.now ?? Date.now;
  const started = now();
  const parsed = parseConnectionString(connectionString, extraHosts);
  if ("error" in parsed) throw new MigrationError("connect", null, parsed.error);

  const client = new pg.Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    // 接続文字列の道でも証明書を確かめる（sslOptions。Supabase は同梱のルート証明書で）
    ssl: sslOptions(parsed, step.systemRoots),
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  });

  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 証明書を確かめられなかった: 画面で案内を出し分ける（[tls]）
    if (isTlsVerifyError(e)) throw new MigrationError("connect", null, `${msg} [tls]`);
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
    const todo = files.filter((f) => !done.has(f.version));
    const result: ApplyResult = { applied: [], alreadyApplied: applied, remaining: [] };
    for (const [i, file] of todo.entries()) {
      if (result.applied.length > 0 && now() - started >= step.budgetMs) {
        result.remaining = todo.slice(i).map((f) => f.version);
        break;
      }
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
