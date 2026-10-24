import { describe, expect, it } from "vitest";
import { handleRequest, MANIFEST } from "../examples/plugin-slack/src/plugin";
import { endpointSecret, signHookPayload } from "../src/hooks/signing";
import { parseManifest } from "../src/hooks/manifest";

/** examples/plugin-slack が Banto 本体の署名・マニフェストの契約どおりに動くことを確認する */
describe("外部プラグインの実例（examples/plugin-slack）", () => {
  const sessionSecret = "site-secret";
  const endpointId = "ep-1";
  const env = { BANTO_HOOK_SECRET: "", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" };
  const NOW = 1_760_000_000;

  async function deliver(envelope: Record<string, unknown>, opts: { slackStatus?: number; seen?: Set<string>; badSig?: boolean; skew?: number } = {}) {
    env.BANTO_HOOK_SECRET = await endpointSecret(sessionSecret, endpointId);
    const body = JSON.stringify(envelope);
    const sig = opts.badSig ? "t=1,v1=00" : await signHookPayload(env.BANTO_HOOK_SECRET, body, NOW + (opts.skew ?? 0));
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      posted.push(JSON.parse(String(init?.body)).text);
      return new Response("ok", { status: opts.slackStatus ?? 200 });
    };
    const req = new Request("https://plugin.example/", { method: "POST", headers: { "Content-Type": "application/json", "X-Banto-Event": String(envelope["event"]), "X-Banto-Signature": sig }, body });
    const res = await handleRequest(req, env, { fetch: fetchImpl, now: () => NOW, seen: opts.seen });
    return { res, posted };
  }

  it("GET はマニフェストを返し、Banto の parseManifest が受け付ける", async () => {
    const res = await handleRequest(new Request("https://plugin.example/"), env, { fetch });
    const m = parseManifest(await res.json());
    expect(m).not.toBeNull();
    expect(m!.name).toBe(MANIFEST.name);
    expect(m!.events).toEqual([...MANIFEST.events]);
    expect(m!.settings.map((s) => s.key)).toEqual(["mention", "include_items", "lang"]);
  });

  it("署名が正しい order.paid を Slack に投稿する。改ざん・古い署名は 400", async () => {
    const seen = new Set<string>();
    const paid = { id: "d-1", event: "order.paid", created_at: "2026-10-14T00:00:00Z", shop_id: "shop-1", attempt: 1, data: { order_number: 1001, total_jpy: 6500, payment_provider: "stripe", items: [{ sku_id: "sku-1", qty: 2 }] } };
    const ok = await deliver(paid, { seen });
    expect(ok.res.status).toBe(200);
    expect(ok.posted).toEqual([":tada: 新しい注文 #1001 ¥6,500（stripe）"]);

    expect((await deliver(paid, { badSig: true })).res.status).toBe(400);
    expect((await deliver(paid, { skew: -600 })).res.status).toBe(400);
    expect((await deliver({ ...paid, data: { ...paid.data, total_jpy: 1 } }, { badSig: true })).res.status).toBe(400);
  });

  it("再送（同じ配信 ID）は二重投稿しない。Slack が落ちていれば 502 で再送を促し、ID は記憶しない", async () => {
    const seen = new Set<string>();
    const shipped = { id: "d-2", event: "order.shipped", created_at: "", shop_id: "shop-1", attempt: 1, data: { order_number: 1001 } };
    const down = await deliver(shipped, { seen, slackStatus: 503 });
    expect(down.res.status).toBe(502);
    expect(seen.has("d-2")).toBe(false);
    const first = await deliver({ ...shipped, attempt: 2 }, { seen });
    expect(first.res.status).toBe(200);
    expect(first.posted).toHaveLength(1);
    const again = await deliver({ ...shipped, attempt: 3 }, { seen });
    expect(again.res.status).toBe(200);
    expect(again.posted).toHaveLength(0);
  });

  it("banto.ping で設定（メンション・明細・言語）を覚え、以後の投稿に反映する。購読外のイベントは無視", async () => {
    const seen = new Set<string>();
    const ping = { id: "d-3", event: "banto.ping", created_at: "", shop_id: "shop-2", attempt: 1, data: { message: "test" }, settings: { mention: "<!channel>", include_items: true, lang: "en" } };
    const p = await deliver(ping, { seen });
    expect(p.posted).toEqual([":white_check_mark: Banto is connected to this channel."]);
    const paid = { id: "d-4", event: "order.paid", created_at: "", shop_id: "shop-2", attempt: 1, data: { order_number: 7, total_jpy: 100, payment_provider: "komoju", items: [{ sku_id: "A", qty: 1 }, { sku_id: "B", qty: 3 }] } };
    expect((await deliver(paid, { seen })).posted).toEqual(["<!channel> :tada: New order #7 — ¥100 (komoju)\n• A × 1\n• B × 3"]);
    const low = { id: "d-5", event: "inventory.low", created_at: "", shop_id: "shop-2", attempt: 1, data: { sku_id: "A", available: 1, threshold: 3 } };
    expect((await deliver(low, { seen })).posted).toEqual(["<!channel> :warning: Low stock: SKU A has 1 left (threshold 3)"]);
    const other = await deliver({ id: "d-6", event: "product.updated", created_at: "", shop_id: "shop-2", attempt: 1, data: {} }, { seen });
    expect(other.res.status).toBe(200);
    expect(other.posted).toHaveLength(0);
  });
});
