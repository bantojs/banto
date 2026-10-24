import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout } from "./helpers";
import { B2_HEADER, buildLabelsCsv, labelSettings, sjisWidth } from "../src/modules/shipping-labels/csv";
import { shippingLabelsClient } from "../src/modules/shipping-labels/client";

const order = {
  number: 1001,
  customer_name: "山田 太郎",
  shipping_address: { name: "山田 太郎", phone: "03-1234-5678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "ハイツ \"A\", 101" },
  delivery: { date: "2026-10-20", slot: "19-21" },
  first_item: "コーヒー豆",
  item_count: 2,
};
const settings = labelSettings({ shipping_labels: { shipper_name: "マイショップ", shipper_phone: "06-0000-0000", shipper_postal: "530-0001", shipper_address: "大阪府大阪市北区梅田1-1", yamato_billing_code: "012345678901" } });

function parse(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out;
}

describe("送り状 CSV（src/modules/shipping-labels/csv.ts）", () => {
  it("B2 クラウド: 97 項目、日付は YYYY/MM/DD、時間帯は 1921、品名は最初の商品 + ほか", () => {
    const { csv, warnings } = buildLabelsCsv("yamato", [order], settings, "2026-10-18");
    const [head, row, end] = csv.split("\r\n");
    expect(end).toBe("");
    expect(parse(head!)).toHaveLength(97);
    expect(B2_HEADER[6]).toBe("配達時間帯");
    const r = parse(row!);
    expect(r).toHaveLength(97);
    expect([r[0], r[1], r[4], r[5], r[6], r[8], r[10], r[11], r[12], r[15], r[17], r[24], r[27], r[39], r[41]]).toEqual([
      "1001", "0", "2026/10/18", "2026/10/20", "1921", "03-1234-5678", "100-0001", "東京都千代田区千代田1-1", 'ハイツ "A", 101', "山田 太郎", "様", "マイショップ", "コーヒー豆ほか", "012345678901", "01",
    ]);
    expect(warnings).toEqual([]);
  });

  it("e飛伝Ⅲ: 配達日は YYYYMMDD、時間帯は 19、指定なしは 00", () => {
    const { csv } = buildLabelsCsv("sagawa", [order, { ...order, number: 1002, delivery: null }], settings, "2026-10-18");
    const lines = csv.split("\r\n");
    const a = parse(lines[1]!);
    expect([a[0], a[3], a[4], a[15], a[16]]).toEqual(["1001", "東京都千代田区", "千代田1-1", "20261020", "19"]);
    const b = parse(lines[2]!);
    expect([b[15], b[16]]).toEqual(["", "00"]);
  });

  it("長すぎる住所・電話番号の無い注文を知らせる", () => {
    const long = { ...order, shipping_address: { ...order.shipping_address, phone: "", line1: "あ".repeat(40) } };
    expect(buildLabelsCsv("yamato", [long], settings, "2026-10-18").warnings.map((w) => w.field)).toEqual(["phone", "address_long"]);
    expect(sjisWidth("ｱa漢")).toBe(4);
  });
});

describe("Shift_JIS への変換（ブラウザ側、client.ts）", () => {
  it("漢字・半角カナ・全角チルダを変換し、無い文字は ? にして知らせる", () => {
    const { encodeSjis } = shippingLabelsClient();
    const r = encodeSjis("山田ｱ～〜A😀");
    // 全角チルダ（U+FF5E）も波ダッシュ（U+301C）も 0x8160 にする
    expect([...r.bytes.slice(5, 9)]).toEqual([0x81, 0x60, 0x81, 0x60]);
    expect(new TextDecoder("shift_jis").decode(r.bytes)).toBe("山田ｱ～～A?");
    expect(r.unmappable).toEqual(["😀"]);
  });
});

