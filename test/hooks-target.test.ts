import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { LookupAddress } from "node:dns";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { fetchManifest } from "../src/hooks/manifest";
import { blockedHookTarget, externalHookUrl } from "../src/hooks/target";
import { createPublicFetch, type publicLookup } from "../src/adapters/node/public-fetch";
import type { PrivilegedDb } from "../src/db/privileged";

/**
 * hooks の行き先は公開のアドレスだけ（docs/hooks.md §5）。登録の検査を通らずに入った行（直叩き・復元）でも、
 * 配信とマニフェストの取得は送る直前に行き先を確かめて送らない。Node の publicFetch は署名付き POST をそのまま運ぶ。
 */
describe("hooks の行き先", () => {
  it("externalHookUrl / blockedHookTarget", () => {
    expect(externalHookUrl("https://plugin.example/hook")).toBe(true);
    expect(externalHookUrl("http://10.0.0.5/hook")).toBe(false);
    expect(externalHookUrl("http://localhost:3000/hook")).toBe(false);
    expect(externalHookUrl("http://metadata.internal/latest")).toBe(false);
    expect(externalHookUrl("https://banto.invalid/plugins/email_resend")).toBe(false);
    expect(externalHookUrl("ftp://plugin.example/hook")).toBe(false);
    expect(blockedHookTarget("https://plugin.example/hook")).toBe(false);
    expect(blockedHookTarget("http://10.0.0.5:8080/admin/")).toBe(true);
    expect(blockedHookTarget("http://metadata.internal/latest")).toBe(true);
    expect(blockedHookTarget("http://[fd00::1]/hook")).toBe(true);
    // 同梱プラグインの内部 URL はプロセス内の振り分け（HTTP には出ない）なので配信の判定では止めない
    expect(blockedHookTarget("https://banto.invalid/plugins/email_resend")).toBe(false);
    expect(blockedHookTarget("not a url")).toBe(true);
  });

  it("配信は私設のアドレス・社内の名前の行を送らずに失敗にする", async () => {
    const calls: string[] = [];
    const finished: [string, boolean, number | null, string | null][] = [];
    const db = {
      claimHookDeliveries: async () => [
        { id: "d1", shop_id: "s", endpoint_id: "e1", event: "order.paid", payload: {}, attempts: 1, url: "http://10.0.0.5:8080/admin/", settings: {}, created_at: "", secret_box: null },
        { id: "d2", shop_id: "s", endpoint_id: "e2", event: "order.paid", payload: {}, attempts: 1, url: "http://metadata.internal/latest", settings: {}, created_at: "", secret_box: null },
        { id: "d3", shop_id: "s", endpoint_id: "e3", event: "order.paid", payload: {}, attempts: 1, url: "https://crm.example/hook", settings: {}, created_at: "", secret_box: null },
      ],
      finishHookDelivery: async (id: string, ok: boolean, status: number | null, err: string | null) => void finished.push([id, ok, status, err]),
    } as unknown as PrivilegedDb;
    const r = await deliverPendingHooks({
      db,
      sessionSecret: "s",
      fetch: async (input, init) => {
        calls.push(`${init?.method} ${new Request(input, init).url}`);
        return new Response("ok", { status: 200 });
      },
    });
    expect(calls).toEqual(["POST https://crm.example/hook"]);
    expect(r).toEqual({ claimed: 3, delivered: 1, failed: 2 });
    expect(finished.filter(([, ok]) => !ok).map(([id, , status, err]) => [id, status, /not a public address/.test(err ?? "")])).toEqual([
      ["d1", null, true],
      ["d2", null, true],
    ]);
  });

  it("マニフェストも私設のアドレスには取りに行かない", async () => {
    let fetched = 0;
    const doFetch: typeof fetch = async () => {
      fetched++;
      return new Response(JSON.stringify({ name: "x", events: [] }));
    };
    expect(await fetchManifest("http://10.0.0.5/manifest", doFetch)).toBeNull();
    expect(await fetchManifest("http://localhost/manifest", doFetch)).toBeNull();
    expect(fetched).toBe(0);
    expect(await fetchManifest("https://plugin.example/manifest", doFetch)).toMatchObject({ name: "x" });
    expect(fetched).toBe(1);
  });

  it("Node の publicFetch は POST の本文とヘッダをそのまま運ぶ（引いた先の確認はそのまま）", async () => {
    const seen: { method: string; body: string; event: string | undefined; length: string | undefined }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", body, event: req.headers["x-banto-event"] as string | undefined, length: req.headers["content-length"] as string | undefined });
        res.statusCode = 201;
        res.end("accepted");
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      // 本番の publicLookup は 127.0.0.1 を断るので、名前の解決だけ差し替えて「公開の名前がこのサーバーを指した」ことにする
      const toLocal: typeof publicLookup = (_hostname, options, callback) => {
        const list: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];
        if (options.all) callback(null, list);
        else callback(null, "127.0.0.1", 4);
      };
      const res = await createPublicFetch(toLocal)(`http://plugin.example:${port}/hook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Banto-Event": "order.paid" }, body: '{"event":"order.paid"}', redirect: "manual" });
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("accepted");
      expect(seen).toEqual([{ method: "POST", body: '{"event":"order.paid"}', event: "order.paid", length: "22" }]);
      // 引いた先が社内のアドレスなら POST でも繋がない（本番の判定）
      const e = (await createPublicFetch()(`http://localhost:${port}/hook`, { method: "POST", body: "x" }).catch((x: unknown) => x)) as Error & { code?: string };
      expect(e.code).toBe("EBANTOBLOCKED");
      expect(seen).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
