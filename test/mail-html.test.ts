import { describe, expect, it } from "vitest";
import { mailAccent, mailLogo, renderMailHtml } from "../src/mail/html";

describe("会員へのメールの HTML（src/mail/html.ts）", () => {
  it("色とロゴは形を確かめてから使い、だめなら既定・無し", () => {
    expect(mailAccent({ theme_settings: { accent_color: "#123abc" } })).toBe("#123abc");
    expect(mailAccent({ theme_settings: { accent_color: "red;background:url(x)" } })).toBe("#1f6feb");
    expect(mailAccent({})).toBe("#1f6feb");
    expect(mailLogo({ theme_settings: { logo_url: "https://x.example/l.png" } })).toBe("https://x.example/l.png");
    expect(mailLogo({ theme_settings: { logo_url: "http://x.example/l.png" } })).toBeNull();
    expect(mailLogo({ theme_settings: { logo_url: "javascript:alert(1)" } })).toBeNull();
  });

  it("ボタンは http(s) の URL だけ。本文はエスケープし、改行は <br>", () => {
    const html = renderMailHtml({ name: "S" }, { heading: "h", paragraphs: ['a\n"<x>"'], button: { label: "go", url: "javascript:alert(1)" } });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("a<br>&quot;&lt;x&gt;&quot;");
    expect(renderMailHtml({ name: "S" }, { heading: "h", paragraphs: [], button: { label: "go", url: "https://s.example/a?b=1&c=2" } })).toContain('href="https://s.example/a?b=1&amp;c=2"');
  });
});