describe("送り状番号の取り込み（ブラウザ側、client.ts）", () => {
  it("Shift_JIS の CSV を読み、見出しから注文番号とお問い合わせ番号の列・運送会社を推測する", () => {
    const L = shippingLabelsClient();
    const b2 = L.encodeSjis('お客様管理番号,送り状種類,伝票番号\r\n1001,0,"1234-5678-9012"\r\n1002,0,\r\n,0,999\r\n').bytes;
    const rows = L.parseCsv(L.decodeBytes(b2));
    expect(L.detectColumns(rows[0]!)).toEqual({ number: 0, tracking: 2, carrier: "yamato" });
    expect(L.trackingItems(rows, 0, 2, "yamato")).toEqual([{ number: "1001", carrier: "yamato", tracking: "1234-5678-9012" }]);
    // e飛伝Ⅲ の書き出し（UTF-8 の BOM つきでも読む）
    const sagawa = L.parseCsv(L.decodeBytes(new TextEncoder().encode("\ufeffお問合せ送り状NO,お客様管理番号\n400011112222,1003\n")));
    expect(L.detectColumns(sagawa[0]!)).toEqual({ number: 1, tracking: 0, carrier: "sagawa" });
    // 見出しが無ければ -1（画面で選ぶ）
    expect(L.detectColumns(["1001", "123"])).toMatchObject({ number: -1, tracking: -1, carrier: null });
  });
});

describe("管理画面（同梱モジュール shipping_labels）", () => {
  it("未発送の注文から CSV を返す。モジュールが OFF なら無い", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_x", settings: { modules: { shipping_labels: true } } });
    const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
    const sku = sb.addSku(shop.id, p.id, { code: "A", price_jpy: 3000, available: 5 });
    const stripe = new FakeStripe();
    const app = appWith(sb, {}, undefined, stripe);
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop", "stripe", ADDRESS);
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}/modules/shipping-labels`)).text();
    expect(page).toContain('id="shipping-labels"');
    const res = await admin.get(`/admin/shops/${shop.id}/modules/shipping-labels/rows.json?carrier=yamato&date=2026-10-18`);
    const data = (await res.json()) as { csv: string; count: number };
    expect(data.count).toBe(1);
    expect(data.csv).toContain(`${sb.tables.orders[0]!["number"]},0,,,2026/10/18`);
    expect(data.csv).toContain("Tシャツ");
    expect((await admin.get(`/admin/shops/${shop.id}/modules/shipping-labels/rows.json?carrier=x`)).status).toBe(400);
    // 送り状番号の取り込み: 支払い済みの注文を発送済みにして番号を残す
    expect(page).toContain('id="tracking-import"');
    const number = sb.tables.orders[0]!["number"];
    let tr = await admin.postJson(`/admin/shops/${shop.id}/modules/shipping-labels/tracking`, { items: [{ number: String(number), carrier: "yamato", tracking: "1234-5678-9012" }, { number: "9", carrier: "yamato", tracking: "1111" }] });
    expect(await tr.json()).toEqual({ shipped: 1, updated: 0, invalid: 0, missing: [9] });
    expect(sb.tables.orders[0]).toMatchObject({ status: "shipped", tracking_carrier: "yamato", tracking_number: "123456789012" });
    tr = await admin.postJson(`/admin/shops/${shop.id}/modules/shipping-labels/tracking`, { items: [] });
    expect(tr.status).toBe(400);
    tr = await admin.postJson(`/admin/shops/${shop.id}/modules/shipping-labels/tracking`, { items: [{ number: "1", carrier: "yamato", tracking: "1111" }] }, { origin: "https://evil.example" });
    expect(tr.status).toBe(403);
    expect(((await (await admin.get(`/admin/shops/${shop.id}/modules/shipping-labels/rows.json?carrier=sagawa`)).json()) as { count: number }).count).toBe(0);
    sb.tables.shops[0]!["settings"] = {};
    const app2 = appWith(sb, {}, undefined, stripe);
    const admin2 = await Browser.loggedIn(app2, "owner@example.com", "password-123");
    expect((await admin2.get(`/admin/shops/${shop.id}/modules/shipping-labels`)).status).toBe(404);
  });
});
