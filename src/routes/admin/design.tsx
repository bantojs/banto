import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { migrated } from "../../db/migration-state";
import { shopOrigin } from "../../storefront/urls";
import { THEMES_MIGRATION } from "../../themes/liquid";
import { assetType, checkThemeBundle, THEME_BUNDLE_LIMITS, type ThemeBundle } from "../../themes/liquid/bundle";
import { extendShopify } from "../../themes/liquid/shopify";
import { sealThemePreview } from "../storefront/liquid";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, publicBaseUrl, sessionSecret, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * デザイン（Liquid のテーマ、0071、docs/themes.md）: /admin/shops/:shopId/design。項目 design の人だけ。
 *   GET  /                                   版の一覧・取り込み・使える条件
 *   POST /versions                           束ねたテーマ（JSON）を検査して置き、版を足す（ブラウザが zip を展開して送る）
 *   POST /versions/:id/assets/:name          資産を 1 つ置く（中身そのもの。版の束ねたファイルに名前があるものだけ）
 *   GET  /versions/:id/preview               ショップのドメインでプレビューを開く（署名付き、30 分）
 *   POST /publish                            公開する・取り下げる（version が空なら既定のテーマに戻す）
 *   POST /versions/:id/delete                版を消す（公開中は消せない）。置き場のファイルも消す
 */
export const design = new Hono<AppEnv>();

interface VersionRow {
  id: string;
  name: string;
  size_bytes: number;
  file_count: number;
  manifest: Record<string, unknown>;
  created_at: string;
}

const FLASH: Record<string, { kind: "ok" | "error"; key: MessageKey }> = {
  uploaded: { kind: "ok", key: "design.uploaded" },
  published: { kind: "ok", key: "design.published" },
  unpublished: { kind: "ok", key: "design.unpublished" },
  deleted: { kind: "ok", key: "design.deleted" },
  requires_domain: { kind: "error", key: "design.requires_domain" },
  full: { kind: "error", key: "design.full" },
  published_cannot_delete: { kind: "error", key: "design.published_cannot_delete" },
  generic: { kind: "error", key: "error.generic" },
};

