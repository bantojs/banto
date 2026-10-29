#!/usr/bin/env node
/**
 * デプロイ（`npm run deploy`）。デプロイごとに違う設定を、ビルドの変数で選ぶ。
 *   BANTO_PLACEMENT … Worker を動かす場所（Cloudflare の Placement、docs/setup.md §8）
 *   BANTO_OBSERVABILITY=off … ログ（Workers Logs）を切る（既定は wrangler.jsonc のとおり ON、docs/setup.md §9）
 * リポジトリの wrangler.jsonc は書き換えない（アップデートで競合しない）。変えた写しを同じ場所に作り、それで wrangler deploy する。
 *
 *   BANTO_PLACEMENT=aws:ap-northeast-1   … DB（Supabase）のリージョンの近くで動かす（いちばん確実）
 *   BANTO_PLACEMENT=smart                … Cloudflare が通信を見て決める（アクセスが少ないと移らないことがある）
 *   未設定                                 … wrangler.jsonc のまま（買い手の近くで動く）
 *
 * Cloudflare 固有の設定だが、デプロイの設定でコードは変わらず、Node 版には関係しない（docs/knowledge/02-decisions.md 2026-10-29）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGION = /^(aws|gcp|azure):[a-z0-9-]{2,40}$/;
/** 設定を変えた写し（.gitignore 済み）。main などの相対パスがそのまま効くよう、wrangler.jsonc と同じ場所に置く */
export const PLACEMENT_CONFIG = "wrangler.placement.jsonc";

/** BANTO_PLACEMENT の値 → wrangler の placement。未設定は null、形が違えば例外 */
export function placementFor(raw) {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (v === "smart") return { mode: "smart" };
  if (REGION.test(v)) return { mode: "targeted", region: v };
  throw new Error(`BANTO_PLACEMENT の形が違います: "${v}"（例: aws:ap-northeast-1 / smart）`);
}

/** BANTO_OBSERVABILITY の値 → ログを切るか。未設定・on は false（wrangler.jsonc のまま）、off は true、ほかは例外 */
export function observabilityOff(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return false;
  if (v === "off") return true;
  throw new Error(`BANTO_OBSERVABILITY の形が違います: "${v}"（off で切る）`);
}

/** wrangler.jsonc の本文に placement を足す。最上位の { の直後に置く（コメントはそのまま）。もう placement があれば例外 */
export function withPlacement(text, placement) {
  if (/^\s*"placement"\s*:/m.test(text)) throw new Error("wrangler.jsonc にもう placement があります。BANTO_PLACEMENT を使うなら、そちらを消してください");
  const at = text.indexOf("{");
  if (at < 0) throw new Error("wrangler.jsonc の形が違います");
  return `${text.slice(0, at + 1)}\n  // scripts/deploy.mjs が BANTO_PLACEMENT から足した\n  "placement": ${JSON.stringify(placement)},${text.slice(at + 1)}`;
}

/** wrangler.jsonc の observability（ログ・issues）を切る。1 行で書かれた "observability": { "enabled": true, ... } だけを相手にする。無ければ例外 */
export function withoutObservability(text) {
  const re = /^(\s*)"observability"\s*:\s*\{\s*"enabled"\s*:\s*true\b.*?(,?)$/m;
  if (!re.test(text)) throw new Error('wrangler.jsonc に "observability": { "enabled": true, ... } がありません');
  return text.replace(re, '$1"observability": { "enabled": false }$2');
}

function main() {
  let placement;
  let obsOff;
  try {
    placement = placementFor(process.env.BANTO_PLACEMENT);
    obsOff = observabilityOff(process.env.BANTO_OBSERVABILITY);
  } catch (e) {
    console.error(`deploy: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const args = ["deploy", ...process.argv.slice(2)];
  const copy = placement !== null || obsOff;
  if (copy) {
    let text = readFileSync("wrangler.jsonc", "utf8");
    try {
      if (placement) text = withPlacement(text, placement);
      if (obsOff) text = withoutObservability(text);
    } catch (e) {
      console.error(`deploy: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    writeFileSync(PLACEMENT_CONFIG, text);
    args.push("--config", PLACEMENT_CONFIG);
  }
  console.log(placement ? `deploy: placement ${JSON.stringify(placement)}` : "deploy: BANTO_PLACEMENT が無いので、placement は wrangler.jsonc のまま");
  console.log(obsOff ? "deploy: BANTO_OBSERVABILITY=off なので、ログ（observability）を切る" : "deploy: ログ（observability）は wrangler.jsonc のまま");
  try {
    // npm run から呼ぶので、wrangler は node_modules/.bin のもの（Windows は npx.cmd のためシェルを通す）
    const r = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: process.platform === "win32" });
    return r.status ?? 1;
  } finally {
    if (copy) rmSync(PLACEMENT_CONFIG, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
