import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, memberLogin, memberMail, quoteFrom } from "./helpers";

/** 会員価格（0099、docs/audiences.md「会員価格」）: 表示・カート・決済の額・予約の単価・管理画面 */

const GOLD = "11111111-1111-4111-8111-111111111111";
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  externalHosts.clear();
});

function setup() {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected",
    settings: { members_enabled: true, modules: { audiences: true }, shipping: { mode: "flat", flat_fee_jpy: 0, free_over_jpy: 0, by_prefecture: {} }, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }] },
  });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, tags: ["sale"] });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  sb.tables.price_rules.push({ id: "pr-1", shop_id: shop.id, name: "ゴールド 20%", audience_id: GOLD, product_ids: [], sku_ids: [], product_condition: { tag: ["sale"] }, price_jpy: null, percent_off: 20, starts_at: null, ends_at: null, enabled: true });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "silver@example.com", session_epoch: 0, attributes: { rank: "silver" } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, stripe, shop, tee, teeM, app, mail };
}

describe("会員価格", () => {
  it("ゲストには「会員価格」を並べて見せ、カートは通常の価格。合う会員はカート・決済の額・予約の単価が会員価格", async () => {
    const { app, mail, teeM, stripe, sb } = setup();
    const guest = new Browser(app, BASE);
    const gh = await (await guest.get("/my-shop/products/tee")).text();
    expect(gh).toContain("会員価格 ¥2,400");
    expect(gh).toContain("¥3,000（会員価格 ¥2,400）");
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    const mh = await (await gold.get("/my-shop/products/tee")).text();
    expect(mh).toContain("会員価格 ¥2,400（通常 ¥3,000）");
    await gold.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    expect(await (await gold.get("/my-shop/cart")).text()).toContain("¥4,800");
    const html = await (await gold.post("/my-shop/checkout/stripe", ADDRESS)).text();
    const res = await gold.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    const session = [...stripe.sessions.values()][0]!;
    expect(session.params.get("line_items[0][price_data][unit_amount]")).toBe("2400");
    expect((sb.tables.reservations[0]!["items"] as { unit_price_jpy: number }[])[0]!.unit_price_jpy).toBe(2400);
    // 合わない会員は通常の価格（ゲストに見せる会員価格は出さない）
    const silver = new Browser(app, BASE);
    await memberLogin(silver, mail, "/my-shop", "silver@example.com");
    const sh = await (await silver.get("/my-shop/products/tee")).text();
    expect(sh).toContain("¥3,000");
    expect(sh).not.toContain("会員価格 ¥2,400（通常");
  });

  it("最終確認のあとで会員価格が変わったら確定しない（予約を戻す）", async () => {
    const { app, mail, teeM, stripe, sb } = setup();
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    await gold.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const html = await (await gold.post("/my-shop/checkout/stripe", ADDRESS)).text();
    // 確認画面を出したあとで決まりを変える（予約の写し直しは 50% 引きになる）
    sb.tables.price_rules[0]!["percent_off"] = 50;
    const res = await gold.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(stripe.sessions.size).toBe(0);
    expect(res.status === 409 || res.headers.get("location")?.includes("error=")).toBe(true);
  });

  it("ヘッドレス: SKU に regular_price_jpy と member_price_jpy", async () => {
    const { app } = setup();
    const j = (await (await app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { skus: { price_jpy: number; regular_price_jpy: number; member_price_jpy: number | null }[] } };
    expect(j.product.skus[0]).toMatchObject({ price_jpy: 3000, regular_price_jpy: 3000, member_price_jpy: 2400 });
  });

  it("管理画面: 会員価格を作る（slug・品番で指定。無いものは保存せずに知らせる）", async () => {
    const { app, shop, sb } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/audiences/prices`;
    expect(await (await b.get(base)).text()).toContain("ゴールド 20%");
    const bad = await b.post(base, { name: "x", audience_id: GOLD, products: "nope", kind: "price", amount: "1000", enabled: "on" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("見つからない商品があります: nope");
    const ok = await b.post(base, { name: "固定", audience_id: GOLD, skus: "TEE-M", kind: "price", amount: "2000", enabled: "on" });
    expect(ok.headers.get("location")).toContain("flash=saved");
    expect(sb.tables.price_rules.find((r) => r["name"] === "固定")).toMatchObject({ price_jpy: 2000, percent_off: null, product_condition: null });
  });
});
