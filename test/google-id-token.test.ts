import { describe, expect, it } from "vitest";
import { MemoryCache } from "../src/adapters/memory-cache";
import { GOOGLE_JWKS_URL, jwksTtl, rsaKeysOf } from "../src/modules/social-login/google-jwt";
import { ENDPOINTS, OAuthError, providerIdentity } from "../src/modules/social-login/providers";
import { fakeGoogleKey, type FakeGoogleKeys } from "./fake-google-jwt";

/**
 * Google の ID トークンの署名の検証（2026-11-22、多層防御）。トークンのエンドポイントと JWKS を偽の fetch で出し、
 * providerIdentity の Google の経路を通す。LINE の経路は test/members-password-line.test.ts
 */
const CLIENT = { clientId: "g-client", clientSecret: "g-secret" };
const NONCE = "nonce-1";
const NOW = 1_800_000_000;
const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: CLIENT.clientId, sub: "G1", nonce: NONCE, iat: NOW - 10, exp: NOW + 3600, email: "m@example.com", email_verified: true, ...over });

function world(keys: FakeGoogleKeys[], token: () => Promise<string>) {
  const state = { jwksCalls: 0, keys, cacheControl: "public, max-age=3600" };
  const doFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === ENDPOINTS.google.token) return Response.json({ id_token: await token() });
    if (url === GOOGLE_JWKS_URL) {
      state.jwksCalls += 1;
      return Response.json({ keys: await Promise.all(state.keys.map((k) => k.jwk())) }, { headers: { "cache-control": state.cacheControl } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const cache = new MemoryCache();
  const run = (nonce = NONCE) => providerIdentity("google", doFetch, CLIENT, { code: "c", redirectUri: "https://x/cb", verifier: "v", nonce }, NOW, cache);
  return { state, run, cache };
}
const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OAuthError);
  return (e as OAuthError).message;
};

describe("Google の ID トークンの署名（src/modules/social-login/google-jwt.ts）", () => {
  it("正しい署名なら受ける。公開鍵は覚えて、次からは取りに行かない", async () => {
    const key = await fakeGoogleKey();
    const w = world([key], () => key.sign(claims()));
    expect(await w.run()).toEqual({ sub: "G1", email: "m@example.com", emailVerified: true });
    expect(await w.run()).toMatchObject({ sub: "G1" });
    expect(w.state.jwksCalls).toBe(1);
  });

  it("改ざん・別の鍵・alg=none・HS256・知らない kid・kid なし・crit・形の崩れは断る", async () => {
    const key = await fakeGoogleKey("kid-1");
    const other = await fakeGoogleKey("kid-1");
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const good = await key.sign(claims());
    const [h, , s] = good.split(".");
    const cases: [string, () => Promise<string>][] = [
      ["中身の改ざん", async () => `${h}.${b64(claims({ sub: "ATTACKER" }))}.${s}`],
      ["別の鍵（同じ kid）", () => other.sign(claims())],
      ["alg=none", async () => `${b64({ alg: "none", kid: "kid-1" })}.${b64(claims())}.`],
      ["alg=none（署名あり）", async () => `${b64({ alg: "none", kid: "kid-1" })}.${b64(claims())}.${s}`],
      ["HS256", async () => `${b64({ alg: "HS256", kid: "kid-1" })}.${b64(claims())}.${s}`],
      ["kid なし", async () => `${b64({ alg: "RS256" })}.${b64(claims())}.${s}`],
      ["crit", () => key.sign(claims(), { crit: ["exp"] })],
      ["2 つに分かれる", async () => `${h}.${b64(claims())}`],
      ["署名でない文字", async () => `${h}.${b64(claims())}.sig!`],
    ];
    for (const [name, token] of cases) {
      const w = world([key], token);
      expect([name, await rejects(w.run())]).toEqual([name, expect.stringMatching(/^id_token /)]);
    }
  });

  it("知らない kid: 1 回だけ取り直して見つかれば受ける（鍵を回した直後）。取り直しても無ければ断る", async () => {
    const old = await fakeGoogleKey("old");
    const fresh = await fakeGoogleKey("new");
    let signer = old;
    const w = world([old], () => signer.sign(claims()));
    await w.run();
    expect(w.state.jwksCalls).toBe(1);
    // Google が鍵を回した: 覚えた鍵に新しい kid が無いので 1 回だけ取り直す
    w.state.keys = [old, fresh];
    signer = fresh;
    expect(await w.run()).toMatchObject({ sub: "G1" });
    expect(w.state.jwksCalls).toBe(2);
    // JWKS にも無い kid: 1 回だけ取りに行って断る（何度も取りに行かない）
    const stray = await fakeGoogleKey("stray");
    signer = stray;
    expect(await rejects(w.run())).toMatch(/unknown kid/);
    expect(w.state.jwksCalls).toBe(3);
  });

  it("中身: iss・aud・nonce の違い・期限切れ・発行時刻が先・未確認のアドレス", async () => {
    const key = await fakeGoogleKey();
    for (const [name, c] of [
      ["iss", claims({ iss: "https://evil.example" })],
      ["aud", claims({ aud: "other-client" })],
      ["nonce", claims({ nonce: "other" })],
      ["期限切れ", claims({ exp: NOW - 1 })],
      ["iat が先", claims({ iat: NOW + 3600 })],
      ["iat なし", claims({ iat: undefined })],
      ["sub なし", claims({ sub: "" })],
    ] as const) {
      const w = world([key], () => key.sign(c));
      expect([name, await rejects(w.run())]).toEqual([name, expect.stringMatching(/claims mismatch/)]);
    }
    // 使い回された nonce（今の流れの nonce と違う）も断る
    const w = world([key], () => key.sign(claims({ nonce: "used-before" })));
    expect(await rejects(w.run("fresh-nonce"))).toMatch(/claims mismatch/);
    // 時計のずれ 5 分までの iat は受ける。未確認のアドレスは結びつけに使わない
    const skew = world([key], () => key.sign(claims({ iat: NOW + 200, email_verified: false })));
    expect(await skew.run()).toEqual({ sub: "G1", email: "m@example.com", emailVerified: false });
  });

  it("JWKS が取れない・空なら断る（ログインはできない、ほかは止めない）", async () => {
    const key = await fakeGoogleKey();
    const w = world([], () => key.sign(claims()));
    expect(await rejects(w.run())).toMatch(/jwks empty/);
  });

  it("覚える時間は Cache-Control の max-age（60 秒〜1 日、無ければ 1 時間）。RS256・sig の RSA の鍵だけ使う", () => {
    expect(jwksTtl("public, max-age=19800, must-revalidate")).toBe(19800);
    expect(jwksTtl("max-age=5")).toBe(60);
    expect(jwksTtl("max-age=9999999")).toBe(86400);
    expect(jwksTtl(null)).toBe(3600);
    expect(
      rsaKeysOf({ keys: [{ kty: "RSA", kid: "a", n: "x", e: "AQAB" }, { kty: "RSA", kid: "b", n: "x", e: "AQAB", use: "enc" }, { kty: "RSA", kid: "c", n: "x", e: "AQAB", alg: "RS512" }, { kty: "EC", kid: "d" }] }).map((k) => k.kid),
    ).toEqual(["a"]);
  });
});
