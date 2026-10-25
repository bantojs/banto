/**
 * 外部の応答の本文を、上限のバイト数まで数えながら読む（Content-Length を信じない。2026-10-25 の監査）。
 * 上限を超えた分は捨てる（切り詰めた文字列を返す）。本文が無ければ ""
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const room = maxBytes - total;
      if (room <= 0) break;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      total += Math.min(value.length, room);
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(out);
}
