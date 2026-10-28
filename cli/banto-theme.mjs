#!/usr/bin/env node
/**
 * banto-theme — Liquid のテーマを Banto に取り込む・プレビューする・公開する（docs/themes.md「コマンドから」）。
 * 依存なし（Node 20 以上の fetch・fs だけ）。この 1 ファイルをテーマのリポジトリに写して使ってよい（MIT）。
 *
 *   BANTO_URL=https://banto.example.com BANTO_TOKEN=banto_... node banto-theme.mjs push ./theme
 *
 * トークンは管理画面の「AI 連携」で発行する（theme:write。公開まで行うなら theme:publish も）。
 * 経路は /api/v1/themes（REST）。判定（テンプレートの検査・権限・版の状態）はすべて Banto 側で行う。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `使い方: banto-theme <コマンド> [引数]

  push [フォルダ] [--name 名前] [--publish]   テーマを新しい版として取り込み、プレビューのリンクを出す
                                              --publish で取り込んだ版を公開する（theme:publish が要る）
  dev [フォルダ]                              フォルダを見張り、変えるたびに取り込み直してプレビューのリンクを出す
                                              （前の dev の版は消す。公開はしない）
  list                                        版の一覧
  publish <版の id>                           公開する（theme:publish）
  unpublish                                   取り下げて既定のテーマに戻す（theme:publish）
  delete <版の id>                            公開していない版を消す
  prune [--keep 5]                            公開していない版を、新しいものから keep 個だけ残して消す

環境変数: BANTO_URL（Banto の URL。管理画面を開く URL で、ショップの独自ドメインではない）、BANTO_TOKEN（AI 用トークン）`;

/** 束ねるファイル（管理画面の取り込みと同じ）。資産は assets/ の直下 */
const TEXT = /^(layout|templates|sections|snippets)\/[^/]+\.liquid$|^(templates|sections|config|locales)\/[^/]+\.json$/;

export class CliError extends Error {}

/** 翻訳は既定（*.default.json）とデプロイの言語だけ（管理画面と同じ。束ねたファイルの大きさを抑える） */
export function wantedLocale(path, locale) {
  const m = /^locales\/(.+)\.json$/.exec(path);
  if (!m) return true;
  return (/\.default$/.test(m[1]) && !/\.schema/.test(m[1])) || m[1] === locale;
}

