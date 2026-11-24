/**
 * KOMOJU の支払い方法ごとの手数料（shops.settings.payment_fees、0170。メンテナの決定 2026-11-23、docs/plugins.md「KOMOJU」）。
 *   GET/POST /admin/shops/:shopId/payment-fees
 * 決まりの形は代引き手数料（settings.cod）と同じ（一律 / 金額の段）。確定の前に DB が同じ決まりで確かめる（reservation_payment_fee_check）。
 * 項目 settings（代引きの設定と同じ）。0170 を当てるまで出さない
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import type { ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { FEE_MAX, FEE_MAX_TIERS, KOMOJU_TYPE_RE, PAYMENT_FEE_MAX_TYPES, PAYMENT_FEES_MIGRATION, paymentFeeRules, paymentFeeWarnings, type FeeRule, type PaymentFeeWarning } from "../../commerce/payment-fees";
import { parsePaymentTypes } from "../../plugins/komoju";
import { komojuTypeLabel } from "../../commerce/checkout";
import { parseTiers, tiersText } from "../../modules/cod/admin";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { NotSavedNotice, failCode, updateShop } from "./shop-save";

export const paymentFeesAdmin = new Hono<AppEnv>();

/** 0170 が当たっているか（入口のリンクにも使う） */
export async function paymentFeesReady(c: AdminContext): Promise<boolean> {
  return migrated({ db: owner(c).db, cache: c.get("adapters").cache }, PAYMENT_FEES_MIGRATION);
}

/** KOMOJU のプラグインの「受け付ける支払い方法」。プラグインが無い・読めない（項目 integrations が無い）ときは null（警告を出さない） */
async function komojuConfigured(c: AdminContext, shopId: string): Promise<string[] | null> {
  try {
    const row = await owner(c).db.from<{ settings: Record<string, string | boolean> | null }>("hook_endpoints").selectOne("settings", { eq: { shop_id: shopId, url: "https://banto.invalid/plugins/komoju" } });
    return row ? parsePaymentTypes(row.settings ?? {}) : null;
  } catch (e) {
    if (e instanceof DbError) return null;
    throw e;
  }
}

function warningText(w: PaymentFeeWarning): string {
  if (w.kind === "types_empty") return t("payfees.warn_types_empty");
  if (w.kind === "not_accepted") return tf("payfees.warn_not_accepted", { type: w.type });
  return tf("payfees.warn_unknown_type", { type: w.type });
}

async function scope(c: AdminContext): Promise<ShopRow | null> {
  if (!(await paymentFeesReady(c))) return null;
  return loadShop(c, param(c, "shopId"), "settings");
}

/** 1 行分の欄（i は行の番号。空の行は新しい種類を足す欄） */
function Row(p: { i: number; type: string; rule: FeeRule | null }) {
  const r = p.rule ?? { fee_type: "flat" as const, fee_jpy: 0, fee_tiers: [] };
  return (
    <fieldset>
      <legend>{p.type ? `${komojuTypeLabel(p.type)}（${p.type}）` : t("payfees.add")}</legend>
      <label for={`type_${p.i}`}>{t("payfees.type")}</label>
      <input id={`type_${p.i}`} name={`type_${p.i}`} value={p.type} maxlength={40} pattern="[a-z_]{1,40}" style="width:14rem" />
      <p>{t("payfees.fee")}</p>
      <label>
        <input type="radio" name={`fee_type_${p.i}`} value="flat" checked={r.fee_type === "flat"} /> {t("cod.fee_flat")}
      </label>
      <input type="number" name={`fee_jpy_${p.i}`} min={0} max={FEE_MAX} value={String(r.fee_jpy)} style="width:8rem" aria-label={t("cod.fee_flat")} /> {t("cod.yen")}
      <label>
        <input type="radio" name={`fee_type_${p.i}`} value="tiers" checked={r.fee_type === "tiers"} /> {t("cod.fee_tiers")}
      </label>
      <textarea name={`fee_tiers_${p.i}`} rows={4} placeholder={"10000,220\n30000,330"} aria-label={t("cod.fee_tiers")}>
        {tiersText(r.fee_tiers)}
      </textarea>
      {p.type ? (
        <label>
          <input type="checkbox" name={`remove_${p.i}`} value="on" /> {t("payfees.remove")}
        </label>
      ) : null}
    </fieldset>
  );
}

