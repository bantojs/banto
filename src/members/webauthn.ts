/**
 * パスキー（WebAuthn）の応答を確かめる（同梱モジュール passkey、0046_mod_passkey、docs/knowledge/10-members-identity.md §18）。
 * WebCrypto だけを使い、ランタイムに依存しない（Workers と Node の両方で動く）。外部のライブラリは使わない。
 *
 * ここで確かめること（W3C Web Authentication Level 3 §7.1 / §7.2 の手順のうち、Banto に要るもの）:
 *   - clientDataJSON の type・challenge・origin（ショップのドメインの https のオリジンだけ）、crossOrigin でないこと
 *   - authenticatorData の rpIdHash（= SHA-256(ショップのドメイン)）、UP（触れた）と UV（本人確認した）のフラグ
 *   - 登録: 公開鍵（COSE）の形と、使える署名の方式（ES256 / EdDSA / RS256）。認証器の証明（attestation）は求めない（"none"）
 *   - ログイン: 保存した公開鍵で authenticatorData || SHA-256(clientDataJSON) の署名
 * challenge が 1 回限りか・期限内か・誰のものかは DB の関数（0046）が確かめる。ここでは比べるための値を返すだけ。
 * 署名の回数（signCount）が戻っていないかも DB の関数が確かめる。
 */
import { b64url, fromB64url } from "../util/signed";

export class WebAuthnError extends Error {
  constructor(readonly code: string) {
    super(`webauthn: ${code}`);
  }
}

/** 使える署名の方式（COSE のアルゴリズム番号）。登録のときに認証器へ渡す順（ES256 がいちばん広く使われる） */
export const COSE_ALGS = [-7, -8, -257] as const;
export type CoseAlg = (typeof COSE_ALGS)[number];

const enc = new TextEncoder();
const MAX_CLIENT_DATA = 4096;
const MAX_ATTESTATION = 64 * 1024;

export function b64urlDecode(s: unknown, max = MAX_ATTESTATION): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== "string" || s.length === 0 || s.length > Math.ceil((max * 4) / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return fromB64url(s);
  } catch {
    return null;
  }
}

export const b64urlEncode = (bytes: ArrayBuffer | Uint8Array): string => b64url(bytes);

// ---------- CBOR（RFC 8949 の必要な部分だけ。長さ不定・浮動小数点・タグは受け付けない） ----------
export type CborValue = number | string | boolean | null | undefined | Uint8Array | CborValue[] | Map<number | string, CborValue>;

/** offset から 1 つ読み、値と読み終えた位置を返す */
export function decodeCbor(bytes: Uint8Array, offset = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > 16) throw new WebAuthnError("cbor_depth");
  const need = (n: number) => {
    if (offset + n > bytes.length) throw new WebAuthnError("cbor_truncated");
  };
  need(1);
  const head = bytes[offset++]!;
  const major = head >> 5;
  const info = head & 0x1f;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) {
    need(1);
    len = bytes[offset]!;
    offset += 1;
  } else if (info === 25) {
    need(2);
    len = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
  } else if (info === 26) {
    need(4);
    len = ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
    offset += 4;
  } else if (info === 27 && (major === 0 || major === 1)) {
    need(8);
    const hi = ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
    const lo = ((bytes[offset + 4]! << 24) >>> 0) + (bytes[offset + 5]! << 16) + (bytes[offset + 6]! << 8) + bytes[offset + 7]!;
    if (hi > 0x1fffff) throw new WebAuthnError("cbor_int");
    len = hi * 0x1_0000_0000 + lo;
    offset += 8;
  } else throw new WebAuthnError("cbor_unsupported");

  switch (major) {
    case 0:
      return { value: len, end: offset };
    case 1:
      return { value: -1 - len, end: offset };
    case 2:
      need(len);
      return { value: bytes.slice(offset, offset + len), end: offset + len };
    case 3: {
      need(len);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + len));
      } catch {
        throw new WebAuthnError("cbor_text");
      }
      return { value: text, end: offset + len };
    }
    case 4: {
      if (len > 1024) throw new WebAuthnError("cbor_size");
      const out: CborValue[] = [];
      for (let i = 0; i < len; i++) {
        const r = decodeCbor(bytes, offset, depth + 1);
        out.push(r.value);
        offset = r.end;
      }
      return { value: out, end: offset };
    }
    case 5: {
      if (len > 256) throw new WebAuthnError("cbor_size");
      const out = new Map<number | string, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(bytes, offset, depth + 1);
        if (typeof k.value !== "number" && typeof k.value !== "string") throw new WebAuthnError("cbor_key");
        if (out.has(k.value)) throw new WebAuthnError("cbor_duplicate_key");
        const v = decodeCbor(bytes, k.end, depth + 1);
        out.set(k.value, v.value);
        offset = v.end;
      }
      return { value: out, end: offset };
    }
    case 7:
      if (info === 20) return { value: false, end: offset };
      if (info === 21) return { value: true, end: offset };
      if (info === 22) return { value: null, end: offset };
      if (info === 23) return { value: undefined, end: offset };
      throw new WebAuthnError("cbor_unsupported");
    default:
      throw new WebAuthnError("cbor_unsupported");
  }
}