async function walk(dir, root = dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, root, out);
    else if (ent.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** フォルダからテーマを束ねる: { bundle, assets: [{ name, path }], skipped } */
export async function buildBundle(dir, locale) {
  let st;
  try {
    st = await stat(dir);
  } catch {
    throw new CliError(`フォルダがありません: ${dir}`);
  }
  if (!st.isDirectory()) throw new CliError(`フォルダではありません: ${dir}`);
  const files = {};
  const assets = [];
  const skipped = [];
  for (const path of (await walk(dir)).sort()) {
    if (TEXT.test(path)) {
      if (wantedLocale(path, locale)) files[path] = await readFile(join(dir, path), "utf8");
      continue;
    }
    const a = /^assets\/([^/]+)$/.exec(path);
    if (a) assets.push({ name: a[1], path: join(dir, path) });
    else skipped.push(path);
  }
  if (!files["layout/theme.liquid"]) throw new CliError(`layout/theme.liquid がありません（テーマのフォルダを指定してください）: ${dir}`);
  return { bundle: { format: 1, files, assets: assets.map((a) => a.name) }, assets, skipped };
}

function client(env, fetchImpl) {
  const base = (env.BANTO_URL ?? "").replace(/\/+$/, "");
  const token = env.BANTO_TOKEN ?? "";
  if (!/^https?:\/\//.test(base)) throw new CliError("BANTO_URL を設定してください（Banto の URL。管理画面を開く URL。例: https://banto.example.com）");
  if (!/^banto_/.test(token)) throw new CliError("BANTO_TOKEN を設定してください（管理画面の「AI 連携」で発行した banto_... のトークン）");
  return async function call(method, path, body, raw) {
    const headers = { authorization: `Bearer ${token}` };
    let payload;
    if (raw) {
      payload = raw;
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(raw.byteLength);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}/api/v1${path}`, { method, headers, body: payload });
      } catch (e) {
        if (attempt < 2) continue;
        throw new CliError(`${base} に繋がりません: ${e instanceof Error ? e.message : String(e)}`);
      }
      // 混んでいる・一時的な失敗は待ってやり直す（2 回まで）
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new CliError(`${method} ${path}: ${res.status}（JSON でない応答。BANTO_URL が Banto を指しているか確かめてください）`);
      }
      if (!res.ok) throw new CliError(`${method} ${path}: ${json?.error?.message ?? res.status}`);
      return json;
    }
  };
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") flags.publish = true;
    else if (a === "--name" || a === "--keep") flags[a.slice(2)] = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("--")) throw new CliError(`知らない指定です: ${a}`);
    else args.push(a);
  }
  return { args, flags };
}

/** 1 つの版を取り込む: 束ねたファイル → 資産（4 つずつ並べて）→ 置き終える。戻り値は版 */
async function pushOnce(call, dir, name, log) {
  const list = await call("GET", "/themes");
  if (!list.can_render) throw new CliError("この Banto では Liquid のテーマを使えません（Workers の有料プランか Node。サイトの設定の「Workers のプラン」）");
  const { bundle, assets, skipped } = await buildBundle(dir, list.locale ?? "ja");
  if (skipped.length) log(`取り込まないファイル ${skipped.length} 個（${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}）`);
  const version = await call("POST", "/themes", { name, bundle });
  log(`版を足しました: ${version.id}（テンプレートなど ${Object.keys(bundle.files).length} 個、資産 ${assets.length} 個）`);
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const a = assets[next++];
      const data = await readFile(a.path);
      await call("PUT", `/themes/${version.id}/assets/${encodeURIComponent(a.name)}`, undefined, data);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, worker));
    return await call("POST", `/themes/${version.id}/complete`);
  } catch (e) {
    // 途中で止まった版は残さない（公開できない版が数の上限を埋めないように）
    await call("DELETE", `/themes/${version.id}`).catch(() => {});
    throw e;
  }
}

async function previewLine(call, id, shopPublished, domain, log) {
  if (!domain) return log("プレビュー: ショップに独自ドメインを設定すると開けます");
  if (!shopPublished) return log("プレビュー: ショップを公開すると開けます");
  const p = await call("POST", `/themes/${id}/preview`);
  log(`プレビュー（30 分）: ${p.preview_url}`);
}

/**
 * コマンドを実行する。テストでは fetch・環境変数・出力を差し替える。
 * @returns 終了コード
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const err = io.error ?? ((s) => console.error(s));
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? fetch;
  try {
    const [cmd, ...rest] = argv;
    const { args, flags } = parseArgs(rest);
    if (!cmd || flags.help || cmd === "help") {
      log(USAGE);
      return cmd ? 0 : 1;
    }
    const call = client(env, fetchImpl);
    switch (cmd) {
      case "push": {
        const dir = args[0] ?? ".";
        const v = await pushOnce(call, dir, flags.name ?? `push ${new Date().toISOString().slice(0, 19).replace("T", " ")}`, log);
        const list = await call("GET", "/themes");
        if (flags.publish) {
          await call("POST", "/themes/publish", { version_id: v.id });
          log(`公開しました: ${v.id}（お店の画面は 30 秒ほどで切り替わります）`);
        } else {
          await previewLine(call, v.id, list.shop_published, list.domain, log);
        }
        return 0;
      }
      case "dev": {
        const dir = args[0] ?? ".";
        let current = null;
        let running = false;
        let again = false;
        const round = async () => {
          if (running) {
            again = true;
            return;
          }
          running = true;
          try {
            const v = await pushOnce(call, dir, `dev ${new Date().toISOString().slice(0, 19).replace("T", " ")}`, log);
            if (current) await call("DELETE", `/themes/${current}`).catch(() => {});
            current = v.id;
            const list = await call("GET", "/themes");
            await previewLine(call, v.id, list.shop_published, list.domain, log);
          } catch (e) {
            err(e instanceof Error ? e.message : String(e));
          } finally {
            running = false;
            if (again) {
              again = false;
              void round();
            }
          }
        };
        await round();
        if (io.once) return 0;
        log(`見張っています: ${dir}（止めるには Ctrl+C）`);
        let timer = null;
        watch(dir, { recursive: true }, (_e, file) => {
          if (file && String(file).split(/[\\/]/).some((p) => p.startsWith("."))) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void round(), 400);
        });
        await new Promise(() => {});
        return 0;
      }
      case "list": {
        const list = await call("GET", "/themes");
        if (!list.items.length) log("版はまだありません");
        for (const v of list.items) {
          const info = [v.manifest?.theme_name, v.manifest?.theme_version].filter(Boolean).join(" ");
          log(`${v.published ? "*" : " "} ${v.id}  ${v.complete ? "        " : "取り込み途中"}  ${v.created_at}  ${v.name}${info ? `（${info}）` : ""}`);
        }
        log(`（* が公開中。版は ${list.items.length} / ${list.max_versions}）`);
        return 0;
      }
      case "publish": {
        if (!args[0]) throw new CliError("公開する版の id を指定してください（banto-theme list）");
        await call("POST", "/themes/publish", { version_id: args[0] });
        log(`公開しました: ${args[0]}（お店の画面は 30 秒ほどで切り替わります）`);
        return 0;
      }
      case "unpublish": {
        await call("POST", "/themes/publish", { version_id: null });
        log("取り下げました。既定のテーマに戻ります");
        return 0;
      }
      case "delete": {
        if (!args[0]) throw new CliError("消す版の id を指定してください");
        await call("DELETE", `/themes/${args[0]}`);
        log(`消しました: ${args[0]}`);
        return 0;
      }
      case "prune": {
        const keep = flags.keep === undefined ? 5 : Number(flags.keep);
        if (!Number.isInteger(keep) || keep < 0) throw new CliError("--keep は 0 以上の整数です");
        const list = await call("GET", "/themes");
        const old = list.items.filter((v) => !v.published).slice(keep);
        for (const v of old) {
          await call("DELETE", `/themes/${v.id}`);
          log(`消しました: ${v.id}  ${v.name}`);
        }
        log(`${old.length} 個消しました`);
        return 0;
      }
      default:
        throw new CliError(`知らないコマンドです: ${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
