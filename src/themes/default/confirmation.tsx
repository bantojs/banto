/**
 * 最終確認画面の中身（特商法の表示・注文を確定するボタン・修正するボタン）。同梱テーマの ConfirmPage と、
 * Liquid のテーマの {% banto_confirmation %}（src/routes/storefront/liquid.ts）が同じものを描く。表示の項目を Banto が決めるため、
 * テーマはこの外側だけを作る（docs/themes.md「レジ」）。インラインのスクリプトを入れない（レジの画面の CSP で止まる）
 */
import type { Confirmation } from "../../commerce/checkout";
import { t, tf } from "../../i18n";
import { yen } from "../../routes/common";

export function ConfirmationBlock({ shopPath, confirmation: cf, quote, error }: { shopPath: string; confirmation: Confirmation; quote: string; error?: string }) {
  const a = cf.ship_to;
  const secondary = "background:transparent;color:inherit;border:1px solid color-mix(in srgb,CanvasText 30%,transparent)";
  return (
    <div class="banto-confirmation">
      <p>{cf.payment.free ? t("confirm.intro_free") : t("confirm.intro")}</p>
      {error ? <p class="error">{error}</p> : null}

      <h2>{t("confirm.items")}</h2>
      <table>
        <thead>
          <tr>
            <th>{t("confirm.product")}</th>
            <th>{t("confirm.unit_price")}</th>
            <th>{t("confirm.qty")}</th>
            <th>{t("confirm.line_total")}</th>
          </tr>
        </thead>
        <tbody>
          {cf.lines.map((l) => (
            <tr>
              <td>
                {l.product_name}
                {l.sku_name ? <span class="muted"> / {l.sku_name}</span> : null}
                {l.reduced ? <span> {t("tax.reduced_mark")}</span> : null}
              </td>
              <td>{yen(l.unit_price_jpy)}</td>
              <td>{l.qty}</td>
              <td>{yen(l.line_total_jpy)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colspan={3}>{t("confirm.subtotal")}</td>
            <td>{yen(cf.subtotal_jpy)}</td>
          </tr>
          <tr>
            <td colspan={3}>{t("confirm.shipping")}</td>
            <td>{yen(cf.shipping_jpy)}</td>
          </tr>
          {cf.discounts.map((d) => (
            <tr>
              <td colspan={3}>
                {t("confirm.discount")}（{d.code} {d.name}）
              </td>
              <td>−{yen(d.amount_jpy)}</td>
            </tr>
          ))}
          <tr>
            <th colspan={3}>{t("confirm.total")}</th>
            <th>{yen(cf.total_jpy)}</th>
          </tr>
        </tfoot>
      </table>
      <p class="muted">{t("tax.included_note")}</p>
      <ul class="muted">
        {cf.tax.map((g) => (
          <li>{g.rate > 0 ? tf("tax.group", { rate: g.rate, amount: yen(g.amount_jpy), tax: yen(g.tax_jpy) }) : tf("tax.group_exempt", { amount: yen(g.amount_jpy) })}</li>
        ))}
      </ul>
      {cf.lines.some((l) => l.reduced) ? <p class="muted">{t("tax.reduced_legend")}</p> : null}
      {cf.coupon_notices.length > 0 ? (
        <div>
          <p class="error">{t("confirm.coupon_notices")}</p>
          <ul>
            {cf.coupon_notices.map((n) => (
              <li>
                {n.code}: {n.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <h2>{t("confirm.payment")}</h2>
      <p>{cf.payment.method}</p>
      <h3>{t("confirm.payment_timing")}</h3>
      <p>{cf.payment.timing}</p>
      {cf.payment.note ? <pre class="legal">{cf.payment.note}</pre> : null}

      {cf.delivery_request ? (
        <div>
          <h2>{t("delivery.request")}</h2>
          <p>{cf.delivery_request.text}</p>
        </div>
      ) : null}
      <h2>{t("confirm.delivery")}</h2>
      {cf.delivery ? (
        <pre class="legal">{cf.delivery}</pre>
      ) : (
        <p>
          <a href={cf.links.legal}>{t("confirm.delivery_fallback")}</a>
        </p>
      )}

      <h2>{t("confirm.cancellation")}</h2>
      {cf.cancellation ? (
        <pre class="legal">{cf.cancellation}</pre>
      ) : (
        <p>
          <a href={cf.links.returns}>{t("confirm.cancellation_fallback")}</a>
        </p>
      )}

      <h2>{t("confirm.ship_to")}</h2>
      <p>
        {a.name}
        <br />〒{a.postal_code} {a.state}
        {a.city}
        {a.line1}
        {a.line2 ? ` ${a.line2}` : ""}
        <br />
        {a.phone} / {a.email}
      </p>
      {cf.marketing_consent !== null && cf.marketing_consent !== undefined ? (
        <p>
          {t("consent.label")}: {cf.marketing_consent ? t("consent.yes") : t("consent.no")}
        </p>
      ) : null}

      <p class="muted">
        {t("confirm.links")}: <a href={cf.links.legal}>{t("shop.legal_notice")}</a> · <a href={cf.links.privacy}>{t("shop.privacy_policy")}</a> · <a href={cf.links.returns}>{t("shop.return_policy")}</a>
      </p>

      <form method="post" action={`${shopPath}/checkout/${cf.payment.provider}`}>
        <input type="hidden" name="quote" value={quote} />
        <p>
          <button type="submit">{cf.submit_label}</button>
        </p>
      </form>
      <form method="post" action={`${shopPath}/checkout`} style="display:inline-block;margin-right:.5rem">
        <input type="hidden" name="provider" value={cf.payment.provider} />
        <input type="hidden" name="customer_name" value={a.name} />
        <input type="hidden" name="customer_email" value={a.email} />
        <input type="hidden" name="phone" value={a.phone} />
        <input type="hidden" name="postal_code" value={a.postal_code} />
        <input type="hidden" name="state" value={a.state} />
        <input type="hidden" name="city" value={a.city} />
        <input type="hidden" name="line1" value={a.line1} />
        <input type="hidden" name="line2" value={a.line2} />
        {cf.delivery_request?.date ? <input type="hidden" name="delivery_date" value={cf.delivery_request.date} /> : null}
        {cf.delivery_request?.slot ? <input type="hidden" name="delivery_slot" value={cf.delivery_request.slot} /> : null}
        {cf.marketing_consent ? <input type="hidden" name="marketing_consent" value="1" /> : null}
        <button type="submit" style={secondary}>
          {t("confirm.edit")}
        </button>
      </form>
      <a href={`${shopPath}/cart`}>{t("confirm.back_to_cart")}</a>
    </div>
  );
}
