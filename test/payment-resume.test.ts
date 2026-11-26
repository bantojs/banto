import { describe, expect, it } from "vitest";
import { abandonPayment, resumePayment } from "../src/commerce/payment-resume";
import { KomojuError, type KomojuClient, type KomojuSession } from "../src/plugins/komoju";
import type { PrivilegedDb, ReservationPayment } from "../src/db/privileged";

const future = new Date(Date.now() + 3600_000).toISOString();

function reservation(over: Partial<ReservationPayment> = {}): ReservationPayment {
  return {
    reservation_id: "res-1",
    status: "pending",
    expires_at: future,
    quote_id: "quote-1",
    payment_session: { provider: "komoju", id: "sess_1", types: ["bank_transfer"] },
    payment_method: "komoju:bank_transfer",
    total_jpy: 3520,
    ...over,
  };
}

function fakes(session: Partial<KomojuSession> | ((id: string) => KomojuSession), opts: { won?: boolean[]; cancelSessionError?: Error; cancelPaymentError?: Error } = {}) {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const sets: { id: string; expected: string | null }[] = [];
  const won = [...(opts.won ?? [true])];
  const komoju = {
    getSession: async (id: string) => {
      calls.push(`get:${id}`);
      return typeof session === "function" ? session(id) : ({ id, session_url: `https://komoju.example/sessions/${id}`, status: "pending", metadata: { reservation_id: "res-1" }, ...session } as KomojuSession);
    },
    createSession: async (p: Record<string, unknown>) => {
      created.push(p);
      return { id: `sess_new${created.length}`, session_url: `https://komoju.example/sessions/sess_new${created.length}`, status: "pending" };
    },
    cancelSession: async (id: string) => {
      calls.push(`cancel-session:${id}`);
      if (opts.cancelSessionError) throw opts.cancelSessionError;
      return { id, session_url: "", status: "cancelled" };
    },
    cancelPayment: async (id: string) => {
      calls.push(`cancel-payment:${id}`);
      if (opts.cancelPaymentError) throw opts.cancelPaymentError;
      return { id, status: "cancelled" };
    },
    refundPayment: async () => ({ id: "x", status: "refunded" }),
  } as unknown as KomojuClient;
  const privileged = {
    reservationSetPaymentSession: async (_r: string, _s: string, ref: { id: string }, expected: string | null) => {
      sets.push({ id: ref.id, expected });
      return won.shift() ?? false;
    },
    reservationPaymentGet: async () => reservation({ payment_session: { provider: "komoju", id: "sess_other" } }),
    releaseReservation: async () => {
      calls.push("release");
      return true;
    },
  } as unknown as PrivilegedDb;
  return { deps: { privileged, komoju }, calls, created, sets };
}