// ---------- authenticatorData（§6.1） ----------
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credential?: { id: Uint8Array; publicKey: Uint8Array; cose: Map<number | string, CborValue> };
}

export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new WebAuthnError("auth_data");
  const flags = bytes[32]!;
  const signCount = ((bytes[33]! << 24) >>> 0) + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!;
  let offset = 37;
  let credential: AuthData["credential"];
  if (flags & FLAG_AT) {
    if (bytes.length < offset + 18) throw new WebAuthnError("auth_data");
    offset += 16; // AAGUID（認証器の機種。証明を求めないので使わない）
    const idLen = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    if (idLen < 16 || idLen > 1023 || bytes.length < offset + idLen) throw new WebAuthnError("credential_id");
    const id = bytes.slice(offset, offset + idLen);
    offset += idLen;
    const key = decodeCbor(bytes, offset);
    if (!(key.value instanceof Map)) throw new WebAuthnError("public_key");
    credential = { id, publicKey: bytes.slice(offset, key.end), cose: key.value };
    offset = key.end;
  }
  if (flags & FLAG_ED) offset = decodeCbor(bytes, offset).end;
  if (offset !== bytes.length) throw new WebAuthnError("auth_data_trailing");
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, ...(credential ? { credential } : {}) };
}

// ---------- 公開鍵（COSE_Key、RFC 9053） ----------
interface VerifyKey {
  alg: CoseAlg;
  key: CryptoKey;
}

function coseBytes(m: Map<number | string, CborValue>, k: number, len?: number): string {
  const v = m.get(k);
  if (!(v instanceof Uint8Array) || (len !== undefined && v.length !== len)) throw new WebAuthnError("public_key");
  return b64url(v);
}

/** COSE の公開鍵を WebCrypto の鍵にする。形が違う・使えない方式なら WebAuthnError */
export async function importCoseKey(cose: Map<number | string, CborValue>): Promise<VerifyKey> {
  const kty = cose.get(1);
  const alg = cose.get(3);
  try {
    if (alg === -7 && kty === 2 && cose.get(-1) === 1) {
      const jwk = { kty: "EC", crv: "P-256", x: coseBytes(cose, -2, 32), y: coseBytes(cose, -3, 32), ext: true };
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) };
    }
    if (alg === -8 && kty === 1 && cose.get(-1) === 6) {
      const jwk = { kty: "OKP", crv: "Ed25519", x: coseBytes(cose, -2, 32), ext: true };
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]) };
    }
    if (alg === -257 && kty === 3) {
      const n = cose.get(-1);
      // 2048 ビット未満の RSA は受け付けない
      if (!(n instanceof Uint8Array) || n.length < 256 || n.length > 1024) throw new WebAuthnError("public_key");
      const jwk = { kty: "RSA", n: b64url(n), e: coseBytes(cose, -2), alg: "RS256", ext: true };
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]) };
    }
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError("public_key");
  }
  throw new WebAuthnError("unsupported_alg");
}

