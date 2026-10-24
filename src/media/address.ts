/**
 * 外から渡された URL の行き先が「公開のインターネット」か（監査 M12）。
 * 画像の URL 取り込み（AI 用 API・WooCommerce の取り込み）が社内のアドレスへ取りに行かないように使う。
 *
 * 文字列の前方一致では判定しない（172.16/12 の抜け、`[::ffff:127.0.0.1]`、`fcbarcelona.com` のような普通の名前の誤判定があった）。
 * アドレスは数に直して範囲で比べる。IPv6 は、中に IPv4 を埋め込む形（IPv4 射影・NAT64・6to4）も中の IPv4 で判定する。
 * 名前（ドメイン）はここでは「社内でしか引けない名前」だけを断る。名前を引いた先のアドレスは、Node では
 * src/adapters/node/public-fetch.ts が接続の直前に確かめる（Workers からは社内のアドレスにそもそも届かない）。
 */

/** 4 つに区切った 10 進の IPv4（URL が正規化した形）を 32 ビットの数に。違えば null */
export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv6（角かっこなし、`::` の省略・末尾の IPv4 表記を含む）を 16 バイトに。ゾーン（%eth0）付きや形の違うものは null */
export function parseIPv6(s: string): Uint8Array | null {
  if (s.includes("%") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  let head = s;
  let v4: number | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    head = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) => (part === "" ? [] : part.split(":"));
  const left = words(halves[0]!);
  const right = halves.length === 2 ? words(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const w = all[i]!;
    if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
    const v = parseInt(w, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  if (v4 !== null) {
    out[12] = (v4 >>> 24) & 0xff;
    out[13] = (v4 >>> 16) & 0xff;
    out[14] = (v4 >>> 8) & 0xff;
    out[15] = v4 & 0xff;
  }
  return out;
}

/** 公開でない IPv4 の範囲（RFC 6890 の特別用途のうち、インターネットの宛先にならないもの） */
const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8], // この網（0.0.0.0 は手元の機械に届く）
  ["10.0.0.0", 8], // 私設
  ["100.64.0.0", 10], // キャリアの共有アドレス（CGNAT。クラウドの内部網にも使われる）
  ["127.0.0.0", 8], // 手元
  ["169.254.0.0", 16], // リンクローカル（クラウドのメタデータ 169.254.169.254）
  ["172.16.0.0", 12], // 私設（Docker の既定の網）
  ["192.0.0.0", 24], // IETF の割り当て
  ["192.0.2.0", 24], // 文書用
  ["192.88.99.0", 24], // 6to4 の中継（廃止）
  ["192.168.0.0", 16], // 私設
  ["198.18.0.0", 15], // 性能測定用
  ["198.51.100.0", 24], // 文書用
  ["203.0.113.0", 24], // 文書用
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4], // 予約・ブロードキャスト
];

const V4_RANGES = V4_BLOCKED.map(([a, bits]) => {
  const base = parseIPv4(a)!;
  const size = 2 ** (32 - bits);
  return [base, base + size - 1] as const;
});

export function isPublicIPv4(n: number): boolean {
  return !V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

const v4At = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const startsWith = (b: Uint8Array, prefix: number[]) => prefix.every((v, i) => b[i] === v);

/**
 * 公開の IPv6 か。グローバルユニキャスト（2000::/3）だけを通し、その中の特別用途と、IPv4 を埋め込む形は中の IPv4 で判定する。
 * それ以外（::、::1、ULA fc00::/7、リンクローカル fe80::/10、マルチキャストなど）は断る
 */
export function isPublicIPv6(b: Uint8Array): boolean {
  const zeros = (n: number) => b.subarray(0, n).every((x) => x === 0);
  // IPv4 射影（::ffff:a.b.c.d）・IPv4 互換（::a.b.c.d、廃止）: 中の IPv4 で
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isPublicIPv4(v4At(b, 12));
  if (zeros(12)) return false;
  // NAT64（64:ff9b::/96）: 中の IPv4 で。64:ff9b:1::/48（ローカルの NAT64）は断る
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b]) && b.subarray(4, 12).every((x) => x === 0)) return isPublicIPv4(v4At(b, 12));
  if ((b[0]! & 0xe0) !== 0x20) return false; // 2000::/3 の外
  // 6to4（2002::/16）: 中の IPv4 で
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicIPv4(v4At(b, 2));
  // 2001::/23（IETF のプロトコル用。Teredo 2001::/32 は中の IPv4 を隠して運ぶ）と 2001:db8::/32（文書用）
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! < 0x02 || (b[2] === 0x0d && b[3] === 0xb8))) return false;
  return true;
}

/** IP アドレス（IPv4 か、角かっこなしの IPv6）が公開か。アドレスでなければ false */
export function isPublicIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 !== null && isPublicIPv6(v6);
}

/** 社内でしか引けない名前の末尾（RFC 6761 / 6762 / 8375 と、クラウドの内部名） */
const INTERNAL_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "lan", "intranet", "corp", "localdomain"];

/**
 * URL のホスト名（`new URL().hostname`。IPv6 は角かっこ付き、IPv4 は 10 進に正規化済み）の行き先を分ける。
 *   public  公開のアドレス
 *   name    ドメイン名（引いた先は接続の直前に確かめる）
 *   blocked 社内のアドレス・社内でしか引けない名前・ドットの無い名前（検索ドメインで社内の名前に化ける）
 */
export function classifyHost(hostname: string): "public" | "name" | "blocked" {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = parseIPv6(h.slice(1, -1));
    return v6 !== null && isPublicIPv6(v6) ? "public" : "blocked";
  }
  const v4 = parseIPv4(h);
  if (v4 !== null) return isPublicIPv4(v4) ? "public" : "blocked";
  if (!h.includes(".") || !/^[a-z0-9.-]+$/.test(h)) return "blocked";
  if (INTERNAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return "blocked";
  return "name";
}
