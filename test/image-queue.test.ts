import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, externalHosts, memoryAdapters, tinyPng } from "./helpers";
import { registerJobs } from "../src/jobs";
import { wcImageKey } from "../src/modules/woo-import/keys";

/**
 * 画像を裏で取り込む（同梱モジュール woo_import、0039）とサイトの設定（0038）。
 * 予約の取り出し・やり直し・権限の本物は test/db/image-import-queue.test.ts（実 PostgreSQL）。ここでは画面と Cron の流れを確かめる。
 */
afterEach(() => externalHosts.clear());

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { woo_import: true } } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const mug = sb.addProduct(shop.id, { slug: "mug", name: "M", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  return { sb, shop, tee, mug, storage, app: appWith(sb, {}, storage) };
}

/** Supabase は偽物へ、それ以外（旧サイトの画像）は externalHosts へ */
const routedFetch = (sb: FakeSupabase): typeof fetch => (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(sb.url)) return sb.fetch(input, init);
  for (const [prefix, handler] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(handler(new Request(input, init)));
  return Promise.reject(new TypeError(`no route: ${url}`));
};

function cron(sb: FakeSupabase, storage: MemoryStorage) {
  const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey }, storage);
  const jobs = new Map<string, () => Promise<void>>();
  adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => undefined };
  registerJobs(adapters, { fetch: routedFetch(sb) });
  return () => jobs.get("image_import")!();
}

describe("画像を裏で取り込む", () => {
  it("予約 → Cron が取得・保存・紐づけ。一時的な失敗は待ちに戻し、断られたものは失敗。画面に進み具合と CSV", async () => {
    const { sb, shop, tee, mug, storage, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    // 予約が無いあいだは進み具合を出さない
    expect(await (await admin.get(base)).text()).not.toContain(`id="image-queue"`);

    const res = await admin.postJson(`${base}/images/queue`, {
      items: [
        { slug: "tee", urls: ["https://old.example/a.png", "https://old.example/busy.png"] },
        { slug: "mug", urls: ["https://old.example/blocked.png"] },
        { slug: "gone", urls: ["https://old.example/x.png"] },
      ],
    });
    expect(await res.json()).toEqual({ queued: 3, skipped: 0, missing: 1 });
    // 同じ URL をもう一度予約しても重ならない
    expect(await (await admin.postJson(`${base}/images/queue`, { items: [{ slug: "tee", urls: ["https://old.example/a.png"] }] })).json()).toMatchObject({ queued: 0, skipped: 1 });

    externalHosts.set("https://old.example/", (req) =>
      req.url.endsWith("blocked.png") ? new Response("no", { status: 403 }) : req.url.endsWith("busy.png") ? new Response("busy", { status: 503 }) : new Response(tinyPng(), { headers: { "content-type": "image/png" } }),
    );
    await cron(sb, storage)();
    const key = wcImageKey(shop.id, tee.id, "https://old.example/a.png", "png");
    expect(storage.objects.has(key)).toBe(true);
    expect(sb.tables.product_images.filter((i) => i["product_id"] === tee.id).map((i) => i["storage_key"])).toEqual([key]);
    expect(sb.imageJobs.map((j) => [j.url.replace("https://old.example/", ""), j.status, j.last_error])).toEqual([
      ["a.png", "done", null],
      ["busy.png", "pending", "http_503"],
      ["blocked.png", "failed", "http_403"],
    ]);
    expect(sb.tables.product_images.some((i) => i["product_id"] === mug.id)).toBe(false);

    const html = await (await admin.get(base)).text();
    expect(html).toContain("取り込んだ画像 1 枚・残り 1 枚・取り込めなかった画像 1 枚");
    expect(html).toContain("旧サイトが取得を断りました（403");
    expect(html).toContain("5 分おきに 12 枚ずつ");
    const csv = await (await admin.get(`${base}/images/queue/failures.csv`)).text();
    expect(csv).toContain("mug,https://old.example/blocked.png,旧サイトが取得を断りました");

    // 取り込み済みの画像は、次に予約しても飛ばす
    expect(await (await admin.postJson(`${base}/images/queue`, { items: [{ slug: "tee", urls: ["https://old.example/a.png"] }] })).json()).toMatchObject({ queued: 0, skipped: 1 });
    // やり直す → 取り消す
    expect((await admin.post(`${base}/images/queue/retry`, {})).headers.get("location")).toContain("queue=retried");
    expect(sb.imageJobs.filter((j) => j.status === "pending")).toHaveLength(2);
    await admin.post(`${base}/images/queue/cancel`, {});
    expect(sb.imageJobs.map((j) => j.status)).toEqual(["done"]);
  });

  it("モジュールを OFF にしたショップの予約は進めない", async () => {
    const { sb, shop, storage, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.postJson(`/admin/shops/${shop.id}/modules/woo-import/images/queue`, { items: [{ slug: "tee", urls: ["https://old.example/a.png"] }] });
    (sb.tables.shops[0]!["settings"] as Record<string, unknown>)["modules"] = { woo_import: false };
    externalHosts.set("https://old.example/", () => new Response(tinyPng(), { headers: { "content-type": "image/png" } }));
    await cron(sb, storage)();
    expect(sb.imageJobs[0]!.status).toBe("pending");
    expect(storage.objects.size).toBe(0);
  });
});

describe("サイトの設定（/admin/site）", () => {
  it("組織の owner がプランを切り替えると、裏の取り込みの 1 回の枚数が変わる", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get("/admin")).text()).toContain('href="/admin/site"');
    let html = await (await admin.get("/admin/site")).text();
    expect(html).toMatch(/value="free" checked/);
    expect((await admin.post("/admin/site", { workers_plan: "paid" })).headers.get("location")).toBe("/admin/site?flash=saved");
    expect(sb.siteSettings).toEqual({ workers_plan: "paid" });
    html = await (await admin.get("/admin/site")).text();
    expect(html).toMatch(/value="paid" checked/);
    await admin.postJson(`/admin/shops/${shop.id}/modules/woo-import/images/queue`, { items: [{ slug: "tee", urls: ["https://old.example/a.png"] }] });
    expect(await (await admin.get(`/admin/shops/${shop.id}/modules/woo-import`)).text()).toContain("5 分おきに 150 枚ずつ");
  });
});

