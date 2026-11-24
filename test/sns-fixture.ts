/**
 * テスト用の Amazon SNS の署名つきの封筒。RSA の鍵と、その公開鍵を入れた最小の X.509 証明書（DER を手で組む）を作り、
 * externalHosts で SNS の証明書の URL から配る。
 */
import { externalHosts } from "./helpers";
import { snsStringToSign } from "../src/payments/sns";

export const SNS_CERT_URL = "https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-test.pem";
export const SNS_TEST_ACCOUNT = "000000000000";
export const SNS_TEST_TOPIC = `arn:aws:sns:ap-northeast-1:${SNS_TEST_ACCOUNT}:amazon-pay-ipn`;
const CERT_ORIGIN = "https://sns.ap-northeast-1.amazonaws.com/";

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | out.length, ...out];
}
function tlv(tag: number, body: Uint8Array | number[]): Uint8Array {
  const b = body instanceof Uint8Array ? Array.from(body) : body;
  return new Uint8Array([tag, ...len(b.length), ...b]);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** 公開鍵（SPKI）を入れた最小の証明書（version あり・なしを選べる） */
export function minimalCertPem(spki: Uint8Array, withVersion = true): string {
  const alg = tlv(0x30, cat(tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), tlv(0x05, [])));
  const parts = [
    ...(withVersion ? [tlv(0xa0, tlv(0x02, [2]))] : []),
    tlv(0x02, [1]),
    alg,
    tlv(0x30, []),
    tlv(0x30, []),
    tlv(0x30, []),
    spki,
  ];
  const tbs = tlv(0x30, cat(...parts));
  const cert = tlv(0x30, cat(tbs, alg, tlv(0x03, [0, 1, 2, 3])));
  const body = b64(cert).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export interface SnsSigner {
  pem: string;
  /** 証明書を取りに来た回数 */
  fetches: number;
  /** 封筒を作って署名する（上書きで Timestamp・SigningCertURL などを変えられる） */
  envelope(message: unknown, opts?: { version?: "1" | "2"; overrides?: Record<string, unknown>; tamper?: (m: Record<string, unknown>) => void }): Promise<string>;
  /** externalHosts に証明書の配り先を入れる（afterEach で消えるので、使うテストの中で呼ぶ） */
  serve(): void;
}

export async function snsSigner(): Promise<SnsSigner> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const sha1Key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const signer: SnsSigner = {
    pem: minimalCertPem(spki),
    fetches: 0,
    async envelope(message, opts = {}) {
      const version = opts.version ?? "2";
      const m: Record<string, unknown> = {
        Type: "Notification",
        MessageId: crypto.randomUUID(),
        TopicArn: SNS_TEST_TOPIC,
        Message: typeof message === "string" ? message : JSON.stringify(message),
        Timestamp: new Date().toISOString(),
        SignatureVersion: version,
        SigningCertURL: SNS_CERT_URL,
        ...opts.overrides,
      };
      const toSign = snsStringToSign(m);
      if (toSign === null) throw new Error("cannot sign");
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", version === "1" ? sha1Key : pair.privateKey, new TextEncoder().encode(toSign)));
      m["Signature"] = b64(sig);
      opts.tamper?.(m);
      return JSON.stringify(m);
    },
    serve() {
      externalHosts.set(CERT_ORIGIN, () => {
        signer.fetches++;
        return new Response(signer.pem, { status: 200, headers: { "content-type": "application/x-pem-file" } });
      });
    },
  };
  return signer;
}
