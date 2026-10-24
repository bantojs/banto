import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const other = sb.addUser("other@example.com", "password-456", { owner: true });
  // 公開中のショップでも他人のものは管理画面から見えないこと（RLS の公開ポリシー越しの漏れを防ぐ）
  const otherShop = sb.addShop(other.id, { slug: "other-shop", name: "他人の店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
  return { sb, owner, shop, other, otherShop, storage, app, b };
}

describe("ショップ設定（Step 4/5）", () => {
  it("設定を保存でき、法務3項目が空のままでは公開できない", async () => {
    const { b, shop, sb } = await setup();
    let html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("マイショップ");
    expect(html).toContain("特定商取引法に基づく表記");

    let res = await b.post(`/admin/shops/${shop.id}`, { name: "新しい名前", slug: "my-shop", published: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=publish_blocked`);
    expect(sb.shops[0]!.published).toBe(false);
    html = await (await b.get(`/admin/shops/${shop.id}?flash=publish_blocked`)).text();
    expect(html).toContain("3つを入力するまで公開できません");

    res = await b.post(`/admin/shops/${shop.id}`, {
      name: "新しい名前",
      slug: "my-shop",
      legal_notice: "表記",
      privacy_policy: "PP",
      return_policy: "RP",
      published: "on",
    });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=saved`);
    expect(sb.shops[0]).toMatchObject({ name: "新しい名前", published: true, legal_notice: "表記" });
  });

  it("他人のショップは 404", async () => {
    const { b, otherShop } = await setup();
    expect((await b.get(`/admin/shops/${otherShop.id}`)).status).toBe(404);
    expect((await b.post(`/admin/shops/${otherShop.id}`, { name: "乗っ取り" })).status).toBe(404);
    expect((await b.get(`/admin/shops/${otherShop.id}/products`)).status).toBe(404);
  });
});

describe("ショップの追加（ダッシュボード）", () => {
  it("2店舗目を追加でき、重複スラッグは弾く", async () => {
    const { b, sb } = await setup();
    let res = await b.post("/admin/shops", { name: "2号店", slug: "my-shop" });
    expect(res.headers.get("location")).toBe("/admin?flash=slug_taken");
    res = await b.post("/admin/shops", { name: "2号店", slug: "second" });
    const created = sb.shops.find((s) => s.slug === "second")!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${created.id}?flash=saved`);
    expect(created).toMatchObject({ name: "2号店", published: false });
    const html = await (await b.get("/admin")).text();
    expect(html).toContain("2号店");
  });
});

describe("商品管理（Step 4）", () => {
  it("商品を作成・編集し、一覧に出る", async () => {
    const { b, shop, sb } = await setup();
    let html = await (await b.get(`/admin/shops/${shop.id}/products`)).text();
    expect(html).toContain("商品がまだありません");

    let res = await b.post(`/admin/shops/${shop.id}/products/new`, { name: "Tシャツ", slug: "Bad Slug" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/new?flash=invalid_slug`);

    res = await b.post(`/admin/shops/${shop.id}/products/new`, { name: "Tシャツ", slug: "tee", description: "綿100%", tags: " 夏物, Tシャツ、夏物,, " });
    const product = sb.tables.products[0]!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/${product.id}?flash=saved`);
    expect(product).toMatchObject({ shop_id: shop.id, slug: "tee", published: false, description: "綿100%", tags: ["夏物", "Tシャツ"] });
    expect(await (await b.get(`/admin/shops/${shop.id}/products/${product.id}`)).text()).toContain('value="夏物, Tシャツ"');

    // 同じ slug は拒否
    res = await b.post(`/admin/shops/${shop.id}/products/new`, { name: "別", slug: "tee" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/new?flash=slug_taken`);

    // 編集 + 公開
    res = await b.post(`/admin/shops/${shop.id}/products/${product.id}`, { name: "Tシャツ（改）", slug: "tee", published: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/${product.id}?flash=saved`);
    expect(product).toMatchObject({ name: "Tシャツ（改）", published: true });

    html = await (await b.get(`/admin/shops/${shop.id}/products/${product.id}`)).text();
    expect(html).toContain("Tシャツ（改）");
    expect(html).toContain("ショップが非公開のため"); // shop 非公開の注意
    expect(html).toContain("SKU がありません");

    html = await (await b.get(`/admin/shops/${shop.id}/products`)).text();
    expect(html).toContain("Tシャツ（改）");
    expect(html).toContain("公開中");
  });

  it("SKU の追加・在庫更新・削除。在庫は set_stock を通る", async () => {
    const { b, shop, sb } = await setup();
    const product = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ" });
    const base = `/admin/shops/${shop.id}/products/${product.id}`;

    let res = await b.post(`${base}/skus`, { code: "TEE-M", name: "M", price_jpy: "3000", available: "5" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    const sku = sb.tables.skus[0]!;
    expect(sku).toMatchObject({ shop_id: shop.id, product_id: product.id, code: "TEE-M", price_jpy: 3000 });
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)).toMatchObject({ available: 5 });
    expect(sb.calls.some((c) => c.endsWith("/rest/v1/rpc/set_stock"))).toBe(true);

    res = await b.post(`${base}/skus`, { code: "TEE-M", price_jpy: "100" });
    expect(res.headers.get("location")).toBe(`${base}?flash=sku_taken`);
    res = await b.post(`${base}/skus`, { code: "TEE-L", price_jpy: "-1" });
    expect(res.headers.get("location")).toBe(`${base}?flash=sku_invalid`);

    const html = await (await b.get(base)).text();
    expect(html).toContain("TEE-M");
    expect(html).toContain("¥3,000");
    expect(html).toContain('value="5"');

    res = await b.post(`${base}/skus/${sku.id}/stock`, { available: "12" });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect(sb.tables.inventory.find((i) => i["sku_id"] === sku.id)).toMatchObject({ available: 12 });

    res = await b.post(`${base}/skus/${sku.id}/delete`, {});
    expect(sb.tables.skus).toHaveLength(0);
    expect(sb.tables.inventory).toHaveLength(0);
  });

  it("他人の商品・SKU は触れない", async () => {
    const { b, otherShop, sb, shop } = await setup();
    const theirs = sb.addProduct(otherShop.id, { slug: "secret", name: "秘密" });
    const theirSku = sb.addSku(otherShop.id, theirs.id, { code: "S-1", available: 3 });

    expect((await b.get(`/admin/shops/${otherShop.id}/products/${theirs.id}`)).status).toBe(404);
    // 自分の shop の URL に他人の product id を混ぜても 404
    expect((await b.get(`/admin/shops/${shop.id}/products/${theirs.id}`)).status).toBe(404);
    expect((await b.post(`/admin/shops/${shop.id}/products/${theirs.id}`, { name: "改ざん", slug: "secret" })).status).toBe(404);
    // 他人の SKU の在庫を自分の商品 URL 経由で書き換えようとしても RPC が拒否
    const mine = sb.addProduct(shop.id, { slug: "mine" });
    const res = await b.post(`/admin/shops/${shop.id}/products/${mine.id}/skus/${theirSku.id}/stock`, { available: "0" });
    expect(res.headers.get("location")).toContain("flash=generic");
    expect(sb.tables.inventory.find((i) => i["sku_id"] === theirSku.id)).toMatchObject({ available: 3 });
    expect(theirs["name"]).toBe("秘密");
  });

  it("画像のアップロード・配信・並び替え・削除（StorageAdapter 経由）", async () => {
    const { b, shop, sb, storage, app } = await setup();
    const product = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ" });
    const base = `/admin/shops/${shop.id}/products/${product.id}`;

    // 非対応形式
    let res = await b.postMultipart(`${base}/images`, { file: new File(["hello"], "x.txt", { type: "text/plain" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=image_type`);
    expect(storage.objects.size).toBe(0);

    // 大きすぎる
    res = await b.postMultipart(`${base}/images`, { file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=image_size`);

    // 正常
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    res = await b.postMultipart(`${base}/images`, { file: new File([png], "a.png", { type: "image/png" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect(storage.objects.size).toBe(1);
    const img = sb.tables.product_images[0]!;
    const key = img["storage_key"] as string;
    expect(key).toMatch(new RegExp(`^shops/${shop.id}/products/${product.id}/[0-9a-f]{24}\\.png$`));
    expect(img).toMatchObject({ shop_id: shop.id, product_id: product.id, sort_order: 0 });

    // 編集画面に <img> が出る
    const html = await (await b.get(base)).text();
    expect(html).toContain(`src="${BASE}/media/${key}"`);

    // /media/* で配信される
    const served = await app.request(`${BASE}/media/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect((await app.request(`${BASE}/media/nope.png`)).status).toBe(404);
    expect((await app.request(`${BASE}/media/../etc/passwd`)).status).toBe(404);

    // 2枚目は sort_order 1。並び替え
    res = await b.postMultipart(`${base}/images`, { file: new File([png], "b.webp", { type: "image/webp" }) });
    const img2 = sb.tables.product_images[1]!;
    expect(img2["sort_order"]).toBe(1);
    await b.post(`${base}/images/${img2["id"]}/sort`, { sort_order: "-1" });
    expect(img2["sort_order"]).toBe(-1);

    // 削除でストレージからも消える
    res = await b.post(`${base}/images/${img["id"]}/delete`, {});
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    expect(storage.objects.has(key)).toBe(false);
    expect(sb.tables.product_images).toHaveLength(1);

    // ブラウザ側で縮小したサムネイルと寸法つき（管理画面のスクリプトが送る形）
    res = await b.postMultipart(`${base}/images`, {
      file: new File([png], "c.webp", { type: "image/webp" }),
      thumb: new File([png], "thumb.webp", { type: "image/webp" }),
      width: "1600",
      height: "1200",
    });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    const img3 = sb.tables.product_images.find((i) => i["width"] === 1600)!;
    expect(img3).toMatchObject({ height: 1200 });
    const tkey = img3["thumb_key"] as string;
    expect(tkey).toBe((img3["storage_key"] as string).replace(/\.webp$/, ".thumb.webp"));
    expect(storage.objects.has(tkey)).toBe(true);
    // 寸法が片方だけ・不正なら保存しない。サムネイルが画像でなければ拒否
    res = await b.postMultipart(`${base}/images`, { file: new File([png], "d.webp", { type: "image/webp" }), width: "100", height: "abc" });
    expect(sb.tables.product_images.at(-1)).toMatchObject({ width: null, height: null, thumb_key: null });
    res = await b.postMultipart(`${base}/images`, { file: new File([png], "e.webp", { type: "image/webp" }), thumb: new File(["x"], "t.txt", { type: "text/plain" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=image_type`);
    // サムネイル付きの画像を削除すると両方消える
    res = await b.post(`${base}/images/${img3["id"]}/delete`, {});
    expect(storage.objects.has(tkey)).toBe(false);
    expect(storage.objects.has(img3["storage_key"] as string)).toBe(false);
    // 編集画面に縮小スクリプトが入っている
    expect(await (await b.get(base)).text()).toContain('id="image-form"');

    // 商品削除で残りの画像も消える
    await b.post(`${base}/delete`, {});
    expect(storage.objects.size).toBe(0);
    expect(sb.tables.products).toHaveLength(0);
    expect(sb.tables.product_images).toHaveLength(0);
  });

  it("未ログインでは商品管理に入れない", async () => {
    const { app, shop } = await setup();
    const anon = new Browser(app);
    const res = await anon.get(`/admin/shops/${shop.id}/products`);
    expect(res.headers.get("location")).toBe("/admin/login");
    const post = await anon.post(`/admin/shops/${shop.id}/products/new`, { name: "x", slug: "x" });
    expect(post.headers.get("location")).toBe("/admin/login");
  });
});
