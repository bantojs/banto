import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("ショップの独自ドメイン（0015）", () => {
  let a: Fixture;
  let b: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "a@example.com", slug: "shop-a", publish: true });
    b = await createShopFixture({ email: "b@example.com", slug: "shop-b", publish: false });
  });
  afterAll(closePool);

  const setDomain = (f: Fixture, domain: string | null) => asUser(f.ownerId, (c) => c.query("update shops set domain = $1 where id = $2", [domain, f.shopId]));

  it("運営者が自分のショップに付けられる。形の違うもの・大文字は DB が断る", async () => {
    await setDomain(a, "shop.example.jp");
    for (const bad of ["Shop.example.jp", "localhost", "shop.example.jp/", "-x.example.jp", "a..jp", "https://shop.example.jp"]) {
      expect(await expectDbError(() => setDomain(a, bad)), bad).toMatch(/shops_domain_format/);
    }
  });

  it("同じドメインを 2 つのショップに付けられない。null（なし）はいくつでも", async () => {
    expect(await expectDbError(() => setDomain(b, "shop.example.jp"))).toMatch(/shops_domain_key/);
    await setDomain(b, null);
    await setDomain(b, "b.example.jp");
    await setDomain(b, null);
  });

  it("公開中のショップのドメインは anon から引ける（ホスト名 → ショップ）。非公開のショップは見えない", async () => {
    await setDomain(b, "b.example.jp");
    const rows = (host: string) => asAnon(async (c) => (await c.query<{ slug: string }>("select slug from shops where domain = $1", [host])).rows);
    expect(await rows("shop.example.jp")).toEqual([{ slug: "shop-a" }]);
    expect(await rows("b.example.jp")).toEqual([]);
  });

  it("ほかの運営者のショップのドメインは変えられない（RLS）", async () => {
    await asUser(b.ownerId, (c) => c.query("update shops set domain = 'evil.example.jp' where id = $1", [a.shopId]));
    const d = await asAnon(async (c) => (await c.query<{ domain: string }>("select domain from shops where id = $1", [a.shopId])).rows[0]!.domain);
    expect(d).toBe("shop.example.jp");
  });
});
