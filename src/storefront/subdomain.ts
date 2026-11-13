/**
 * サブドメインモード（デプロイの設定 SHOP_DOMAIN_TEMPLATE、docs/custom-domain.md §7）。
 *
 * ひな形（例 `{slug}.example.com`）を入れると、ショップを作ったときに `<スラッグ>.example.com` をショップのドメイン（shops.domain）にする。
 * ショップごとに独自ドメインを付けるのと同じ扱いになる（お店と管理画面が別のオリジンになり、Liquid のテーマ・パスキーが使える）。
 * ひな形に合うホストはスラッグでショップを引き、どのショップにも結ばれていないホストは 404 にする（domain.ts）。
 */
import { normalizeDomain } from "./urls";

/** スラッグの形（src/routes/common.ts の SLUG_RE と DB の shops_slug_format と同じ） */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface DomainTemplate {
  /** `{slug}` の後ろ（例 `.example.com`、`-acme.example.com`） */
  suffix: string;
  /** suffix のうち、スラッグと同じラベルに入る部分（例 ``、`-acme`） */
  labelSuffix: string;
}

const PLACEHOLDER = "{slug}";

/** ひな形を読む。形が違えば null（サブドメインモードにしない） */
export function parseDomainTemplate(raw: string | null | undefined): DomainTemplate | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v.startsWith(PLACEHOLDER)) return null;
  const suffix = v.slice(PLACEHOLDER.length);
  if (suffix.includes(PLACEHOLDER) || !(suffix.startsWith(".") || suffix.startsWith("-"))) return null;
  const dot = suffix.indexOf(".");
  if (dot < 0) return null;
  const labelSuffix = suffix.slice(0, dot);
  // スラッグの後ろに付ける文字はハイフンで始まり、ラベルの終わりは英数字（`{slug}-` のような形を断る）
  if (labelSuffix && !/^-[a-z0-9-]*[a-z0-9]$/.test(labelSuffix)) return null;
  // 1 文字のスラッグを入れて、ドメインの形として正しいか
  if (normalizeDomain(`a${suffix}`) !== `a${suffix}`) return null;
  return { suffix, labelSuffix };
}

/**
 * ひな形とスラッグから作るショップのドメイン。DNS のラベルとして使えなければ null
 * （長さ 63 字まで・末尾の `-` なし・`xn--` で始まらない・3〜4 文字目に `--` を置かない（IDNA の予約））
 */
export function templateDomain(tpl: DomainTemplate, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const label = slug + tpl.labelSuffix;
  if (label.length > 63 || label.endsWith("-") || label.slice(2, 4) === "--") return null;
  const domain = slug + tpl.suffix;
  return normalizeDomain(domain) === domain ? domain : null;
}

/** ひな形に合うホストのスラッグ（合わなければ null） */
export function templateSlug(tpl: DomainTemplate, host: string): string | null {
  if (host.length <= tpl.suffix.length || !host.endsWith(tpl.suffix)) return null;
  const slug = host.slice(0, -tpl.suffix.length);
  return templateDomain(tpl, slug) === host ? slug : null;
}

/** このショップのドメインが、ひな形どおり（スラッグから作ったもの）か */
export function isTemplateDomain(tpl: DomainTemplate | null, shop: { slug: string; domain?: string | null }): boolean {
  return Boolean(tpl && shop.domain && shop.domain === templateDomain(tpl, shop.slug));
}

/**
 * デプロイの設定からひな形を読む。管理画面の URL（PUBLIC_BASE_URL）が無ければ使わない
 * （ショップのドメインと Banto 自身のホストを分けられないため。独自ドメインの保存と同じ条件、docs/custom-domain.md §1）
 */
export function domainTemplateFrom(config: { get(name: string): string | undefined }): DomainTemplate | null {
  if (!config.get("PUBLIC_BASE_URL")) return null;
  return parseDomainTemplate(config.get("SHOP_DOMAIN_TEMPLATE"));
}
