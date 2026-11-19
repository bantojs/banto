import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { ADDRESS, Browser, appWith, externalHosts, memberLogin, memberMail, quoteFrom } from "./helpers";
import { MEMBER_ADDRESS_MIGRATION } from "../src/commerce/checkout";

/** 会員の注文のお届け先を既定の住所に写す（0159）。DB の判定は test/db/member-address-from-order.test.ts */
afterEach(() => externalHosts.clear());

function setup(saved: Record<string, unknown> | null = null) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_connected",
    settings: { members_enabled: true, shipping: { mode: "flat", flat_fee_jpy: 500 }, contact_email: "shop@example.com", modules: { cod: true }, cod: { fee_type: "flat", fee_jpy: 330 } },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 10 });
  const member = { id: crypto.randomUUID(), shop_id: shop.id, email: "member@example.com", session_epoch: 0, attributes: {}, default_address: saved };
  sb.tables.customers.push(member);
  const mail = memberMail(sb, shop.id);
  return { sb, shop, sku, member, mail, app: appWith(sb, { RESEND_API_KEY: "re_test" }) };
}

async function order(b: Browser, skuId: string, address: Record<string, string>) {
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty: "1" });
  const html = await (await b.post("/my-shop/checkout/cod", address)).text();
  return b.post("/my-shop/checkout/cod", { quote: quoteFrom(html) });
}

describe("会員の住所の保存（0159）", () => {
  it("既定の住所が無い会員: レジに「保存します」のお知らせ、注文の確定で住所が入る", async () => {
    const { sku, member, mail, app } = setup();
    const b = new Browser(app);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const page = await (await b.post("/my-shop/checkout", { provider: "cod" })).text();
    expect(page).toContain("ご注文のお届け先を会員情報に保存し");
    expect(page).not.toContain('name="save_address"');
    const html = await (await b.post("/my-shop/checkout/cod", ADDRESS)).text();
    expect((await b.post("/my-shop/checkout/cod", { quote: quoteFrom(html) })).status).toBe(303);
    expect(member.default_address).toMatchObject({ name: ADDRESS.customer_name, postal_code: ADDRESS.postal_code, state: ADDRESS.state, city: ADDRESS.city, line1: ADDRESS.line1 });
    // 次の注文では欄が埋まる
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const next = await (await b.post("/my-shop/checkout", { provider: "cod" })).text();
    expect(next).toContain(`value="${ADDRESS.line1}"`);
    expect(next).toContain('name="save_address"');
  });

  it("既定の住所がある会員: 選んだときだけ上書きする。修正するで戻っても選んだまま", async () => {
    const saved = { name: "前の名前", phone: "0300000000", postal_code: "1000001", country: "JP", state: "東京都", city: "千代田区", line1: "前の番地", line2: null };
    const { sku, member, mail, app } = setup(saved);
    const b = new Browser(app);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const other = { ...ADDRESS, line1: "新しい番地 1-2-3" };
    await order(b, sku.id, other);
    expect(member.default_address).toEqual(saved);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const review = await (await b.post("/my-shop/checkout/cod", { ...other, save_address: "1" })).text();
    expect(review).toContain('name="save_address" value="1"');
    expect((await b.post("/my-shop/checkout/cod", { quote: quoteFrom(review) })).status).toBe(303);
    expect(member.default_address).toMatchObject({ line1: "新しい番地 1-2-3" });
  });

  it("ゲストには出さない。0159 を当てる前の DB にも出さない", async () => {
    const { sb, sku, mail } = setup();
    const guest = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    await guest.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const page = await (await guest.post("/my-shop/checkout", { provider: "cod" })).text();
    expect(page).not.toContain("会員情報に保存");
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== MEMBER_ADDRESS_MIGRATION);
    const old = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    await memberLogin(old, mail, "/my-shop", "member@example.com");
    await old.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await (await old.post("/my-shop/checkout", { provider: "cod" })).text()).not.toContain("会員情報に保存");
  });
});
