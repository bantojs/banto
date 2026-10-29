#!/usr/bin/env node
/**
 * デプロイ（`npm run deploy`）。Worker を動かす場所（Cloudflare の Placement）を、ビルドの変数 BANTO_PLACEMENT で選ぶ。
 * リポジトリの wrangler.jsonc は書き換えない（アップデートで競合しない）。placement を足した写しを同じ場所に作り、それで wrangler deploy する。
 *
 *   BANTO_PLACEMENT=aws:ap-northeast-1   … DB（Supabase）のリージョンの近くで動かす（いちばん確実。docs/setup.md §8）
 *   BANTO_PLACEMENT=smart                … Cloudflare が通信を見て決める（アクセスが少ないと移らないことがある）
 *   未設定                                 … wrangler.jsonc のまま（買い手の近くで動く）
 *
 * Cloudflare 固有の設定だが、デプロイの設定でコードは変わらず、Node 版には関係しない（docs/knowledge/02-decisions.md 2026-10-29）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGION = /^(aws|gcp|azure):[a-z0-9-]{2,40}$/;
/** placement を足した写し（.gitignore 済み）。main などの相対パスがそのまま効くよう、wrangler.jsonc と同じ場所に置く */
export const PLACEMENT_CONFIG = "wrangler.placement.jsonc";

/** BANTO_PLACEMENT の値 → wrangler の placement。未設定は null、形が違えば例外 */
export function placementFor(raw) {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (v === "smart") return { mode: "smart" };
  if (REGION.test(v)) return { mode: "targeted", region: v };
  throw new Error(`BANTO_PLACEMENT の形が違います: "${v}"（例: aws:ap-northeast-1 / smart）`);
}

/** wrangler.jsonc の本文に placement を足す。最上位の { の直後に置く（コメントはそのまま）。もう placement があれば例外 */
export function withPlacement(text, placement) {
  if (/^\s*"placement"\s*:/m.test(text)) throw new Error("wrangler.jsonc にもう placement があります。BANTO_PLACEMENT を使うなら、そちらを消してください");
  const at = text.indexOf("{");
  if (at < 0) throw new Error("wrangler.jsonc の形が違います");
  return `${text.slice(0, at + 1)}\n  // scripts/deploy.mjs が BANTO_PLACEMENT から足した\n  "placement": ${JSON.stringify(placement)},${text.slice(at + 1)}`;
}

function main() {
  let placement;
  try {
    placement = placementFor(process.env.BANTO_PLACEMENT);
  } catch (e) {
    console.error(`deploy: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const args = ["deploy", ...process.argv.slice(2)];
  if (placement) {
    writeFileSync(PLACEMENT_CONFIG, withPlacement(readFileSync("wrangler.jsonc", "utf8"), placement));
    args.push("--config", PLACEMENT_CONFIG);
    console.log(`deploy: placement ${JSON.stringify(placement)}`);
  } else {
    console.log("deploy: BANTO_PLACEMENT が無いので、placement は wrangler.jsonc のまま");
  }
  try {
    // npm run から呼ぶので、wrangler は node_modules/.bin のもの（Windows は npx.cmd のためシェルを通す）
    const r = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: process.platform === "win32" });
    return r.status ?? 1;
  } finally {
    if (placement) rmSync(PLACEMENT_CONFIG, { force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