paymentFeesAdmin.get("/:shopId/payment-fees", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const rules = [...paymentFeeRules(shop.settings).entries()];
  const warnings = paymentFeeWarnings(rules.map(([type]) => type), await komojuConfigured(c, shop.id));
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("payfees.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("plugins.title"), href: `/admin/shops/${shop.id}/plugins` }, { label: t("payfees.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "plugins" }}>
      <PageHead title={t("payfees.title")} />
      {flash === "saved" ? <p class="notice">{t("payfees.saved")}</p> : null}
      {flash === "invalid" ? <p class="error">{tf("payfees.invalid", { max: PAYMENT_FEE_MAX_TYPES })}</p> : null}
      <NotSavedNotice flash={flash} />
      <p>{t("payfees.intro")}</p>
      <p class="muted">{t("payfees.types_hint")}</p>
      {warnings.length > 0 ? (
        <ul class="error" data-payfees-warnings>
          {warnings.map((w) => (
            <li>{warningText(w)}</li>
          ))}
        </ul>
      ) : null}
      <form method="post" action={`/admin/shops/${shop.id}/payment-fees`}>
        {rules.map(([type, rule], i) => (
          <Row i={i} type={type} rule={rule} />
        ))}
        {rules.length < PAYMENT_FEE_MAX_TYPES ? <Row i={rules.length} type="" rule={null} /> : null}
        <input type="hidden" name="rows" value={String(rules.length + 1)} />
        <p class="muted">{t("cod.fee_tiers_help")}</p>
        <p>
          <button type="submit">{t("payfees.save")}</button>
        </p>
      </form>
      <p class="muted">{t("payfees.after_note")}</p>
    </AdminLayout>,
  );
});

/** フォーム → settings.payment_fees。形の違う行があれば null（保存しない） */
export function parsePaymentFeesForm(f: Record<string, string | undefined>): Record<string, FeeRule> | null {
  const rows = Math.min(Number.parseInt(f.rows ?? "0", 10) || 0, PAYMENT_FEE_MAX_TYPES + 1);
  const out: Record<string, FeeRule> = {};
  for (let i = 0; i < rows; i++) {
    const type = (f[`type_${i}`] ?? "").trim();
    if (!type || f[`remove_${i}`] === "on") continue;
    if (!KOMOJU_TYPE_RE.test(type) || out[type]) return null;
    const fee_type = f[`fee_type_${i}`] === "tiers" ? "tiers" : "flat";
    const fee_tiers = parseTiers(f[`fee_tiers_${i}`] ?? "");
    if (fee_tiers === null || fee_tiers.length > FEE_MAX_TIERS || (fee_type === "tiers" && fee_tiers.length === 0)) return null;
    const n = Number.parseInt((f[`fee_jpy_${i}`] ?? "0").replace(/,/g, ""), 10);
    if (fee_type === "flat" && !(Number.isInteger(n) && n >= 0 && n <= FEE_MAX)) return null;
    out[type] = { fee_type, fee_jpy: fee_type === "flat" ? n : 0, fee_tiers };
  }
  return Object.keys(out).length > PAYMENT_FEE_MAX_TYPES ? null : out;
}

paymentFeesAdmin.post("/:shopId/payment-fees", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const fees = parsePaymentFeesForm(await formFields(c));
  if (!fees) return c.redirect(`/admin/shops/${shop.id}/payment-fees?flash=invalid`);
  const settings: Record<string, unknown> = { ...(shop.settings ?? {}) };
  // 決まりが 1 つも無ければ鍵ごと外す（KOMOJU は今までどおり 1 つのボタン）
  if (Object.keys(fees).length > 0) settings["payment_fees"] = fees;
  else delete settings["payment_fees"];
  try {
    await updateShop(c, shop.id, { settings });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shop.id}/payment-fees?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shop.id}/payment-fees?flash=saved`);
});
