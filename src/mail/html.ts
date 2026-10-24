/**
 * 会員へのメールの HTML（ショップのロゴ・アクセントカラー。テーマ設定 shops.settings.theme_settings）。
 * テキスト版も必ず一緒に送る（HTML を表示しないメールソフト向け）。値はすべてエスケープし、色と画像の URL は形を確かめてから使う。
 * メールソフトは <style> を落とすことがあるので、見た目はインラインの style だけで作る。
 */
export interface MailBranding {
  name: string;
  settings?: Record<string, unknown> | null;
}

export interface MailContent {
  /** 本文のいちばん上の見出し */
  heading: string;
  /** 段落（プレーンテキスト。改行はそのまま改行にする） */
  paragraphs: string[];
  /** 大きく出す値（ログインのコード） */
  code?: string;
  /** ボタン（https / http の URL だけ） */
  button?: { label: string; url: string };
  /** 下の小さい注意書き */
  note?: string;
}

const DEFAULT_ACCENT = "#1f6feb";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function themeSetting(settings: Record<string, unknown> | null | undefined, key: string): string | null {
  const ts = settings?.["theme_settings"];
  if (!ts || typeof ts !== "object") return null;
  const v = (ts as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function mailAccent(settings: Record<string, unknown> | null | undefined): string {
  const v = themeSetting(settings, "accent_color");
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

/** メールに載せてよいロゴの URL（https だけ。http の画像はメールソフトが出さないことが多い） */
export function mailLogo(settings: Record<string, unknown> | null | undefined): string | null {
  const v = themeSetting(settings, "logo_url");
  if (!v || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const para = (s: string) => escapeHtml(s).replace(/\n/g, "<br>");

export function renderMailHtml(shop: MailBranding, m: MailContent): string {
  const accent = mailAccent(shop.settings);
  const logo = mailLogo(shop.settings);
  const href = m.button ? safeHref(m.button.url) : null;
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif";
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(shop.name)}" style="max-height:48px;max-width:240px;border:0">`
    : `<span style="font-size:18px;font-weight:bold;color:#111">${escapeHtml(shop.name)}</span>`;
  return [
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(m.heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f4f5f7;${font}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;border-top:4px solid ${accent}">`,
    `<tr><td style="padding:24px 28px 8px">${header}</td></tr>`,
    `<tr><td style="padding:8px 28px 24px;color:#222;font-size:15px;line-height:1.7">`,
    `<h1 style="font-size:18px;margin:0 0 16px;color:#111">${escapeHtml(m.heading)}</h1>`,
    ...m.paragraphs.map((p) => `<p style="margin:0 0 14px">${para(p)}</p>`),
    m.code ? `<p style="margin:8px 0 20px;font-size:32px;letter-spacing:6px;font-weight:bold;color:#111;font-family:Menlo,Consolas,monospace">${escapeHtml(m.code)}</p>` : "",
    m.button && href
      ? `<p style="margin:8px 0 20px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">${escapeHtml(m.button.label)}</a></p>`
      : "",
    m.note ? `<p style="margin:16px 0 0;color:#666;font-size:13px">${para(m.note)}</p>` : "",
    `</td></tr></table>`,
    `<p style="color:#888;font-size:12px;margin:16px 0 0">${escapeHtml(shop.name)}</p>`,
    `</td></tr></table></body></html>`,
  ].join("");
}
