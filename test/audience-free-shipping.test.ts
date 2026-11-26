import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, externalHosts, memberLogin, memberMail, quoteFrom } from "./helpers";
import { audienceFreeRules, freeShippingTarget, memberFreeOverHint, parseShippingSettings, publicShipping, shippingQuote } from "../src/commerce/shipping";
import { freeShippingObject } from "../src/routes/storefront/liquid";
import { publicShopSettings } from "../src/storefront/data";
import { audienceFreeRulesFromForm } from "../src/routes/admin/shops";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/** 会員の条件ごとの送料無料の金額（0171、docs/audiences.md「会員の条件ごとの送料無料」） */

const GOLD = "11111111-1111-4111-8111-111111111111";
const SILVER = "22222222-2222-4222-8222-222222222222";
const PARAM = "33333333-3333-4333-8333-333333333333";

describe("送料の計算（shipping.ts）", () => {
  const base = parseShippingSettings({ mode: "flat", flat_fee_jpy: 800, free_over_jpy: 5000, by_prefecture: {} });
  it("会員の金額が無ければ今までどおり。ショップ全体の金額で無料なら理由は threshold", () => {
    expect(shippingQuote(base, 4000, "東京都")).toEqual({ fee: 800, free_reason: null });
    expect(shippingQuote(base, 5000, "東京都")).toEqual({ fee: 0, free_reason: "threshold" });
  });
  it("会員の金額（低い方）で無料なら audience。0 = いつでも無料。届かなければ送料", () => {
    expect(shippingQuote(base, 3000, "東京都", 3000)).toEqual({ fee: 0, free_reason: "audience" });
    expect(shippingQuote(base, 2999, "東京都", 3000)).toEqual({ fee: 800, free_reason: null });
    expect(shippingQuote(base, 1, "東京都", 0)).toEqual({ fee: 0, free_reason: "audience" });
    // ショップ全体のほうが低ければそちら
    expect(shippingQuote(base, 6000, "東京都", 8000)).toEqual({ fee: 0, free_reason: "threshold" });
  });
  it("都道府県別でも効く。もともと 0 円の地域は理由なし", () => {
    const pref = parseShippingSettings({ mode: "by_prefecture", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: { 沖縄県: 2000, 東京都: 0 } });
    expect(shippingQuote(pref, 1000, "沖縄県", 0)).toEqual({ fee: 0, free_reason: "audience" });
    expect(shippingQuote(pref, 1000, "沖縄県", 5000)).toEqual({ fee: 2000, free_reason: null });
    expect(shippingQuote(pref, 1000, "東京都", 0)).toEqual({ fee: 0, free_reason: null });
  });
  it("決まりの読み方: 形の違う行・重なる条件を捨て、10 件まで。名前は 40 文字", () => {
    const rules = audienceFreeRules([
      { audience_id: GOLD, free_over_jpy: 0, label: " ゴールド会員 " },
      { audience_id: GOLD, free_over_jpy: 100 },
      { audience_id: "nope", free_over_jpy: 0 },
      { audience_id: SILVER, free_over_jpy: -1 },
      { audience_id: SILVER, free_over_jpy: 3000, label: "x".repeat(50) },
      ...Array.from({ length: 20 }, (_, i) => ({ audience_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, free_over_jpy: i })),
    ]);
    expect(rules[0]).toEqual({ audience_id: GOLD, free_over_jpy: 0, label: "ゴールド会員", exclude_sale: false });
    expect(rules[1]).toEqual({ audience_id: SILVER, free_over_jpy: 3000, label: "x".repeat(40), exclude_sale: false });
    expect(rules).toHaveLength(10);
  });
  it("公開の形: 名前を付けた決まりの名前と金額だけ（id・名前の無い決まりは出さない）。読み直すと案内と『決まりがある』だけが分かる", () => {
    const raw = { mode: "flat", flat_fee_jpy: 800, free_over_jpy: 5000, by_prefecture: {}, free_over_by_audience: [{ audience_id: GOLD, free_over_jpy: 0, label: "ゴールド会員" }, { audience_id: SILVER, free_over_jpy: 3000 }] };
    const pub = publicShopSettings({ shipping: raw })["shipping"] as Record<string, unknown>;
    expect(pub).toEqual(publicShipping(raw));
    expect(pub["free_over_by_audience"]).toEqual([{ label: "ゴールド会員", free_over_jpy: 0, exclude_sale: false }]);
    expect(pub["member_free"]).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(GOLD);
    expect(JSON.stringify(pub)).not.toContain("3000");
    const parsed = parseShippingSettings(pub);
    expect(parsed.free_over_by_audience).toEqual([]);
    expect(parsed.has_member_free).toBe(true);
    expect(parsed.member_free).toEqual([{ label: "ゴールド会員", free_over_jpy: 0, exclude_sale: false }]);
    // 決まりが無ければ member_free も無い
    expect(publicShipping({ mode: "flat", flat_fee_jpy: 800, free_over_by_audience: [{ audience_id: "nope", free_over_jpy: 0 }] })).toEqual({ mode: "flat", flat_fee_jpy: 800 });
    expect(parseShippingSettings({ mode: "flat", flat_fee_jpy: 800 }).has_member_free).toBe(false);
  });
  it("カートの目安: 当てはまる条件のいちばん低い金額（ゲスト・金額の無い条件・合わない条件は見ない）と、ショップ全体の低い方", () => {
    const list = [
      { condition: { attr: "rank", in: ["gold"] }, free_over_jpy: 0 },
      { condition: { attr: "rank", in: ["gold", "silver"] }, free_over_jpy: 3000 },
      { condition: { member: true } },
    ];
    expect(memberFreeOverHint(list, { member: true, attrs: { rank: "gold" } })).toBe(0);
    expect(memberFreeOverHint(list, { member: true, attrs: { rank: "silver" } })).toBe(3000);
    expect(memberFreeOverHint(list, { member: true, attrs: { rank: "regular" } })).toBeNull();
    expect(memberFreeOverHint(list, { member: false, attrs: { rank: "gold" } })).toBeNull();
    expect(freeShippingTarget(10000, 3000)).toEqual({ over: 3000, member: true });
    expect(freeShippingTarget(10000, null)).toEqual({ over: 10000, member: false });
    expect(freeShippingTarget(2000, 3000)).toEqual({ over: 2000, member: false });
    expect(freeShippingTarget(null, 0)).toEqual({ over: 0, member: true });
    expect(freeShippingTarget(null, null)).toEqual({ over: null, member: false });
  });
  it("Liquid の cart.banto_free_shipping: 金額・あといくら・届いたか・会員特典か（金額が無ければ null）", () => {
    const info = (viewerFreeOver: number | null, member: boolean) => ({ summary: "", freeOver: 10000, table: null, taxRate: 0.1, viewerFreeOver, viewerFreeMember: member });
    const silver = freeShippingObject(info(3000, true), 2000)!;
    expect(silver).toMatchObject({ applied: false, member: true });
    expect(JSON.stringify(silver.remaining)).toContain("1000");
    expect(freeShippingObject(info(0, true), 2000)).toMatchObject({ applied: true, member: true });
    expect(freeShippingObject(info(10000, false), 12000)).toMatchObject({ applied: true, member: false });
    expect(freeShippingObject({ ...info(null, false), freeOver: null }, 2000)).toBeNull();
    expect(freeShippingObject(undefined, 2000)).toBeNull();
    // 買える商品が無いカートは null（金額 0 のゴールドでも「届いた」と出さない）
    expect(freeShippingObject(info(0, true), 0, { empty: true })).toBeNull();
    // 送料無料のクーポンが入っていれば届いた扱い（あと 0 円、会員特典ではない）
    const coupon = freeShippingObject(info(3000, true), 1000, { coupon: true })!;
    expect(coupon).toMatchObject({ applied: true, member: false, coupon: true });
    expect(JSON.stringify(coupon.remaining)).toContain("0");
    expect(freeShippingObject(info(3000, true), 1000)).toMatchObject({ applied: false, coupon: false });
  });
  it("管理画面のフォーム: 選べる条件だけ・外す・重ならない。欄が無い・条件が読めないなら今の決まりのまま", () => {
    const current = [{ audience_id: GOLD, free_over_jpy: 0, label: null, exclude_sale: false }];
    const choices = [{ id: GOLD, name: "ゴールド" }, { id: SILVER, name: "シルバー" }];
    expect(audienceFreeRulesFromForm({ aud_0: GOLD, aud_over_0: "0", aud_remove_0: "on", aud_1: SILVER, aud_over_1: "3000", aud_label_1: "シルバー会員" }, choices, current)).toEqual([{ audience_id: SILVER, free_over_jpy: 3000, label: "シルバー会員", exclude_sale: false }]);
    expect(audienceFreeRulesFromForm({ aud_0: PARAM, aud_over_0: "0", aud_1: SILVER, aud_over_1: "x" }, choices, current)).toEqual([]);
    expect(audienceFreeRulesFromForm({}, null, current)).toEqual(current);
    expect(audienceFreeRulesFromForm({ aud_0: SILVER, aud_over_0: "1" }, [], current)).toEqual(current);
  });
});

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  externalHosts.clear();
});

