import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

const dbUrl = process.env.BANTO_TEST_DB_URL;

describe("マイグレーション適用フォーム", () => {
  afterEach(() => externalHosts.clear());

  it("アクセストークン: Management API に 1 ファイルずつ SQL を送り、トークンは保存しない。401 / SQL エラー / 不正な形は画面向けの文言", async () => {
    const sb = new FakeSupabase({ appliedMigrations: [], url: "https://kqmfujpwiftnsktxfcjj.supabase.co" });
    const app = appWith(sb);
    const b = new Browser(app);
    const html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("kqmfujpwiftnsktxfcjj");

    const calls: { auth: string | null; query: string }[] = [];
    externalHosts.set("https://api.supabase.com/", async (req) => {
      const body = (await req.json()) as { query: string };
      calls.push({ auth: req.headers.get("authorization"), query: body.query });
      expect(new URL(req.url).pathname).toBe("/v1/projects/kqmfujpwiftnsktxfcjj/database/query");
      if (req.headers.get("authorization") !== "Bearer sbp_0123456789abcdef0123456789abcdef01234567") return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      if (body.query.startsWith("select version from banto_migrations")) return new Response(JSON.stringify({ message: 'relation "banto_migrations" does not exist' }), { status: 400 });
      if (body.query.includes("0004_commerce")) return new Response(JSON.stringify({ message: "syntax error at or near \"boom\"" }), { status: 400 });
      return new Response("[]", { status: 201 });
    });

    // 不正な形はリクエストしない
    let res = await b.post("/admin/setup/migrate", { access_token: "not-a-token" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("アクセストークンが正しくないか");
    expect(calls).toHaveLength(0);

    // 401
    res = await b.post("/admin/setup/migrate", { access_token: "sbp_ffffffffffffffffffffffffffffffffffffffff" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("アクセストークンが正しくないか");

    // 0004 で SQL エラー → それまでの分は適用済みとして残り、失敗したバージョンが表示される。トークンは画面に出ない
    res = await b.post("/admin/setup/migrate", { access_token: " sbp_0123456789abcdef0123456789abcdef01234567 " });
    expect(res.status).toBe(400);
    const errHtml = await res.text();
    expect(errHtml).toContain("0004_commerce");
    expect(errHtml).toContain("syntax error");
    expect(errHtml).not.toContain("sbp_0123456789");
    const applied = calls.filter((c) => c.auth === "Bearer sbp_0123456789abcdef0123456789abcdef01234567" && !c.query.startsWith("select"));
    expect(applied.map((c) => /banto_migrations \(version\) values \('([^']+)'\)/.exec(c.query)?.[1])).toEqual(["0001_init", "0002_hooks", "0003_api", "0004_commerce"]);
  });

  it("アクセストークン: 既存の適用済みを飛ばし、残りを順に当てて転送する。SUPABASE_URL がローカルならトークン欄は出ない", async () => {
    const sb = new FakeSupabase({ appliedMigrations: [], url: "https://abcdefghijklmnopqrst.supabase.co" });
    const app = appWith(sb);
    const b = new Browser(app);
    const queries: string[] = [];
    externalHosts.set("https://api.supabase.com/", async (req) => {
      const body = (await req.json()) as { query: string };
      queries.push(body.query);
      if (body.query.startsWith("select version")) return new Response(JSON.stringify([{ version: "0001_init" }, { version: "0002_hooks" }]), { status: 201 });
      return new Response("[]", { status: 201 });
    });
    const res = await b.post("/admin/setup/migrate", { access_token: "sbp_0123456789abcdef0123456789abcdef01234567" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/setup?migrated=${encodeURIComponent(BUNDLED_MIGRATIONS.slice(2).join(","))}`);
    expect(queries).toHaveLength(1 + BUNDLED_MIGRATIONS.length - 2);

    const local = new Browser(appWith(new FakeSupabase({ appliedMigrations: [] })));
    const html = await (await local.get("/admin/setup")).text();
    expect(html).not.toContain('name="access_token"');
    expect(html).toContain('name="connection_string"');
  });

  it("ウィザード: 未適用があればフォームを出し、不正な接続文字列は 400 で理由を返す", async () => {
    const sb = new FakeSupabase({ appliedMigrations: [] });
    const b = new Browser(appWith(sb));
    let html = await (await b.get("/admin/setup")).text();
    expect(html).toContain('action="/admin/setup/migrate"');
    expect(html).toContain("Session pooler");
    expect(html).toContain(`適用する (${BUNDLED_MIGRATIONS.join(", ")})`);
    expect(html).not.toContain("supabase db push");

    let res = await b.post("/admin/setup/migrate", { connection_string: "not-a-url" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("接続文字列の形式が正しくありません");

    res = await b.post("/admin/setup/migrate", { connection_string: "postgres://u:p@evil.example/db" });
    expect(res.status).toBe(400);
    html = await res.text();
    expect(html).toContain("このホストのデータベースには接続できません");
    expect(html).not.toContain("evil.example"); // 入力値をエコーしない

    // 適用済みならフォームは出ない・POST は転送
    const done = new Browser(appWith(new FakeSupabase()));
    html = await (await done.get("/admin/setup")).text();
    expect(html).not.toContain('action="/admin/setup/migrate"');
    res = await done.post("/admin/setup/migrate", { connection_string: "postgres://u:p@x.supabase.co/db" });
    expect(res.headers.get("location")).toBe("/admin/setup");
  });

  it("owner 登録後のウィザード適用はログインが必要", async () => {
    const sb = new FakeSupabase({ appliedMigrations: ["0001_init"] });
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const anon = new Browser(appWith(sb));
    const res = await anon.post("/admin/setup/migrate", { connection_string: "postgres://u:p@x.supabase.co/db" });
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  it("/admin/update: ダッシュボードから辿れ、最新なら案内、未適用ならフォーム", async () => {
    const sb = new FakeSupabase({ appliedMigrations: ["0001_init"] });
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    let html = await (await b.get("/admin")).text();
    expect(html).toContain('href="/admin/update"');
    html = await (await b.get("/admin/update")).text();
    expect(html).toContain("0002_hooks");
    expect(html).toContain('action="/admin/update"');
    const res = await b.post("/admin/update", { connection_string: "postgres://u:p@evil.example/db" });
    expect(res.status).toBe(400);

    const sb2 = new FakeSupabase();
    sb2.addUser("owner@example.com", "password-123", { owner: true });
    const b2 = await Browser.loggedIn(appWith(sb2), "owner@example.com", "password-123");
    expect(await (await b2.get("/admin/update")).text()).toContain("データベースは最新です");
    expect((await b2.get("/admin")).status).toBe(200);
  });

  it.skipIf(!dbUrl)("実 DB: ウィザードから空の DB に適用できる", async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    await admin.query("drop database if exists banto_wizard_test");
    await admin.query("create database banto_wizard_test");
    await admin.end();
    const u = new URL(dbUrl!);
    u.pathname = "/banto_wizard_test";
    u.searchParams.set("sslmode", "disable");
    const target = new pg.Client({ connectionString: u.toString() });
    await target.connect();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await target.query(readFileSync(join(import.meta.dirname, "..", "supabase", "test", "auth_shim.sql"), "utf8"));

    const sb = new FakeSupabase({ appliedMigrations: [] });
    const b = new Browser(appWith(sb));
    const res = await b.post("/admin/setup/migrate", { connection_string: u.toString() });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/admin/setup?migrated=${encodeURIComponent(BUNDLED_MIGRATIONS.join(","))}`);
    const versions = await target.query<{ version: string }>("select version from banto_migrations order by version");
    expect(versions.rows.map((r) => r.version)).toEqual([...BUNDLED_MIGRATIONS]);
    await target.end();
    const cleanup = new pg.Client({ connectionString: dbUrl });
    await cleanup.connect();
    await cleanup.query("drop database if exists banto_wizard_test");
    await cleanup.end();
  });
});
