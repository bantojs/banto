import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, tinyPng } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { cleanAttributes, parseFieldDefinitions, publicAttributes } from "../src/products/fields";
import { parseCustomerFieldDefinitions } from "../src/customers/fields";
import { fieldsFromForm, parseArticleFieldRows } from "../src/blog/fields";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

/** 独自の項目の「画像」（商品のカスタム項目と記事の項目 0120、メンテナの決定 2026-11-05、src/routes/admin/field-image.tsx） */

const MEDIA = `${BASE}/media`;

describe("値の形", () => {
  it("商品: image はこのショップの画像の置き場のものだけ（ほかのホストの /media/ はホストを外す、外の画像は捨てる）。会員の項目には無い", () => {
    const fields = parseFieldDefinitions("photo | 素材の写真 | image\nnote | メモ | text");
    expect(fields[0]).toMatchObject({ key: "photo", type: "image", public: true });
    expect(cleanAttributes(fields, { photo: `${MEDIA}/fields/s/a.webp` }, MEDIA)).toEqual({ photo: `${MEDIA}/fields/s/a.webp` });
    expect(cleanAttributes(fields, { photo: "https://other.example/media/fields/s/a.webp" }, MEDIA)).toEqual({ photo: "/media/fields/s/a.webp" });
    expect(cleanAttributes(fields, { photo: "https://evil.example/x.png" }, MEDIA)).toEqual({});
    expect(cleanAttributes(fields, { photo: "javascript:alert(1)" }, MEDIA)).toEqual({});
    expect(publicAttributes(fields, { photo: "/media/a.webp" })).toEqual([{ key: "photo", label: "素材の写真", type: "image", value: "/media/a.webp" }]);
    expect(parseCustomerFieldDefinitions("photo | 写真 | image\nrank | ランク | text").map((f) => f.key)).toEqual(["rank"]);
  });

  it("記事: image は 0120 が当たってから。フォームの値は置き場のものだけ", () => {
    const blogs: { id: string; handle: string }[] = [];
    expect(parseArticleFieldRows("photo | 写真 | image", blogs).error).toBe("photo | 写真 | image");
    const { defs, error } = parseArticleFieldRows("photo | 写真 | image", blogs, { image: true });
    expect(error).toBeNull();
    expect(defs).toEqual([{ key: "photo", label: "写真", type: "image" }]);
    expect(fieldsFromForm(defs, { field_photo: ` ${MEDIA}/fields/s/a.webp ` }, MEDIA)).toEqual({ photo: `${MEDIA}/fields/s/a.webp` });
    expect(fieldsFromForm(defs, { field_photo: "https://evil.example/x.png" }, MEDIA)).toEqual({});
  });
});

function setup(opts: { applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "S",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { modules: { blog: true, pages: true }, product_fields: [{ key: "photo", label: "素材の写真", type: "image" }] },
  });
  const coat = sb.addProduct(shop.id, { slug: "coat", name: "コート", published: true });
  sb.addSku(shop.id, String(coat["id"]), { code: "coat", name: "F", price_jpy: 1000, available: 1 });
  const staff = sb.addBlog(shop.id, { id: crypto.randomUUID(), handle: "staff", title: "スタッフ", article_fields: [{ key: "photo", label: "写真", type: "image" }] });
  const amada = sb.addArticle(shop.id, staff.id, { id: crypto.randomUUID(), handle: "amada", title: "天田", published: true });
  const storage = new MemoryStorage(MEDIA);
  return { sb, shop, coat, staff, amada, storage, app: appWith(sb, {}, storage) };
}

