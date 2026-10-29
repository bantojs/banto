import { describe, expect, it } from "vitest";
import { MANIFEST, QuotaError, handleRequest, plan, sweep, type Converter } from "../examples/plugin-webp/src/plugin";
import { endpointSecret, signHookPayload } from "../src/hooks/signing";
import { parseManifest } from "../src/hooks/manifest";

/** examples/plugin-webp が Banto 本体の署名・マニフェスト・画像の差し替えの API（0077）の契約どおりに動くことを確認する */
describe("外部プラグインの実例（examples/plugin-webp）", () => {
  const env = { BANTO_HOOK_SECRET: "", BANTO_API_URL: "https://shop.example/api/v1", BANTO_API_TOKEN: "banto_token", BANTO_MEDIA_URL: "https://media.example" };
  const NOW = 1_760_000_000;
  const JPG = { id: "11111111-1111-4111-8111-111111111111", storage_key: "shops/s/products/p/aaaaaaaaaaaaaaaaaaaaaaaa.jpg", thumb_key: null };
  const DONE = { id: "22222222-2222-4222-8222-222222222222", storage_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.webp", thumb_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.thumb.webp" };
  const NOTHUMB = { id: "33333333-3333-4333-8333-333333333333", storage_key: "shops/s/products/p/cccccccccccccccccccccccc.webp", thumb_key: null };
  const GIF = { id: "44444444-4444-4444-8444-444444444444", storage_key: "shops/s/products/p/dddddddddddddddddddddddd.gif", thumb_key: null };

  function world(opts: { images?: unknown[]; quota?: boolean; products?: { id: string; images: unknown[] }[] } = {}) {
    const puts: { url: string; parts: Record<string, { type: string; size: number }>; length: string | null }[] = [];
    const converts: number[] = [];
    const convert: Converter = async (bytes, { width }) => {
      if (opts.quota) throw new QuotaError();
      converts.push(width);
      return new Uint8Array(width === 400 ? 10 : 20);
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("https://media.example/")) return new Response(new Uint8Array(100));
      if (method === "GET" && /\/api\/v1\/products\?/.test(url)) {
        const items = opts.products ?? [];
        return Response.json({ items, total: items.length, limit: 50, offset: 0 });
      }
      if (method === "GET" && url.startsWith("https://shop.example/api/v1/products/")) {
        const id = decodeURIComponent(url.split("/").pop()!);
        const p = opts.products?.find((x) => x.id === id);
        return Response.json({ id, images: p ? p.images : (opts.images ?? []) });
      }
      if (method === "PUT" && url.endsWith("/file")) {
        const h = new Headers(init?.headers);
        expect(h.get("authorization")).toBe("Bearer banto_token");
        const form = await new Request("https://x/", { method: "PUT", headers: { "content-type": h.get("content-type")! }, body: init!.body as BodyInit }).formData();
        const parts: Record<string, { type: string; size: number }> = {};
        for (const [k, v] of form.entries()) if (v instanceof Blob) parts[k] = { type: v.type, size: v.size };
        puts.push({ url, parts, length: h.get("content-length") });
        return Response.json({ image_id: "x", product: {} });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    };
    return { deps: { fetch: fetchImpl, convert, now: () => NOW, seen: new Set<string>() }, puts, converts };
  }

  async function deliver(w: ReturnType<typeof world>, envelope: Record<string, unknown>, badSig = false) {
    env.BANTO_HOOK_SECRET = await endpointSecret("site-secret", "ep-webp");
    const body = JSON.stringify(envelope);
    const sig = badSig ? "t=1,v1=00" : await signHookPayload(env.BANTO_HOOK_SECRET, body, NOW);
    return handleRequest(new Request("https://plugin.example/", { method: "POST", headers: { "Content-Type": "application/json", "X-Banto-Signature": sig }, body }), env, w.deps);
  }
  const updated = (id: string) => ({ id, event: "product.updated", created_at: "", shop_id: "s", attempt: 1, data: { product_id: "p", shop_id: "s" } });

  it("GET はマニフェストを返し、Banto の parseManifest が受け付ける。購読は product.updated だけ", async () => {
    const res = await handleRequest(new Request("https://plugin.example/"), env, world().deps);
    const m = parseManifest(await res.json());
    expect(m?.events).toEqual(["product.updated"]);
    expect(MANIFEST.events).toEqual(["product.updated"]);
  });

  it("何を直すか: JPEG・PNG は両方、WebP でサムネイルが無ければサムネイルだけ、済み・GIF は飛ばす", () => {
    expect(plan(JPG)).toBe("both");
    expect(plan(NOTHUMB)).toBe("thumb");
    expect(plan(DONE)).toBe("skip");
    expect(plan(GIF)).toBe("skip");
  });

  it("product.updated: JPEG は 1600px と 400px の WebP にして PUT /images/{id}/file。WebP は本画像をそのままでサムネイルだけ。済みは触らない", async () => {
    const w = world({ images: [JPG, DONE, NOTHUMB, GIF] });
    const res = await deliver(w, updated("d-1"));
    expect(res.status).toBe(200);
    expect(w.converts).toEqual([1600, 400, 400]);
    expect(w.puts.map((p) => p.url)).toEqual([`https://shop.example/api/v1/images/${JPG.id}/file`, `https://shop.example/api/v1/images/${NOTHUMB.id}/file`]);
    expect(w.puts[0]!.parts).toEqual({ image: { type: "image/webp", size: 20 }, thumbnail: { type: "image/webp", size: 10 } });
    // WebP の本画像は取ってきたものをそのまま（100 バイト）
    expect(w.puts[1]!.parts["image"]).toEqual({ type: "image/webp", size: 100 });
    expect(Number(w.puts[0]!.length)).toBeGreaterThan(0);
    // 差し替えたあとにまた届く product.updated（もう直した画像だけ）は何もしない
    const again = world({ images: [DONE] });
    expect((await deliver(again, updated("d-2"))).status).toBe(200);
    expect(again.puts).toHaveLength(0);
  });

  it("署名が違えば 400。同じ配信 ID は二度処理しない。枠が切れたら 200 で受け取って何も置かない", async () => {
    const w = world({ images: [JPG] });
    expect((await deliver(w, updated("d-3"), true)).status).toBe(400);
    expect((await deliver(w, updated("d-3"))).status).toBe(200);
    expect((await deliver(w, updated("d-3"))).status).toBe(200);
    expect(w.puts).toHaveLength(1);
    const q = world({ images: [JPG], quota: true });
    const res = await deliver(q, updated("d-4"));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/quota/);
    expect(q.puts).toHaveLength(0);
  });

  it("見回り: 直すものがある商品だけを、1 回に決まった枚数まで直す。枠が切れたら止める", async () => {
    const products = [
      { id: "p1", images: [DONE] },
      { id: "p2", images: [JPG, { ...JPG, id: "55555555-5555-4555-8555-555555555555" }] },
      { id: "p3", images: [NOTHUMB] },
    ];
    const w = world({ products });
    expect(await sweep(env, w.deps, 2)).toEqual({ fixed: 2, quota: false });
    expect(w.puts).toHaveLength(2);
    const q = world({ products, quota: true });
    expect(await sweep(env, q.deps, 10)).toEqual({ fixed: 0, quota: true });
  });
});
