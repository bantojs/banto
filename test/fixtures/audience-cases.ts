/**
 * 会員の条件（0097）の答え合わせの表。同じ表を TS（src/members/audience.ts、test/audience.test.ts）と
 * 実 PostgreSQL の banto_audience_ok（test/db/audiences.test.ts）に流して、判定がずれないことを確かめる。
 * 判定を変えるときは、この表を先に直す。
 */
export interface AudienceCase {
  name: string;
  cond: unknown;
  member: boolean;
  attrs: Record<string, unknown>;
  ok: boolean;
}

const gold = { all: [{ member: true }, { attr: "rank", in: ["gold", "platinum"] }] };
const vip = { any: [{ attr: "rank", in: ["gold"] }, { attr: "points", gte: 10000 }] };

export const AUDIENCE_CASES: AudienceCase[] = [
  { name: "条件なしは誰でも", cond: null, member: false, attrs: {}, ok: true },
  { name: "会員: ゲストは偽", cond: { member: true }, member: false, attrs: {}, ok: false },
  { name: "会員: 会員は真", cond: { member: true }, member: true, attrs: {}, ok: true },
  { name: "in: 合う（大文字小文字・前後の空白を区別しない）", cond: gold, member: true, attrs: { rank: " Gold " }, ok: true },
  { name: "in: 合わない", cond: gold, member: true, attrs: { rank: "silver" }, ok: false },
  { name: "in: 値が無い", cond: gold, member: true, attrs: {}, ok: false },
  { name: "in: 数の値も文字で比べる", cond: { attr: "level", in: ["3"] }, member: true, attrs: { level: 3 }, ok: true },
  { name: "ゲストは独自項目を持たない（attr は偽）", cond: { attr: "rank", in: ["gold"] }, member: false, attrs: { rank: "gold" }, ok: false },
  { name: "gte: 境目は真", cond: { attr: "points", gte: 10000 }, member: true, attrs: { points: 10000 }, ok: true },
  { name: "gte: 足りない", cond: { attr: "points", gte: 10000 }, member: true, attrs: { points: 9999 }, ok: false },
  { name: "gte: 数の文字も数として", cond: { attr: "points", gte: 10 }, member: true, attrs: { points: "12" }, ok: true },
  { name: "gte: 指数・符号の形も数（PostgreSQL の numeric と同じ）", cond: { attr: "points", gte: 1000 }, member: true, attrs: { points: "+1.5e3" }, ok: true },
  { name: "gte: 数でない値は偽", cond: { attr: "points", gte: 10 }, member: true, attrs: { points: "abc" }, ok: false },
  { name: "lte", cond: { attr: "age", lte: 20 }, member: true, attrs: { age: 20.5 }, ok: false },
  { name: "set: 入っている", cond: { attr: "rank", set: true }, member: true, attrs: { rank: "x" }, ok: true },
  { name: "set: 空の文字は入っていない", cond: { attr: "rank", set: true }, member: true, attrs: { rank: "  " }, ok: false },
  { name: "any: どちらか", cond: vip, member: true, attrs: { rank: "silver", points: 20000 }, ok: true },
  { name: "any: どちらでもない", cond: vip, member: true, attrs: { rank: "silver", points: 5 }, ok: false },
  { name: "not: 会員で海外でない", cond: { all: [{ member: true }, { not: { attr: "region", in: ["overseas"] } }] }, member: true, attrs: { region: "jp" }, ok: true },
  { name: "not: 海外は偽", cond: { all: [{ member: true }, { not: { attr: "region", in: ["overseas"] } }] }, member: true, attrs: { region: "Overseas" }, ok: false },
  { name: "not だけ: ゲストは真（独自項目が無いので）", cond: { not: { attr: "region", in: ["overseas"] } }, member: false, attrs: {}, ok: true },
  { name: "入れ子", cond: { all: [{ member: true }, { any: [gold, { all: [{ attr: "points", gte: 100 }, { not: { attr: "rank", in: ["banned"] } }] }] }] }, member: true, attrs: { rank: "silver", points: 150 }, ok: true },
  { name: "入れ子: 除外", cond: { all: [{ member: true }, { any: [gold, { all: [{ attr: "points", gte: 100 }, { not: { attr: "rank", in: ["banned"] } }] }] }] }, member: true, attrs: { rank: "banned", points: 150 }, ok: false },
];
