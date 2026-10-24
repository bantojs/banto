import { Hono } from "hono";
import type { AppEnv } from "../app";

/**
 * 商品画像の配信。MEDIA_BASE_URL が Worker 自身を指す構成（既定）で使う。
 * R2 の公開バケット / カスタムドメインを MEDIA_BASE_URL にした場合はこのルートを通らない。
 * キーはランダムなので、長期キャッシュしてよい。
 */
export const media = new Hono<AppEnv>();

media.get("/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  if (!key || key.includes("..")) return c.notFound();
  const obj = await c.get("adapters").storage.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