function setup(opts: { rules?: unknown[]; modules?: boolean; migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected",
    settings: {
      members_enabled: true,
      modules: { audiences: opts.modules ?? true },
      shipping: { mode: "flat", flat_fee_jpy: 800, free_over_jpy: 10000, by_prefecture: {}, free_over_by_audience: opts.rules ?? [{ audience_id: GOLD, free_over_jpy: 0, label: "ゴールド会員" }, { audience_id: SILVER, free_over_jpy: 3000, label: null }] },
      customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver", "regular"] }],
    },
  });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  sb.tables.audiences.push({ id: SILVER, shop_id: shop.id, name: "シルバー", condition: { all: [{ member: true }, { attr: "rank", in: ["silver"] }] } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 2000, available: 5 });
  for (const rank of ["gold", "silver", "regular"]) sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: `${rank}@example.com`, session_epoch: 0, attributes: { rank } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, stripe, shop, teeM, app, mail };
}

async function confirmAs(app: ReturnType<typeof appWith>, mail: ReturnType<typeof memberMail>, skuId: string, qty: number, email: string | null) {
  const b = new Browser(app, BASE);
  if (email) await memberLogin(b, mail, "/my-shop", email);
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty: String(qty) });
  const html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
  return { b, html };
}

describe("会員の条件ごとの送料無料（お店の画面）", () => {
  it("条件に合う会員は送料 0 円（会員特典）で確定まで進む。合わない会員とゲストは送料", async () => {
    const { app, mail, teeM, stripe, sb } = setup();
    const gold = await confirmAs(app, mail, teeM.id, 1, "gold@example.com");
    expect(gold.html).toContain("会員特典で送料無料");
    const res = await gold.b.post("/my-shop/checkout/stripe", { quote: quoteFrom(gold.html) });
    expect(res.status).toBe(303);
    expect(sb.tables.reservations[0]!["shipping_jpy"]).toBe(0);
    expect([...stripe.sessions.values()][0]!.params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") ?? "0").toBe("0");
    const regular = await confirmAs(app, mail, teeM.id, 1, "regular@example.com");
    expect(regular.html).not.toContain("会員特典で送料無料");
    expect(regular.html).toContain("¥800");
    const guest = await confirmAs(app, mail, teeM.id, 1, null);
    expect(guest.html).not.toContain("会員特典で送料無料");
  });

  it("シルバーは 3,000 円以上で無料（届かなければ送料）", async () => {
    const { app, mail, teeM } = setup();
    expect((await confirmAs(app, mail, teeM.id, 1, "silver@example.com")).html).not.toContain("会員特典で送料無料");
    expect((await confirmAs(app, mail, teeM.id, 2, "silver@example.com")).html).toContain("会員特典で送料無料");
  });

  it("確認のあとで会員の独自項目が変わったら確認画面を出し直す（確定の前に DB の最新の値で引き直す）", async () => {
    const { app, mail, teeM, stripe, sb } = setup();
    const gold = await confirmAs(app, mail, teeM.id, 1, "gold@example.com");
    sb.tables.customers.find((x) => x["email"] === "gold@example.com")!["attributes"] = { rank: "regular" };
    const res = await gold.b.post("/my-shop/checkout/stripe", { quote: quoteFrom(gold.html) });
    expect(stripe.sessions.size).toBe(0);
    const again = res.status === 303 ? await (await gold.b.get(res.headers.get("location")!)).text() : await res.text();
    expect(again).not.toContain("会員特典で送料無料");
  });

  it("DB に聞くのは 1 リクエストで 1 回（確認画面で 1 回、確定の前の引き直しで 1 回）", async () => {
    const { app, mail, teeM, sb } = setup();
    const gold = await confirmAs(app, mail, teeM.id, 1, "gold@example.com");
    expect(sb.memberFreeShippingCalls).toBe(1);
    await gold.b.post("/my-shop/checkout/stripe", { quote: quoteFrom(gold.html) });
    expect(sb.memberFreeShippingCalls).toBe(2);
  });

  it("セッションの世代が変わった（ログアウトさせた）古い Cookie では効かない", async () => {
    const { app, mail, teeM, sb } = setup();
    const b = new Browser(app, BASE);
    await memberLogin(b, mail, "/my-shop", "gold@example.com");
    sb.tables.customers.find((x) => x["email"] === "gold@example.com")!["session_epoch"] = 1;
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    expect(html).not.toContain("会員特典で送料無料");
  });

  it("DB に聞けなかったら送料がかかる側で計算する（エラーにしない）", async () => {
    const { app, mail, teeM, sb } = setup();
    sb.memberFreeShippingFail = true;
    const gold = await confirmAs(app, mail, teeM.id, 1, "gold@example.com");
    expect(gold.html).not.toContain("会員特典で送料無料");
    expect(gold.html).toContain("¥800");
    expect(sb.memberFreeShippingCalls).toBe(1);
  });

  it("モジュールが OFF・0171 の前・ゲストは DB に聞かない（送料の案内にも出さない）", async () => {
    const off = setup({ modules: false });
    expect((await confirmAs(off.app, off.mail, off.teeM.id, 1, "gold@example.com")).html).not.toContain("会員特典で送料無料");
    expect(off.sb.memberFreeShippingCalls ?? 0).toBe(0);
    expect(await (await off.app.request(`${BASE}/my-shop/shipping`)).text()).not.toContain("ゴールド会員");
    const before = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v < "0171") });
    expect((await confirmAs(before.app, before.mail, before.teeM.id, 1, "gold@example.com")).html).not.toContain("会員特典で送料無料");
    expect(before.sb.memberFreeShippingCalls ?? 0).toBe(0);
    const on = setup();
    await confirmAs(on.app, on.mail, on.teeM.id, 1, null);
    expect(on.sb.memberFreeShippingCalls ?? 0).toBe(0);
  });

  it("カートの「あと○円で送料無料」: ゴールドは会員特典で無料・シルバーは 3,000 円まで・ゲストはショップ全体。カートでは member_free_shipping_over を呼ばない", async () => {
    const { app, mail, teeM, sb } = setup();
    const cartAs = async (email: string | null) => {
      const b = new Browser(app, BASE);
      if (email) await memberLogin(b, mail, "/my-shop", email);
      await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
      return (await b.get("/my-shop/cart")).text();
    };
    expect(await cartAs("gold@example.com")).toContain("会員特典で送料無料です");
    expect(await cartAs("silver@example.com")).toContain("あと¥1,000で送料無料");
    expect(await cartAs("regular@example.com")).toContain("あと¥8,000で送料無料");
    expect(await cartAs(null)).toContain("あと¥8,000で送料無料");
    expect(sb.memberFreeShippingCalls ?? 0).toBe(0);
    // モジュールが OFF なら会員の条件を見ない
    const off = setup({ modules: false });
    const b = new Browser(off.app, BASE);
    await memberLogin(b, off.mail, "/my-shop", "gold@example.com");
    await b.post("/my-shop/cart/add", { sku_id: off.teeM.id, qty: "1" });
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("あと¥8,000で送料無料");
    expect(html).not.toContain("会員特典で送料無料です");
  });

  it("ヘッドレスのカート: 会員トークンなら会員の条件の金額で「あといくら」（目安）。ゲストはショップ全体", async () => {
    const { app, mail, teeM, sb } = setup();
    const token = async (email: string) => {
      const start = await app.request(`${BASE}/api/shops/my-shop/members/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const { challenge_id } = (await start.json()) as { challenge_id: string };
      const ver = await app.request(`${BASE}/api/shops/my-shop/members/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id, code: mail.code(email) }) });
      return ((await ver.json()) as { access_token: string }).access_token;
    };
    const cart = async (auth: string | null) =>
      ((await (await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ op: "add", sku_id: teeM.id, qty: 1 }) })).json()) as { shipping: Record<string, unknown> }).shipping;
    expect(await cart(await token("silver@example.com"))).toMatchObject({ free_over_jpy: 10000, viewer_free_over_jpy: 3000, member_free_applies: true, remaining_for_free_jpy: 1000 });
    expect(await cart(await token("gold@example.com"))).toMatchObject({ viewer_free_over_jpy: 0, member_free_applies: true, remaining_for_free_jpy: 0 });
    expect(await cart(null)).toMatchObject({ viewer_free_over_jpy: 10000, member_free_applies: false, remaining_for_free_jpy: 8000 });
    expect(sb.memberFreeShippingCalls ?? 0).toBe(0);
  });

  it("送料の案内は名前を付けた決まりだけ（会員の条件の名前は出さない）", async () => {
    const { app } = setup();
    const html = await (await app.request(`${BASE}/my-shop/shipping`)).text();
    expect(html).toContain("ゴールド会員の方は送料無料");
    expect(html).not.toContain("シルバー");
  });

  it("ヘッドレス: カートの shipping.member_free と quote の shipping_free_reason", async () => {
    const { app, teeM } = setup();
    const cartRes = (await (await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "add", sku_id: teeM.id, qty: 1 }) })).json()) as { cart: string; shipping: { member_free: unknown[] } };
    expect(cartRes.shipping.member_free).toEqual([{ label: "ゴールド会員", free_over_jpy: 0, exclude_sale: false }]);
    const q = (await (await app.request(`${BASE}/api/shops/my-shop/checkout/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cart: cartRes.cart, provider: "stripe", address: ADDRESS }) })).json()) as { confirmation: { shipping_jpy: number; shipping_free_reason: string | null } };
    expect(q.confirmation).toMatchObject({ shipping_jpy: 800, shipping_free_reason: null });
  });
});

describe("会員の条件ごとの送料無料（管理画面）", () => {
  it("決まりを足す・外す。表示用の条件は選べない。保存しても今の決まり以外の送料の設定は変わる", async () => {
    const { app, shop, sb } = setup({ rules: [] });
    sb.tables.audiences.push({ id: PARAM, shop_id: shop.id, name: "広告から", condition: { param: "utm_source", in: ["ad"] } });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get(`/admin/shops/${shop.id}/settings/shipping`)).text();
    expect(page).toContain("会員の条件ごとの送料無料");
    expect(page).toContain("ゴールド");
    expect(page).not.toContain("広告から");
    await b.post(`/admin/shops/${shop.id}/shipping`, { mode: "flat", flat_fee_jpy: "700", free_over_jpy: "", tax_rate: "10", aud_0: GOLD, aud_over_0: "0", aud_label_0: "ゴールド会員", aud_1: PARAM, aud_over_1: "0" });
    const ship = (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, Record<string, unknown>>)["shipping"]!;
    expect(ship["flat_fee_jpy"]).toBe(700);
    expect(ship["free_over_by_audience"]).toEqual([{ audience_id: GOLD, free_over_jpy: 0, label: "ゴールド会員", exclude_sale: false }]);
  });
});
