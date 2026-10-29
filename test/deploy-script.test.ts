import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placementFor, withPlacement } from "../scripts/deploy.mjs";

/** デプロイの Placement（scripts/deploy.mjs、BANTO_PLACEMENT） */
describe("scripts/deploy.mjs", () => {
  it("BANTO_PLACEMENT の値: リージョン・smart・未設定。形が違えば止める", () => {
    expect(placementFor("aws:ap-northeast-1")).toEqual({ mode: "targeted", region: "aws:ap-northeast-1" });
    expect(placementFor(" smart ")).toEqual({ mode: "smart" });
    expect(placementFor(undefined)).toBeNull();
    expect(placementFor("")).toBeNull();
    expect(() => placementFor("ap-northeast-1")).toThrow(/BANTO_PLACEMENT/);
    expect(() => placementFor("aws:ap-northeast-1; rm")).toThrow(/BANTO_PLACEMENT/);
  });

  it("リポジトリの wrangler.jsonc に足すと、コメントを残したまま最上位に placement が入る。2 つ目は足さない", () => {
    const text = readFileSync("wrangler.jsonc", "utf8");
    const out = withPlacement(text, { mode: "targeted", region: "aws:ap-northeast-1" });
    expect(out).toContain('"placement": {"mode":"targeted","region":"aws:ap-northeast-1"},');
    expect(out).toContain('"name": "banto"');
    expect(out.replace(/\n {2}\/\/ scripts\/deploy\.mjs[^\n]*\n {2}"placement"[^\n]*/, "")).toBe(text);
    expect(() => withPlacement(out, { mode: "smart" })).toThrow(/もう placement/);
  });
});