async function scope(c: AdminContext): Promise<ShopRow | null> {
  return loadShop(c, param(c, "shopId"), "design");
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/design`;
const keyOf = (shopId: string, versionId: string) => `themes/${shopId}/${versionId}/bundle.json`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** テーマの情報（settings_schema.json の theme_info）。画面に出すだけ */
function manifestOf(bundle: ThemeBundle): Record<string, string> {
  try {
    const schema = JSON.parse((bundle.files["config/settings_schema.json"] ?? "[]").replace(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/, "")) as unknown;
    const info = Array.isArray(schema) ? schema.find((x) => x && typeof x === "object" && (x as Record<string, unknown>)["name"] === "theme_info") : null;
    if (!info || typeof info !== "object") return {};
    const pick = (k: string) => (typeof (info as Record<string, unknown>)[k] === "string" ? String((info as Record<string, unknown>)[k]).slice(0, 100) : undefined);
    return Object.fromEntries(Object.entries({ theme_name: pick("theme_name"), theme_version: pick("theme_version"), theme_author: pick("theme_author") }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  } catch {
    return {};
  }
}

async function readBundle(c: AdminContext, shopId: string, versionId: string): Promise<ThemeBundle | null> {
  const obj = await c.get("adapters").storage.get(keyOf(shopId, versionId));
  if (!obj) return null;
  try {
    return JSON.parse(await new Response(obj.body).text()) as ThemeBundle;
  } catch {
    return null;
  }
}

/**
 * zip をブラウザで展開して、テンプレート・設定・翻訳を 1 つの JSON に束ねて送り、資産を 1 つずつ送る。
 * ライブラリは使わない（zip の目次を読み、DecompressionStream("deflate-raw") で戻す。ZIP64・暗号化は断る）。
 * 固定の文字列なので raw で出す（利用者の入力を含まない）。文言は data-* で受け取る
 */
const UPLOAD_SCRIPT = `(function(){
  var form=document.getElementById("theme-form"); if(!form) return;
  var input=document.getElementById("theme-file"), status=document.getElementById("theme-status"), btn=form.querySelector("button[type=submit]");
  var MSG=JSON.parse(form.getAttribute("data-msg")||"{}");
  var TEXT=/^(layout|templates|sections|snippets)\\/[^\\/]+\\.liquid$|^(templates|sections|config|locales)\\/[^\\/]+\\.json$/;
  function say(s){ status.textContent=s; }
  function readZip(buf){
    var dv=new DataView(buf), eocd=-1;
    for(var i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-65557);i--){ if(dv.getUint32(i,true)===0x06054b50){eocd=i;break;} }
    if(eocd<0) throw new Error(MSG.notzip);
    var n=dv.getUint16(eocd+10,true), off=dv.getUint32(eocd+16,true), out=[], dec=new TextDecoder();
    for(var k=0;k<n;k++){
      if(dv.getUint32(off,true)!==0x02014b50) throw new Error(MSG.notzip);
      var flags=dv.getUint16(off+8,true), method=dv.getUint16(off+10,true), csize=dv.getUint32(off+20,true), nlen=dv.getUint16(off+28,true), elen=dv.getUint16(off+30,true), clen=dv.getUint16(off+32,true), lho=dv.getUint32(off+42,true);
      if(flags&1) throw new Error(MSG.encrypted);
      var name=dec.decode(new Uint8Array(buf,off+46,nlen));
      var start=lho+30+dv.getUint16(lho+26,true)+dv.getUint16(lho+28,true);
      out.push({name:name,method:method,data:new Uint8Array(buf,start,csize)});
      off+=46+nlen+elen+clen;
    }
    return out;
  }
  function unpack(e){
    if(e.method===0) return Promise.resolve(new Blob([e.data]));
    if(e.method!==8||typeof DecompressionStream==="undefined") return Promise.reject(new Error(MSG.method));
    return new Response(new Blob([e.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  }
  form.addEventListener("submit",function(ev){
    ev.preventDefault();
    var file=input.files&&input.files[0]; if(!file) return;
    btn.disabled=true; say(MSG.reading);
    file.arrayBuffer().then(function(buf){
      var entries=readZip(buf).filter(function(e){ return !/\\/$/.test(e.name)&&!/(^|\\/)(__MACOSX|\\.)/.test(e.name); });
      // 1 つのフォルダに包まれた zip（theme/layout/... ）なら、そのフォルダを外す
      var first=entries.length?entries[0].name.split("/")[0]:"";
      if(first&&!/^(layout|templates|sections|snippets|config|locales|assets)$/.test(first)&&entries.every(function(e){return e.name.split("/")[0]===first;})) entries.forEach(function(e){ e.name=e.name.slice(first.length+1); });
      var files={}, assets=[], blobs={};
      return Promise.all(entries.map(function(e){
        if(TEXT.test(e.name)) return unpack(e).then(function(b){ return b.text(); }).then(function(s){ files[e.name]=s; });
        var m=/^assets\\/([^\\/]+)$/.exec(e.name);
        if(m) return unpack(e).then(function(b){ assets.push(m[1]); blobs[m[1]]=b; });
        return null;
      })).then(function(){
        say(MSG.checking);
        var name=(form.elements.namedItem("name").value||"").trim()||file.name.replace(/\\.zip$/i,"");
        return fetch(form.action,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({name:name,bundle:{format:1,files:files,assets:assets}})});
      }).then(function(res){ return res.json(); }).then(function(r){
        if(!r.ok){ throw new Error((r.errors||[MSG.failed]).slice(0,20).join("\\n")); }
        var i=0;
        function next(){
          if(i>=assets.length){ location.href=r.next; return; }
          var a=assets[i++]; say(MSG.assets+" "+i+" / "+assets.length);
          return fetch(r.assets+encodeURIComponent(a),{method:"POST",credentials:"same-origin",headers:{"content-type":"application/octet-stream"},body:blobs[a]}).then(function(res){ if(!res.ok) throw new Error(MSG.asset_failed+" "+a); return next(); });
        }
        return next();
      });
    }).catch(function(err){ btn.disabled=false; status.style.whiteSpace="pre-wrap"; say(String(err&&err.message||err)); });
  });
})();`;

design.get("/:shopId/design", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.text(t("shop.not_found"), 404);
  const { db } = owner(c);
  const tabs = { shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "design" as const };
  const crumbs = [{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("design.title") }];
  if (!(await migrated({ db, cache: c.get("adapters").cache }, THEMES_MIGRATION))) {
    return c.html(
      <AdminLayout title={`${shop.name} · ${t("design.title")}`} nav crumbs={crumbs} shopTabs={tabs}>
        <PageHead title={t("design.title")} />
        <p class="notice">{t("design.needs_update")}</p>
      </AdminLayout>,
    );
  }
  const [versions, published, plan] = await Promise.all([
    db.from<VersionRow>("theme_versions").select("id,name,size_bytes,file_count,manifest,created_at", { eq: { shop_id: shop.id }, order: "created_at.desc" }),
    db.from<{ theme_version_id: string | null }>("shops").selectOne("theme_version_id", { eq: { id: shop.id } }),
    db.rpc<string>("banto_site_plan", {}).catch(() => "free"),
  ]);
  const current = published?.theme_version_id ?? null;
  const cpuOk = Boolean(c.get("adapters").cpuUnlimited) || plan === "paid";
  const flash = FLASH[c.req.query("flash") ?? ""];
  const msg = {
    reading: t("design.js.reading"),
    checking: t("design.js.checking"),
    assets: t("design.js.assets"),
    failed: t("design.js.failed"),
    asset_failed: t("design.js.asset_failed"),
    notzip: t("design.js.notzip"),
    encrypted: t("design.js.encrypted"),
    method: t("design.js.method"),
  };
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("design.title")}`} nav crumbs={crumbs} shopTabs={tabs}>
      <PageHead title={t("design.title")} sub={t("design.intro")} />
      {flash ? <p class={flash.kind === "ok" ? "notice" : "error"}>{t(flash.key)}</p> : null}
      <section>
        <h2>{t("design.conditions")}</h2>
        <ul>
          <li>{shop.domain ? tf("design.cond_domain_ok", { domain: shop.domain }) : t("design.cond_domain_ng")}</li>
          <li>{cpuOk ? t("design.cond_plan_ok") : t("design.cond_plan_ng")}</li>
        </ul>
        {!shop.domain || !cpuOk ? <p class="muted">{t("design.cond_fallback")}</p> : null}
      </section>

      <section>
        <h2>{t("design.versions")}</h2>
        {versions.length === 0 ? (
          <p class="muted">{t("design.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("design.col_name")}</th>
                <th>{t("design.col_theme")}</th>
                <th>{t("design.col_created")}</th>
                <th>{t("design.col_size")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr>
                  <td>
                    {v.name}
                    {v.id === current ? <span class="badge">{t("design.live")}</span> : null}
                  </td>
                  <td class="muted">{[v.manifest["theme_name"], v.manifest["theme_version"]].filter((x) => typeof x === "string").join(" ")}</td>
                  <td>{formatDateTime(v.created_at)}</td>
                  <td>{tf("design.size", { kb: Math.ceil(v.size_bytes / 1024), files: v.file_count })}</td>
                  <td class="actions">
                    {shop.domain ? (
                      <a class="btn secondary" href={`${base(shop)}/versions/${v.id}/preview`} target="_blank" rel="noopener">
                        {t("design.preview")}
                      </a>
                    ) : null}
                    {v.id === current ? null : (
                      <form method="post" action={`${base(shop)}/publish`} class="inline">
                        <input type="hidden" name="version" value={v.id} />
                        <button type="submit" disabled={!shop.domain}>
                          {t("design.publish")}
                        </button>
                      </form>
                    )}
                    {v.id === current ? null : (
                      <form method="post" action={`${base(shop)}/versions/${v.id}/delete`} class="inline" onsubmit={`return confirm(${JSON.stringify(t("design.delete_confirm"))})`}>
                        <button type="submit" class="danger">
                          {t("design.delete")}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {current ? (
          <form method="post" action={`${base(shop)}/publish`}>
            <input type="hidden" name="version" value="" />
            <button type="submit" class="secondary">
              {t("design.unpublish")}
            </button>
          </form>
        ) : null}
      </section>

      <section>
        <h2>{t("design.upload")}</h2>
        <p class="muted">{tf("design.upload_hint", { mb: Math.round(THEME_BUNDLE_LIMITS.assetBytes / 1048576) })}</p>
        <form id="theme-form" method="post" action={`${base(shop)}/versions`} data-msg={JSON.stringify(msg)}>
          <label>
            {t("design.upload_name")}
            <input type="text" name="name" maxlength={100} />
          </label>
          <label>
            {t("design.upload_file")}
            <input type="file" id="theme-file" accept=".zip,application/zip" required />
          </label>
          <button type="submit">{t("design.upload_button")}</button>
          <p id="theme-status" class="muted" aria-live="polite" />
          <noscript>
            <p class="error">{t("design.noscript")}</p>
          </noscript>
        </form>
        <script dangerouslySetInnerHTML={{ __html: UPLOAD_SCRIPT }} />
      </section>
    </AdminLayout>,
  );
});

/** 束ねたテーマを受けて検査し、置き場に置いてから版を足す。答えは JSON（画面のスクリプトが読む） */
design.post("/:shopId/design/versions", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.json({ ok: false, errors: [t("shop.not_found")] }, 404);
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > THEME_BUNDLE_LIMITS.bundleChars * 2) return c.json({ ok: false, errors: [t("design.too_large")] }, 413);
  let body: { name?: unknown; bundle?: unknown };
  try {
    body = (await c.req.json()) as { name?: unknown; bundle?: unknown };
  } catch {
    return c.json({ ok: false, errors: [t("error.generic")] }, 400);
  }
  const check = checkThemeBundle(body.bundle, { extend: extendShopify });
  if (!check.ok || !check.bundle) return c.json({ ok: false, errors: check.errors }, 422);
  const bundle = check.bundle;
  const name = (typeof body.name === "string" ? body.name.trim() : "").slice(0, 100) || t("design.untitled");
  const id = crypto.randomUUID();
  const text = JSON.stringify(bundle);
  const storage = c.get("adapters").storage;
  await storage.put(keyOf(shop.id, id), new TextEncoder().encode(text).buffer as ArrayBuffer, "application/json");
  try {
    await owner(c).db.rpc("theme_version_create", {
      p_shop_id: shop.id,
      p_id: id,
      p_name: name,
      p_size_bytes: Math.max(1, text.length),
      p_file_count: Object.keys(bundle.files).length + bundle.assets.length,
      p_manifest: manifestOf(bundle),
      p_settings: {},
    });
  } catch (e) {
    await storage.delete(keyOf(shop.id, id));
    if (e instanceof DbError && e.message.includes("theme_versions_full")) return c.json({ ok: false, errors: [t("design.full")] }, 409);
    throw e;
  }
  return c.json({ ok: true, id, assets: `${base(shop)}/versions/${id}/assets/`, next: `${base(shop)}?flash=uploaded` });
});

/** 資産を 1 つ置く。版の束ねたファイルに名前があり、決まった種類で、上限の大きさまで */
design.post("/:shopId/design/versions/:versionId/assets/:name", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const versionId = param(c, "versionId");
  const name = param(c, "name");
  if (!shop || !UUID.test(versionId)) return c.json({ ok: false }, 404);
  const type = assetType(name);
  if (!type) return c.json({ ok: false }, 400);
  // 自分のショップの版か（RLS。design の項目）
  const row = await owner(c).db.from<{ id: string }>("theme_versions").selectOne("id", { eq: { id: versionId, shop_id: shop.id } });
  if (!row) return c.json({ ok: false }, 404);
  const bundle = await readBundle(c, shop.id, versionId);
  if (!bundle || !bundle.assets.includes(name)) return c.json({ ok: false }, 404);
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > THEME_BUNDLE_LIMITS.assetBytes) return c.json({ ok: false }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > THEME_BUNDLE_LIMITS.assetBytes) return c.json({ ok: false }, 413);
  await c.get("adapters").storage.put(`themes/${shop.id}/${versionId}/assets/${name}`, buf, type);
  return c.json({ ok: true });
});

/** ショップのドメインでプレビューを開く（券は押したときに作る。30 分） */
design.get("/:shopId/design/versions/:versionId/preview", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const versionId = param(c, "versionId");
  const secret = sessionSecret(c);
  if (!shop || !shop.domain || !secret || !UUID.test(versionId)) return c.text(t("shop.not_found"), 404);
  const row = await owner(c).db.from<{ id: string }>("theme_versions").selectOne("id", { eq: { id: versionId, shop_id: shop.id } });
  if (!row) return c.text(t("shop.not_found"), 404);
  const token = await sealThemePreview(secret, shop.id, versionId);
  return c.redirect(`${shopOrigin(publicBaseUrl(c), shop)}/?preview_theme=${versionId}&preview_token=${encodeURIComponent(token)}`);
});

