/**
 * 会員の条件（見せる相手、0097_audiences。メンテナの決定 2026-11-02、docs/audiences.md）。
 *   - 判定の正は DB の banto_audience_ok。ここは画面を描くとき（ブロックの出し分け・キャッシュの区分け）とクーポンの材料に使う写し。
 *     同じ答え合わせの表（test/fixtures/audience-cases.ts）を TS と実 PostgreSQL に流して、ずれないことを確かめる
 *   - お金と秘密（買える・単価・見せない商品やページ）は DB が判定する。ここで決めない
 */
/** 会員の条件のマイグレーション。当たるまで条件の機能は出さない（会員の Cookie にも値を入れない） */
export const AUDIENCES_MIGRATION = "0097_audiences";
/** 同梱モジュールの id（既定 OFF） */
export const AUDIENCES_MODULE = "audiences";

export type AudienceCondition =
  | { all: AudienceCondition[] }
  | { any: AudienceCondition[] }
  | { not: AudienceCondition }
  | { member: true }
  | { attr: string; in: string[] }
  | { attr: string; gte: number }
  | { attr: string; lte: number }
  | { attr: string; set: true };

/** 判定の材料: ログイン中の会員か・会員の独自項目（ゲストは {}） */
export interface AudienceContext {
  member: boolean;
  attrs: Record<string, unknown>;
}

export const GUEST: AudienceContext = { member: false, attrs: {} };

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).trim() : null);

/** 条件を満たすか（banto_audience_ok と同じ規則）。null は誰でも。形の分からないものは偽 */
export function audienceOk(cond: unknown, ctx: AudienceContext): boolean {
  if (cond === null || cond === undefined) return true;
  if (!isObj(cond)) return false;
  if (Array.isArray(cond["all"])) return cond["all"].every((c) => audienceOk(c, ctx));
  if (Array.isArray(cond["any"])) return cond["any"].some((c) => audienceOk(c, ctx));
  if ("not" in cond) return !audienceOk(cond["not"], ctx);
  if ("member" in cond) return ctx.member;
  if (typeof cond["attr"] === "string") {
    if (!ctx.member) return false;
    const v = text(ctx.attrs[cond["attr"]]);
    if (v === null || v === "") return false;
    if (cond["set"] === true) return true;
    if (Array.isArray(cond["in"])) return cond["in"].some((x) => text(x)?.toLowerCase() === v.toLowerCase());
    // PostgreSQL の numeric への読み替えと同じ形だけ（符号・小数・指数）
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return false;
    const n = Number(v);
    if (typeof cond["gte"] === "number") return n >= cond["gte"];
    if (typeof cond["lte"] === "number") return n <= cond["lte"];
  }
  return false;
}

/** 条件で使っている独自項目の鍵（管理画面の説明・Cookie に入れる値の確かめ） */
export function audienceKeys(cond: unknown, out = new Set<string>()): Set<string> {
  if (!isObj(cond)) return out;
  for (const k of ["all", "any"]) if (Array.isArray(cond[k])) for (const c of cond[k] as unknown[]) audienceKeys(c, out);
  if ("not" in cond) audienceKeys(cond["not"], out);
  if (typeof cond["attr"] === "string") out.add(cond["attr"]);
  return out;
}

/** 管理画面の短い説明（「会員 かつ（ランク が gold / platinum または ポイント ≥ 10000）」）。labels は鍵 → 表示名 */
export function describeAudience(cond: unknown, labels: Record<string, string>, words: { member: string; and: string; or: string; not: string; set: string; anyone: string }, top = true): string {
  if (cond === null || cond === undefined) return words.anyone;
  if (!isObj(cond)) return "?";
  const wrap = (s: string) => (top ? s : `（${s}）`);
  if (Array.isArray(cond["all"])) return wrap(cond["all"].map((c) => describeAudience(c, labels, words, false)).join(` ${words.and} `));
  if (Array.isArray(cond["any"])) return wrap(cond["any"].map((c) => describeAudience(c, labels, words, false)).join(` ${words.or} `));
  if ("not" in cond) return `${words.not}${describeAudience(cond["not"], labels, words, false)}`;
  if ("member" in cond) return words.member;
  if (typeof cond["attr"] === "string") {
    const name = labels[cond["attr"]] ?? cond["attr"];
    if (Array.isArray(cond["in"])) return `${name} = ${cond["in"].map(String).join(" / ")}`;
    if (typeof cond["gte"] === "number") return `${name} ≥ ${cond["gte"]}`;
    if (typeof cond["lte"] === "number") return `${name} ≤ ${cond["lte"]}`;
    if (cond["set"] === true) return `${name} ${words.set}`;
  }
  return "?";
}

/** 会員の Cookie・トークンに入れた独自項目の値（壊れた値は捨てる） */
export function audienceAttrsOf(v: unknown): Record<string, string | number | boolean> {
  if (!isObj(v)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v)) if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && (typeof x === "string" || typeof x === "number" || typeof x === "boolean")) out[k] = typeof x === "string" ? x.slice(0, 200) : x;
  return out;
}
