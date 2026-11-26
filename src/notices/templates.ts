/**
 * お知らせの文面（差し込み付きの文面、0154、メンテナの決定 2026-11-18、docs/notices.md）。
 * 注文のメール・LINE とお店で試着のお知らせ（お客様あて）の件名・本文を、ショップが知らせの種類 × 送り方ごとに直せる。
 *   - 差し込みは {{名前}}。知らせごとに使える名前・必ず入れる名前・1 回だけの名前（明細のようなかたまり）が決まっている
 *   - 決まりは DB の banto_notice_spec と同じ（保存は notice_text_set が断る。test/db/notice-texts.test.ts で縛る）
 *   - 送るときもここで確かめ直し、合わなければその知らせだけ既定の文面で送る（止めない。管理画面に警告を出す）
 *   - 既定の文面（行が無いとき）は今までの文面と同じ（LINE の注文の知らせだけ 0179 でリンクの行を足した。値が無ければ行ごと消える）
 * 値はすべてプレーンテキスト（メールも LINE も HTML ではない）。値の中の {{…}} はもう一度は置き換えず、値の中の改行・空行もそのまま
 */

export const NOTICE_TEXTS_MIGRATION = "0154_notice_texts";

export const NOTICE_KINDS = ["order_paid", "order_shipped", "tryon_requested", "tryon_ready", "tryon_reminder", "tryon_extended", "tryon_cancelled", "payment_reminder"] as const;

/** お支払いのお願い（0181）。当てるまで画面に出さない */
export const PAYMENT_REMINDER_MIGRATION = "0181_payment_reminder";
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type NoticeChannel = "mail" | "line";

export interface NoticeSpec {
  subjectAllowed?: readonly string[];
  subjectRequired?: readonly string[];
  bodyAllowed: readonly string[];
  bodyRequired: readonly string[];
  once: readonly string[];
}

const ORDER_MAIL_SUBJECT = ["shop_name", "customer_name", "number", "total"];
const TRYON_MAIL_SUBJECT = ["shop_name", "customer_name", "number", "store_name"];

/** LINE の注文の知らせのリンク（{{order_link}}・{{tracking}}）。0179 から */
export const LINE_NOTICE_LINKS_MIGRATION = "0179_line_notice_links";

/**
 * DB の banto_notice_spec と同じ。lineLinks は 0179 を当てたか（当てる前の DB は LINE の注文の知らせでリンクの差し込みを断るので、
 * 管理画面は当てるまで出さない。送るときの確かめ直しは既定の true のまま: 当てる前の DB にはリンク入りの文面が保存されていない）
 */
export function noticeSpec(kind: NoticeKind, channel: NoticeChannel, lineLinks = true): NoticeSpec {
  const shipped = kind === "order_shipped";
  if (kind === "order_paid" || shipped) {
    if (channel === "line") {
      if (!lineLinks) return { bodyAllowed: ["shop_name", "number", "total"], bodyRequired: ["number"], once: [] };
      return { bodyAllowed: ["shop_name", "number", "total", ...(shipped ? ["tracking"] : []), "order_link"], bodyRequired: ["number"], once: shipped ? ["tracking"] : [] };
    }
    return {
      subjectAllowed: ORDER_MAIL_SUBJECT,
      subjectRequired: ["number"],
      bodyAllowed: ["shop_name", "customer_name", "number", "total", "order_details", ...(shipped ? ["tracking"] : []), "return_policy", "order_link", "contact"],
      bodyRequired: shipped ? ["order_details", "tracking"] : ["order_details"],
      once: ["order_details", "tracking"],
    };
  }
  if (kind === "payment_reminder") {
    // 0181: お支払いのお願い。リンク（payment_link）は必ず入れる。LINE に氏名は載せない
    if (channel === "line") return { bodyAllowed: ["shop_name", "total", "pay_until", "payment_link"], bodyRequired: ["payment_link"], once: ["payment_link"] };
    return {
      subjectAllowed: ["shop_name", "customer_name", "total", "pay_until"],
      subjectRequired: [],
      bodyAllowed: ["shop_name", "customer_name", "total", "pay_until", "items", "payment_link", "contact"],
      bodyRequired: ["payment_link"],
      once: ["items", "payment_link"],
    };
  }
  const plain = kind === "tryon_requested" || kind === "tryon_cancelled";
  if (channel === "line") return { bodyAllowed: plain ? ["shop_name", "number", "store_name"] : ["shop_name", "number", "store_name", "hold_until"], bodyRequired: plain ? ["number"] : ["number", "hold_until"], once: [] };
  return {
    subjectAllowed: plain ? TRYON_MAIL_SUBJECT : [...TRYON_MAIL_SUBJECT, "hold_until"],
    subjectRequired: ["number"],
    bodyAllowed:
      kind === "tryon_requested"
        ? ["shop_name", "customer_name", "number", "store_name", "visit", "items", "store_info", "contact", "shop_link"]
        : kind === "tryon_cancelled"
          ? ["shop_name", "customer_name", "number", "store_name", "contact", "shop_link"]
          : ["shop_name", "customer_name", "number", "store_name", "hold_until", "items", "store_info", "contact", "shop_link"],
    bodyRequired: kind === "tryon_requested" ? ["items", "store_info"] : kind === "tryon_cancelled" ? ["number"] : ["hold_until", "items", "store_info"],
    once: ["items", "store_info"],
  };
}

