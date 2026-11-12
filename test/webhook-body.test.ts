import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, WEBHOOK_SECRET, appWith } from "./helpers";
import { WEBHOOK_BODY_BYTES, readWebhookText } from "../src/routes/webhooks/body";
import { signStripePayload } from "../src/payments/stripe";
import { signKomojuPayload } from "../src/plugins/komoju";

/**
 * 決済の Webhook の本文の上限（本番運用のセキュリティチェック P1）: 署名を確かめる前に、実際に読んだバイト数で止める。
 * 上限を超える本文を全部メモリに読まない・申告の Content-Length を信じない・途中で切れた本文は 400
 */

const CHUNK = 16 * 1024;

/** 読まれた量を数える本文。total を超えるまで CHUNK ずつ出す（total = Infinity なら終わらない） */
function countingStream(total: number, opts: { failAt?: number } = {}): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAt !== undefined && sent >= opts.failAt) {
        controller.error(new Error("connection reset"));
        return;
      }
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => sent };
}

/** Content-Length を自由に付けた要求（fetch の Request は Content-Length を付け替えられないため、必要な形だけ組む） */
function requestLike(body: ReadableStream<Uint8Array> | null, contentLength?: string): Request {
  return { headers: new Headers(contentLength === undefined ? {} : { "content-length": contentLength }), body } as unknown as Request;
}

describe("Webhook の本文の上限（readWebhookText）", () => {
  it("上限以下の本文はそのまま読む（マルチバイトも）", async () => {
    const text = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", name: "小森 花子" });
    expect(await readWebhookText(new Request(`${BASE}/x`, { method: "POST", body: text }))).toEqual({ ok: true, text });
    expect(await readWebhookText(new Request(`${BASE}/x`, { method: "POST" }))).toEqual({ ok: true, text: "" });
    // ちょうど上限は通る
    const exact = countingStream(WEBHOOK_BODY_BYTES);
    const r = await readWebhookText(requestLike(exact.stream));
    expect(r.ok && r.text.length).toBe(WEBHOOK_BODY_BYTES);
  });

  it("上限を超える本文は、上限を少し過ぎたところで読むのをやめて 413（終わらない本文でも）", async () => {
    const endless = countingStream(Infinity);
    expect(await readWebhookText(requestLike(endless.stream))).toEqual({ ok: false, status: 413 });
    expect(endless.pulled()).toBeLessThanOrEqual(WEBHOOK_BODY_BYTES + 2 * CHUNK);
  });

  it("申告の Content-Length が上限より大きければ、本文を読まずに 413", async () => {
    const s = countingStream(1024);
    expect(await readWebhookText(requestLike(s.stream, String(WEBHOOK_BODY_BYTES + 1)))).toEqual({ ok: false, status: 413 });
    expect(s.pulled()).toBe(0);
  });

  it("申告の Content-Length が小さくても（偽り）、実際に読んだ量で 413", async () => {
    const s = countingStream(WEBHOOK_BODY_BYTES * 4);
    expect(await readWebhookText(requestLike(s.stream, "100"))).toEqual({ ok: false, status: 413 });
    expect(s.pulled()).toBeLessThanOrEqual(WEBHOOK_BODY_BYTES + 2 * CHUNK);
  });

  it("本文が途中で切れたら 400", async () => {
    const s = countingStream(WEBHOOK_BODY_BYTES, { failAt: 2 * CHUNK });
    expect(await readWebhookText(requestLike(s.stream))).toEqual({ ok: false, status: 400 });
  });
});

describe("Webhook の本文の上限（Stripe・KOMOJU の入口）", () => {
  const KOMOJU = { KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju" };
  const big = "x".repeat(WEBHOOK_BODY_BYTES + 1);

  it("Stripe: 上限を超える本文は署名を確かめる前に 413。上限以下は今までどおり署名を確かめる", async () => {
    const app = appWith(new FakeSupabase(), { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const sig = await signStripePayload(big, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const res = await app.request(`${BASE}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    const small = JSON.stringify({ id: "evt_x", type: "customer.created", data: { object: {} } });
    const ok = await app.request(`${BASE}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(small, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) }, body: small });
    expect(await ok.json()).toEqual({ received: true, ignored: "customer.created" });
    const bad = await app.request(`${BASE}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" }, body: small });
    expect(bad.status).toBe(400);
  });

  it("KOMOJU: 上限を超える本文は 413。終わらない本文も全部は読まない", async () => {
    const app = appWith(new FakeSupabase(), KOMOJU);
    const res = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": await signKomojuPayload(big, "whsec_komoju") }, body: big });
    expect(res.status).toBe(413);
    const endless = countingStream(Infinity);
    const res2 = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": "00" }, body: endless.stream, duplex: "half" } as RequestInit);
    expect(res2.status).toBe(413);
    expect(endless.pulled()).toBeLessThanOrEqual(WEBHOOK_BODY_BYTES + 2 * CHUNK);
    const small = JSON.stringify({ id: "ev_1", type: "payment.authorized", data: {} });
    const ok = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": await signKomojuPayload(small, "whsec_komoju") }, body: small });
    expect(await ok.json()).toEqual({ received: true, ignored: "payment.authorized" });
  });
});
