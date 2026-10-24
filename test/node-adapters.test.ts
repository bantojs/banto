import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeAdapters, EnvConfig, FsStorage, IntervalScheduler, MemoryCache } from "../src/adapters/node";
import { encodeKey, S3Storage, signS3Request } from "../src/adapters/node/s3";
import { createPublicFetch } from "../src/adapters/node/public-fetch";
import { createServer } from "node:http";

describe("Node アダプタ", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("FsStorage: put/get/delete、パストラバーサル拒否", async () => {
    const dir = await mkdtemp(join(tmpdir(), "banto-media-"));
    dirs.push(dir);
    const s = new FsStorage(dir, "https://media.example/");
    const put = await s.put("shops/a/b.png", new Uint8Array([1, 2, 3]).buffer, "image/png");
    expect(put.url).toBe("https://media.example/shops/a/b.png");
    const got = await s.get("shops/a/b.png");
    expect(got?.contentType).toBe("image/png");
    expect(new Uint8Array(await new Response(got!.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await s.get("nope.png")).toBeNull();
    await s.delete("shops/a/b.png");
    expect(await s.get("shops/a/b.png")).toBeNull();
    await expect(s.get("../etc/passwd")).rejects.toThrow(/invalid storage key/);
  });

  it("EnvConfig / MemoryCache / IntervalScheduler", async () => {
    const cfg = new EnvConfig({ A: "1", B: "" });
    expect(cfg.get("A")).toBe("1");
    expect(cfg.get("B")).toBeUndefined();
    expect(() => cfg.secret("B")).toThrow(/Missing secret: B/);

    const cache = new MemoryCache();
    await cache.set("k", { v: 1 }, 60);
    expect(await cache.get("k")).toEqual({ v: 1 });
    await cache.set("x", 1, -1);
    expect(await cache.get("x")).toBeNull();

    const sched = new IntervalScheduler();
    const ran: string[] = [];
    sched.register("a", async () => void ran.push("a"));
    sched.register("boom", async () => {
      throw new Error("boom");
    });
    sched.register("b", async () => void ran.push("b"));
    const silent = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sched.runAll();
    silent.mockRestore();
    expect(ran).toEqual(["a", "b"]); // 1つ失敗しても他は走る

    const a = createNodeAdapters({ MEDIA_DIR: dirs[0], PUBLIC_BASE_URL: "http://x" });
    expect(a.storage).toBeInstanceOf(FsStorage);
    const s3 = createNodeAdapters({ S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", MEDIA_BASE_URL: "https://cdn.example" });
    expect(s3.storage).toBeInstanceOf(S3Storage);
    expect(() => createNodeAdapters({ S3_ENDPOINT: "https://s3.example" })).toThrow(/Missing secret: S3_BUCKET/);
  });
});

describe("S3 SigV4", () => {
  it("AWS ドキュメントの GET Object 例と同じ署名になる", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html（Example: GET Object）
    const headers = await signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["Authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("S3Storage: 署名付きで PUT/GET/DELETE し、キーをエンコードする", async () => {
    const calls: { method: string; url: string; auth: string; type: string | null; body: Uint8Array }[] = [];
    const store = new Map<string, { body: Uint8Array; type: string }>();
    const fake: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const body = new Uint8Array(await req.arrayBuffer());
      calls.push({ method: req.method, url: req.url, auth: req.headers.get("authorization") ?? "", type: req.headers.get("content-type"), body });
      const key = new URL(req.url).pathname;
      if (req.method === "PUT") {
        store.set(key, { body, type: req.headers.get("content-type") ?? "" });
        return new Response(null, { status: 200 });
      }
      if (req.method === "GET") {
        const o = store.get(key);
        return o ? new Response(o.body.buffer as ArrayBuffer, { status: 200, headers: { "content-type": o.type } }) : new Response("", { status: 404 });
      }
      store.delete(key);
      return new Response(null, { status: 204 });
    };
    const s = new S3Storage({ endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", bucket: "banto-media", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://media.example", fetch: fake });
    const put = await s.put("shops/日本/a b.png", new Uint8Array([9]).buffer, "image/png");
    expect(put.url).toBe("https://media.example/shops/日本/a b.png");
    expect(calls[0]!.url).toBe("https://acc.r2.cloudflarestorage.com/banto-media/shops/%E6%97%A5%E6%9C%AC/a%20b.png");
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const got = await s.get("shops/日本/a b.png");
    expect(got?.contentType).toBe("image/png");
    expect(await s.get("missing")).toBeNull();
    await s.delete("shops/日本/a b.png");
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "GET", "DELETE"]);
    expect(encodeKey("a/b c/d*e")).toBe("a/b%20c/d%2Ae");
  });
});

describe("ConfigAdapter の未設定判定", () => {
  it("空文字と REPLACE_ME は未設定として扱う（Deploy ボタンの雛形をそのまま配置しても壊れない）", async () => {
    const { normalizeConfigValue, CONFIG_PLACEHOLDER } = await import("../src/adapters/types");
    expect(normalizeConfigValue(undefined)).toBeUndefined();
    expect(normalizeConfigValue("")).toBeUndefined();
    expect(normalizeConfigValue("  ")).toBeUndefined();
    expect(normalizeConfigValue(CONFIG_PLACEHOLDER)).toBeUndefined();
    expect(normalizeConfigValue("eyJabc")).toBe("eyJabc");
    const { EnvConfig } = await import("../src/adapters/node");
    const cfg = new EnvConfig({ A: "REPLACE_ME", B: "x" });
    expect(cfg.get("A")).toBeUndefined();
    expect(cfg.get("B")).toBe("x");
    expect(() => cfg.secret("A")).toThrow(/Missing secret/);
  });
});

describe("publicFetch（Node、監査 M12）", () => {
  it("名前を引いた先が社内のアドレスなら繋がない（同じサーバーに素の fetch なら繋がる）", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
      const e = (await createPublicFetch()(`http://localhost:${port}/`).catch((x: unknown) => x)) as Error & { code?: string };
      expect(e.code).toBe("EBANTOBLOCKED");
      expect(hits).toBe(1);
      await expect(createPublicFetch()(`http://localhost:${port}/`, { method: "POST" })).rejects.toThrow(/only GET/);
    } finally {
      server.close();
    }
  });
});
