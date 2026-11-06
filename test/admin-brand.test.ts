import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { appWith } from "./helpers";
import { adminIconOf, adminNameOf, setAdminBrand } from "../src/routes/admin/brand";

/** 管理画面の左上の名前とアイコン（BANTO_ADMIN_NAME・BANTO_ADMIN_ICON_URL、メンテナの決定 2026-11-06） */
afterEach(() => setAdminBrand(null, null));

const login = async (vars: Record<string, string>) => (await appWith(new FakeSupabase(), vars).request("http://localhost/admin/login")).text();

describe("管理画面の名前とアイコン", () => {
  it("既定は Banto（番頭）と「番」", async () => {
    const html = await login({});
    expect(html).toContain('<span class="mark" aria-hidden="true">番</span>Banto（番頭）');
  });

  it("名前を変えると左上と題名に。アイコンは名前の最初の文字", async () => {
    const html = await login({ BANTO_ADMIN_NAME: "  acme ストア管理 " });
    expect(html).toContain('<span class="mark" aria-hidden="true">A</span>acme ストア管理');
    expect(html).toMatch(/<title>[^<]* · acme ストア管理<\/title>/);
    expect(html).not.toContain("Banto（番頭）</a>");
  });

  it("アイコンの画像の URL を入れると画像（https かこのサイトのパスだけ）", async () => {
    const html = await login({ BANTO_ADMIN_NAME: "ACME", BANTO_ADMIN_ICON_URL: "https://cdn.example.com/logo.png" });
    expect(html).toContain('<img class="mark" src="https://cdn.example.com/logo.png" alt="" width="28" height="28"/>ACME');
    expect(adminIconOf("/media/brand/logo.webp")).toBe("/media/brand/logo.webp");
    for (const bad of ["http://cdn.example.com/a.png", "javascript:alert(1)", "//evil.example/a.png", 'https://x.example/a.png" onerror="x', "data:image/png;base64,AAAA"]) expect(adminIconOf(bad)).toBeNull();
    expect(adminNameOf("a\u0000b".padEnd(60, "x"))).toHaveLength(40);
  });
});
