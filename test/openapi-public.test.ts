import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";
import { api } from "../src/routes/api";
import { publicOpenapiDocument } from "../src/routes/api/openapi-public";

/**
 * ヘッドレスの公開 API の OpenAPI（/api/openapi.json）。ルートを足したのに文書に足し忘れる・消したのに残る、を止める。
 */
type Spec = { openapi: string; info: { license?: unknown }; servers: { url: string }[]; paths: Record<string, Record<string, { operationId?: string; responses: Record<string, unknown>; security?: unknown }>>; components: { schemas: Record<string, unknown> } };

/** Hono のパス（:shop、:id{正規表現}）→ OpenAPI のパス（{shop}） */
const toOpenapi = (p: string) => p.replace(/:([A-Za-z_]+)(\{[^/]*\})?/g, "{$1}");

describe("ヘッドレスの公開 API の OpenAPI", () => {
  it("/api/openapi.json を認証なし・CORS * で返す。servers は呼ばれたオリジンの /api", async () => {
    const app = appWith(new FakeSupabase());
    const res = await app.request(`${BASE}/api/openapi.json`, { headers: { origin: "https://wp.example.com" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const spec = (await res.json()) as Spec;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: `${BASE}/api` }]);
    expect(((await (await app.request(`${BASE}/api`)).json()) as Record<string, unknown>)["openapi"]).toBe("/api/openapi.json");
  });

  it("登録したルートと文書のパス・メソッドが一致する", () => {
    const spec = publicOpenapiDocument(BASE, "test") as unknown as Spec;
    const routes = new Set(
      api.routes
        .filter((r) => r.method === "GET" || r.method === "POST")
        .filter((r) => r.path !== "/")
        .map((r) => `${r.method.toLowerCase()} ${toOpenapi(r.path)}`),
    );
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`)));
    expect([...routes].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((d) => !routes.has(d)).sort()).toEqual([]);
  });

  it("どの操作にも重ならない operationId がある（生成したクライアントのメソッド名）。ライセンスは MIT", () => {
    const spec = publicOpenapiDocument(BASE, "test") as unknown as Spec;
    const ops = Object.entries(spec.paths).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => ({ key: `${m} ${p}`, id: op.operationId })));
    expect(ops.filter((o) => !o.id).map((o) => o.key)).toEqual([]);
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
    expect(spec.info.license).toEqual({ name: "MIT", identifier: "MIT" });
  });

  it("各操作に応答があり、エラーの応答は共通の Error を指す。会員トークンの要る操作は security を持つ", () => {
    const spec = publicOpenapiDocument(BASE, "test") as unknown as Spec;
    expect(spec.components.schemas["Error"]).toBeDefined();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
        for (const [code, r] of Object.entries(op.responses)) {
          if (Number(code) >= 400) expect(JSON.stringify(r), `${method} ${path} ${code}`).toContain("#/components/schemas/Error");
        }
      }
    }
    for (const p of ["/shops/{shop}/members/me", "/shops/{shop}/members/sessions", "/shops/{shop}/members/logout-all"]) expect(spec.paths[p]!["get"] ?? spec.paths[p]!["post"]).toHaveProperty("security", [{ memberBearer: [] }]);
  });
});
