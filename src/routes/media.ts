import { Hono } from "hono";
import { mediaCacheControl } from "../adapters/types";
import type { AppEnv } from "../app";

/**
 * 商品画像の配信。MEDIA_BASE_URL が Worker 自身を指す構成（既定）で使う。
 * R2 の公開バケット / カスタムドメインを MEDIA_BASE_URL にした場合はこのルートを通らない。
 * キーはランダムなので、長期キャッシュしてよい（値は置き場に付ける値と同じ、mediaCacheControl）。上書きする商品フィード（feeds/）は覚えさせない。テーマのファイル（themes/）は配らない。
 */
export const media = new Hono<AppEnv>();

media.get("/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  // テーマのファイル（themes/）はここでは配らない。テーマの JS・CSS を管理画面と同じオリジンで開かせない（docs/themes.md。資産はショップのドメインから）
  if (!key || key.includes("..") || key.startsWith("themes/")) return c.notFound();
  const storage = c.get("adapters").storage;
  const common = { "Cache-Control": mediaCacheControl(key) ?? "no-cache", "X-Content-Type-Options": "nosniff" };
  // 動画の再生（Range）。1 つの範囲（bytes=a- / bytes=a-b）だけに答え、終わりの無い範囲は RANGE_CHUNK までにする（Worker のメモリと CPU を食わない。
  // ブラウザは続きを次の Range で取りに来る）。後ろから数える範囲・複数の範囲は無視して全体を返す（HTTP では Range を無視してよい）
  const range = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(c.req.header("range") ?? "");
  if (range && storage.getRange) {
    const start = Number(range[1]);
    const want = range[2] ? Number(range[2]) : start + RANGE_CHUNK - 1;
    if (want < start) return c.body(null, 416);
    const r = await storage.getRange(key, start, Math.min(want, start + RANGE_CHUNK - 1));
    if (!r) return c.notFound();
    if (r === "unsatisfiable") return c.body(null, 416, { "Content-Range": "bytes */*" });
    return new Response(r.body, {
      status: 206,
      headers: { ...common, "Content-Type": r.contentType, "Accept-Ranges": "bytes", "Content-Range": `bytes ${r.start}-${r.end}/${r.size}`, "Content-Length": String(r.end - r.start + 1) },
    });
  }
  const obj = await storage.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: { ...common, "Content-Type": obj.contentType, ...(storage.getRange ? { "Accept-Ranges": "bytes" } : {}) },
  });
});

/** 1 回の Range の応答の上限（終わりの無い範囲を頼まれたとき） */
export const RANGE_CHUNK = 2 * 1024 * 1024;
