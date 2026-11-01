import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith, externalHosts, tinyPng } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

/**
 * AI 用 API の画像の経路: JSON の本文はどれも 1MB の上限（413）を通り、URL からの取り込みは
 * products:write を確かめてから外に取りに行く（スコープの無いトークンで Worker に取得も置き場への書き込みもさせない）。
 */
afterEach(() => externalHosts.clear());

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, tee, storage, app, issue };
}

describe("AI 用 API の画像", () => {
  it("PUT /products/:id/images/order も本文の上限（1MB・413）を通る", async () => {
    const { app, issue, tee } = await setup();
    const tok = await issue(["products:read", "products:write"]);
    const body = JSON.stringify({ image_ids: Array.from({ length: 90000 }, (_, i) => `x${String(i).padStart(30, "0")}`) });
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
    const res = await app.request(`${BASE}/api/v1/products/${tee.id}/images/order`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "content-length": String(body.length) }, body });
    expect(res.status).toBe(413);
    // 小さい本文は今までどおり検査に進む（JSON でなければ 400）
    const bad = await app.request(`${BASE}/api/v1/products/${tee.id}/images/order`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "[]" });
    expect(bad.status).toBe(400);
  });

  it("URL からの取り込みは products:write を確かめてから取りに行く（無ければ取得も置き場への書き込みも起きない）", async () => {
    const { app, issue, tee, storage } = await setup();
    const tok = await issue(["products:read"]);
    let fetched = 0;
    let putSeen = 0;
    const origPut = storage.put.bind(storage);
    storage.put = async (k, b, ct) => {
      putSeen++;
      return origPut(k, b, ct);
    };
    externalHosts.set("https://images.example/", () => {
      fetched++;
      return new Response(tinyPng(), { headers: { "content-type": "image/png" } });
    });
    const res = await app.request(`${BASE}/api/v1/products/${tee.id}/images`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ image_url: "https://images.example/a.png" }) });
    expect(res.status).toBe(401);
    expect(fetched).toBe(0);
    expect(putSeen).toBe(0);
    expect(storage.objects.size).toBe(0);

    // スコープがあれば取り込める
    const ok = await issue(["products:read", "products:write"]);
    const res2 = await app.request(`${BASE}/api/v1/products/${tee.id}/images`, { method: "POST", headers: { authorization: `Bearer ${ok}`, "content-type": "application/json" }, body: JSON.stringify({ image_url: "https://images.example/a.png" }) });
    expect(res2.status).toBe(201);
    expect(fetched).toBe(1);
    expect(putSeen).toBe(1);
  });
});
