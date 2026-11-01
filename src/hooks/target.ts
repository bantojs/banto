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
 * 外部プラグインの URL として受け付けるか（登録・更新）。http(s) で、行き先が公開のアドレスかドメイン名、banto.invalid でない。
 */
export function externalHookUrl(url: string): boolean {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return false;
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
