import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, fieldForm } from "./helpers";
import { fieldRowsFromForm, optionsText, productFields } from "../src/products/fields";
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

  it("今ある選択肢に区切りの文字を含んでも、欄を触っていなければ元の配列のまま。触れば区切る", () => {
    const options = ["A, B", "赤、白", "C"];
    const form = fieldForm([{ key: "kind", label: "種類（直した）", type: "select", options: optionsText(options), orig: true }]);
    form["f_options_orig_0"] = JSON.stringify(options);
    expect(fieldRowsFromForm(form).rows[0]).toMatchObject({ label: "種類（直した）", options });
    form["f_options_0"] = `${optionsText(options)}, D`;
    expect(fieldRowsFromForm(form).rows[0]).toMatchObject({ options: ["A", "B", "赤", "白", "C", "D"] });
    // 改行を含む選択肢: ブラウザは入力欄の値から改行を落とすが、触っていなければ元のまま
    const multi = ["一行目\n二行目", "C"];
    const sent = fieldForm([{ key: "kind", label: "種類", type: "select", options: optionsText(multi).replace(/\n/g, ""), orig: true }]);
    sent["f_options_orig_0"] = JSON.stringify(multi);
    expect(fieldRowsFromForm(sent).rows[0]).toMatchObject({ options: multi });
    // 形の違う隠しの値は使わない
    form["f_options_0"] = "X";
    form["f_options_orig_0"] = "{broken";
    expect(fieldRowsFromForm(form).rows[0]).toMatchObject({ options: ["X"] });
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
    expect(html).not.toContain("区切りの文字");
    const customers = await (await admin.get(`/admin/shops/${shop.id}/customer-fields`)).text();
    expect(customers).not.toContain('value="image"');
    expect(customers).not.toContain('name="f_vis_');
  });

  it("区切りの文字を含む選択肢: 画面で知らせ、表示名だけ直して保存しても選択肢は変わらない（商品の値が選択肢から外れない）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const options = ["A, B", "C"];
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { product_fields: [{ key: "kind", label: "種類", type: "select", options }] } });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/fields`;
    const html = await (await admin.get(base)).text();
    expect(html).toContain("選択肢に「,」か「、」を含むものがあります");
    // 画面の欄をそのまま送る（表示名だけ直す）
    const form: Record<string, string> = {};
    for (const m of html.matchAll(/<input type="(?:text|hidden)" name="([^"]+)" value="([^"]*)"/g)) form[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    for (const m of html.matchAll(/<select name="([^"]+)"[^>]*>[\s\S]*?<option value="([^"]+)" selected/g)) form[m[1]!] = m[2]!;
    form["f_label_0"] = "種類（直した）";
    expect((await admin.post(base, form)).headers.get("location")).toBe(`${base}?flash=fields_saved`);
    const saved = (sb.tables.shops[0]!["settings"] as Record<string, unknown>)["product_fields"] as { label: string; options: string[] }[];
    expect(saved[0]).toMatchObject({ label: "種類（直した）", options });
  });
});
