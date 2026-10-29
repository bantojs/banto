import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith, externalHosts, tinyPng } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { imageSize, sniffImage } from "../src/media/images";
import { ImageFetchError, fetchImage } from "../src/media/fetch-image";

/**
 * 商品画像のファイルを送る API（0037）と、画像の中身の検査（sniffImage / imageSize）、URL からの取得（fetchImage）。
 * キーの形・他のショップの商品は test/db/api-image-upload.test.ts（実 PostgreSQL）。
 */
afterEach(() => externalHosts.clear());

const bytes = (...parts: (number[] | string)[]): Uint8Array<ArrayBuffer> => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
// 幅 640・高さ 480 の見出しだけを持つ各形式
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0], [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03], new Array(20).fill(0));
const GIF = bytes("GIF89a", [0x80, 0x02, 0xe0, 0x01], new Array(10).fill(0));
const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0, 0, 0, 0, 0], [0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
const AVIF = bytes([0, 0, 0, 0x1c], "ftypmif1", [0, 0, 0, 0], "mif1avifmiaf", new Array(8).fill(0));
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("画像の中身の検査", () => {
  it("先頭のバイトで種類を決める。SVG・HTML・壊れた見出しは null", () => {
    expect(sniffImage(JPEG)?.contentType).toBe("image/jpeg");
    expect(sniffImage(tinyPng())?.contentType).toBe("image/png");
    expect(sniffImage(GIF)?.contentType).toBe("image/gif");
    expect(sniffImage(WEBP)?.contentType).toBe("image/webp");
    expect(sniffImage(AVIF)?.contentType).toBe("image/avif");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(bytes("<html><body>"))).toBeNull();
    expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("寸法を見出しから読む（AVIF は読まない）", () => {
    expect(imageSize(JPEG, "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageSize(tinyPng(1600, 1200), "image/png")).toEqual({ width: 1600, height: 1200 });
    expect(imageSize(GIF, "image/gif")).toEqual({ width: 640, height: 480 });
    expect(imageSize(WEBP, "image/webp")).toEqual({ width: 640, height: 480 });
    expect(imageSize(AVIF, "image/avif")).toBeNull();
    expect(imageSize(tinyPng(30000, 10), "image/png")).toBeNull();
  });
});

describe("URL からの取得（fetchImage）", () => {
  let handler: (req: Request) => Response = () => new Response("unset", { status: 500 });
  const fetchVia = (u: string) => fetchImage(u, (input, init) => Promise.resolve(handler(new Request(input, init))));

  it("リダイレクト先が社内のアドレスなら取りに行かない。公開の転送先は追う", async () => {
    handler = (req) =>
      req.url.endsWith("evil.png") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      : req.url.endsWith("moved.png") ? new Response(null, { status: 301, headers: { location: "/a.png" } })
      : new Response(tinyPng(), { headers: { "content-type": "image/png" } });
    const e = await fetchVia("https://images.example/evil.png").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImageFetchError);
    expect((e as ImageFetchError).code).toBe("host_not_allowed");
    expect((await fetchVia("https://images.example/moved.png")).ext).toBe("png");
  });

  it("種類は中身で決める: octet-stream の PNG は受け、image/png と名乗る HTML は断る。状態は http_<番号>", async () => {
    handler = (req) =>
      req.url.endsWith("raw") ? new Response(tinyPng(), { headers: { "content-type": "application/octet-stream" } })
      : req.url.endsWith("fake.png") ? new Response("<html>", { headers: { "content-type": "image/png" } })
      : new Response("no", { status: 403 });
    expect((await fetchVia("https://images.example/raw")).contentType).toBe("image/png");
    expect(((await fetchVia("https://images.example/fake.png").catch((x: unknown) => x)) as ImageFetchError).code).toBe("not_image");
    expect(((await fetchVia("https://images.example/blocked.png").catch((x: unknown) => x)) as ImageFetchError).code).toBe("http_403");
    expect(((await fetchVia("http://172.16.0.1/a.png").catch((x: unknown) => x)) as ImageFetchError).code).toBe("host_not_allowed");
  });

  it("社内のアドレス・ウェブ以外のポート・認証情報付きの URL には取りに行かない（監査 M12）", async () => {
    let called = 0;
    handler = () => {
      called++;
      return new Response(tinyPng(), { headers: { "content-type": "image/png" } });
    };
    for (const u of ["http://100.64.0.1/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://[::]/a.png", "http://[64:ff9b::a9fe:a9fe]/a.png", "http://metadata/a.png", "https://images.example:22/a.png", "https://user:pass@images.example/a.png"]) {
      const e = (await fetchVia(u).catch((x: unknown) => x)) as ImageFetchError;
      expect(e, u).toBeInstanceOf(ImageFetchError);
      expect(["host_not_allowed", "bad_url"], u).toContain(e.code);
    }
    expect(called).toBe(0);
    // 普通のドメイン（前の判定は fc で始まる名前を断っていた）
    expect((await fetchVia("https://fcbarcelona.com/a.png")).ext).toBe("png");
    expect((await fetchVia("https://images.example:8443/a.png")).ext).toBe("png");
  });

  it("本文は数えながら読み、上限を超えたらそこでやめる（Content-Length を名乗らない巨大な本文）", async () => {
    let pulled = 0;
    handler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(ctrl) {
            pulled++;
            ctrl.enqueue(pulled === 1 ? new Uint8Array([...tinyPng(), ...new Uint8Array(1024 * 1024 - 33)]) : new Uint8Array(1024 * 1024));
            if (pulled > 100) ctrl.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    const e = (await fetchVia("https://images.example/huge.png").catch((x: unknown) => x)) as ImageFetchError;
    expect(e.code).toBe("too_large");
    expect(pulled).toBeLessThan(10);
  });
});

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const mug = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "mug", name: "マグ", published: true });
  const other = sb.addUser("other@example.com", "password-456", { owner: true });
  const otherProduct = sb.addProduct(sb.addShop(other.id, { slug: "other", name: "他店", published: true }).id, { id: crypto.randomUUID(), slug: "x", name: "x", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, mug, otherProduct, storage, app, issue };
}

const upload = async (app: ReturnType<typeof appWith>, token: string, productId: string, body: BodyInit, headers: Record<string, string> = {}) => {
  const res = await app.request(`${BASE}/api/v1/products/${productId}/images/upload`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
};

describe("POST /api/v1/products/{id}/images/upload", () => {
  it("本文が画像そのもの: 種類は中身で決め、寸法を残す。products:write だけのトークンで使える", async () => {
    const { app, issue, mug, storage, sb, shop } = await setup();
    const tok = await issue(["products:write"]);
    const png = tinyPng(1600, 1200);
    const r = await upload(app, tok, mug.id, png, { "content-type": "image/jpeg", "content-length": String(png.byteLength) });
    expect(r.status).toBe(201);
    const row = sb.tables.product_images.find((i) => i["id"] === r.json["image_id"])!;
    expect(String(row["storage_key"])).toMatch(new RegExp(`^shops/${shop.id}/products/${mug.id}/[0-9a-f]{24}\\.png$`));
    expect(row).toMatchObject({ width: 1600, height: 1200, thumb_key: null });
    expect(storage.objects.get(String(row["storage_key"]))!.contentType).toBe("image/png");
  });

  it("multipart: image と thumbnail。サムネイルは本画像の隣のキー", async () => {
    const { app, issue, mug, storage, sb } = await setup();
    const tok = await issue(["products:write"]);
    const form = new FormData();
    form.append("image", new Blob([WEBP], { type: "application/octet-stream" }), "a.webp");
    form.append("thumbnail", new Blob([tinyPng(400, 300)]), "a.thumb.png");
    const req = new Request("http://x", { method: "POST", body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const r = await upload(app, tok, mug.id, body, { "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) });
    expect(r.status).toBe(201);
    const row = sb.tables.product_images.find((i) => i["id"] === r.json["image_id"])!;
    expect(String(row["thumb_key"])).toBe(String(row["storage_key"]).replace(/\.webp$/, ".thumb.png"));
    expect(row).toMatchObject({ width: 640, height: 480 });
    expect(storage.objects.size).toBe(2);
  });

  it("断るもの: SVG・HTML（400）、5MB 超（413）、Content-Length なし（411）、JSON（415）。何も置かない", async () => {
    const { app, issue, mug, storage } = await setup();
    const tok = await issue(["products:write"]);
    expect((await upload(app, tok, mug.id, SVG, { "content-type": "image/svg+xml", "content-length": String(SVG.byteLength) })).status).toBe(400);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(tinyPng());
    expect((await upload(app, tok, mug.id, big, { "content-type": "image/png", "content-length": String(big.byteLength) })).status).toBe(413);
    // 申告より長く送られても上限で止める
    expect((await upload(app, tok, mug.id, big, { "content-type": "image/png", "content-length": "100" })).status).toBe(413);
    expect((await upload(app, tok, mug.id, tinyPng(), { "content-type": "image/png" })).status).toBe(411);
    expect((await upload(app, tok, mug.id, "{}", { "content-type": "application/json", "content-length": "2" })).status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });

  it("スコープ不足は 401、他のショップの商品は 404（置いたものは消す）", async () => {
    const { app, issue, mug, otherProduct, storage } = await setup();
    const png = tinyPng();
    const h = { "content-type": "image/png", "content-length": String(png.byteLength) };
    expect((await upload(app, await issue(["products:read"]), mug.id, png, h)).status).toBe(401);
    const tok = await issue(["products:write"]);
    expect((await upload(app, tok, otherProduct.id, png, h)).status).toBe(404);
    expect((await upload(app, tok, "not-a-uuid", png, h)).status).toBe(404);
    expect(storage.objects.size).toBe(0);
  });
});

describe("PUT /api/v1/images/{id}/file（0077）", () => {
  const multipart = async (parts: Record<string, Blob>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(parts)) form.append(k, v, k);
    const req = new Request("http://x", { method: "POST", body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    return { body, headers: { "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) } };
  };
  const replace = async (app: ReturnType<typeof appWith>, token: string, imageId: string, body: BodyInit, headers: Record<string, string>) => {
    const res = await app.request(`${BASE}/api/v1/images/${imageId}/file`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...headers }, body });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
  };

  it("行・並び順・SKU への結び付けはそのままで、本画像とサムネイルを差し替え、前のファイルを消す", async () => {
    const { app, issue, mug, storage, sb } = await setup();
    const tok = await issue(["products:write"]);
    const png = tinyPng(1600, 1200);
    const first = await upload(app, tok, mug.id, png, { "content-type": "image/png", "content-length": String(png.byteLength) });
    const second = await upload(app, tok, mug.id, png, { "content-type": "image/png", "content-length": String(png.byteLength) });
    const id = String(first.json["image_id"]);
    const row = sb.tables.product_images.find((i) => i["id"] === id)!;
    row["options"] = { color: "レッド" };
    const oldKey = String(row["storage_key"]);
    const m = await multipart({ image: new Blob([WEBP]), thumbnail: new Blob([WEBP]) });
    const r = await replace(app, tok, id, m.body, m.headers);
    expect(r.status).toBe(200);
    expect(r.json["image_id"]).toBe(id);
    expect(String(row["storage_key"])).toMatch(/\.webp$/);
    expect(String(row["thumb_key"])).toBe(String(row["storage_key"]).replace(/\.webp$/, ".thumb.webp"));
    expect(row).toMatchObject({ sort_order: 0, options: { color: "レッド" }, width: 640, height: 480 });
    expect(storage.objects.has(oldKey)).toBe(false);
    // 本画像 2 枚目（そのまま）+ 差し替えた本画像とサムネイル
    expect(storage.objects.size).toBe(3);
    expect(sb.tables.product_images.find((i) => i["id"] === second.json["image_id"])!["sort_order"]).toBe(1);
  });

  it("断るもの: 他のショップ・読むだけのトークン（何も置かない）、options、SVG", async () => {
    const { app, issue, mug, storage, sb, otherProduct } = await setup();
    const tok = await issue(["products:write"]);
    const ro = await issue(["products:read"]);
    sb.tables.product_images.push({ id: crypto.randomUUID(), shop_id: otherProduct["shop_id"], product_id: otherProduct.id, storage_key: "x", thumb_key: null, sort_order: 0, options: {} });
    const otherImage = String(sb.tables.product_images.at(-1)!["id"]);
    const h = { "content-type": "image/webp", "content-length": String(WEBP.byteLength) };
    expect((await replace(app, tok, otherImage, WEBP, h)).status).toBe(404);
    const png = tinyPng(10, 10);
    const up = await upload(app, tok, mug.id, png, { "content-type": "image/png", "content-length": String(png.byteLength) });
    const before = storage.objects.size;
    expect((await replace(app, ro, String(up.json["image_id"]), WEBP, h)).status).toBe(401);
    expect((await app.request(`${BASE}/api/v1/images/${up.json["image_id"]}/file?options=${encodeURIComponent('{"color":"x"}')}`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, ...h }, body: WEBP })).status).toBe(400);
    expect((await replace(app, tok, String(up.json["image_id"]), SVG, { "content-type": "image/svg+xml", "content-length": String(SVG.byteLength) })).status).toBe(400);
    expect(storage.objects.size).toBe(before);
  });

  it("0077 が当たる前は 409 migration_required", async () => {
    const { app, issue, mug, sb } = await setup();
    const tok = await issue(["products:write"]);
    const png = tinyPng(10, 10);
    const up = await upload(app, tok, mug.id, png, { "content-type": "image/png", "content-length": String(png.byteLength) });
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0077_api_image_replace");
    const r = await replace(app, tok, String(up.json["image_id"]), WEBP, { "content-type": "image/webp", "content-length": String(WEBP.byteLength) });
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("migration_required");
  });
});

describe("PUT /api/v1/products/{id}/images/order（0078）", () => {
  const reorder = async (app: ReturnType<typeof appWith>, token: string, productId: string, body: unknown) => {
    const res = await app.request(`${BASE}/api/v1/products/${productId}/images/order`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const addThree = async (app: ReturnType<typeof appWith>, tok: string, productId: string) => {
    const png = tinyPng(10, 10);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push(String((await upload(app, tok, productId, png, { "content-type": "image/png", "content-length": String(png.byteLength) })).json["image_id"]));
    return ids as [string, string, string];
  };

  it("渡した順に並べ直して商品を返す。MCP の product_images_reorder も同じ", async () => {
    const { app, issue, mug } = await setup();
    const tok = await issue(["products:write"]);
    const [a, b, c] = await addThree(app, tok, mug.id);
    const r = await reorder(app, tok, mug.id, { image_ids: [c, a, b] });
    expect(r.status).toBe(200);
    expect((r.json["images"] as { id: string }[]).map((i) => i.id)).toEqual([c, a, b]);
    const mcp = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "product_images_reorder", arguments: { product_id: mug.id, image_ids: [b, c, a] } } }),
    });
    const text = JSON.stringify(await mcp.json());
    expect(text.indexOf(b)).toBeLessThan(text.indexOf(c));
    expect(text.indexOf(c)).toBeLessThan(text.indexOf(a));
  });

  it("断るもの: 足りない・重なり（400 image_ids_mismatch）、形の違い（400）、読むだけのトークン（401）", async () => {
    const { app, issue, mug } = await setup();
    const tok = await issue(["products:write"]);
    const ro = await issue(["products:read"]);
    const [a, b, c] = await addThree(app, tok, mug.id);
    const missing = await reorder(app, tok, mug.id, { image_ids: [a, b] });
    expect(missing.status).toBe(400);
    expect(missing.json.error?.message).toMatch(/^image_ids_mismatch/);
    expect((await reorder(app, tok, mug.id, { image_ids: [a, a, b] })).status).toBe(400);
    expect((await reorder(app, tok, mug.id, { image_ids: "x" })).status).toBe(400);
    expect((await reorder(app, tok, mug.id, { image_ids: [a, b, "nope"] })).status).toBe(400);
    expect((await reorder(app, ro, mug.id, { image_ids: [c, b, a] })).status).toBe(401);
  });

  it("0078 が当たる前は 409 migration_required", async () => {
    const { app, issue, mug, sb } = await setup();
    const tok = await issue(["products:write"]);
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0078_api_image_order");
    const old = await reorder(app, tok, mug.id, { image_ids: [] });
    expect(old.status).toBe(409);
    expect(old.json.error?.code).toBe("migration_required");
  });
});