/**
 * ECDSA の署名（DER の SEQUENCE { INTEGER r, INTEGER s }）を WebCrypto の形（r || s、各 32 バイト）にする。
 * 長さの形式・先頭の 0・余りのバイトを厳密に確かめる
 */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  const fail = () => new WebAuthnError("signature");
  if (der.length < 8 || der[0] !== 0x30 || der[1]! >= 0x80 || der[1] !== der.length - 2) throw fail();
  let offset = 2;
  const out = new Uint8Array(new ArrayBuffer(size * 2));
  for (let i = 0; i < 2; i++) {
    if (der[offset] !== 0x02) throw fail();
    const len = der[offset + 1]!;
    offset += 2;
    if (len === 0 || len > size + 1 || offset + len > der.length) throw fail();
    let v = der.subarray(offset, offset + len);
    offset += len;
    // 負の数は無い。余分な先頭の 0 は 1 つだけ（次のバイトの最上位ビットが立っているとき）
    if (v[0]! & 0x80) throw fail();
    if (v[0] === 0 && v.length > 1) {
      if (!(v[1]! & 0x80)) throw fail();
      v = v.subarray(1);
    }
    if (v.length > size) throw fail();
    out.set(v, i * size + (size - v.length));
  }
  if (offset !== der.length) throw fail();
  return out;
}

async function verifySignature(k: VerifyKey, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    if (k.alg === -7) return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.key, derToRaw(signature), data);
    if (k.alg === -8) return await crypto.subtle.verify({ name: "Ed25519" }, k.key, signature, data);
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, k.key, signature, data);
  } catch {
    return false;
  }
}

// ---------- clientDataJSON（§5.8.1） ----------
interface ClientData {
  challenge: string;
}

