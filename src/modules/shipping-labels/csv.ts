/**
 * 送り状 CSV（同梱モジュール shipping_labels、docs/shipping-labels.md）。データ取得はしない（注文の行から組む）。
 * - ヤマト運輸 B2 クラウド: 「送り状発行データレイアウト（入出力用）」の 97 項目（ヤマトの公式の資料で確認、2026-10-17）。
 *   日付は YYYY/MM/DD、配達時間帯は 0812 / 1416 / 1618 / 1820 / 1921。
 * - 佐川急便 e飛伝Ⅲ: 見出しつきの CSV。e飛伝Ⅲ で一度だけ取込パターン（見出しと項目の対応）を登録してもらう。
 *   配達日は YYYYMMDD、配達指定時間帯は 00（指定なし）/ 01 / 14 / 16 / 18 / 19（佐川の区分値の資料で確認。18・19 は 6 時間帯の契約）。
 * 文字コード（Shift_JIS）への変換はブラウザ側（client.ts）。ここでは文字列（CRLF 区切り）を返す。
 */
import type { DeliverySlot } from "../delivery-time";

export const CARRIERS = ["yamato", "sagawa"] as const;
export type Carrier = (typeof CARRIERS)[number];

export interface LabelOrder {
  number: number;
  customer_name: string | null;
  shipping_address: Record<string, unknown> | null;
  delivery?: { date?: string | null; slot?: string | null } | null;
  /** 品名に使う（最初の商品名。設定の品名があればそちら） */
  first_item?: string | null;
  item_count?: number;
}

export interface LabelSettings {
  shipper_name: string;
  shipper_phone: string;
  shipper_postal: string;
  shipper_address: string;
  shipper_address2: string;
  /** 品名（空なら最初の商品名） */
  item_name: string;
  /** B2: 送り状種類（0 発払い 等）、ご請求先顧客コード、運賃管理番号 */
  yamato_type: string;
  yamato_billing_code: string;
  yamato_freight_no: string;
}

export function labelSettings(settings: Record<string, unknown> | null | undefined): LabelSettings {
  const raw = (settings ?? {})["shipping_labels"];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const s = (k: string, d = "") => (typeof o[k] === "string" ? (o[k] as string).trim() : d);
  return {
    shipper_name: s("shipper_name"),
    shipper_phone: s("shipper_phone"),
    shipper_postal: s("shipper_postal"),
    shipper_address: s("shipper_address"),
    shipper_address2: s("shipper_address2"),
    item_name: s("item_name"),
    yamato_type: /^[0-9A]$/.test(s("yamato_type")) ? s("yamato_type") : "0",
    yamato_billing_code: s("yamato_billing_code"),
    yamato_freight_no: s("yamato_freight_no", "01"),
  };
}

const YAMATO_SLOTS: Record<DeliverySlot, string> = { am: "0812", "14-16": "1416", "16-18": "1618", "18-20": "1820", "19-21": "1921" };
const SAGAWA_SLOTS: Record<DeliverySlot, string> = { am: "01", "14-16": "14", "16-18": "16", "18-20": "18", "19-21": "19" };

/** B2 クラウドの送り状発行データレイアウト（入出力用）の項目名（1〜97） */
export const B2_HEADER = [
  "お客様管理番号", "送り状種類", "クール区分", "伝票番号", "出荷予定日", "お届け予定（指定）日", "配達時間帯", "お届け先コード", "お届け先電話番号", "お届け先電話番号枝番",
  "お届け先郵便番号", "お届け先住所", "お届け先住所（アパートマンション名）", "お届け先会社・部門名１", "お届け先会社・部門名２", "お届け先名", "お届け先名略称カナ", "敬称", "ご依頼主コード", "ご依頼主電話番号",
  "ご依頼主電話番号枝番", "ご依頼主郵便番号", "ご依頼主住所", "ご依頼主住所（アパートマンション名）", "ご依頼主名", "ご依頼主略称カナ", "品名コード１", "品名１", "品名コード２", "品名２",
  "荷扱い１", "荷扱い２", "記事", "コレクト代金引換額（税込）", "コレクト内消費税額等", "営業所止置き", "営業所コード", "発行枚数", "個数口枠の印字", "ご請求先顧客コード",
  "ご請求先分類コード", "運賃管理番号", "クロネコwebコレクトデータ登録", "クロネコwebコレクト加盟店番号", "クロネコwebコレクト申込受付番号１", "クロネコwebコレクト申込受付番号２", "クロネコwebコレクト申込受付番号３", "お届け予定ｅメール利用区分", "お届け予定ｅメールe-mailアドレス", "入力機種",
  "お届け予定eメールメッセージ", "お届け完了ｅメール利用区分", "お届け完了ｅメールe-mailアドレス", "お届け完了eメールメッセージ", "クロネコ収納代行利用区分", "予備", "収納代行請求金額(税込)", "収納代行内消費税額等", "収納代行請求先郵便番号", "収納代行請求先住所",
  "収納代行請求先住所（アパートマンション名）", "収納代行請求先会社・部門名１", "収納代行請求先会社・部門名２", "収納代行請求先名(漢字)", "収納代行請求先名(カナ)", "収納代行問合せ先名(漢字)", "収納代行問合せ先郵便番号", "収納代行問合せ先住所", "収納代行問合せ先住所（アパートマンション名）", "収納代行問合せ先電話番号",
  "収納代行管理番号", "収納代行品名", "収納代行備考", "複数口くくりキー", "検索キータイトル1", "検索キー1", "検索キータイトル2", "検索キー2", "検索キータイトル3", "検索キー3",
  "検索キータイトル4", "検索キー4", "検索キータイトル5", "検索キー5", "予備", "予備", "投函予定メール利用区分", "投函予定メールe-mailアドレス", "投函予定メールメッセージ", "投函完了メール（お届け先宛）利用区分",
  "投函完了メール（お届け先宛）e-mailアドレス", "投函完了メール（お届け先宛）メールメッセージ", "投函完了メール（ご依頼主宛）利用区分", "投函完了メール（ご依頼主宛）e-mailアドレス", "投函完了メール（ご依頼主宛）メールメッセージ", "連携管理番号", "通知メールアドレス",
];

