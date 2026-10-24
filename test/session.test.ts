import { describe, expect, it } from "vitest";
import { generateSecret, openSession, sealSession, type SessionData } from "../src/auth/session";

const data: SessionData = { access_token: "a", refresh_token: "r", expires_at: 123, user_id: "u1", email: "x@example.com" };

describe("封をしたセッション Cookie（0030: AES-GCM。refresh_token は平文で載らない）", () => {
  it("seal → open で元に戻る", async () => {
    const sealed = await sealSession("secret", data);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sealed.split(".")[2]!, "base64url").toString("utf8")).not.toContain("refresh_token");
    expect(await openSession("secret", sealed)).toEqual(data);
    expect(await openSession("secret", await sealSession("secret", { ...data, epoch: 3 }))).toEqual({ ...data, epoch: 3 });
  });

  it("別の secret・改ざん・壊れた形式は null", async () => {
    const sealed = await sealSession("secret", data);
    expect(await openSession("other", sealed)).toBeNull();
    expect(await openSession("secret", `${sealed}x`)).toBeNull();
    const [v, iv, ct] = sealed.split(".");
    // 置き換える文字が元と同じだと改ざんにならない（1/64 で落ちるフレークだった）。必ず違う文字にする
    const flip = (c: string) => (c === "A" ? "B" : "A");
    expect(await openSession("secret", `${v}.${iv}.${flip(ct![0]!)}${ct!.slice(1)}`)).toBeNull();
    expect(await openSession("secret", `${v}.${iv}A.${ct}`)).toBeNull();
    expect(await openSession("secret", "garbage")).toBeNull();
    expect(await openSession("secret", undefined)).toBeNull();
    expect(await openSession("secret", "")).toBeNull();
  });

  it("generateSecret は URL セーフで十分な長さ", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(generateSecret()).not.toBe(s);
  });
});