export const NOTICE_SUBJECT_MAX = 150;
export const noticeBodyMax = (channel: NoticeChannel): number => (channel === "line" ? 2000 : 4000);

/** 保存のときの誤り（DB の invalid_notice_text:<code>[:<名前>] と同じ） */
export interface NoticeTextError {
  code: string;
  tag?: string;
}

/** {{ と }} の組（DB の正規表現と同じく、あいだに改行があっても組とみなす） */
const TAG_RE = /\{\{([\s\S]*?)\}\}/g;

function tagsCheck(text: string, allowed: readonly string[], required: readonly string[], once: readonly string[], where: "body" | "subject"): NoticeTextError | null {
  const names: string[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const n = (m[1] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
    if (!/^[a-z_]{1,40}$/.test(n) || !allowed.includes(n)) return { code: `${where}_unknown_tag`, tag: n.slice(0, 40) };
    names.push(n);
  }
  if (/\{\{|\}\}/.test(text.replace(TAG_RE, ""))) return { code: `${where}_broken_tag` };
  for (const n of required) if (!names.includes(n)) return { code: `${where}_missing_tag`, tag: n };
  for (const n of once) if (names.filter((x) => x === n).length > 1) return { code: `${where}_repeated_tag`, tag: n };
  return null;
}

/** 本文の改行を LF にそろえ、前後の空白と改行を除く（DB の notice_text_set と同じ） */
export const normalizeNoticeBody = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");

/** 決まりに合うか（保存の前の画面と、送る前の確かめ直し）。合えば null */
export function checkNoticeText(kind: NoticeKind, channel: NoticeChannel, subject: string | null, body: string, lineLinks = true): NoticeTextError | null {
  const spec = noticeSpec(kind, channel, lineLinks);
  const b = normalizeNoticeBody(body);
  if (b === "") return { code: "body_empty" };
  // NUL は PostgreSQL の text に入らない（保存で落ちる前に理由を出す）
  if (b.includes("\u0000") || (subject ?? "").includes("\u0000")) return { code: "nul" };
  if ([...b].length > noticeBodyMax(channel)) return { code: "body_too_long" };
  const bodyErr = tagsCheck(b, spec.bodyAllowed, spec.bodyRequired, spec.once, "body");
  if (bodyErr) return bodyErr;
  if (channel === "mail") {
    const s = (subject ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
    if (s === "") return { code: "subject_empty" };
    if (/[\r\n]/.test(s)) return { code: "subject_newline" };
    if ([...s].length > NOTICE_SUBJECT_MAX) return { code: "subject_too_long" };
    return tagsCheck(s, spec.subjectAllowed ?? [], spec.subjectRequired ?? [], [], "subject");
  }
  return null;
}

/** DB の誤りの文字列（invalid_notice_text:body_missing_tag:order_details）→ 誤り。違う形なら null */
export function noticeTextErrorOf(message: string): NoticeTextError | null {
  const m = /invalid_notice_text:([a-z_]+)(?::([a-z_]{0,40}))?/.exec(message);
  return m ? { code: m[1]!, ...(m[2] ? { tag: m[2] } : {}) } : null;
}

/**
 * 差し込む。値が空の差し込みだけの行は行ごと消し、3 つ以上続く改行は 2 つにする（空のかたまりで空行が重ならないように）。
 * 値の中の {{…}} はそのまま（1 回だけ置き換える）
 */
export function fillNotice(text: string, values: Readonly<Record<string, string>>): string {
  // 消す行と空行の重なりは文面（ひな形）の側だけで決め、差し込んだ値の中の空行はショップが書いたとおりに残す
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const only = /^[ \t]*\{\{[ \t]*([a-z_]+)[ \t]*\}\}[ \t]*$/.exec(line);
    if (only && (values[only[1]!] ?? "") === "") continue;
    if (line.trim() === "" && (lines.length === 0 || lines[lines.length - 1]!.trim() === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.map((line) => line.replace(TAG_RE, (_, n: string) => values[n.replace(/^[ \t]+|[ \t]+$/g, "")] ?? "")).join("\n").replace(/\s+$/, "");
}

/** ショップが直した文面（行）。無ければ既定 */
export interface NoticeTextRow {
  kind: string;
  channel: string;
  subject: string | null;
  body: string;
}

/** 既定の文面（今までの文面と同じ。LINE の注文の知らせは 0179 でリンクの行を足した） */
export const DEFAULT_NOTICE_TEXTS: Record<NoticeKind, { mail: { subject: string; body: string }; line: string }> = {
  order_paid: {
    mail: {
      subject: "【{{shop_name}}】ご注文ありがとうございます（注文番号 {{number}}）",
      body: "{{customer_name}} 様\n\nご注文を承りました。内容をご確認ください。\n\n{{order_details}}\n\n{{return_policy}}\n\n{{order_link}}\n\n{{contact}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】ご注文ありがとうございます。\n注文番号 {{number}}\n合計 {{total}}\n発送の準備ができしだい、お知らせします。\n\n{{order_link}}",
  },
  order_shipped: {
    mail: {
      subject: "【{{shop_name}}】商品を発送しました（注文番号 {{number}}）",
      body: "{{customer_name}} 様\n\nご注文の商品を発送しました。到着までしばらくお待ちください。\n\n{{tracking}}\n\n{{order_details}}\n\n{{order_link}}\n\n{{contact}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】ご注文の商品を発送しました。\n注文番号 {{number}}\n到着までしばらくお待ちください。\n\n{{tracking}}\n\n{{order_link}}",
  },
  tryon_requested: {
    mail: {
      subject: "【{{shop_name}}】お店で試着のお申し込みを承りました（受付番号 {{number}}）",
      body: "{{customer_name}} 様\n\nお店で試着のお申し込みを承りました。お支払いはご来店時に店舗でお願いします（ご試着だけでも大丈夫です）。\n\n受付番号: {{number}}\n{{visit}}\n\n{{items}}\n\n{{store_info}}\n\n{{contact}}\n\n{{shop_link}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】お店で試着のお申し込みを承りました。\n受付番号 {{number}}\n店舗 {{store_name}}\n店舗でご用意ができしだい、お知らせします。",
  },
  tryon_ready: {
    mail: {
      subject: "【{{shop_name}}】{{store_name}}でご試着いただけます（受付番号 {{number}}）",
      body: "{{customer_name}} 様\n\nお申し込みの商品を {{store_name}} にご用意しました。\n{{hold_until}}までお取り置きします。営業時間をご確認のうえ、お越しください。\n\n受付番号: {{number}}\n\n{{items}}\n\n{{store_info}}\n\n{{contact}}\n\n{{shop_link}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】{{store_name}}でご試着いただけます。\n受付番号 {{number}}\n{{hold_until}}までお取り置きします。",
  },
  tryon_reminder: {
    mail: {
      subject: "【{{shop_name}}】お取り置きは{{hold_until}}までです（受付番号 {{number}}）",
      body: "{{customer_name}} 様\n\n{{store_name}}でお取り置きしている商品は、{{hold_until}}までです。営業時間をご確認のうえ、お越しください。\n\n受付番号: {{number}}\n\n{{items}}\n\n{{store_info}}\n\n{{contact}}\n\n{{shop_link}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】{{store_name}}でのお取り置きは{{hold_until}}までです。\n受付番号 {{number}}\nお待ちしております。",
  },
  tryon_extended: {
    mail: {
      subject: "【{{shop_name}}】お取り置きの期限を延長しました（受付番号 {{number}}）",
      body: "{{customer_name}} 様\n\n{{store_name}}でのお取り置きを{{hold_until}}まで延長しました。営業時間をご確認のうえ、お越しください。\n\n受付番号: {{number}}\n\n{{items}}\n\n{{store_info}}\n\n{{contact}}\n\n{{shop_link}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】{{store_name}}でのお取り置きを{{hold_until}}まで延長しました。\n受付番号 {{number}}",
  },
  payment_reminder: {
    mail: {
      subject: "【{{shop_name}}】お支払いのお願い（{{pay_until}}まで）",
      body: "{{customer_name}} 様\n\nお申し込みいただいたご注文のお支払いが、まだ確認できていません。\n{{pay_until}}までにお支払いがないと、お申し込みは取り消されます。\n\n{{items}}\n\n合計（税込）: {{total}}\n\nお支払いがまだの方は、こちらからお支払いに進めます（お申し込みを取りやめることもできます）:\n{{payment_link}}\n\nコンビニ払い・銀行振込の手続きを済ませた方は、KOMOJU から届いたメールの案内でお支払いください。行き違いでお支払い済みの場合は、ご容赦ください。\n\n{{contact}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】お支払いのお願い\nお申し込みのお支払いがまだ確認できていません（合計 {{total}}）。\n{{pay_until}}までにお支払いがないと、お申し込みは取り消されます。\n{{payment_link}}",
  },
  tryon_cancelled: {
    mail: {
      subject: "【{{shop_name}}】お店で試着のお申し込みを取り消しました（受付番号 {{number}}）",
      body: "{{customer_name}} 様\n\nお店で試着のお申し込み（受付番号 {{number}}）を取り消しました。\n\n{{contact}}\n\n{{shop_link}}\n\n{{shop_name}}",
    },
    line: "【{{shop_name}}】お店で試着のお申し込み（受付番号 {{number}}）を取り消しました。",
  },
};

/** LINE の既定の文面。0179 を当てる前の DB にはリンクの行の無い文面を出す（そのまま保存しても DB が断らないように） */
export function defaultLineText(kind: NoticeKind, lineLinks = true): string {
  const text = DEFAULT_NOTICE_TEXTS[kind].line;
  return lineLinks ? text : text.replace(/\n\n\{\{(?:tracking|order_link)\}\}/g, "");
}

/** 直した文面を使えるか（行があって、今の決まりに合う）。使えなければ既定 */
function usable(kind: NoticeKind, channel: NoticeChannel, row: NoticeTextRow | null | undefined): row is NoticeTextRow {
  return Boolean(row) && row!.kind === kind && row!.channel === channel && checkNoticeText(kind, channel, row!.subject, row!.body) === null;
}

/** メールの件名と本文（直した文面が今の決まりに合わなければ既定） */
export function noticeMail(kind: NoticeKind, rows: readonly NoticeTextRow[] | null | undefined, values: Readonly<Record<string, string>>): { subject: string; text: string } {
  const row = (rows ?? []).find((r) => r.kind === kind && r.channel === "mail");
  const t = usable(kind, "mail", row) ? { subject: row.subject ?? "", body: row.body } : DEFAULT_NOTICE_TEXTS[kind].mail;
  return { subject: fillNotice(t.subject, values).replace(/[\r\n]+/g, " "), text: fillNotice(t.body, values) };
}

/** LINE の文 */
export function noticeLine(kind: NoticeKind, rows: readonly NoticeTextRow[] | null | undefined, values: Readonly<Record<string, string>>): string {
  const row = (rows ?? []).find((r) => r.kind === kind && r.channel === "line");
  return fillNotice(usable(kind, "line", row) ? row.body : DEFAULT_NOTICE_TEXTS[kind].line, values);
}

/** 管理画面の警告: 保存してある文面のうち、今の決まりに合わず既定で送っているもの */
export function staleNoticeTexts(rows: readonly NoticeTextRow[]): NoticeTextRow[] {
  return rows.filter((r) => (NOTICE_KINDS as readonly string[]).includes(r.kind) && (r.channel === "mail" || r.channel === "line") && checkNoticeText(r.kind as NoticeKind, r.channel, r.subject, r.body) !== null);
}