describe("商品のカスタム項目の画像", () => {
  it("管理画面で画像を置いて URL を入れ、商品の保存で書く。お店の画面と ::: product show=field: は <img> で描く", async () => {
    const { sb, shop, coat, storage, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const form = await (await admin.get(`/admin/shops/${shop.id}/products/${coat["id"]}`)).text();
    expect(form).toContain(`data-field-image="/admin/shops/${shop.id}/products/field-image"`);

    let res = await admin.postMultipart(`/admin/shops/${shop.id}/products/field-image`, { image: new File([tinyPng()], "a.png", { type: "image/png" }) });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${MEDIA}/fields/${shop.id}/[^/]+\\.png$`));
    expect(storage.objects.size).toBe(1);
    res = await admin.postMultipart(`/admin/shops/${shop.id}/products/field-image`, { image: new File([new TextEncoder().encode("<html>")], "a.png", { type: "image/png" }) });
    expect(res.status).toBe(400);

    res = await admin.post(`/admin/shops/${shop.id}/products/${coat["id"]}`, { name: "コート", slug: "coat", attr_photo: url, published: "on" });
    expect(res.status).toBe(302);
    expect(coat["attributes"]).toEqual({ photo: url });
    await admin.post(`/admin/shops/${shop.id}/products/${coat["id"]}`, { name: "コート", slug: "coat", attr_photo: "https://evil.example/x.png", published: "on" });
    expect(coat["attributes"]).toEqual({});
    await admin.post(`/admin/shops/${shop.id}/products/${coat["id"]}`, { name: "コート", slug: "coat", attr_photo: url, published: "on" });

    sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "pick", title: "P", body: "::: product slug=coat show=name,field:photo", published: true });
    const b = new Browser(app, BASE);
    expect(await (await b.get("/my-shop/products/coat")).text()).toContain(`<td><img src="${url}" alt="素材の写真" loading="lazy"`);
    expect(await (await b.get("/my-shop/pages/pick")).text()).toContain(`<span class="banto-product__field-value"><img src="${url}" alt="素材の写真" loading="eager" fetchpriority="high"></span>`); // ページの最初の画像はすぐ読む（src/pages/lead-image.ts）
  });
});

describe("記事の項目の画像（0120）", () => {
  it("定義・画像を置く・記事の保存・ひな形の part=field: で <img>", async () => {
    const { sb, shop, staff, amada, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/blog`;
    expect((await admin.post(`${base}/${staff.id}/fields`, { rows: "photo | 写真 | image\nheight | 身長 | number" })).headers.get("location")).toContain("flash=fields_saved");
    const form = await (await admin.get(`${base}/${staff.id}/articles/${amada["id"]}`)).text();
    expect(form).toContain(`data-field-image="${base}/field-image"`);
    const up = await admin.postMultipart(`${base}/field-image`, { image: new File([tinyPng()], "a.png", { type: "image/png" }) });
    const { url } = (await up.json()) as { url: string };
    const save = { title: "天田", handle: "amada", body: "", tags: "", excerpt: "", author: "", published_at: "", image_url: "", seo_title: "", seo_description: "", template_suffix: "", action: "update", published: "on" };
    expect((await admin.post(`${base}/${staff.id}/articles/${amada["id"]}`, { ...save, field_photo: url, field_height: "158" })).status).toBe(302);
    expect(amada["fields"]).toEqual({ photo: url, height: 158 });

    const tpl = sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "tpl-staff", title: "t", body: "::: current part=title\n\n::: current part=field:photo" });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { articles: { [staff.id]: tpl.id } };
    expect(await (await new Browser(app, BASE).get("/my-shop/blogs/staff/amada")).text()).toContain(`<img class="banto-field banto-field--photo banto-field--image" src="${url}" alt="写真" loading="eager" fetchpriority="high">`); // ひな形の最初の画像はすぐ読む
  });

  it("0120 の前は image の定義を保存しない", async () => {
    const { staff, shop, app } = setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0120_article_field_image") });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.post(`/admin/shops/${shop.id}/modules/blog/${staff.id}/fields`, { rows: "photo | 写真 | image" })).status).toBe(400);
  });

  it("AI 用 API: 記事の保存の画像の項目は置き場のものだけ（外の画像は 400、ほかのホストの /media/ はホストを外す）", async () => {
    const { sb, shop, app } = setup();
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: sb.tables.shops[0]!["owner_id"], name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["content:read", "content:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const rest = (body: unknown) => app.request(`${BASE}/api/v1/blogs/staff/articles`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await rest({ handle: "amada", fields: { photo: "https://evil.example/x.png" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/^article_field_invalid:photo/);
    res = await rest({ handle: "amada", fields: { photo: "https://other.example/media/fields/s/a.webp" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { fields?: Record<string, unknown> }).fields ?? sb.tables.articles.find((a) => a["handle"] === "amada")!["fields"]).toMatchObject({ photo: "/media/fields/s/a.webp" });
  });
});
