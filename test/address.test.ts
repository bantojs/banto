import { describe, expect, it } from "vitest";
import { classifyHost, isPublicIp, parseIPv6 } from "../src/media/address";

/** 外から渡された URL の行き先の判定（監査 M12）。ホスト名は new URL() が正規化した形で渡ってくる */
const host = (u: string) => classifyHost(new URL(u).hostname);

describe("行き先の判定（src/media/address.ts）", () => {
  it("社内の IPv4 は、どの書き方でも断る（URL が 10 進に直した形で判定する）", () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://100.64.0.1/", // CGNAT（前の判定の抜け）
      "http://100.127.255.255/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://192.0.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
    ])
      expect(host(u), u).toBe("blocked");
    for (const u of ["http://8.8.8.8/", "http://172.32.0.1/", "http://100.128.0.1/", "http://1.1.1.1/"]) expect(host(u), u).toBe("public");
  });

  it("IPv6: 手元・ULA・リンクローカル、IPv4 を埋め込む形（射影・NAT64・6to4）は中の IPv4 で", () => {
    for (const u of [
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/", // 前の判定の抜け
      "http://[::ffff:a9fe:a9fe]/",
      "http://[::127.0.0.1]/",
      "http://[64:ff9b::a9fe:a9fe]/", // NAT64 で 169.254.169.254
      "http://[2002:a9fe:a9fe::1]/", // 6to4 で 169.254.169.254
      "http://[2001::1]/", // Teredo
      "http://[2001:db8::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
    ])
      expect(host(u), u).toBe("blocked");
    for (const u of ["http://[2606:4700::1111]/", "http://[64:ff9b::808:808]/", "http://[2002:808:808::1]/", "http://[::ffff:8.8.8.8]/"]) expect(host(u), u).toBe("public");
  });

  it("名前: 社内でしか引けない名前とドットの無い名前は断る。普通のドメインは誤って断らない", () => {
    for (const u of ["http://localhost/", "http://LOCALHOST./", "http://api.localhost/", "http://printer.local/", "http://metadata.google.internal/", "http://nas.home.arpa/", "http://metadata/", "http://router.lan/"])
      expect(host(u), u).toBe("blocked");
    // 前の判定（文字列の前方一致）は、fc / fd / fe80 で始まる普通のドメインまで断っていた
    for (const u of ["https://fcbarcelona.com/a.png", "https://fdx.com/a.png", "https://fe80.example.com/a.png", "https://images.example.com/a.png", "https://例え.jp/a.png", "https://localhost.example.com/a.png"])
      expect(host(u), u).toBe("name");
  });

  it("引いた先のアドレス（Node の publicFetch が使う）", () => {
    expect(isPublicIp("93.184.216.34")).toBe(true);
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIp("fe80::1%eth0")).toBe(false);
    expect(isPublicIp("not an ip")).toBe(false);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("::")).toEqual(new Uint8Array(16));
  });
});
