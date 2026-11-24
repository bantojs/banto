import { externalHosts } from "./helpers";
import { GOOGLE_JWKS_URL } from "../src/modules/social-login/google-jwt";

/** 偽の Google の署名の鍵（RS256）。sign で ID トークンを作り、serve で JWKS を externalHosts に出す */
export interface FakeGoogleKeys {
  kid: string;
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  jwk(): Promise<Record<string, unknown>>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export async function fakeGoogleKey(kid = "kid-1"): Promise<FakeGoogleKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    kid,
    async sign(payload, header = {}) {
      const h = b64({ alg: "RS256", kid, typ: "JWT", ...header });
      const p = b64(payload);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
    },
    async jwk() {
      const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
      return { kty: "RSA", kid, n: j["n"], e: j["e"], alg: "RS256", use: "sig" };
    },
  };
}

/** JWKS を出す（keys は呼ぶたびに読み直す。calls で取りに来た回数を数える） */
export function serveGoogleJwks(keys: () => FakeGoogleKeys[], cacheControl = "public, max-age=3600"): { calls: number; dispose: () => void } {
  const state = { calls: 0, dispose: () => externalHosts.delete("https://www.googleapis.com/") };
  externalHosts.set("https://www.googleapis.com/", async (req) => {
    if (req.url !== GOOGLE_JWKS_URL) return new Response("not found", { status: 404 });
    state.calls += 1;
    return Response.json({ keys: await Promise.all(keys().map((k) => k.jwk())) }, { headers: { "cache-control": cacheControl } });
  });
  return state;
}
