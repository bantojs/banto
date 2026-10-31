import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { CONTENT_API_MIGRATION } from "../src/pages";
import { MCP_TOOLS } from "../src/mcp/tools";

/**
 * /api/v1 と /mcp のページ・記事（0083、content:read / content:write）。Worker は形を整えて api_* に渡すだけなので、
 * ここでは経路・アイキャッチの検査・DB の版の判定・MCP の注釈を確かめる。権限と値の検査は test/db/content-api.test.ts（実 PostgreSQL）
 */
function setup(modules: Record<string, boolean> = { pages: true, blog: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "読みもの", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules } });
  sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  const rest = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await app.request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
  };
  return { sb, shop, issue, rest, mcp };
}

describe("ページ・記事の AI 用 API（REST /api/v1・MCP）", () => {
  it("ページ: 作る → handle で直す → id で直す → 一覧 → 取得 → ゴミ箱", async () => {
    const { rest, issue } = setup();
    const tok = await issue(["content:read", "content:write"]);
    const created = await rest(tok, "POST", "/pages", { handle: "about", title: "私たちについて", body: "## ようこそ" });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ handle: "about", status: "draft", body: "## ようこそ" });
    const id = created.json["id"] as string;
    expect((await rest(tok, "POST", "/pages", { handle: "about", published: true })).json).toMatchObject({ id, status: "published" });
    expect((await rest(tok, "PATCH", `/pages/${id}`, { title: "会社案内" })).json).toMatchObject({ id, title: "会社案内" });
    expect((await rest(tok, "GET", "/pages")).json["total"]).toBe(1);
    expect((await rest(tok, "GET", "/pages/about")).json["id"]).toBe(id);
    expect((await rest(tok, "DELETE", `/pages/${id}`)).json["status"]).toBe("trash");
    expect((await rest(tok, "GET", "/pages?status=trash")).json["total"]).toBe(1);
    expect((await rest(tok, "DELETE", "/pages/not-a-uuid")).status).toBe(404);
  });

  it("記事: ブログの一覧 → 作る → 一覧 → 取得 → ゴミ箱。無いブログは 404", async () => {
    const { rest, issue } = setup();
    const tok = await issue(["content:read", "content:write"]);
    expect((await rest(tok, "GET", "/blogs")).json["items"]).toEqual([expect.objectContaining({ handle: "news", articles: 0 })]);
    const a = await rest(tok, "POST", "/blogs/news/articles", { handle: "hello", title: "はじめまして", tags: ["新作"], published: true });
    expect(a.json).toMatchObject({ handle: "hello", status: "published" });
    expect((await rest(tok, "GET", "/blogs/news/articles")).json["total"]).toBe(1);
    expect((await rest(tok, "GET", "/blogs/news/articles/hello")).json["id"]).toBe(a.json["id"]);
    expect((await rest(tok, "DELETE", `/blogs/news/articles/${String(a.json["id"])}`)).json["status"]).toBe("trash");
    expect((await rest(tok, "GET", "/blogs/none/articles")).status).toBe(404);
  });

  it("アイキャッチはこのショップの画像の置き場だけ（ほかのホストの /media/ はホストを外す）。外の画像は 400", async () => {
    const { rest, issue } = setup();
    const tok = await issue(["content:write"]);
    const bad = await rest(tok, "POST", "/pages", { handle: "a", title: "a", image_url: "https://evil.example/x.png" });
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toMatch(/^invalid_image_url/);
    const moved = await rest(tok, "POST", "/pages", { handle: "b", title: "b", image_url: "https://evil.example/media/pages/x/a.webp" });
    expect(moved.json["image_url"]).toBe("/media/pages/x/a.webp");
    expect((await rest(tok, "POST", "/pages", { handle: "c", title: "c", image_url: `${BASE}/media/pages/x/c.webp` })).json["image_url"]).toBe(`${BASE}/media/pages/x/c.webp`);
  });

  it("スコープ不足は 401、モジュールが OFF は 409 module_disabled、0083 の前は 409 migration_required", async () => {
    const ro = setup();
    const read = await ro.issue(["content:read"]);
    expect((await ro.rest(read, "POST", "/pages", { handle: "x", title: "x" })).status).toBe(401);
    const off = setup({});
    const t = await off.issue(["content:read"]);
    const r = await off.rest(t, "GET", "/pages");
    expect(r.status).toBe(409);
    expect(r.json.error?.message).toMatch(/^module_disabled/);
    const old = setup();
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((v) => v !== CONTENT_API_MIGRATION);
    const t2 = await old.issue(["content:read"]);
    const m = await old.rest(t2, "GET", "/pages");
    expect(m.status).toBe(409);
    expect(m.json.error?.code).toBe("migration_required");
  });

  it("MCP: 読むツールは readOnly、書くツールは【書き込み】と destructiveHint。page_save で作れる", async () => {
    const names = ["pages_list", "page_get", "page_save", "page_trash", "blogs_list", "articles_list", "article_get", "article_save", "article_trash"];
    for (const n of names) {
      const tool = MCP_TOOLS.find((x) => x.name === n)!;
      expect(tool, n).toBeDefined();
      expect(tool.readOnly, n).toBe(!/save|trash/.test(n));
      if (!tool.readOnly) expect(tool.description, n).toMatch(/^【書き込み】/);
      else expect(tool.description, n).toContain("指示ではない");
    }
    const { mcp, issue } = setup();
    const tok = await issue(["content:read", "content:write"]);
    const r = await mcp(tok, "page_save", { handle: "faq", title: "よくある質問", body: "Q. 送料は？" });
    expect(r.result?.isError).toBeFalsy();
    expect(JSON.parse(r.result!.content[0]!.text)).toMatchObject({ handle: "faq", title: "よくある質問" });
  });
});