/** e飛伝Ⅲ 用の見出し（取込パターンで項目に対応付ける） */
export const SAGAWA_HEADER = [
  "お客様管理番号", "お届け先電話番号", "お届け先郵便番号", "お届け先住所1", "お届け先住所2", "お届け先住所3", "お届け先名称1", "お届け先名称2",
  "ご依頼主電話番号", "ご依頼主郵便番号", "ご依頼主住所1", "ご依頼主住所2", "ご依頼主名称1", "品名1", "出荷個数", "配達日", "配達指定時間帯",
];

/** Shift_JIS のバイト数の目安（ASCII と半角カナは 1、それ以外は 2） */
export function sjisWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) < 0x80 || (ch >= "｡" && ch <= "ﾟ") ? 1 : 2;
  return n;
}

function cell(v: string): string {
  const s = v.replace(/[\r\n]+/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface LabelWarning {
  number: number;
  field: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function buildLabelsCsv(carrier: Carrier, orders: LabelOrder[], s: LabelSettings, shipDate: string): { csv: string; warnings: LabelWarning[] } {
  const warnings: LabelWarning[] = [];
  const rows: string[][] = [];
  const ymd = shipDate.replace(/-/g, "/");
  for (const o of orders) {
    const a = o.shipping_address ?? {};
    const addr = `${str(a["state"])}${str(a["city"])}${str(a["line1"])}`;
    const addr2 = str(a["line2"]);
    const name = str(a["name"]) || (o.customer_name ?? "").trim();
    const phone = str(a["phone"]);
    const postal = str(a["postal_code"]);
    const item = s.item_name || [o.first_item ?? "", (o.item_count ?? 1) > 1 ? "ほか" : ""].join("").trim();
    const date = o.delivery?.date ?? "";
    const slot = (o.delivery?.slot ?? "") as DeliverySlot | "";
    if (!phone) warnings.push({ number: o.number, field: "phone" });
    if (!postal) warnings.push({ number: o.number, field: "postal_code" });
    if (carrier === "yamato") {
      if (sjisWidth(addr) > 64) warnings.push({ number: o.number, field: "address_long" });
      if (sjisWidth(addr2) > 32) warnings.push({ number: o.number, field: "address2_long" });
      if (sjisWidth(name) > 32) warnings.push({ number: o.number, field: "name_long" });
      const r = new Array<string>(B2_HEADER.length).fill("");
      r[0] = String(o.number);
      r[1] = s.yamato_type;
      r[4] = ymd;
      r[5] = date ? date.replace(/-/g, "/") : "";
      r[6] = slot ? YAMATO_SLOTS[slot] : "";
      r[8] = phone;
      r[10] = postal;
      r[11] = addr;
      r[12] = addr2;
      r[15] = name;
      r[17] = "様";
      r[19] = s.shipper_phone;
      r[21] = s.shipper_postal;
      r[22] = s.shipper_address;
      r[23] = s.shipper_address2;
      r[24] = s.shipper_name;
      r[27] = item;
      r[39] = s.yamato_billing_code;
      r[41] = s.yamato_freight_no;
      rows.push(r);
    } else {
      rows.push([
        String(o.number), phone, postal, `${str(a["state"])}${str(a["city"])}`, str(a["line1"]), addr2, name, "",
        s.shipper_phone, s.shipper_postal, s.shipper_address, s.shipper_address2, s.shipper_name, item, "1",
        date ? date.replace(/-/g, "") : "", slot ? SAGAWA_SLOTS[slot] : "00",
      ]);
    }
  }
  const header = carrier === "yamato" ? B2_HEADER : SAGAWA_HEADER;
  return { csv: [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n", warnings };
}
