import { describe, expect, it } from "vitest";
import { AUDIENCE_CASES } from "./fixtures/audience-cases";
import { audienceAttrsOf, audienceKeys, audienceOk, describeAudience } from "../src/members/audience";

/** 会員の条件の TS の写し（0097）。正は DB の banto_audience_ok で、同じ表を test/db/audiences.test.ts が流す */
describe("audienceOk", () => {
  it("答え合わせの表（DB と同じ）", () => {
    for (const c of AUDIENCE_CASES) expect({ name: c.name, ok: audienceOk(c.cond, { member: c.member, attrs: c.attrs }) }).toEqual({ name: c.name, ok: c.ok });
  });

  it("鍵の一覧・説明・Cookie の値の読み取り", () => {
    const cond = { all: [{ member: true }, { any: [{ attr: "rank", in: ["gold", "platinum"] }, { attr: "points", gte: 10000 }] }, { not: { attr: "region", in: ["overseas"] } }] };
    expect([...audienceKeys(cond)].sort()).toEqual(["points", "rank", "region"]);
    const words = { member: "会員", and: "かつ", or: "または", not: "でない: ", set: "が入っている", anyone: "だれでも" };
    expect(describeAudience(cond, { rank: "ランク", points: "ポイント" }, words)).toBe("会員 かつ （ランク = gold / platinum または ポイント ≥ 10000） かつ でない: region = overseas");
    expect(audienceAttrsOf({ rank: "gold", points: 1, "Bad-Key": "x", obj: {} })).toEqual({ rank: "gold", points: 1 });
  });
});
