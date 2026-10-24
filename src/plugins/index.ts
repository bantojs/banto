import type { BundledPlugin } from "./types";
import { lineNotify } from "./line_notify";
import { komoju } from "./komoju";
import { stripeDirect } from "./stripe_direct";
import { emailResend } from "./email_resend";
import { lineBuyerNotify } from "./line_buyer";

/** 同梱プラグインの一覧。追加したらここに足す（管理画面「プラグイン」に並ぶ） */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [stripeDirect, komoju, emailResend, lineNotify, lineBuyerNotify];

export function findBundledPlugin(id: string): BundledPlugin | undefined {
  return BUNDLED_PLUGINS.find((p) => p.id === id);
}

export { bundledPluginIdFromUrl, bundledPluginUrl, BUNDLED_PLUGIN_URL_PREFIX } from "./types";
export type { BundledPlugin, PluginContext } from "./types";
