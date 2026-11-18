import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { NotSavedNotice, failCode, updateShop } from "../../routes/admin/shop-save";
import { COD_DEFAULT_MAX_TOTAL, COD_FEE_MAX, COD_MAX_TIERS, COD_NOTE_MAX, COD_UPTO_MAX, codSettings, type CodSettings, type CodTier } from "./index";

/**
 * 同梱モジュール「代金引換」の設定（shops.settings.cod。docs/cod.md）。
 *   GET/POST /admin/shops/:shopId/modules/cod
 * 手数料（一律 / 金額の段）・上限金額（合計・手数料込み）・会員だけ・確認画面に添える文。確定のとき DB が同じ決まりで引き直す
 */
export const codAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<{ shop: ShopRow; cod: CodSettings } | null> {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  const cod = shop ? codSettings(shop.settings) : null;
  return shop && cod ? { shop, cod } : null;
}

/** 段の欄（1 行に「この金額まで,手数料」） */
export function tiersText(tiers: CodTier[]): string {
  return tiers.map((x) => `${x.upto},${x.fee}`).join("\n");
}

/** 段の欄を読む。形の違う行があれば null（保存しない） */
export function parseTiers(text: string): CodTier[] | null {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (rows.length > COD_MAX_TIERS) return null;
  const out: CodTier[] = [];
  for (const row of rows) {
    const m = /^([0-9][0-9,]*)\s*[,、\t ]\s*([0-9][0-9,]*)$/.exec(row.replace(/[円¥\s]+(?=[,、\t])/g, "").replace(/円$/, ""));
    if (!m) return null;
    const upto = Number(m[1]!.replace(/,/g, ""));
    const fee = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isInteger(upto) || upto < 1 || upto > COD_UPTO_MAX || !Number.isInteger(fee) || fee < 0 || fee > COD_FEE_MAX) return null;
    out.push({ upto, fee });
  }
  return out.sort((a, b) => a.upto - b.upto);
}

codAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const sc = await scope(c);
  if (!sc) return c.notFound();
  const { shop, cod } = sc;
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("cod.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("cod.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules", here: "cod" }}>
      <PageHead title={t("cod.title")} />
      {flash === "saved" ? <p class="notice">{t("cod.saved")}</p> : null}
      {flash === "invalid_tiers" ? <p class="error">{tf("cod.invalid_tiers", { max: COD_MAX_TIERS })}</p> : null}
      <NotSavedNotice flash={flash} />
      <p>{t("cod.intro")}</p>
      <form method="post" action={`/admin/shops/${shop.id}/modules/cod`}>
        <fieldset>
          <legend>{t("cod.fee")}</legend>
          <label>
            <input type="radio" name="fee_type" value="flat" checked={cod.fee_type === "flat"} /> {t("cod.fee_flat")}
          </label>
          <input id="fee_jpy" type="number" name="fee_jpy" min={0} max={COD_FEE_MAX} value={String(cod.fee_jpy)} style="width:8rem" aria-label={t("cod.fee_flat")} /> {t("cod.yen")}
          <label>
            <input type="radio" name="fee_type" value="tiers" checked={cod.fee_type === "tiers"} /> {t("cod.fee_tiers")}
          </label>
          <textarea id="fee_tiers" name="fee_tiers" rows={5} placeholder={"10000,330\n30000,440\n100000,660\n300000,1100"} aria-label={t("cod.fee_tiers")}>
            {tiersText(cod.fee_tiers)}
          </textarea>
          <p class="muted">{t("cod.fee_tiers_help")}</p>
        </fieldset>
        <label for="max_total_jpy">{t("cod.max_total")}</label>
        <input id="max_total_jpy" type="number" name="max_total_jpy" min={1} max={COD_UPTO_MAX} value={String(cod.max_total_jpy)} style="width:10rem" /> {t("cod.yen")}
        <p class="muted">{t("cod.max_total_help")}</p>
        <label>
          <input type="checkbox" name="members_only" value="on" checked={cod.members_only} /> {t("cod.members_only")}
        </label>
        <label for="note">{t("cod.note")}</label>
        <textarea id="note" name="note" rows={3} maxlength={COD_NOTE_MAX}>
          {cod.note}
        </textarea>
        <p class="muted">{t("cod.note_help")}</p>
        <p>
          <button type="submit">{t("cod.save")}</button>
        </p>
      </form>
      <p class="muted">{t("cod.after_note")}</p>
    </AdminLayout>,
  );
});

codAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const sc = await scope(c);
  if (!sc) return c.notFound();
  const { shop } = sc;
  const f = await formFields(c);
  const int = (v: string | undefined, lo: number, hi: number, d: number) => {
    const n = Number.parseInt((v ?? "").replace(/,/g, ""), 10);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  const fee_type = f.fee_type === "tiers" ? "tiers" : "flat";
  const fee_tiers = parseTiers(f.fee_tiers ?? "");
  if (fee_tiers === null || (fee_type === "tiers" && fee_tiers.length === 0)) return c.redirect(`/admin/shops/${shop.id}/modules/cod?flash=invalid_tiers`);
  const cod = {
    fee_type,
    fee_jpy: int(f.fee_jpy, 0, COD_FEE_MAX, 0),
    fee_tiers,
    max_total_jpy: int(f.max_total_jpy, 1, COD_UPTO_MAX, COD_DEFAULT_MAX_TOTAL),
    members_only: f.members_only === "on",
    note: (f.note ?? "").trim().slice(0, COD_NOTE_MAX),
  };
  try {
    await updateShop(c, shop.id, { settings: { ...(shop.settings ?? {}), cod } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shop.id}/modules/cod?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shop.id}/modules/cod?flash=saved`);
});
