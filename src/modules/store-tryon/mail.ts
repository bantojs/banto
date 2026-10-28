/**
 * お店で試着のメール（同梱のメール通知プラグイン email_resend が送る。0025 の tryon_contact を読む）。
 *   tryon.requested                → お客様に「受け付けました」、店舗に「申し込みがありました」（店舗のメール通知が ON のとき）
 *   tryon.updated（ready）         → お客様に「ご試着いただけます」（取り置きの期限）
 *   tryon.updated（cancelled）     → お客様に「取り消しました」
 * 店舗の住所・営業時間・臨時休業も載せる（何時ごろ行けばよいか分かるように）。
 */
import { shopHome } from "../../storefront/urls";
import { dateLabel, upcomingSpecialDays, todayHere, weeklyLines, formatRanges, type StoreRow } from "./index";

export interface TryonContact {
  request_id: string;
  number: number;
  status: string;
  visit_date: string | null;
  hold_until: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  store: Pick<StoreRow, "name" | "postal_code" | "address" | "phone" | "hours" | "special_days"> & { email: string | null; notify_email: boolean };
  /** storefront は 0069 から（お店の画面を使わないショップは、メールの「お店」のリンクを外のサイトへ） */
  shop: { name: string; slug: string; domain?: string | null; contact_email: string | null; settings?: Record<string, unknown> | null; storefront?: { mode?: string | null; site_url?: string | null } | null };
  items: { name: string | null; sku: string | null; qty: number; unit_price_jpy: number }[];
}

export interface TryonMail {
  to: string;
  subject: string;
  text: string;
  /** Resend の Idempotency-Key の末尾（同じ hooks の配信で宛先ごとに分ける） */
  key: string;
}

function storeBlock(c: TryonContact): string {
  const st = c.store;
  const today = todayHere();
  const lines = [`■ ${st.name}`];
  if (st.address) lines.push(`${st.postal_code ? `〒${st.postal_code} ` : ""}${st.address}`);
  if (st.phone) lines.push(`電話 ${st.phone}`);
  lines.push("営業時間:");
  for (const w of weeklyLines(st)) lines.push(`  ${w.day} ${w.text}`);
  const sp = upcomingSpecialDays(st, today, 45);
  if (sp.length > 0) {
    lines.push("臨時休業・臨時営業:");
    for (const d of sp) lines.push(`  ${dateLabel(d.date)} ${d.closed ? "休業" : formatRanges(d.hours).replace(/-/g, "〜")}${d.note ? ` ${d.note}` : ""}`);
  }
  return lines.join("\n");
}

const itemLines = (c: TryonContact) => c.items.map((i) => `・${i.name ?? ""}${i.sku ? ` / ${i.sku}` : ""} × ${i.qty}`).join("\n");

export function buildTryonMails(event: string, c: TryonContact, publicBaseUrl: string | undefined): TryonMail[] {
  const out: TryonMail[] = [];
  const shopName = c.shop.name;
  const head = `${c.customer_name ?? "お客"} 様\n\n`;
  // お店のリンク: お店の画面を使わない（off / checkout）ショップは外のサイト、それ以外は Banto のお店のトップ
  const sf = c.shop.storefront;
  const site = sf && sf.mode && sf.mode !== "full" && typeof sf.site_url === "string" && sf.site_url.startsWith("https://") ? sf.site_url : null;
  const home = site ?? (publicBaseUrl || c.shop.domain ? shopHome(publicBaseUrl ?? "", c.shop) : null);
  const foot = `${c.shop.contact_email ? `\nお問い合わせ: ${c.shop.contact_email}\n` : ""}${home ? `\n${home}\n` : ""}\n${shopName}`;
  if (event === "tryon.requested") {
    if (c.customer_email) {
      const when = c.visit_date ? `ご来店予定日: ${dateLabel(c.visit_date)}\n店舗でご用意ができしだい、あらためてお知らせします。` : "店舗に商品が届きしだい、あらためてお知らせします。";
      out.push({
        to: c.customer_email,
        key: "customer",
        subject: `【${shopName}】お店で試着のお申し込みを承りました（受付番号 ${c.number}）`,
        text: `${head}お店で試着のお申し込みを承りました。お支払いはご来店時に店舗でお願いします（ご試着だけでも大丈夫です）。\n\n受付番号: ${c.number}\n${when}\n\n${itemLines(c)}\n\n${storeBlock(c)}\n${foot}`,
      });
    }
    if (c.store.notify_email && c.store.email) {
      out.push({
        to: c.store.email,
        key: "store",
        subject: `【${shopName}】お店で試着の申し込み（${c.store.name}・受付番号 ${c.number}）`,
        text: `${c.store.name} に、お店で試着の申し込みがありました。\n\n受付番号: ${c.number}\n${c.visit_date ? `来店予定日: ${dateLabel(c.visit_date)}\n` : ""}お名前: ${c.customer_name ?? ""}\n電話: ${c.customer_phone ?? ""}\nメール: ${c.customer_email ?? ""}\n${c.note ? `ご要望: ${c.note}\n` : ""}\n${itemLines(c)}\n\n管理画面の「お店で試着」で状態を進めてください。\n`,
      });
    }
  } else if (event === "tryon.updated" && c.customer_email) {
    if (c.status === "ready") {
      out.push({
        to: c.customer_email,
        key: "customer",
        subject: `【${shopName}】${c.store.name}でご試着いただけます（受付番号 ${c.number}）`,
        text: `${head}お申し込みの商品を ${c.store.name} にご用意しました。\n${c.hold_until ? `${dateLabel(c.hold_until)}までお取り置きします。` : ""}営業時間をご確認のうえ、お越しください。\n\n受付番号: ${c.number}\n\n${itemLines(c)}\n\n${storeBlock(c)}\n${foot}`,
      });
    } else if (c.status === "cancelled") {
      out.push({
        to: c.customer_email,
        key: "customer",
        subject: `【${shopName}】お店で試着のお申し込みを取り消しました（受付番号 ${c.number}）`,
        text: `${head}お店で試着のお申し込み（受付番号 ${c.number}）を取り消しました。\n${foot}`,
      });
    }
  }
  return out;
}
