import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith, memberMail } from "./helpers";
import { issueTokens } from "../src/members/auth";

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, headless: { return_origins: ["https://wp.example.com"] } } });
  const other = sb.addShop(owner.id, { slug: "other", name: "別の店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const mail = memberMail(sb, shop.id);
  sb.tables.hook_endpoints.push({ id: "ep-mail-other", shop_id: other.id, name: "mail", url: "https://banto.invalid/plugins/email_resend", events: [], enabled: true, settings: { from: "Other <o@example.com>" } });
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await app.request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "https://wp.example.com", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { sb, shop, mail, call };
}

describe("ヘッドレスの会員 API（店ごと・パスワードなし）", () => {
  it("login → verify（コード）→ me → refresh → logout-all。古いトークンは使えない", async () => {
    const { sb, mail, call } = setup();
    let r = await call("/api/shops/my-shop/members/login", { email: "Hanako@example.com" });
    expect(r.status).toBe(200);
    const challenge = r.json["challenge_id"] as string;
    expect(challenge).toMatch(/^[0-9a-f-]{36}$/);
    // リンクの行き先は Banto の確認画面（return_to なし）
    expect(mail.link("hanako@example.com")).toBe(`${BASE}/my-shop/account/verify?c=${challenge}&t=${new URL(mail.link("hanako@example.com")).searchParams.get("t")}`);

    r = await call("/api/shops/my-shop/members/verify", { challenge_id: challenge, code: "000000" === mail.code("hanako@example.com") ? "111111" : "000000" });
    expect(r).toEqual({ status: 401, json: { error: "invalid_code" } });
    r = await call("/api/shops/my-shop/members/verify", { challenge_id: challenge, code: mail.code("hanako@example.com") });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ expires_in: 900, member: { email: "hanako@example.com", created: true } });
    const access = r.json["access_token"] as string;
    const refresh = r.json["refresh_token"] as string;
    expect(access.startsWith("bm1.")).toBe(true);
    // 使用済み
    expect((await call("/api/shops/my-shop/members/verify", { challenge_id: challenge, code: mail.code("hanako@example.com") })).json).toEqual({ error: "expired" });

    r = await call("/api/shops/my-shop/members/me", undefined, access);
    expect(r).toMatchObject({ status: 200, json: { email: "hanako@example.com", orders: [] } });
    // 他店ではそのトークンは使えない
    expect((await call("/api/shops/other/members/me", undefined, access)).status).toBe(401);

    r = await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh });
    expect(r.status).toBe(200);
    const access2 = r.json["access_token"] as string;
    // access を refresh として使うことはできない
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: access })).status).toBe(401);

    expect((await call("/api/shops/my-shop/members/logout-all", {}, access2)).json).toEqual({ ok: true });
    expect(sb.tables.customers[0]!["session_epoch"]).toBe(1);
    expect((await call("/api/shops/my-shop/members/me", undefined, access)).status).toBe(401);
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh })).status).toBe(401);
  });

  it("セッション（0045）: refresh は回るたびに変わり、使い回すとセッションごと止まる。トークンにメールアドレスを入れない", async () => {
    const { sb, mail, call } = setup();
    const login = async () => {
      const ch = (await call("/api/shops/my-shop/members/login", { email: "hanako@example.com" })).json["challenge_id"];
      return (await call("/api/shops/my-shop/members/verify", { challenge_id: ch, code: mail.code("hanako@example.com") })).json;
    };
    const first = await login();
    const access = first["access_token"] as string;
    const refresh = first["refresh_token"] as string;
    // 署名付きの平文なので、中身にメールアドレスが無いこと
    for (const tok of [access, refresh]) expect(Buffer.from(tok.slice(4).split(".")[0]!, "base64url").toString()).not.toContain("hanako");
    expect(sb.memberSessions).toHaveLength(1);
    expect(sb.memberSessions[0]).toMatchObject({ kind: "api", revoked_at: null });

    // 1 回目の refresh で世代が進む。同時に呼んだ 2 つ目（同じ refresh）は 30 秒以内なら通る
    const r1 = await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh });
    expect(r1.status).toBe(200);
    const r1b = await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh });
    expect(r1b.status).toBe(200);
    const refresh2 = r1.json["refresh_token"] as string;
    expect(refresh2).not.toBe(refresh);
    const r2 = await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh2 });
    expect(r2.status).toBe(200);
    // 2 つ前の refresh を使う = 使い回し。セッションごと取り消す（本人の新しい refresh も使えなくなる）
    expect(await call("/api/shops/my-shop/members/refresh", { refresh_token: refresh })).toEqual({ status: 401, json: { error: "refresh_token_reused" } });
    expect(sb.memberSessions[0]).toMatchObject({ revoked_reason: "reuse" });
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: r2.json["refresh_token"] })).status).toBe(401);

    // 端末ごと: 2 台でログインし、一覧から片方をログアウトさせる
    const a = await login();
    const b = await login();
    const list = await call("/api/shops/my-shop/members/sessions", undefined, a["access_token"] as string);
    expect(list.status).toBe(200);
    const sessions = list.json["sessions"] as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const other = sessions.find((x) => !x.current)!;
    expect((await call(`/api/shops/my-shop/members/sessions/${other.id}/revoke`, {}, a["access_token"] as string)).json).toEqual({ ok: true });
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: b["refresh_token"] })).json).toEqual({ error: "invalid_refresh_token" });
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: a["refresh_token"] })).status).toBe(200);

    // この端末をログアウト（refresh_token で）
    const c2 = await login();
    expect((await call("/api/shops/my-shop/members/logout", { refresh_token: c2["refresh_token"] })).json).toEqual({ ok: true });
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: c2["refresh_token"] })).status).toBe(401);
  });

  it("0045 より前に発行した（セッションの行の無い）refresh は通さない", async () => {
    const { sb, shop, mail, call } = setup();
    const ch = (await call("/api/shops/my-shop/members/login", { email: "old@example.com" })).json["challenge_id"];
    await call("/api/shops/my-shop/members/verify", { challenge_id: ch, code: mail.code("old@example.com") });
    const row = sb.tables.customers.find((c) => c["email"] === "old@example.com")!;
    // sid の無いトークン（0045 より前の形）を同じ秘密で作る
    const old = await issueTokens("test-session-secret", shop.id, String(row["id"]), Number(row["session_epoch"] ?? 0), null);
    expect(await call("/api/shops/my-shop/members/refresh", { refresh_token: old.refresh_token })).toEqual({ status: 401, json: { error: "invalid_refresh_token" } });
  });

  it("return_to は許可リストのオリジンだけ。リンクのトークンで verify できる", async () => {
    const { mail, call } = setup();
    let r = await call("/api/shops/my-shop/members/login", { email: "taro@example.com", return_to: "https://wp.example.com/my-account/?lang=ja" });
    const challenge = r.json["challenge_id"] as string;
    const link = new URL(mail.link("taro@example.com"));
    expect(`${link.origin}${link.pathname}`).toBe("https://wp.example.com/my-account/");
    expect(link.searchParams.get("lang")).toBe("ja");
    expect(link.searchParams.get("banto_challenge")).toBe(challenge);
    r = await call("/api/shops/my-shop/members/verify", { challenge_id: link.searchParams.get("banto_challenge"), token: link.searchParams.get("banto_token") });
    expect(r.status).toBe(200);

    // 許可されていない戻り先は無視して、Banto の確認画面にする（オープンリダイレクトにしない）
    await call("/api/shops/my-shop/members/login", { email: "jiro@example.com", return_to: "https://evil.example/steal" });
    expect(mail.link("jiro@example.com").startsWith(`${BASE}/my-shop/account/verify?c=`)).toBe(true);
  });

  it("不正なアドレス。他店のチャレンジは通らない", async () => {
    const { call } = setup();
    expect((await call("/api/shops/my-shop/members/login", { email: "bad" })).json).toEqual({ error: "invalid_email" });
    // 他店のチャレンジは自店では通らない
    const r = await call("/api/shops/other/members/login", { email: "x@example.com" });
    expect((await call("/api/shops/my-shop/members/verify", { challenge_id: r.json["challenge_id"], code: "123456" })).json).toEqual({ error: "invalid_code" });
  });
});