describe("大きすぎる画像を縮小して取り込む（このページのブラウザで縮小）", () => {
  // 5MB を超える PNG（見出しは本物、残りは 0 埋め）
  const bigPng = () => {
    const b = new Uint8Array(6 * 1024 * 1024);
    b.set(tinyPng(6000, 4000));
    return b;
  };

  it("元の画像を中継する（40MB まで・社内のアドレス不可・保存しない・ページとして動かない）", async () => {
    const { sb, shop, storage, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    externalHosts.set("https://old.example/", (req) =>
      req.url.endsWith("huge.png") ? new Response(new Uint8Array(16), { headers: { "content-type": "image/png", "content-length": String(41 * 1024 * 1024) } }) : req.url.endsWith("page.html") ? new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }) : new Response(bigPng(), { headers: { "content-type": "image/png" } }),
    );
    let res = await admin.get(`${base}/images/original?url=${encodeURIComponent("https://old.example/big.png")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await res.arrayBuffer()).byteLength).toBe(6 * 1024 * 1024);
    expect(storage.objects.size).toBe(0);
    res = await admin.get(`${base}/images/original?url=${encodeURIComponent("https://old.example/huge.png")}`);
    expect([res.status, await res.json()]).toEqual([413, { error: "too_large_original" }]);
    res = await admin.get(`${base}/images/original?url=${encodeURIComponent("https://old.example/page.html")}`);
    expect(await res.json()).toEqual({ error: "not_image" });
    res = await admin.get(`${base}/images/original?url=${encodeURIComponent("http://169.254.169.254/latest")}`);
    expect(await res.json()).toEqual({ error: "host_not_allowed" });
    // モジュールが OFF のショップ・他人のショップでは使えない
    (sb.tables.shops[0]!["settings"] as Record<string, unknown>)["modules"] = { woo_import: false };
    expect((await admin.get(`${base}/images/original?url=${encodeURIComponent("https://old.example/big.png")}`)).status).toBe(404);
  });

  it("縮小した画像を元の URL のキーで登録し、裏の予約を取り込み済みにする。2 回目は飛ばす", async () => {
    const { sb, shop, tee, storage, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    const url = "https://old.example/big.png";
    // 裏の取り込みで too_large になった予約
    await admin.postJson(`${base}/images/queue`, { items: [{ slug: "tee", urls: [url] }] });
    externalHosts.set("https://old.example/", () => new Response(bigPng(), { headers: { "content-type": "image/png" } }));
    await cron(sb, storage)();
    expect(sb.imageJobs[0]).toMatchObject({ status: "failed", last_error: "too_large" });
    let html = await (await admin.get(base)).text();
    expect(html).toContain(`data-resize-large=""`);
    expect(html).toContain(`"large":[{"slug":"tee","url":"${url}"}]`);

    const send = (image: Uint8Array<ArrayBuffer>, thumb?: Uint8Array<ArrayBuffer>) =>
      admin.postMultipart(`${base}/images/resized`, { slug: "tee", url, image: new File([image], "image.webp"), ...(thumb ? { thumbnail: new File([thumb], "thumbnail.webp") } : {}) });
    // 画像でないもの・5MB を超えるものは受けない
    expect((await send(new TextEncoder().encode("<svg onload=alert(1)>") as Uint8Array<ArrayBuffer>)).status).toBe(400);
    expect((await send(bigPng())).status).toBe(400);
    let res = await send(tinyPng(1600, 1067), tinyPng(400, 267));
    expect(await res.json()).toEqual({ added: 1, skipped: 0 });
    const row = sb.tables.product_images.find((i) => i["product_id"] === tee.id)!;
    expect(row["storage_key"]).toBe(wcImageKey(shop.id, tee.id, url, "png"));
    expect(row).toMatchObject({ width: 1600, height: 1067, thumb_key: String(row["storage_key"]).replace(/\.png$/, ".thumb.png") });
    expect(storage.objects.size).toBe(2);
    expect(sb.imageJobs[0]).toMatchObject({ status: "done", last_error: null });
    res = await send(tinyPng(1600, 1067));
    expect(await res.json()).toEqual({ added: 0, skipped: 1 });
    html = await (await admin.get(base)).text();
    expect(html).not.toContain(`data-resize-large=""`);
  });
});
