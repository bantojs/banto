import { describe, expect, it } from "vitest";
import { createDbClient, filterExpr } from "../src/db/client";

/** DbClient の条件の木（where → PostgREST の and=(…)）と in・件数。管理画面の検索とページ送りが使う */
describe("DbClient の条件の木", () => {
  it("値は二重引用符で囲み、部分一致は LIKE の特別な文字をそのままの文字にする", () => {
    expect(filterExpr({ col: "name", op: "eq", value: 'a,"b)' })).toBe('name.eq."a,\\"b)"');
    expect(filterExpr({ col: "number", op: "eq", value: 1001 })).toBe("number.eq.1001");
    expect(filterExpr({ col: "email", op: "contains", value: "100%_a*\\" })).toBe('email.ilike."*100\\\\%\\\\_a\\\\\\\\*"');
    expect(filterExpr({ col: "marketing_consent", op: "is", value: null })).toBe("marketing_consent.is.null");
    expect(filterExpr({ col: "attributes->>rank", op: "contains", value: "gold" })).toBe('attributes->>rank.ilike."*gold*"');
    expect(filterExpr({ or: [{ col: "a", op: "lt", value: "x" }, { and: [{ col: "a", op: "eq", value: "x" }, { col: "id", op: "lt", value: "y" }] }] })).toBe('or(a.lt."x",and(a.eq."x",id.lt."y"))');
  });

  it("列の名前は決まった形だけ（式の差し込みを止める）", () => {
    expect(() => filterExpr({ col: "name.eq.x,or(id", op: "eq", value: 1 })).toThrow(/invalid filter column/);
    expect(() => filterExpr({ col: "attributes->>a.b", op: "eq", value: 1 })).toThrow(/invalid filter column/);
  });

  it("select は and=(…) と in.(…) を付け、count は Prefer: count=exact の Content-Range を読む", async () => {
    const seen: { url: string; prefer: string | null }[] = [];
    const db = createDbClient({
      url: "https://db.example",
      anonKey: "anon",
      fetch: async (input, init) => {
        seen.push({ url: String(input), prefer: new Headers(init?.headers).get("prefer") });
        return new Response("[]", { status: 200, headers: { "content-range": "*/12345" } });
      },
    });
    await db.from("orders").select("*", { eq: { shop_id: "s" }, in: { id: ["a", "b"] }, where: [{ col: "customer_name", op: "contains", value: "山田" }], order: "created_at.desc,id.desc", limit: 51 });
    const u = new URL(seen[0]!.url);
    expect(u.searchParams.get("and")).toBe('(customer_name.ilike."*山田*")');
    expect(u.searchParams.get("id")).toBe('in.("a","b")');
    expect(u.searchParams.get("order")).toBe("created_at.desc,id.desc");
    expect(await db.from("coupon_grants").count({ eq: { campaign_id: "c", status: "available" } })).toBe(12345);
    expect(seen[1]!.prefer).toBe("count=exact");
    expect(new URL(seen[1]!.url).searchParams.get("limit")).toBe("0");
  });
});
