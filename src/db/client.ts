/**
 * RLS が効く経路（anon キー + 任意のユーザー JWT）で PostgREST を叩く最小クライアント。
 * 管理画面・ストアフロントはこちらを使う。service_role は privileged.ts のみ（CLAUDE.md §1-3）。
 * ルートから直接 fetch で PostgREST を叩かず、必ずここを通す（CLAUDE.md §11）。
 */

export type Row = object;
export type Scalar = string | number | boolean | null;

export interface DbClientOptions {
  url: string;
  anonKey: string;
  /** Supabase Auth のアクセストークン。無ければ anon として振る舞う */
  userJwt?: string;
  /** テスト用。省略時はグローバル fetch */
  fetch?: typeof fetch;
}

export class DbError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
  /** PostgREST が「テーブル/関数が無い」と言っているか（マイグレーション未適用の検出に使う） */
  get isMissingRelation(): boolean {
    return this.code === "PGRST205" || this.code === "PGRST202" || this.code === "42P01" || this.code === "42883";
  }
  /** 列が無い（マイグレーション未適用で、新しい列を読もうとした） */
  get isMissingColumn(): boolean {
    return this.code === "42703" || this.code === "PGRST204";
  }
  get isRlsViolation(): boolean {
    return this.code === "42501";
  }
}

export interface SelectOptions {
  eq?: Record<string, Scalar>;
  /** 列の値がどれかに一致（PostgREST の in.(…)）。空の配列は 0 件になる */
  in?: Record<string, readonly string[]>;
  /** 配列の列がこれらの値をすべて含む（PostgREST の cs.{…}。記事のタグで絞る） */
  arrayContains?: Record<string, readonly string[]>;
  /** 条件の木（すべてを満たす行だけ。PostgREST の and=(…)）。管理画面の検索とキーセットのページ送りに使う */
  where?: readonly Filter[];
  /** 例: "created_at.desc" */
  order?: string;
  limit?: number;
  /** ページング用。PostgREST（Supabase 既定）は 1 回 1,000 行までなので、それ以上は offset で回す */
  offset?: number;
}

/**
 * 条件の木。列は英小文字・数字・_ と、jsonb の 1 段の鍵（attributes->>key）だけ。
 * contains は大文字小文字を区別しない部分一致（ilike。% と _ はそのままの文字として探す）
 */
export type Filter =
  | { or: readonly Filter[] }
  | { and: readonly Filter[] }
  | { col: string; op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; value: string | number | boolean }
  | { col: string; op: "is"; value: null | boolean }
  | { col: string; op: "contains"; value: string };

const FILTER_COLUMN = /^[a-z_][a-z0-9_]*(->>[a-z0-9_]+)?$/;

function quoteValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 条件の木 → PostgREST の論理式（and(…) / or(…) / 列.演算子.値） */
export function filterExpr(f: Filter): string {
  if ("or" in f) return `or(${f.or.map(filterExpr).join(",")})`;
  if ("and" in f) return `and(${f.and.map(filterExpr).join(",")})`;
  if (!FILTER_COLUMN.test(f.col)) throw new Error(`invalid filter column: ${f.col}`);
  if (f.op === "is") return `${f.col}.is.${f.value === null ? "null" : String(f.value)}`;
  if (f.op === "contains") {
    // LIKE の特別な文字をそのままの文字に。* は PostgREST が % に読み替えるので値からは外す
    const like = f.value.replace(/\*/g, "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    return `${f.col}.ilike.${quoteValue(`*${like}*`)}`;
  }
  return `${f.col}.${f.op}.${typeof f.value === "string" ? quoteValue(f.value) : String(f.value)}`;
}

export interface TableQuery<T extends Row> {
  select(columns?: string, opts?: SelectOptions): Promise<T[]>;
  selectOne(columns?: string, opts?: SelectOptions): Promise<T | null>;
  /** 条件に合う行の数（PostgREST の Prefer: count=exact。行そのものは読まない）。数が大きい表では絞り込みに使う列にインデックスがあること */
  count(opts?: SelectOptions): Promise<number>;
  insert(rows: Partial<T> | Partial<T>[]): Promise<T[]>;
  update(values: Partial<T>, eq: Record<string, Scalar>): Promise<T[]>;
  delete(eq: Record<string, Scalar>): Promise<void>;
}

export interface DbClient {
  from<T extends Row = Row>(table: string): TableQuery<T>;
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

function buildQuery(columns: string | undefined, opts: SelectOptions | undefined, eq?: Record<string, Scalar>): string {
  const q = new URLSearchParams();
  if (columns) q.set("select", columns);
  for (const [k, v] of Object.entries({ ...(opts?.eq ?? {}), ...(eq ?? {}) })) {
    q.set(k, v === null ? "is.null" : `eq.${String(v)}`);
  }
  // 値は二重引用符で囲む（カンマや括弧を含んでも 1 つの値として扱われるように）
  for (const [k, vs] of Object.entries(opts?.in ?? {})) {
    q.set(k, `in.(${vs.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`);
  }
  for (const [k, vs] of Object.entries(opts?.arrayContains ?? {})) {
    q.set(k, `cs.{${vs.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`);
  }
  if (opts?.where && opts.where.length > 0) q.set("and", `(${opts.where.map(filterExpr).join(",")})`);
  if (opts?.order) q.set("order", opts.order);
  if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts?.offset) q.set("offset", String(opts.offset));
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function toDbError(res: Response): Promise<DbError> {
  const text = await res.text();
  let code: string | undefined;
  let message = text;
  let details: string | undefined;
  try {
    const j = JSON.parse(text) as { code?: string; message?: string; details?: string; hint?: string };
    code = j.code;
    message = j.message ?? text;
    details = j.details ?? j.hint;
  } catch {
    /* PostgREST 以外の応答（ゲートウェイエラー等）はそのまま */
  }
  return new DbError(`PostgREST ${res.status}: ${message}`, res.status, code, details);
}

export function createDbClient(opts: DbClientOptions): DbClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    apikey: opts.anonKey,
    Authorization: `Bearer ${opts.userJwt ?? opts.anonKey}`,
    "Content-Type": "application/json",
    ...extra,
  });

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await doFetch(`${base}/rest/v1/${path}`, init);
    if (!res.ok) throw await toDbError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    from<T extends Row = Row>(table: string): TableQuery<T> {
      return {
        select: (columns = "*", o) => request<T[]>(`${table}${buildQuery(columns, o)}`, { headers: headers() }),
        async count(o) {
          const res = await doFetch(`${base}/rest/v1/${table}${buildQuery("id", { ...o, limit: 0 })}`, { headers: headers({ Prefer: "count=exact" }) });
          if (!res.ok) throw await toDbError(res);
          await res.body?.cancel();
          const n = Number((res.headers.get("content-range") ?? "").split("/")[1]);
          if (!Number.isInteger(n)) throw new DbError("PostgREST: count missing", res.status);
          return n;
        },
        async selectOne(columns = "*", o) {
          const rows = await request<T[]>(`${table}${buildQuery(columns, { ...o, limit: 1 })}`, { headers: headers() });
          return rows[0] ?? null;
        },
        insert: (rows) =>
          request<T[]>(table, {
            method: "POST",
            headers: headers({ Prefer: "return=representation" }),
            body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
          }),
        update: (values, eq) =>
          request<T[]>(`${table}${buildQuery(undefined, undefined, eq)}`, {
            method: "PATCH",
            headers: headers({ Prefer: "return=representation" }),
            body: JSON.stringify(values),
          }),
        delete: (eq) => request<void>(`${table}${buildQuery(undefined, undefined, eq)}`, { method: "DELETE", headers: headers() }),
      };
    },
    rpc: <T>(fn: string, args: Record<string, unknown> = {}) =>
      request<T>(`rpc/${fn}`, { method: "POST", headers: headers(), body: JSON.stringify(args) }),
  };
}
