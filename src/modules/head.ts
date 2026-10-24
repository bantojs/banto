/**
 * お店の画面の <head> に差し込む同梱モジュールの一覧（コアの口 src/storefront/head.ts）。
 * コアはここに並んだものを、ON のショップでだけ呼ぶ。中身（どのサービスのタグか）はモジュールが持つ。
 */
import type { StorefrontHeadContributor } from "../storefront/head";
import { ga4Head } from "./ga4/ga4";

export const STOREFRONT_HEAD_CONTRIBUTORS: readonly StorefrontHeadContributor[] = [ga4Head];
