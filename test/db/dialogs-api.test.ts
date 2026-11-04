import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0111_dialogs_api: AI 用 API とつないだプラグインからダイアログを作る（スコープ dialogs:write・連携ごとに分かれる・運営者は付け替えられない） */
describe.skipIf(!dbAvailable)("ダイアログの API（0111_dialogs_api）", () => {
  let a: Fixture;
  let b: Fixture;
  let ep: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  async function issue(f: Fixture, scopes: string[], endpoint: string | null = null) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, endpoint_id) values ($1, $2, 't', $3, $4, $5, $6)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes, endpoint]));
    return sha(raw);
  }
  const on = (shopId: string) => getPool().query(`update shops set settings = jsonb_set(coalesce(settings, '{}'), '{modules}', coalesce(settings->'modules', '{}') || '{"dialogs": true}') where id = $1`, [shopId]);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "dapi-a@example.com", slug: "dapi-a", publish: true });
    b = await createShopFixture({ email: "dapi-b@example.com", slug: "dapi-b", publish: true });
    ep = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'MA', 'https://ma.example.com/hook', '{}') returning id", [a.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("モジュールが OFF なら断る。ON なら作れて、プラグインのトークンで作ったものはその連携のもの", async () => {
    const plugin = await issue(a, ["dialogs:write"], ep);
    expect(await expectDbError(() => rpc("api_dialogs_list", [plugin]))).toMatch(/module_disabled/);
    await on(a.shopId);
    const d = await rpc<{ id: string; pages: unknown }>("api_dialog_create", [plugin, JSON.stringify({ name: "カゴ", title: "残っています", pages: { kinds: ["cart", "nope"] } })]);
    expect(d.pages).toEqual({ kinds: ["cart"] });
    expect((await getPool().query("select endpoint_id from dialogs where id = $1", [d.id])).rows[0]!.endpoint_id).toBe(ep);
    // 形の確かめは 0110 と同じ一本道。知らない鍵は断る
    expect(await expectDbError(() => rpc("api_dialog_create", [plugin, JSON.stringify({ name: "x", title: "x", buttons: [{ label: "x", url: "javascript:alert(1)" }] })]))).toMatch(/invalid_dialog:buttons/);
    expect(await expectDbError(() => rpc("api_dialog_create", [plugin, JSON.stringify({ name: "x", title: "x", shop_id: b.shopId })]))).toMatch(/unknown_field/);
  });

  it("運営者のトークンとプラグインのトークンは、互いのものに触れない。ほかのショップのものも", async () => {
    await on(a.shopId);
    const plugin = await issue(a, ["dialogs:write"], ep);
    const op = await issue(a, ["dialogs:write"]);
    const mine = await rpc<{ id: string }>("api_dialog_create", [op, JSON.stringify({ name: "運営者", title: "x" })]);
    const theirs = (await rpc<{ id: string; name: string }[]>("api_dialogs_list", [plugin]))[0]!;
    expect((await rpc<{ name: string }[]>("api_dialogs_list", [op])).map((d) => d.name)).toEqual(["運営者"]);
    expect(await expectDbError(() => rpc("api_dialog_update", [plugin, mine.id, JSON.stringify({ enabled: false })]))).toMatch(/not_found/);
    expect(await expectDbError(() => rpc("api_dialog_delete", [op, theirs.id]))).toMatch(/not_found/);
    expect((await rpc<{ enabled: boolean }>("api_dialog_update", [op, mine.id, JSON.stringify({ enabled: false })])).enabled).toBe(false);
    await on(b.shopId);
    const other = await issue(b, ["dialogs:write"]);
    expect(await expectDbError(() => rpc("api_dialog_delete", [other, mine.id]))).toMatch(/not_found/);
    const coupons = await issue(a, ["coupons:write"]);
    expect(await expectDbError(() => rpc("api_dialogs_list", [coupons]))).toMatch(/unauthorized/);
  });

  it("運営者の JWT からは連携を付けられない・付け替えられない。連携を外すと一緒に消える", async () => {
    const row = (await getPool().query<{ id: string }>("select id from dialogs where endpoint_id = $1 limit 1", [ep])).rows[0]!;
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update dialogs set endpoint_id = null where id = $1", [row.id])))).toMatch(/invalid_dialog:endpoint/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into dialogs (shop_id, name, title, endpoint_id) values ($1, 'x', 'x', $2)", [a.shopId, ep])))).toMatch(/invalid_dialog:endpoint/);
    // 運営者は止められる
    await asUser(a.ownerId, (c) => c.query("update dialogs set enabled = false where id = $1", [row.id]));
    await getPool().query("delete from hook_endpoints where id = $1", [ep]);
    expect((await getPool().query("select id from dialogs where id = $1", [row.id])).rows).toEqual([]);
  });
});
