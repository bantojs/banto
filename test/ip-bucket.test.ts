import { describe, expect, it } from "vitest";
import { ipBucket, ipHash } from "../src/members/auth";

describe("回数の制限で「同じ IP」とみなす単位（IPv6 は /64）", () => {
  it("IPv4 はそのまま、IPv6 は上位 64 ビットに丸める", () => {
    expect(ipBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("2001:db8:abcd:0012:0000:0000:0000:0001")).toBe("2001:db8:abcd:12::/64");
    expect(ipBucket("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(ipBucket("2001:DB8:ABCD:12::FFFF")).toBe("2001:db8:abcd:12::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("not-an-ip")).toBe("not-an-ip");
  });
  it("同じ /64 の 2 つの IP は同じハッシュ、別の /64 は別", async () => {
    const a = await ipHash("s", "2001:db8:abcd:12::1");
    const b = await ipHash("s", "2001:db8:abcd:12:ffff:ffff:ffff:ffff");
    const c = await ipHash("s", "2001:db8:abcd:13::1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("お店の画面の経路の壊れたパーセント符号", () => {
  it("/%E0%A4%A は 500 ではなく 404", async () => {
    const { FakeSupabase } = await import("./fake-supabase");
    const { appWith, BASE } = await import("./helpers");
    const app = appWith(new FakeSupabase());
    const res = await app.request(`${BASE}/%E0%A4%A`);
    expect(res.status).toBe(404);
    const res2 = await app.request(`${BASE}/%E0%A4%A/products/x`);
    expect(res2.status).toBe(404);
  });
});
