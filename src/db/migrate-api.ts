/**
 * Supabase Management API 経由のマイグレーション適用（ウィザード / アップデート画面の既定の経路）。
 *
 * Workers から Supabase の pooler へ TLS で直接つなぐ経路（migrate.ts）は、Cloudflare 側の制約で
 * ハンドシェイク直後に切られることがある（workerd #2712）。Management API は HTTPS なので確実に届く。
 * 運営者が Supabase の「アクセストークン」（アカウント → Access Tokens）を貼り、Worker が
 * POST https://api.supabase.com/v1/projects/<ref>/database/query で SQL を流す。トークンは保存しない。
 * Supabase 以外のホストにはつながない（SUPABASE_URL から取った project ref だけを使う）。
 */
import type { MigrationFile } from "./migrations";
import { MIGRATION_STEP_BUDGET_MS, type ApplyResult } from "./migrate";

/**
 * 1 回のリクエストで送る問い合わせの数の上限。Workers の無料プランは 1 リクエストのサブリクエストが 50 まで。
 * マイグレーションは 1 ファイル = 1 回なので、初回（全部）は 1 回では当てきれない。残りは画面が続けて送る（migrate.tsx）
 */
export const MIGRATION_STEP_MAX_QUERIES = 40;

export const SUPABASE_MANAGEMENT_API = "https://api.supabase.com";

export class ManagementApiError extends Error {
  constructor(
    public readonly kind: "token" | "ref" | "rate_limited" | "query" | "apply",
    public readonly version: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ManagementApiError";
  }
}

/** SUPABASE_URL（https://<ref>.supabase.co）から project ref を取り出す。ローカル等では null */
export function projectRefFromUrl(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  const m = /^https:\/\/([a-z0-9]{15,30})\.supabase\.(co|in|red)(\/|$)/i.exec(supabaseUrl.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** 個人アクセストークンの形（sbp_ + 英数字）。前後の空白や引用符は落とす */
export function normalizeAccessToken(raw: string): string | null {
  const s = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  return /^sbp_[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

async function runQuery(opts: { ref: string; token: string; fetch: typeof fetch }, query: string): Promise<unknown> {
  const res = await opts.fetch(`${SUPABASE_MANAGEMENT_API}/v1/projects/${opts.ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (res.ok) {
    try {
      return text ? JSON.parse(text) : [];
    } catch {
      return [];
    }
  }
  let message = text;
  try {
    const j = JSON.parse(text) as { message?: string; error?: string };
    message = j.message ?? j.error ?? text;
  } catch {
    /* プレーンテキスト */
  }
  if (res.status === 401 || res.status === 403) throw new ManagementApiError("token", null, message);
  if (res.status === 404) throw new ManagementApiError("ref", null, message);
  if (res.status === 429) throw new ManagementApiError("rate_limited", null, message);
  throw new ManagementApiError("query", null, `${res.status}: ${message}`);
}

export async function applyMigrationsViaApi(
  opts: { ref: string; token: string; fetch: typeof fetch; now?: () => number },
  files: readonly MigrationFile[],
): Promise<ApplyResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  let applied: string[] = [];
  try {
    const rows = (await runQuery(opts, "select version from banto_migrations order by version")) as { version?: string }[];
    applied = Array.isArray(rows) ? rows.map((r) => String(r.version)) : [];
  } catch (e) {
    // 初回はテーブルが無い（42P01）。それ以外のエラーはそのまま
    if (!(e instanceof ManagementApiError && e.kind === "query" && /banto_migrations|42P01|does not exist/i.test(e.message))) throw e;
  }
  const done = new Set(applied);
  const todo = files.filter((f) => !done.has(f.version));
  const result: ApplyResult = { applied: [], alreadyApplied: applied, remaining: [] };
  let queries = 1;
  for (const [i, file] of todo.entries()) {
    // 上限か持ち時間に達したら、残りは次のリクエストへ（少なくとも 1 つは当てる）
    if (result.applied.length > 0 && (queries >= MIGRATION_STEP_MAX_QUERIES || now() - started >= MIGRATION_STEP_BUDGET_MS)) {
      result.remaining = todo.slice(i).map((f) => f.version);
      break;
    }
    try {
      // 1 ファイル = 1 リクエスト。複数文の simple query は暗黙の 1 トランザクションなので、途中で失敗すれば全体が戻る
      queries++;
      await runQuery(opts, file.sql);
    } catch (e) {
      if (e instanceof ManagementApiError && (e.kind === "token" || e.kind === "rate_limited" || e.kind === "ref")) throw e;
      throw new ManagementApiError("apply", file.version, e instanceof Error ? e.message : String(e));
    }
    result.applied.push(file.version);
  }
  return result;
}