function parseClientData(raw: Uint8Array, type: "webauthn.create" | "webauthn.get", origin: string): ClientData {
  if (raw.length > MAX_CLIENT_DATA) throw new WebAuthnError("client_data");
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new WebAuthnError("client_data");
  }
  if (!v || typeof v !== "object") throw new WebAuthnError("client_data");
  const o = v as Record<string, unknown>;
  if (o["type"] !== type) throw new WebAuthnError("type");
  if (typeof o["challenge"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(o["challenge"])) throw new WebAuthnError("challenge");
  if (o["origin"] !== origin) throw new WebAuthnError("origin");
  // iframe の中からの呼び出しは受け付けない（ショップのページの上で直接）
  if (o["crossOrigin"] === true) throw new WebAuthnError("cross_origin");
  return { challenge: o["challenge"] };
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

async function checkAuthData(auth: AuthData, rpId: string): Promise<void> {
  if (!sameBytes(auth.rpIdHash, await sha256(enc.encode(rpId)))) throw new WebAuthnError("rp_id");
  if (!(auth.flags & FLAG_UP)) throw new WebAuthnError("user_presence");
  if (!(auth.flags & FLAG_UV)) throw new WebAuthnError("user_verification");
  // BS（同期済み）は BE（同期できる）が無ければ立たない
  if (auth.flags & FLAG_BS && !(auth.flags & FLAG_BE)) throw new WebAuthnError("flags");
}

/** 32 バイトの challenge（base64url）。DB には HMAC だけを置く */
export function newChallenge(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b64url(b);
}

export interface Expected {
  /** ショップのドメインの https のオリジン（https://shop.example.jp） */
  origin: string;
  /** RP ID = ショップのドメイン */
  rpId: string;
}

export interface RegistrationResult {
  /** clientDataJSON に入っていた challenge（DB で照合する） */
  challenge: string;
  credentialId: string;
  /** COSE の公開鍵（base64url）。ログインのときに importCoseKey で戻す */
  publicKey: string;
  alg: CoseAlg;
  signCount: number;
  backedUp: boolean;
}

/** 登録（navigator.credentials.create の応答）を確かめる */
export async function verifyRegistration(body: unknown, expected: Expected): Promise<RegistrationResult> {
  const cred = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const res = (cred["response"] && typeof cred["response"] === "object" ? cred["response"] : {}) as Record<string, unknown>;
  if (cred["type"] !== "public-key") throw new WebAuthnError("type");
  const clientDataJSON = b64urlDecode(res["clientDataJSON"], MAX_CLIENT_DATA);
  const attestation = b64urlDecode(res["attestationObject"]);
  const rawId = b64urlDecode(cred["rawId"], 1023);
  if (!clientDataJSON || !attestation || !rawId) throw new WebAuthnError("malformed");
  const client = parseClientData(clientDataJSON, "webauthn.create", expected.origin);
  const att = decodeCbor(attestation);
  if (att.end !== attestation.length || !(att.value instanceof Map)) throw new WebAuthnError("attestation");
  const authData = att.value.get("authData");
  if (typeof att.value.get("fmt") !== "string" || !(authData instanceof Uint8Array)) throw new WebAuthnError("attestation");
  const auth = parseAuthData(authData);
  await checkAuthData(auth, expected.rpId);
  if (!auth.credential) throw new WebAuthnError("credential_missing");
  if (!sameBytes(auth.credential.id, rawId)) throw new WebAuthnError("credential_id");
  const key = await importCoseKey(auth.credential.cose);
  return {
    challenge: client.challenge,
    credentialId: b64url(auth.credential.id),
    publicKey: b64url(auth.credential.publicKey),
    alg: key.alg,
    signCount: auth.signCount,
    backedUp: Boolean(auth.flags & FLAG_BS),
  };
}

export interface AssertionInput {
  credentialId: string;
  /** clientDataJSON に入っていた challenge（DB で照合する） */
  challenge: string;
  /** 認証器が返した利用者の ID（会員 ID の 16 バイト）。返らないこともある */
  userHandle: Uint8Array<ArrayBuffer> | null;
  clientDataJSON: Uint8Array<ArrayBuffer>;
  authenticatorData: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/** ログイン（navigator.credentials.get の応答）の形と clientDataJSON を読む。署名は保存した鍵を引いてから verifyAssertion で確かめる */
export function readAssertion(body: unknown, expected: Expected): AssertionInput {
  const cred = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const res = (cred["response"] && typeof cred["response"] === "object" ? cred["response"] : {}) as Record<string, unknown>;
  if (cred["type"] !== "public-key") throw new WebAuthnError("type");
  const rawId = b64urlDecode(cred["rawId"], 1023);
  const clientDataJSON = b64urlDecode(res["clientDataJSON"], MAX_CLIENT_DATA);
  const authenticatorData = b64urlDecode(res["authenticatorData"], 2048);
  const signature = b64urlDecode(res["signature"], 1024);
  const userHandle = res["userHandle"] === null || res["userHandle"] === undefined ? null : b64urlDecode(res["userHandle"], 64);
  if (!rawId || !clientDataJSON || !authenticatorData || !signature || (res["userHandle"] != null && !userHandle)) throw new WebAuthnError("malformed");
  const client = parseClientData(clientDataJSON, "webauthn.get", expected.origin);
  return { credentialId: b64url(rawId), challenge: client.challenge, userHandle, clientDataJSON, authenticatorData, signature };
}

/** 保存した公開鍵で署名を確かめる。戻り値は認証器の署名の回数と同期済みか */
export async function verifyAssertion(a: AssertionInput, stored: { publicKey: string }, expected: Expected): Promise<{ signCount: number; backedUp: boolean }> {
  const auth = parseAuthData(a.authenticatorData);
  await checkAuthData(auth, expected.rpId);
  if (auth.credential) throw new WebAuthnError("auth_data");
  const coseBytesRaw = b64urlDecode(stored.publicKey);
  if (!coseBytesRaw) throw new WebAuthnError("public_key");
  const cose = decodeCbor(coseBytesRaw);
  if (!(cose.value instanceof Map) || cose.end !== coseBytesRaw.length) throw new WebAuthnError("public_key");
  const key = await importCoseKey(cose.value);
  const signed = new Uint8Array(new ArrayBuffer(a.authenticatorData.length + 32));
  signed.set(a.authenticatorData, 0);
  signed.set(await sha256(a.clientDataJSON), a.authenticatorData.length);
  if (!(await verifySignature(key, a.signature, signed))) throw new WebAuthnError("signature");
  return { signCount: auth.signCount, backedUp: Boolean(auth.flags & FLAG_BS) };
}

/** 会員 ID（UUID）を WebAuthn の user.id（16 バイト）にする。個人情報は入れない */
export function userHandleOf(customerId: string): Uint8Array<ArrayBuffer> {
  const hex = customerId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new WebAuthnError("user_handle");
  const out = new Uint8Array(new ArrayBuffer(16));
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sameUserHandle(a: Uint8Array, customerId: string): boolean {
  return sameBytes(a, userHandleOf(customerId));
}
