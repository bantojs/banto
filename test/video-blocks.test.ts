import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { MAX_VIDEO_BYTES, sniffMp4 } from "../src/media/video";
import { parseShopBlock, shopBlockLine, shopBlocksOf } from "../src/pages/shop-blocks";
import { markdownToHtml } from "../src/pages/markdown";
import { FsStorage } from "../src/adapters/node";
import { S3Storage } from "../src/adapters/node/s3";
import { RANGE_CHUNK } from "../src/routes/media";

/** 本文の短い動画（`::: video`、src/media/video.ts）と、/media/ の Range（動画の再生に要る） */

const SHOP = "11111111-2222-4333-8444-555555555555";
/** ftyp の箱（大きさ 24・主ブランド・版・互換ブランド 2 つ）+ 中身 */
function mp4(major = "isom", compat = ["isom", "mp41"], extra = 64): Uint8Array {
  const head = new Uint8Array(8 + 8 + compat.length * 4);
  new DataView(head.buffer).setUint32(0, head.length);
  head.set(new TextEncoder().encode(`ftyp${major}`), 4);
  compat.forEach((c, i) => head.set(new TextEncoder().encode(c), 16 + i * 4));
  const out = new Uint8Array(head.length + extra);
  out.set(head);
  return out;
}

describe("mp4 の見分け", () => {
  it("mp4 のブランドだけ。mov・AVIF・HEIF・ほかの形は受けない", () => {
    expect(sniffMp4(mp4())).toBe(true);
    expect(sniffMp4(mp4("mp42", ["mp42", "avc1"]))).toBe(true);
    expect(sniffMp4(mp4("qt  ", ["qt  "]))).toBe(false);
    expect(sniffMp4(mp4("avif", ["mif1", "avif"]))).toBe(false);
    expect(sniffMp4(mp4("heic", ["mif1", "heic"]))).toBe(false);
    expect(sniffMp4(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBe(false);
  });
});

describe("動画のブロック", () => {
  const src = `/media/pages/${SHOP}/abc_DEF-1.mp4`;
  it("置き場の mp4 だけを受ける（ほかの形・ほかのホストは文字のまま / 描かない）", () => {
    const b = parseShopBlock(`::: video src="${src}" poster="/media/pages/${SHOP}/p.webp" autoplay=1 loop=1 controls=0`)!;
    expect(b.attrs).toEqual({ src, poster: `/media/pages/${SHOP}/p.webp`, autoplay: "1", loop: "1", controls: "0" });
    expect(shopBlockLine(b)).toBe(`::: video src="${src}" poster="/media/pages/${SHOP}/p.webp" autoplay=1 loop=1 controls=0`);
    expect(shopBlockLine(parseShopBlock(`::: video src="${src}"`)!)).toBe(`::: video src="${src}"`);
    expect(parseShopBlock(`::: video src="/media/pages/${SHOP}/x.mov"`)).toBeNull();
    expect(parseShopBlock(`::: video src="/media/themes/${SHOP}/x.mp4"`)).toBeNull();
    expect(parseShopBlock(`::: video src="javascript:alert(1)//x.mp4"`)).toBeNull();
    expect(shopBlocksOf(`::: video src="${src}"`)).toEqual([]);
    // 形は合っても、ほかのホストの置き場は描かない
    expect(markdownToHtml(`::: video src="https://evil.example/pages/${SHOP}/x.mp4"`, { mediaBase: "https://media.example.jp" })).not.toContain("<video");
  });

  it("お店の画面: 自動で再生するときは音を消し、iPhone で全画面にしない。編集の画面は再生しない", () => {
    const html = markdownToHtml(`::: video src="https://media.example.jp/pages/${SHOP}/a.mp4" autoplay=1 loop=1 controls=0`, { mediaBase: "https://media.example.jp" });
    expect(html).toContain(`<video src="https://media.example.jp/pages/${SHOP}/a.mp4" preload="metadata" playsinline autoplay muted loop></video>`);
    expect(markdownToHtml(`::: video src="${src}"`, { mediaBase: "https://m" })).toContain(`<video src="${src}" preload="metadata" playsinline controls></video>`);
    const ed = markdownToHtml(`::: video src="${src}" autoplay=1`, { mediaBase: "https://m", editor: true });
    expect(ed).toContain('data-kind="video"');
    expect(ed).not.toContain(" autoplay");
  });

  it("置く: mp4 だけ・20MB まで。置き場の pages/<ショップ>/ に video/mp4 で", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } }, id: SHOP });
    const storage = new MemoryStorage(`${BASE}/media`);
    const app = appWith(sb, {}, storage);
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/pages`;
    const ok = await b.postMultipart(`${base}/videos`, { file: new File([mp4() as BlobPart], "a.mp4", { type: "video/mp4" }) }, { headers: { accept: "application/json" } });
    expect(ok.status).toBe(200);
    const { url } = (await ok.json()) as { url: string };
    expect(url).toMatch(new RegExp(`/media/pages/${shop.id}/[A-Za-z0-9_-]+\\.mp4$`));
    const key = url.replace(`${BASE}/media/`, "");
    expect(storage.objects.get(key)?.contentType).toBe("video/mp4");
    // 申告の種類を偽っても中身で断る
    expect((await b.postMultipart(`${base}/videos`, { file: new File(["<html></html>"], "a.mp4", { type: "video/mp4" }) }, { headers: { accept: "application/json" } })).status).toBe(400);
    expect((await b.postMultipart(`${base}/videos`, { file: new File([mp4("isom", ["isom"], MAX_VIDEO_BYTES) as BlobPart], "big.mp4", { type: "video/mp4" }) }, { headers: { accept: "application/json" } })).status).toBe(413);
    // 本文に置くと、お店の画面に出る
    sb.addPage(shop.id, { handle: "movie", title: "動画", body: `::: video src="${url}"` });
    expect(await (await new Browser(app, BASE).get("/my-shop/pages/movie")).text()).toContain(`<video src="${url}"`);
  });
});

describe("/media/ の Range", () => {
  it("1 つの範囲に 206 で答え、終わりの無い範囲は RANGE_CHUNK まで。外なら 416。Range が無ければ全体", async () => {
    const storage = new MemoryStorage(`${BASE}/media`);
    const big = new Uint8Array(RANGE_CHUNK + 1000).map((_, i) => i % 251);
    await storage.put("pages/x/v.mp4", big.buffer, "video/mp4");
    const app = appWith(new FakeSupabase(), {}, storage);
    const get = (range?: string) => app.request(`${BASE}/media/pages/x/v.mp4`, range ? { headers: { range } } : {});
    const r1 = await get("bytes=0-1");
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe(`bytes 0-1/${big.length}`);
    expect([...new Uint8Array(await r1.arrayBuffer())]).toEqual([0, 1]);
    const r2 = await get("bytes=10-");
    expect(r2.status).toBe(206);
    expect(r2.headers.get("content-range")).toBe(`bytes 10-${10 + RANGE_CHUNK - 1}/${big.length}`);
    expect((await r2.arrayBuffer()).byteLength).toBe(RANGE_CHUNK);
    expect((await get(`bytes=${big.length}-`)).status).toBe(416);
    const all = await get();
    expect(all.status).toBe(200);
    expect(all.headers.get("accept-ranges")).toBe("bytes");
    expect((await all.arrayBuffer()).byteLength).toBe(big.length);
    // 後ろから数える範囲は無視して全体
    expect((await get("bytes=-10")).status).toBe(200);
  });

  it("FsStorage と S3Storage の getRange", async () => {
    const dir = await mkdtemp(join(tmpdir(), "banto-range-"));
    try {
      const fs = new FsStorage(dir, "https://m");
      await fs.put("a/b.mp4", new Uint8Array([1, 2, 3, 4, 5]).buffer, "video/mp4");
      const r = await fs.getRange("a/b.mp4", 1, 10);
      expect(r).toMatchObject({ start: 1, end: 4, size: 5, contentType: "video/mp4" });
      expect([...new Uint8Array(await new Response((r as { body: ReadableStream }).body).arrayBuffer())]).toEqual([2, 3, 4, 5]);
      expect(await fs.getRange("a/b.mp4", 5, null)).toBe("unsatisfiable");
      expect(await fs.getRange("a/none.mp4", 0, null)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const seen: string[] = [];
    const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["range"]));
      return new Response(new Uint8Array([7, 8]), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 3-4/10" } });
    }) as typeof fetch;
    const s3 = new S3Storage({ endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://m", fetch: fake });
    expect(await s3.getRange("k.mp4", 3, 4)).toMatchObject({ start: 3, end: 4, size: 10 });
    expect(seen).toEqual(["bytes=3-4"]);
  });
});
