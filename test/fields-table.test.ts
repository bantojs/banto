import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, fieldForm } from "./helpers";
import { fieldRowsFromForm, productFields } from "../src/products/fields";
import { customerFields } from "../src/customers/fields";

/** 独自項目の表（メンテナの決定 2026-11-08「独自項目は書式の文字の欄ではなく表で決める」） */
describe("独自項目の表の欄 → 定義（fieldRowsFromForm）", () => {
  it("今ある行の鍵は固定、消す印の行と空の行は飛ばす、選択肢は「,」「、」で区切る、お客様の画面の 3 つ", () => {
    const form = fieldForm([
      { key: "material", label: "素材", orig: true, vis: "card" },
      { key: "old", label: "古い", orig: true, del: true },
      { key: "origin", label: "原産国", type: "select", options: "日本, 中国、ベトナム" },
      { key: "cost", label: "原価", type: "number", vis: "private" },
      { key: "", label: "" },
    ]);
    // 今ある行の鍵は f_key を送られても変えない
    form["f_key_0"] = "renamed";
    const { rows, invalid } = fieldRowsFromForm(form);
    expect(invalid).toEqual([]);
    expect(productFields({ product_fields: rows })).toEqual([
      { key: "material", label: "素材", type: "text", public: true, card: true },
      { key: "origin", label: "原産国", type: "select", options: ["日本", "中国", "ベトナム"], public: true },
      { key: "cost", label: "原価", type: "number", public: false },
    ]);
  });

  it("形の違う鍵・重なる鍵は invalid（呼び手は保存しない）。表示名が空なら鍵、知らない種類は文字", () => {
    const { rows, invalid } = fieldRowsFromForm(fieldForm([{ key: "size", label: "" }, { key: "size", label: "重なり" }, { key: "1bad", label: "数字始まり" }, { key: "", label: "鍵なし" }, { key: "x", label: "X", type: "script" }]));
    expect(invalid).toEqual(["size", "1bad", "鍵なし"]);
    expect(rows).toEqual([
      { key: "size", label: "size", type: "text", public: true },
      { key: "x", label: "X", type: "text", public: true },
    ]);
  });

  it("会員の項目は画像を使わず、お客様の画面には出さない（公開の欄は無視）", () => {
    const { rows } = fieldRowsFromForm(fieldForm([{ key: "rank", label: "ランク", vis: "card" }, { key: "photo", label: "写真", type: "image" }]));
    expect(customerFields({ customer_fields: rows })).toEqual([{ key: "rank", label: "ランク", type: "text", public: false }]);
  });
});

describe("独自項目の表の画面", () => {
  it("今ある項目の行と空の行 3 つを出し、空の行の鍵だけ入力できる。会員の項目には画像と公開の列が無い。足すボタンのスクリプトは構文として正しい", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { product_fields: [{ key: "material", label: "素材", type: "text" }] } });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/fields`)).text();
    expect(html).toContain('name="f_n" value="4"');
    expect(html).toContain('<code>material</code><input type="hidden" name="f_orig_0" value="material"/>');
    expect(html).not.toContain('name="f_key_0"');
    for (const i of [1, 2, 3]) expect(html).toContain(`name="f_key_${i}"`);
    expect(html).toContain('<option value="image">画像</option>');
    expect(html).toContain('name="f_vis_0"');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(html.indexOf('id="fields-form"')))![1]!;
    expect(() => new Function(script)).not.toThrow();
    const customers = await (await admin.get(`/admin/shops/${shop.id}/customer-fields`)).text();
    expect(customers).not.toContain('value="image"');
    expect(customers).not.toContain('name="f_vis_');
  });
});
