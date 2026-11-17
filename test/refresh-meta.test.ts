import { describe, expect, it } from "vitest";
import { refreshMeta } from "../src/routes/storefront/liquid";

describe("完了画面の読み込み直し（Liquid のテーマ）", () => {
  it("URL があれば # の無い URL を明示し、属性の中でエスケープする", () => {
    expect(refreshMeta(4, "/checkout/done?s=a.b&x=1")).toBe('<meta http-equiv="refresh" content="4;url=/checkout/done?s=a.b&amp;x=1">');
    expect(refreshMeta(4, '/x"><script>')).not.toContain('"><script>');
    expect(refreshMeta(4, null)).toBe('<meta http-equiv="refresh" content="4">');
  });
});
