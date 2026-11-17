/**
 * お店で試着のメール（同梱のメール通知プラグイン email_resend が送る。0025 の tryon_contact を読む）。
 *   tryon.requested                → お客様に「受け付けました」、店舗に「申し込みがありました」（店舗のメール通知が ON のとき）
 *   tryon.updated（ready）         → お客様に「ご試着いただけます」（取り置きの期限）
 *   tryon.updated（cancelled）     → お客様に「取り消しました」
 *   tryon.updated（ready・reminder）→ お客様に「明日までお取り置きしています」（来店期限の前日、0152）
 *   tryon.updated（ready・extended）→ お客様に「取り置きを延長しました」、店舗に「延長がありました」（店舗のメール通知が ON のとき。0151）
 * 店舗の住所・営業時間・臨時休業も載せる（何時ごろ行けばよいか分かるように）。
 */
import { shopHome } from "../../storefront/urls";
import { optionLabel, optionNamesOf } from "../../products/option-names";
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
  shop: { name: string; slug: string; domain?: string | null; contact_email: string | null; settings?: Record<string, unknown> | null; storefront?: { mode?: string | null; site_url?: string | null } | null; /** 0147。SKU の options の key → 表示名 */ option_names?: unknown };
  /** code・options は 0147 から（それより前の DB では無い） */
  items: { name: string | null; sku: string | null; code?: string | null; options?: Record<string, unknown> | null; axes?: unknown; qty: number; unit_price_jpy: number }[];
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

/** 選択肢の値（文字列と数だけ。null・オブジェクトは出さない） */
const optionValue = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** 選択肢を商品の軸（option_axes）の順に並べる。jsonb は鍵の順を保たないため。軸に無い鍵は後ろに元の順で */
function orderedOptions(options: Record<string, unknown>, axes: unknown): [string, unknown][] {
  const keys = Array.isArray(axes) ? axes.map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>)["key"] : null)).filter((k): k is string => typeof k === "string") : [];
  const rank = (k: string) => (keys.indexOf(k) === -1 ? keys.length : keys.indexOf(k));
  return Object.entries(options)
    .map((e, i) => [e, i] as const)
    .sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1])
    .map(([e]) => e);
}

/**
 * 品目の行。SKU の選択肢があれば「品名 / カラー: ネイビー・サイズ: M（品番 TEE-NV-M）× 1」（0147。表示名は 0094 の option_names、
 * 並びは商品の軸の順）。SKU の名前が品番とも選択肢をつないだものとも違えば名前も添える（「限定カラー」など）。無ければ「品名 / SKU の名前 × 1」
 */
function itemLines(c: TryonContact): string {
  const names = optionNamesOf(c.shop.option_names);
  return c.items
    .map((i) => {
      const raw = i.options && typeof i.options === "object" ? i.options : {};
      const opts = orderedOptions(raw, i.axes)
        .map(([k, v]) => [optionLabel(names, k), optionValue(v)] as const)
        .filter(([, v]) => v !== "");
      if (opts.length === 0) return `・${i.name ?? ""}${i.sku ? ` / ${i.sku}` : ""} × ${i.qty}`;
      const joined = opts.map(([, v]) => v).join(" / ");
      const skuName = i.sku && i.sku !== i.code && i.sku !== joined ? `${i.sku} ` : "";
      return `・${i.name ?? ""} / ${skuName}${opts.map(([k, v]) => `${k}: ${v}`).join("・")}${i.code ? `（品番 ${i.code}）` : ""} × ${i.qty}`;
    })
    .join("\n");
}

export function buildTryonMails(event: string, c: TryonContact, publicBaseUrl: string | undefined, opts: { extended?: boolean; previousHoldUntil?: string | null; reminder?: boolean } = {}): TryonMail[] {
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
  } else if (event === "tryon.updated" && c.status === "ready" && opts.reminder) {
    // 来店期限の前日のお知らせ（0152）。お客様にだけ
    if (c.customer_email) {
      out.push({
        to: c.customer_email,
        key: "customer",
        subject: `【${shopName}】お取り置きは${c.hold_until ? dateLabel(c.hold_until) : "明日"}までです（受付番号 ${c.number}）`,
        text: `${head}${c.store.name}でお取り置きしている商品は、${c.hold_until ? dateLabel(c.hold_until) : "明日"}までです。営業時間をご確認のうえ、お越しください。\n\n受付番号: ${c.number}\n\n${itemLines(c)}\n\n${storeBlock(c)}\n${foot}`,
      });
    }
  } else if (event === "tryon.updated" && c.status === "ready" && opts.extended) {
    // 会員が会員ページで取り置きを延ばした（0151）
    const until = c.hold_until ? dateLabel(c.hold_until) : "";
    if (c.customer_email) {
      out.push({
        to: c.customer_email,
        key: "customer",
        subject: `【${shopName}】お取り置きの期限を延長しました（受付番号 ${c.number}）`,
        text: `${head}${c.store.name}でのお取り置きを${until}まで延長しました。営業時間をご確認のうえ、お越しください。\n\n受付番号: ${c.number}\n\n${itemLines(c)}\n\n${storeBlock(c)}\n${foot}`,
      });
    }
    if (c.store.notify_email && c.store.email) {
      out.push({
        to: c.store.email,
        key: "store",
        subject: `【${shopName}】お店で試着の取り置きの延長（${c.store.name}・受付番号 ${c.number}）`,
        text: `${c.store.name} でお取り置き中のお申し込みの期限が、お客様の操作で延長されました。\n\n受付番号: ${c.number}\n${opts.previousHoldUntil ? `延長前の期限: ${dateLabel(opts.previousHoldUntil)}\n` : ""}新しい期限: ${until}\nお名前: ${c.customer_name ?? ""}\n\n${itemLines(c)}\n`,
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
