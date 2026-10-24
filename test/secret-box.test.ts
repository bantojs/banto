import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "../src/members/secret-box";

describe("提供元の秘密の暗号化（secret-box）", () => {
  it("同じサイトの秘密・ショップ・用途でだけ開ける。暗号文は毎回変わり、平文を含まない", async () => {
    const box = await sealSecret("site-secret", "shop-1", "oauth:google", "client-secret-xyz");
    expect(box).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(box).not.toContain("client-secret-xyz");
    expect(await sealSecret("site-secret", "shop-1", "oauth:google", "client-secret-xyz")).not.toBe(box);
    expect(await openSecret("site-secret", "shop-1", "oauth:google", box)).toBe("client-secret-xyz");
    // 別のショップの行・別の提供元に移した暗号文、サイトの秘密が変わった、改ざん
    expect(await openSecret("site-secret", "shop-2", "oauth:google", box)).toBeNull();
    expect(await openSecret("site-secret", "shop-1", "oauth:line", box)).toBeNull();
    expect(await openSecret("other-secret", "shop-1", "oauth:google", box)).toBeNull();
    const mid = box.length - 10;
    const tampered = `${box.slice(0, mid)}${box[mid] === "A" ? "B" : "A"}${box.slice(mid + 1)}`;
    expect(await openSecret("site-secret", "shop-1", "oauth:google", tampered)).toBeNull();
    expect(await openSecret("site-secret", "shop-1", "oauth:google", "garbage")).toBeNull();
  });
});
