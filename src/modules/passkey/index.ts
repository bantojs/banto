/**
 * パスキーでログイン（同梱モジュール passkey、既定 OFF。0046_mod_passkey、docs/members.md「パスキー」、
 * 設計は docs/knowledge/10-members-identity.md §18）。
 * 使えるのは独自ドメインのショップの、そのドメインの上だけ（RP ID = ショップのドメイン。人間の決定 2026-10-23）。
 * 署名の検証は src/members/webauthn.ts、ルートは src/routes/storefront/members.ts の「パスキー」の節。
 * ここはモジュールの名前と、ブラウザで動く小さなスクリプト（テーマが <script src> で読む）だけを持つ。
 */
import { type Mailer, sendMail } from "../../mail/send";
import { renderMailHtml } from "../../mail/html";
import { t, tf } from "../../i18n";
import { formatDateTime } from "../../i18n/time";

export const PASSKEY_MODULE = "passkey";
/** ヘッドレスの会員がパスキーを追加する券（0070） */
export const PASSKEY_ADD_MIGRATION = "0070_mod_passkey_headless_add";

/**
 * ブラウザのスクリプト（`${shopPath}/account/passkey.js`）。テーマは次の印を付けた要素を置く（src/themes/types.ts）:
 *   data-banto-passkey="login"     押すとパスキーでログイン（data-return-to があればヘッドレスの戻り先）
 *   data-banto-passkey="register"  押すとこの端末のパスキーを追加
 *   data-banto-passkey-error       失敗したときの文言を入れる場所（data-msg-failed / -cancelled / -reauth / -unsupported）
 *   data-banto-passkey-block       パスキーが使えないブラウザでは隠す
 * fetch は同じオリジンの JSON（csrfGuard を通る）。文字列の置き換えだけで組める ES2017 で書く（ビルドを通さない）
 */
export const PASSKEY_CLIENT_JS = `(function () {
  "use strict";
  var me = document.currentScript;
  if (!me || window.__bantoPasskey) return;
  window.__bantoPasskey = true;
  var base = new URL("./", me.src).href;
  var supported = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  function b2u(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function u2b(u) {
    u = u.replace(/-/g, "+").replace(/_/g, "/");
    while (u.length % 4) u += "=";
    var s = atob(u), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b.buffer;
  }
  function post(path, body) {
    return fetch(base + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }
  function say(el, key) {
    var box = document.querySelector("[data-banto-passkey-error]");
    if (!box) return;
    box.textContent = box.getAttribute("data-msg-" + key) || box.getAttribute("data-msg-failed") || "";
    box.hidden = false;
  }
  function login(el) {
    return post("passkey/login/options", {}).then(function (o) {
      if (!o.publicKey) return o;
      var pk = o.publicKey;
      pk.challenge = u2b(pk.challenge);
      return navigator.credentials.get({ publicKey: pk }).then(function (c) {
        var r = c.response;
        return post("passkey/login", {
          challenge_id: o.challenge_id,
          return_to: el.getAttribute("data-return-to") || undefined,
          credential: { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(r.clientDataJSON), authenticatorData: b2u(r.authenticatorData), signature: b2u(r.signature), userHandle: r.userHandle ? b2u(r.userHandle) : null } }
        });
      });
    });
  }
  function register(el) {
    return post("passkey/register/options", {}).then(function (o) {
      if (!o.publicKey) return o;
      var pk = o.publicKey;
      pk.challenge = u2b(pk.challenge);
      pk.user.id = u2b(pk.user.id);
      (pk.excludeCredentials || []).forEach(function (x) { x.id = u2b(x.id); });
      return navigator.credentials.create({ publicKey: pk }).then(function (c) {
        var r = c.response;
        return post("passkey/register", {
          challenge_id: o.challenge_id,
          return_to: el.getAttribute("data-return-to") || undefined,
          credential: { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(r.clientDataJSON), attestationObject: b2u(r.attestationObject) } }
        });
      });
    });
  }
  var els = document.querySelectorAll("[data-banto-passkey]");
  for (var i = 0; i < els.length; i++) (function (el) {
    if (!supported) {
      var block = el.closest("[data-banto-passkey-block]") || el;
      block.hidden = true;
      return;
    }
    el.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (el.disabled) return;
      el.disabled = true;
      var run = el.getAttribute("data-banto-passkey") === "register" ? register(el) : login(el);
      run.then(function (r) {
        if (r && r.redirect) { location.assign(r.redirect); return; }
        el.disabled = false;
        say(el, r && r.error === "reauth" ? "reauth" : "failed");
      }, function (e) {
        el.disabled = false;
        say(el, e && e.name === "NotAllowedError" ? "cancelled" : "failed");
      });
    });
  })(els[i]);
})();
`;

/** パスキーを追加したことを本人に知らせる（盗まれたセッションで足されたときに気づけるように）。送れなくても登録は止めない */
export async function sendPasskeyAddedNotice(
  deps: { mailer: Mailer | null },
  shop: { name: string; settings?: Record<string, unknown> | null },
  m: { from: string; to: string; accountUrl: string; at?: Date },
): Promise<void> {
  if (!deps.mailer || !m.from || !m.to) return;
  const time = formatDateTime((m.at ?? new Date()).toISOString());
  await sendMail(deps.mailer, {
    from: m.from,
    to: m.to,
    subject: tf("passkey.notice_subject", { shop: shop.name }),
    text: tf("passkey.notice_body", { shop: shop.name, email: m.to, time, account: m.accountUrl }),
    html: renderMailHtml(shop, {
      heading: t("passkey.notice_heading"),
      paragraphs: [tf("passkey.notice_intro", { email: m.to, time }), t("passkey.notice_advice")],
      button: { label: t("member.notice_button"), url: m.accountUrl },
    }),
  }).catch((e: unknown) => console.error("[banto] passkey added notice:", e));
}
