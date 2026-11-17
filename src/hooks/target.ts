/**
 * hooks の送信先（外部プラグインの URL）の行き先の判定。登録・更新・配信・テスト送信・マニフェストの取得のすべてがここを通る。
 * 私設のアドレス・localhost・社内でしか引けない名前には登録も配信もしない（画像の取り込みと同じ classifyHost）。
 * 同梱プラグインの内部 URL（banto.invalid）は HTTP を使わずプロセス内で振り分けるので、配信の判定では「公開」として扱わない代わりに通す。
 */
import { classifyHost } from "../media/address";
import { bundledPluginIdFromUrl } from "../plugins/types";

/** 同梱プラグインの内部 URL のホスト（/plugins の経路だけが登録する。0031） */
export function isBundledHookHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "banto.invalid" || h.endsWith(".banto.invalid");
}

/**
 * 入力された URL のホストが国際化ドメイン（ASCII の外の文字）なら、URL パーサーの形（xn--…）に直す。ほかはそのまま。
 * DB と Worker は ASCII のホストだけを受ける（どちらの読み方でも同じホストになる形だけ）ので、保存の前に直しておく
 */
export function asciiHookUrl(url: string): string {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  if (!/[^\x00-\x7f]/.test(authority)) return url;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * 外部プラグインの URL として受け付けるか（登録・更新）。http(s) で、行き先が公開のアドレスかドメイン名、banto.invalid でない。
 */
export function externalHookUrl(url: string): boolean {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return false;
  // DB（banto_hook_url_shape_ok、0142）と同じ形だけ: ホストは ASCII の名前か [IPv6]、利用者情報（user@）・制御文字・バックスラッシュは受けない。
  // URL パーサーは \ を区切りに読み、全角の数字や % の符号化を直すので、文字のまま比べる DB の検査と別のホストになる書き方を入口で断る
  if (url.length > 2000 || /[\\\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1]?.toLowerCase() ?? "";
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.?)(:[0-9]{1,5})?$/.test(authority)) return false;
  try {
    const host = new URL(url).hostname;
    if (isBundledHookHost(host)) return false;
    return classifyHost(host) !== "blocked";
  } catch {
    return false;
  }
}

/**
 * 送る直前の最後の砦: 行き先が私設のアドレス・社内の名前なら true（送らずに失敗にする）。
 * 直叩き・復元で入った行を止める。同梱プラグインの URL はプロセス内の振り分けなので false（HTTP には出ない）。
 */
export function blockedHookTarget(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    if (bundledPluginIdFromUrl(url) !== null) return false;
    return classifyHost(u.hostname) === "blocked";
  } catch {
    return true;
  }
}

export const BLOCKED_HOOK_TARGET = "hook target is not a public address (private IP, localhost or an internal name); delivery was not attempted";
