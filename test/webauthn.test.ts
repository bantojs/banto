import { describe, expect, it } from "vitest";
import { WebAuthnError, decodeCbor, derToRaw, newChallenge, parseAuthData, readAssertion, sameUserHandle, userHandleOf, verifyAssertion, verifyRegistration } from "../src/members/webauthn";
import { b64u, cbor, createCredential, getAssertion, rawToDer, type Alg } from "./webauthn-authenticator";

const EXPECTED = { origin: "https://shop.example.jp", rpId: "shop.example.jp" };
const USER = userHandleOf("0b8f2c1e-7a3d-4f6b-9c2e-1d5a8b7c6e4f");

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WebAuthnError) return e.code;
    throw e;
  }
  return "ok";
}

/** 応答の response の 1 項目を書き換える */
function patch(r: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return { ...r, response: { ...(r["response"] as Record<string, unknown>), [key]: value } };
}

describe("パスキーの応答の検証（src/members/webauthn.ts）", () => {
  for (const alg of [-7, -8, -257] as Alg[]) {
    it(`登録 → ログイン（${alg === -7 ? "ES256" : alg === -8 ? "EdDSA" : "RS256"}）`, async () => {
      const ch = newChallenge();
      const { credential, response } = await createCredential(ch, USER, { ...EXPECTED, alg });
      const reg = await verifyRegistration(response, EXPECTED);
      expect(reg).toMatchObject({ challenge: ch, credentialId: b64u(credential.id), alg, signCount: 0, backedUp: false });

      const ch2 = newChallenge();
      const a = readAssertion(await getAssertion(credential, ch2, { ...EXPECTED, step: 1 }), EXPECTED);
      expect(a.challenge).toBe(ch2);
      expect(a.credentialId).toBe(reg.credentialId);
      expect(sameUserHandle(a.userHandle!, "0b8f2c1e-7a3d-4f6b-9c2e-1d5a8b7c6e4f")).toBe(true);
      expect(await verifyAssertion(a, { publicKey: reg.publicKey }, EXPECTED)).toEqual({ signCount: 1, backedUp: false });
    });
  }

  it("登録: 違うオリジン・RP ID・種類・iframe・本人確認なし・触れていない・ID の食い違いは通らない", async () => {
    const ch = newChallenge();
    const make = async (o: Partial<Parameters<typeof createCredential>[2]> = {}) => (await createCredential(ch, USER, { ...EXPECTED, ...o })).response;
    expect(await code(verifyRegistration(await make({ origin: "https://evil.example" }), EXPECTED))).toBe("origin");
    expect(await code(verifyRegistration(await make({ origin: "http://shop.example.jp" }), EXPECTED))).toBe("origin");
    expect(await code(verifyRegistration(await make({ rpId: "example.jp" }), EXPECTED))).toBe("rp_id");
    expect(await code(verifyRegistration(await make({ type: "webauthn.get" }), EXPECTED))).toBe("type");
    expect(await code(verifyRegistration(await make({ crossOrigin: true }), EXPECTED))).toBe("cross_origin");
    expect(await code(verifyRegistration(await make({ flags: 0x01 }), EXPECTED))).toBe("user_verification");
    expect(await code(verifyRegistration(await make({ flags: 0x04 }), EXPECTED))).toBe("user_presence");
    expect(await code(verifyRegistration(await make({ flags: 0x15 }), EXPECTED))).toBe("flags"); // BS だけ（BE なし）
    expect(await verifyRegistration(await make({ flags: 0x1d }), EXPECTED)).toMatchObject({ backedUp: true });
    const r = await make();
    expect(await code(verifyRegistration({ ...r, rawId: b64u(new Uint8Array(32)) }, EXPECTED))).toBe("credential_id");
    expect(await code(verifyRegistration({ ...r, type: "password" }, EXPECTED))).toBe("type");
    expect(await code(verifyRegistration(patch(r, "attestationObject", "!!"), EXPECTED))).toBe("malformed");
    // 末尾に余計なバイト
    const att = Buffer.from((r["response"] as Record<string, string>)["attestationObject"]!, "base64url");
    expect(await code(verifyRegistration(patch(r, "attestationObject", b64u(Buffer.concat([att, Buffer.from([0])]))), EXPECTED))).toBe("attestation");
  });

  it("登録: 使えない方式・弱い RSA・形の違う鍵は通らない", async () => {
    const authData = async (cose: Uint8Array) => {
      const rp = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EXPECTED.rpId)));
      const id = new Uint8Array(16).fill(7);
      return new Uint8Array([...rp, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, 16, ...id, ...cose]);
    };
    const reg = async (cose: Map<number, unknown>) => {
      const att = cbor(new Map<string, never>([["fmt", "none" as never], ["attStmt", new Map() as never], ["authData", (await authData(cbor(cose as never))) as never]]));
      const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: newChallenge(), origin: EXPECTED.origin }));
      return code(verifyRegistration({ type: "public-key", rawId: b64u(new Uint8Array(16).fill(7)), response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } }, EXPECTED));
    };
    // ES384 は使わない
    expect(await reg(new Map<number, unknown>([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]))).toBe("unsupported_alg");
    // 1024 ビットの RSA
    expect(await reg(new Map<number, unknown>([[1, 3], [3, -257], [-1, new Uint8Array(128).fill(0xff)], [-2, new Uint8Array([1, 0, 1])]]))).toBe("public_key");
    // 座標の長さが違う
    expect(await reg(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]]))).toBe("public_key");
    // 曲線の上に無い点
    expect(await reg(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]]))).toBe("public_key");
  });

  it("ログイン: 改ざん・別の鍵・違う challenge の署名・RP ID・本人確認なし・登録の応答は通らない", async () => {
    const { credential, response } = await createCredential(newChallenge(), USER, EXPECTED);
    const reg = await verifyRegistration(response, EXPECTED);
    const other = await verifyRegistration((await createCredential(newChallenge(), USER, EXPECTED)).response, EXPECTED);
    const get = async (o: Partial<Parameters<typeof getAssertion>[2]> = {}) => getAssertion(credential, newChallenge(), { ...EXPECTED, ...o });

    const good = await get();
    expect(await code(verifyAssertion(readAssertion(good, EXPECTED), { publicKey: other.publicKey }, EXPECTED))).toBe("signature");
    // authenticatorData を書き換えると署名が合わない（回数を進めた形にする）
    const ad = Buffer.from((good["response"] as Record<string, string>)["authenticatorData"]!, "base64url");
    ad[36] = 9;
    expect(await code(verifyAssertion(readAssertion(patch(good, "authenticatorData", b64u(ad)), EXPECTED), reg, EXPECTED))).toBe("signature");
    // clientDataJSON を別の challenge に差し替える
    const cd = JSON.parse(Buffer.from((good["response"] as Record<string, string>)["clientDataJSON"]!, "base64url").toString());
    cd.challenge = newChallenge();
    expect(await code(verifyAssertion(readAssertion(patch(good, "clientDataJSON", b64u(Buffer.from(JSON.stringify(cd)))), EXPECTED), reg, EXPECTED))).toBe("signature");

    expect(await code(verifyAssertion(readAssertion(await get({ rpId: "evil.example" }), EXPECTED), reg, EXPECTED))).toBe("rp_id");
    expect(await code(verifyAssertion(readAssertion(await get({ flags: 0x01 }), EXPECTED), reg, EXPECTED))).toBe("user_verification");
    expect(await code(Promise.resolve().then(() => readAssertion(response, EXPECTED)))).toBe("malformed");
    expect(await code(Promise.resolve().then(async () => readAssertion(await get({ type: "webauthn.create" }), EXPECTED)))).toBe("type");
    expect(await code(Promise.resolve().then(async () => readAssertion(await get({ origin: "https://shop.example.jp.evil.example" }), EXPECTED)))).toBe("origin");
    // 利用者の ID が返らない認証器もある
    expect(readAssertion(await get({ userHandle: null }), EXPECTED).userHandle).toBeNull();
  });

  it("DER の署名: 厳密に読む", () => {
    const raw = new Uint8Array(64).fill(0x7f);
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    const high = new Uint8Array(64).fill(0x80);
    expect(derToRaw(rawToDer(high))).toEqual(high);
    const short = new Uint8Array(64);
    short[1] = 5;
    short[33] = 6;
    expect(derToRaw(rawToDer(short))).toEqual(short);
    const der = rawToDer(raw);
    expect(() => derToRaw(new Uint8Array([...der, 0]))).toThrow(WebAuthnError);
    // 余分な先頭の 0
    expect(() => derToRaw(new Uint8Array([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]))).toThrow(WebAuthnError);
    // 負の数
    expect(() => derToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]))).toThrow(WebAuthnError);
  });

  it("CBOR: 長さ不定・浮動小数点・重複したキー・途中で切れたものは読まない", () => {
    expect(decodeCbor(cbor(new Map<number | string, never>([[1, 2 as never], ["a", new Uint8Array([1]) as never], [-3, [true, null] as never]]))).value).toEqual(
      new Map<number | string, unknown>([[1, 2], ["a", new Uint8Array([1])], [-3, [true, null]]]),
    );
    expect(() => decodeCbor(new Uint8Array([0x5f, 0x41, 0x00, 0xff]))).toThrow(WebAuthnError);
    expect(() => decodeCbor(new Uint8Array([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(WebAuthnError);
    expect(() => decodeCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(WebAuthnError);
    expect(() => decodeCbor(new Uint8Array([0x58, 0x10, 0x00]))).toThrow(WebAuthnError);
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrow(WebAuthnError);
    expect(() => parseAuthData(new Uint8Array(36))).toThrow(WebAuthnError);
  });
});
