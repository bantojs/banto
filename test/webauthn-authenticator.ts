/**
 * テスト用の認証器（パスキー）。ブラウザ（navigator.credentials）の応答と同じ形を、WebCrypto で作る。
 * CBOR の組み立ては src/members/webauthn.ts の読み取りとは別に書く（同じ間違いを両方でしないように）。
 * 実際のブラウザの応答との突き合わせは、Chromium の仮想の認証器で一度確かめた（docs/knowledge/10-members-identity.md §18）。
 */
const subtle = crypto.subtle;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

// ---------- CBOR の組み立て ----------
type Enc = number | string | Uint8Array | boolean | null | Enc[] | Map<number | string, Enc>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cbor(v: Enc): Uint8Array {
  const out: number[] = [];
  const put = (x: Enc) => {
    if (typeof x === "number") out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === "string") {
      const b = enc.encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (x === null) out.push(0xf6);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(put);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        put(k);
        put(val);
      }
    }
  };
  put(v);
  return new Uint8Array(out);
}

// ---------- 鍵 ----------
export type Alg = -7 | -8 | -257;

async function generate(alg: Alg): Promise<CryptoKeyPair> {
  if (alg === -7) return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (alg === -8) return (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  return subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
}

async function coseKey(alg: Alg, pub: CryptoKey): Promise<Uint8Array> {
  const jwk = await subtle.exportKey("jwk", pub);
  const d = (s: string | undefined) => new Uint8Array(Buffer.from(s ?? "", "base64url"));
  if (alg === -7) return cbor(new Map<number, Enc>([[1, 2], [3, -7], [-1, 1], [-2, d(jwk.x)], [-3, d(jwk.y)]]));
  if (alg === -8) return cbor(new Map<number, Enc>([[1, 1], [3, -8], [-1, 6], [-2, d(jwk.x)]]));
  return cbor(new Map<number, Enc>([[1, 3], [3, -257], [-1, d(jwk.n)], [-2, d(jwk.e)]]));
}

/** WebCrypto の ECDSA の署名（r || s）を、認証器と同じ DER にする */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0]! & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(b)));

export interface FakeCredential {
  id: Uint8Array;
  alg: Alg;
  keys: CryptoKeyPair;
  userHandle: Uint8Array;
  counter: number;
}

export interface AuthOptions {
  origin: string;
  rpId: string;
  /** 0x05 = UP + UV（既定） */
  flags?: number;
  type?: string;
  crossOrigin?: boolean;
  /** 署名の回数を進める量（同期するパスキーは 0 のまま） */
  step?: number;
}

/** navigator.credentials.create の応答（JSON にしたもの）を作る */
export async function createCredential(challenge: string, userHandle: Uint8Array, o: AuthOptions & { alg?: Alg }): Promise<{ credential: FakeCredential; response: Record<string, unknown> }> {
  const alg = o.alg ?? -7;
  const keys = await generate(alg);
  const id = new Uint8Array(32);
  crypto.getRandomValues(id);
  const cose = await coseKey(alg, keys.publicKey);
  const counter = o.step ?? 0;
  const authData = new Uint8Array([
    ...(await sha256(enc.encode(o.rpId))),
    (o.flags ?? 0x05) | 0x40,
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
    ...new Uint8Array(16),
    id.length >> 8,
    id.length & 0xff,
    ...id,
    ...cose,
  ]);
  const clientData = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.create", challenge, origin: o.origin, crossOrigin: o.crossOrigin ?? false }));
  const attestationObject = cbor(new Map<string, Enc>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  return {
    credential: { id, alg, keys, userHandle, counter },
    response: { id: b64u(id), rawId: b64u(id), type: "public-key", response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ["internal"] } },
  };
}

/** navigator.credentials.get の応答（JSON にしたもの）を作る */
export async function getAssertion(cred: FakeCredential, challenge: string, o: AuthOptions & { userHandle?: Uint8Array | null }): Promise<Record<string, unknown>> {
  cred.counter += o.step ?? 0;
  const c = cred.counter;
  const authData = new Uint8Array([...(await sha256(enc.encode(o.rpId))), o.flags ?? 0x05, (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]);
  const clientData = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.get", challenge, origin: o.origin, crossOrigin: o.crossOrigin ?? false }));
  const signed = new Uint8Array([...authData, ...(await sha256(clientData))]);
  let sig: Uint8Array;
  if (cred.alg === -7) sig = rawToDer(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.keys.privateKey, signed)));
  else if (cred.alg === -8) sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, cred.keys.privateKey, signed));
  else sig = new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, cred.keys.privateKey, signed));
  const handle = o.userHandle === undefined ? cred.userHandle : o.userHandle;
  return {
    id: b64u(cred.id),
    rawId: b64u(cred.id),
    type: "public-key",
    response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: handle ? b64u(handle) : null },
  };
}