design.post("/:shopId/design/publish", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const version = (f.version ?? "").trim();
  if (version && !UUID.test(version)) return c.redirect(`${base(shop)}?flash=generic`);
  try {
    await owner(c).db.rpc("theme_publish", { p_shop_id: shop.id, p_version_id: version || null });
  } catch (e) {
    if (e instanceof DbError && e.message.includes("theme_requires_domain")) return c.redirect(`${base(shop)}?flash=requires_domain`);
    throw e;
  }
  // お客様の画面のショップ行のキャッシュは短い（30 秒）ので、そのまま待てば切り替わる
  return c.redirect(`${base(shop)}?flash=${version ? "published" : "unpublished"}`);
});

design.post("/:shopId/design/versions/:versionId/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const versionId = param(c, "versionId");
  if (!shop || !UUID.test(versionId)) return c.text(t("shop.not_found"), 404);
  const bundle = await readBundle(c, shop.id, versionId);
  let prefix: string;
  try {
    prefix = await owner(c).db.rpc<string>("theme_version_delete", { p_version_id: versionId });
  } catch (e) {
    if (e instanceof DbError && e.message.includes("theme_published")) return c.redirect(`${base(shop)}?flash=published_cannot_delete`);
    throw e;
  }
  const storage = c.get("adapters").storage;
  for (const a of bundle?.assets ?? []) if (assetType(a)) await storage.delete(`${prefix}assets/${a}`).catch(() => {});
  await storage.delete(`${prefix}bundle.json`).catch(() => {});
  return c.redirect(`${base(shop)}?flash=deleted`);
});