describe("お支払いに戻る（0180、src/commerce/payment-resume.ts）", () => {
  it("手続き前で期限内の決済ページへ戻す", async () => {
    const f = fakes({});
    expect(await resumePayment(f.deps, "shop-1", reservation(), "https://shop.example/done")).toEqual({ kind: "redirect", url: "https://komoju.example/sessions/sess_1" });
    expect(f.created).toHaveLength(0);
  });

  it("手続き済み（お支払い待ち）は案内のメールへ、支払い済みは確定待ち", async () => {
    expect(await resumePayment(fakes({ status: "completed", payment: { id: "pay_1", status: "authorized" } }).deps, "shop-1", reservation(), "u")).toEqual({ kind: "awaiting" });
    expect(await resumePayment(fakes({ status: "complete", payment: { id: "pay_1", status: "authorized" } }).deps, "shop-1", reservation(), "u")).toEqual({ kind: "awaiting" });
    expect(await resumePayment(fakes({ status: "completed", payment: { id: "pay_1", status: "captured" } }).deps, "shop-1", reservation(), "u")).toEqual({ kind: "paid" });
  });

  it("期限切れ・取り消し済みの決済ページは同じ予約・金額・種類で作り直し、前の ID と同じときだけ入れ替える", async () => {
    const f = fakes({ expired: true });
    expect(await resumePayment(f.deps, "shop-1", reservation(), "https://shop.example/done?s=t")).toEqual({ kind: "redirect", url: "https://komoju.example/sessions/sess_new1" });
    expect(f.created).toEqual([{ amountJpy: 3520, returnUrl: "https://shop.example/done?s=t", reservationId: "res-1", shopId: "shop-1", paymentTypes: ["bank_transfer"], expiresInSeconds: expect.any(Number) }]);
    // 作り直す決済ページは予約の残り（ここでは約 1 時間）より長く払えない
    expect(f.created[0]!["expiresInSeconds"]).toBeLessThanOrEqual(3600);
    expect(f.created[0]!["expiresInSeconds"]).toBeGreaterThan(3500);
    // 予約の残りが 10 分を切っていれば作り直さない
    const late = fakes({ expired: true });
    expect(await resumePayment(late.deps, "shop-1", reservation({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }), "u")).toEqual({ kind: "unavailable" });
    expect(late.created).toHaveLength(0);
    expect(f.sets).toEqual([{ id: "sess_new1", expected: "sess_1" }]);
    const g = fakes({ status: "cancelled" });
    expect((await resumePayment(g.deps, "shop-1", reservation(), "u")).kind).toBe("redirect");
  });

  it("二度押しで負けたら作ったほうを取り消し、勝ったほうの決済ページへ", async () => {
    const f = fakes((id) => (id === "sess_other" ? { id, session_url: "https://komoju.example/sessions/sess_other", status: "pending", metadata: { reservation_id: "res-1" } } : { id, session_url: "", status: "pending", expired: true }), { won: [false] });
    expect(await resumePayment(f.deps, "shop-1", reservation(), "u")).toEqual({ kind: "redirect", url: "https://komoju.example/sessions/sess_other" });
    expect(f.calls).toContain("cancel-session:sess_new1");
  });

  it("失敗した支払いが付いていても、決済ページが手続き前（pending）なら払い直せる。取りやめは決済ページも取り消す", async () => {
    const f = fakes({ status: "pending", payment: { id: "pay_failed", status: "failed" } });
    expect(await resumePayment(f.deps, "shop-1", reservation(), "u")).toEqual({ kind: "redirect", url: "https://komoju.example/sessions/sess_1" });
    expect(await abandonPayment(f.deps, "shop-1", reservation())).toBe("released");
    expect(f.calls).toContain("cancel-session:sess_1");
    expect(f.calls).not.toContain("cancel-payment:pay_failed");
  });

  it("確定・解放・期限切れ・決済ページの無い予約・違う予約の決済ページには戻らない", async () => {
    const f = fakes({});
    expect(await resumePayment(f.deps, "s", reservation({ status: "confirmed" }), "u")).toEqual({ kind: "confirmed" });
    expect(await resumePayment(f.deps, "s", reservation({ status: "released" }), "u")).toEqual({ kind: "released" });
    expect(await resumePayment(f.deps, "s", reservation({ expires_at: new Date(Date.now() - 1000).toISOString() }), "u")).toEqual({ kind: "unavailable" });
    expect(await resumePayment(f.deps, "s", reservation({ payment_session: null }), "u")).toEqual({ kind: "unavailable" });
    expect(await resumePayment({ ...f.deps, komoju: null }, "s", reservation(), "u")).toEqual({ kind: "unavailable" });
    expect(await resumePayment(fakes({ metadata: { reservation_id: "res-2" } }).deps, "s", reservation(), "u")).toEqual({ kind: "unavailable" });
    expect(f.calls).toEqual([]);
  });

  it("取りやめる: 先に KOMOJU を取り消し、取り消せたときだけ在庫を戻す", async () => {
    const pending = fakes({});
    expect(await abandonPayment(pending.deps, "s", reservation())).toBe("released");
    expect(pending.calls).toEqual(["get:sess_1", "cancel-session:sess_1", "release"]);
    const awaiting = fakes({ status: "completed", payment: { id: "pay_1", status: "authorized" } });
    expect(await abandonPayment(awaiting.deps, "s", reservation())).toBe("released");
    expect(awaiting.calls).toEqual(["get:sess_1", "cancel-payment:pay_1", "release"]);
    // 期限切れの決済ページは取り消さずに戻す
    const expired = fakes({ expired: true });
    expect(await abandonPayment(expired.deps, "s", reservation())).toBe("released");
    expect(expired.calls).toEqual(["get:sess_1", "release"]);
    // 支払い済み・取り消せない（422）・KOMOJU の誤りなら戻さない
    const paid = fakes({ status: "completed", payment: { id: "pay_1", status: "captured" } });
    expect(await abandonPayment(paid.deps, "s", reservation())).toBe("paid");
    expect(paid.calls).not.toContain("release");
    const raced = fakes({}, { cancelSessionError: new KomojuError("KOMOJU 422: already completed", 422) });
    expect(await abandonPayment(raced.deps, "s", reservation())).toBe("paid");
    expect(raced.calls).not.toContain("release");
    const down = fakes({}, { cancelSessionError: new KomojuError("KOMOJU 503", 503) });
    expect(await abandonPayment(down.deps, "s", reservation())).toBe("failed");
    expect(down.calls).not.toContain("release");
    // 確定・解放済みは何もしない
    expect(await abandonPayment(pending.deps, "s", reservation({ status: "confirmed" }))).toBe("confirmed");
    expect(await abandonPayment(pending.deps, "s", reservation({ status: "released" }))).toBe("released");
  });
});
