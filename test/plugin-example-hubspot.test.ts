import { describe, expect, it } from "vitest";
import { contactProperties, handleRequest, MANIFEST } from "../examples/plugin-hubspot/src/plugin";
import { endpointSecret, signHookPayload } from "../src/hooks/signing";
import { parseManifest } from "../src/hooks/manifest";

/** examples/plugin-hubspot が Banto 本体の署名・マニフェスト・API の契約どおりに動くことを確認する */
describe("外部プラグインの実例（examples/plugin-hubspot）", () => {
  const sessionSecret = "site-secret";
  const endpointId = "ep-hubspot";
  const env = { BANTO_HOOK_SECRET: "", BANTO_API_URL: "https://shop.example/api/v1", BANTO_API_TOKEN: "banto_token", HUBSPOT_ACCESS_TOKEN: "pat-1", HUBSPOT_API_URL: "https://hubspot.test" };
  const NOW = 1_760_000_000;
  const customer = { id: "c-1", email: "Member@Example.com", name: "山田 花子", default_address: { phone: "090", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "1-1", line2: "2F", country: "JP" }, external_ref: null as { provider: string; id: string } | null };

  async function deliver(envelope: Record<string, unknown>, opts: { seen?: Set<string>; badSig?: boolean; bantoStatus?: number; hubspotStatus?: number; patchStatus?: number; customer?: typeof customer } = {}) {
    env.BANTO_HOOK_SECRET = await endpointSecret(sessionSecret, endpointId);
    const body = JSON.stringify(envelope);
    const sig = opts.badSig ? "t=1,v1=00" : await signHookPayload(env.BANTO_HOOK_SECRET, body, NOW);
    const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      calls.push({ method: init?.method ?? "GET", url, auth: h.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith("https://shop.example/api/v1/customers/") && (init?.method ?? "GET") === "GET") {
        return opts.bantoStatus ? new Response("{}", { status: opts.bantoStatus }) : Response.json(opts.customer ?? customer);
      }
      if (url.startsWith("https://shop.example/api/v1/customers/") && init?.method === "PATCH") return new Response("{}", { status: opts.patchStatus ?? 200 });
      if (url === "https://hubspot.test/crm/v3/objects/contacts/batch/upsert") {
        return opts.hubspotStatus ? new Response("{}", { status: opts.hubspotStatus }) : Response.json({ status: "COMPLETE", results: [{ id: "hs-501", new: true }] });
      }
      if (url.startsWith("https://hubspot.test/crm/v3/objects/contacts/") && init?.method === "DELETE") return new Response(null, { status: opts.hubspotStatus ?? 204 });
      throw new Error(`unexpected fetch ${url}`);
    };
    const req = new Request("https://plugin.example/", { method: "POST", headers: { "Content-Type": "application/json", "X-Banto-Event": String(envelope["event"]), "X-Banto-Signature": sig }, body });
    const res = await handleRequest(req, env, { fetch: fetchImpl, now: () => NOW, seen: opts.seen });
    return { res, calls };
  }
  const created = (id: string, ref: unknown = null) => ({ id, event: "customer.created", created_at: "2026-10-23T00:00:00Z", shop_id: "shop-1", attempt: 1, data: { customer_id: "c-1", shop_id: "shop-1", external_ref: ref } });

  it("GET はマニフェストを返し、Banto の parseManifest が受け付ける。購読は customer.* だけ", async () => {
    const res = await handleRequest(new Request("https://plugin.example/"), env, { fetch });
    const m = parseManifest(await res.json());
    expect(m).not.toBeNull();
    expect(m!.events).toEqual(["customer.created", "customer.updated", "customer.deleted"]);
    expect(m!.settings.map((s) => s.key)).toEqual(["archive_on_delete", "no_write_back"]);
    expect(MANIFEST.settings.every((s) => s.type !== ("secret" as string))).toBe(true);
  });

  it("customer.created: Banto からプロフィールを引き、HubSpot にメールアドレスで upsert し、ID を external_ref に書き戻す。個人情報はペイロードではなく API から", async () => {
    const seen = new Set<string>();
    const { res, calls } = await deliver(created("d-1"), { seen });
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://shop.example/api/v1/customers/c-1",
      "POST https://hubspot.test/crm/v3/objects/contacts/batch/upsert",
      "PATCH https://shop.example/api/v1/customers/c-1",
    ]);
    expect(calls[0]!.auth).toBe("Bearer banto_token");
    expect(calls[1]!.auth).toBe("Bearer pat-1");
    expect(calls[1]!.body).toEqual({ inputs: [{ idProperty: "email", id: "member@example.com", properties: { email: "member@example.com", lastname: "山田 花子", phone: "090", address: "1-1 2F", city: "千代田区", state: "東京都", zip: "100-0001", country: "JP" } }] });
    expect(calls[2]!.body).toEqual({ external_ref: { provider: "hubspot", id: "hs-501" } });
    // 再送は処理しない
    const again = await deliver(created("d-1"), { seen });
    expect(again.calls).toHaveLength(0);
  });

  it("書き戻しで届く 2 回目の customer.updated は、external_ref が一致するので書き戻さない（ループしない）。no_write_back でも書き戻さない", async () => {
    const seen = new Set<string>();
    const synced = { ...customer, external_ref: { provider: "hubspot", id: "hs-501" } };
    const updated = { ...created("d-2", synced.external_ref), event: "customer.updated" };
    const { calls } = await deliver(updated, { seen, customer: synced });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    // ping で no_write_back を覚える
    await deliver({ id: "d-ping", event: "banto.ping", created_at: "", shop_id: "shop-2", attempt: 1, data: {}, settings: { no_write_back: true } }, { seen });
    const other = await deliver({ ...created("d-3"), shop_id: "shop-2" }, { seen });
    expect(other.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("Banto か HubSpot が落ちていれば 502（再送してもらう）。Banto で 404（もう退会）なら 200 で飛ばす。署名が違えば 400", async () => {
    const seen = new Set<string>();
    expect((await deliver(created("d-4"), { seen, hubspotStatus: 503 })).res.status).toBe(502);
    expect(seen.has("d-4")).toBe(false);
    expect((await deliver(created("d-4"), { seen, bantoStatus: 500 })).res.status).toBe(502);
    expect((await deliver(created("d-4"), { seen, bantoStatus: 404 })).res.status).toBe(200);
    expect(seen.has("d-4")).toBe(true);
    // 409 external_ref_taken は再送しても直らないので進む
    expect((await deliver(created("d-5"), { seen, patchStatus: 409 })).res.status).toBe(200);
    expect((await deliver(created("d-6"), { badSig: true })).res.status).toBe(400);
    // メールアドレスの無い会員は飛ばす
    const noMail = await deliver(created("d-7"), { seen, customer: { ...customer, email: null as unknown as string } });
    expect(noMail.res.status).toBe(200);
    expect(noMail.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("customer.deleted: 設定が ON で external_ref が hubspot のときだけアーカイブ。購読外のイベントは無視", async () => {
    const seen = new Set<string>();
    const deleted = (id: string, shop: string, ref: unknown) => ({ id, event: "customer.deleted", created_at: "", shop_id: shop, attempt: 1, data: { customer_id: "c-1", shop_id: shop, external_ref: ref } });
    expect((await deliver(deleted("d-8", "shop-3", { provider: "hubspot", id: "hs-501" }), { seen })).calls).toHaveLength(0); // 既定 OFF
    await deliver({ id: "d-ping3", event: "banto.ping", created_at: "", shop_id: "shop-3", attempt: 1, data: {}, settings: { archive_on_delete: true } }, { seen });
    const on = await deliver(deleted("d-9", "shop-3", { provider: "hubspot", id: "hs-501" }), { seen });
    expect(on.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://hubspot.test/crm/v3/objects/contacts/hs-501"]);
    expect((await deliver(deleted("d-10", "shop-3", { provider: "salesforce", id: "x" }), { seen })).calls).toHaveLength(0);
    expect((await deliver(deleted("d-11", "shop-3", null), { seen })).calls).toHaveLength(0);
    const other = await deliver({ id: "d-12", event: "order.paid", created_at: "", shop_id: "shop-3", attempt: 1, data: { order_id: "o" } }, { seen });
    expect(other.res.status).toBe(200);
    expect(other.calls).toHaveLength(0);
  });

  it("contactProperties: 空の値は送らない。氏名は住所の名前で補う", () => {
    expect(contactProperties({ id: "x", email: "A@b.c", name: null, default_address: { name: " 田中 " }, external_ref: null })).toEqual({ email: "a@b.c", lastname: "田中" });
    expect(contactProperties({ id: "x", email: "a@b.c", name: "", default_address: null, external_ref: null })).toEqual({ email: "a@b.c" });
  });
});
