import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bucketNameFor, observabilityOff, placementFor, withBucket, withWorkerName, withoutObservability, withPlacement, workerNameFor } from "../scripts/deploy.mjs";

/** デプロイの設定（scripts/deploy.mjs、BANTO_PLACEMENT・BANTO_OBSERVABILITY） */
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

  it("ログは wrangler.jsonc で既定 ON。BANTO_OBSERVABILITY=off の写しだけ切る", () => {
    expect(observabilityOff(undefined)).toBe(false);
    expect(observabilityOff("on")).toBe(false);
    expect(observabilityOff(" OFF ")).toBe(true);
    expect(() => observabilityOff("no")).toThrow(/BANTO_OBSERVABILITY/);
    const text = readFileSync("wrangler.jsonc", "utf8");
    expect(text).toMatch(/^ {2}"observability": \{ "enabled": true, "issues": \{ "enabled": true \} \},$/m);
    const out = withoutObservability(withPlacement(text, { mode: "smart" }));
    expect(out).toContain('"observability": { "enabled": false },');
    expect(out).toContain('"placement": {"mode":"smart"},');
    expect(() => withoutObservability(out)).toThrow(/observability/);
  });

  it("同じアカウントに 2 つ目を立てる: Worker 名と R2 のバケット名だけを変える（ほかの行はそのまま）。形が違えば止める", () => {
    expect(workerNameFor(undefined)).toBeNull();
    expect(workerNameFor(" banto-shop2 ")).toBe("banto-shop2");
    expect(() => workerNameFor("Banto")).toThrow(/BANTO_WORKER_NAME/);
    expect(() => workerNameFor("banto-")).toThrow(/BANTO_WORKER_NAME/);
    expect(() => workerNameFor(`b${"a".repeat(63)}`)).toThrow(/BANTO_WORKER_NAME/);
    expect(bucketNameFor("", "BANTO_MEDIA_BUCKET")).toBeNull();
    expect(bucketNameFor("banto-shop2-media", "BANTO_MEDIA_BUCKET")).toBe("banto-shop2-media");
    expect(() => bucketNameFor("ab", "BANTO_MEDIA_BUCKET")).toThrow(/BANTO_MEDIA_BUCKET/);
    expect(() => bucketNameFor("x_y", "BANTO_PRIVATE_BUCKET")).toThrow(/BANTO_PRIVATE_BUCKET/);
    const text = readFileSync("wrangler.jsonc", "utf8");
    const out = withBucket(withBucket(withWorkerName(withPlacement(text, { mode: "smart" }), "banto-shop2"), "MEDIA", "banto-shop2-media"), "PRIVATE", "banto-shop2-private");
    expect(out).toMatch(/^ {2}"name": "banto-shop2",$/m);
    expect(out).toContain('{ "binding": "MEDIA", "bucket_name": "banto-shop2-media" }');
    expect(out).toContain('{ "binding": "PRIVATE", "bucket_name": "banto-shop2-private" }');
    expect(out).toContain('"$schema"');
    const back = withBucket(withBucket(withWorkerName(out, "banto"), "MEDIA", "banto-media"), "PRIVATE", "banto-private");
    expect(back).toBe(withPlacement(text, { mode: "smart" }));
    expect(() => withBucket(text, "NOPE", "x-y-z")).toThrow(/NOPE/);
  });
});
