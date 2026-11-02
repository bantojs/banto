#!/usr/bin/env node
/**
 * デプロイ（`npm run deploy`）。デプロイごとに違う設定を、ビルドの変数で選ぶ。
 *   BANTO_PLACEMENT … Worker を動かす場所（Cloudflare の Placement、docs/setup.md §8）
 *   BANTO_OBSERVABILITY=off … ログ（Workers Logs）を切る（既定は wrangler.jsonc のとおり ON、docs/setup.md §9）
 *   BANTO_WORKER_NAME / BANTO_MEDIA_BUCKET / BANTO_PRIVATE_BUCKET … Worker 名と R2 のバケット名（既定は wrangler.jsonc の banto / banto-media / banto-private）。
 *     同じアカウントに Banto を 2 つ以上立てる（お店ごと・確認用など）ときに、それぞれのデプロイの設定で変える（docs/setup.md §10）
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

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** BANTO_WORKER_NAME の値 → Worker 名。未設定は null、形が違えば例外（英小文字・数字・ハイフン、63 文字まで） */
export function workerNameFor(raw) {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (WORKER_NAME.test(v)) return v;
  throw new Error(`BANTO_WORKER_NAME の形が違います: "${v}"（英小文字・数字・ハイフン、63 文字まで。例: banto-shop2）`);
}

/** BANTO_*_BUCKET の値 → R2 のバケット名。未設定は null、形が違えば例外（英小文字・数字・ハイフン、3〜63 文字） */
export function bucketNameFor(raw, varName) {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (BUCKET_NAME.test(v)) return v;
  throw new Error(`${varName} の形が違います: "${v}"（英小文字・数字・ハイフン、3〜63 文字。例: banto-shop2-media）`);
}

/** wrangler.jsonc の最上位の "name" を変える（行の頭の "name" だけ。無ければ例外） */
export function withWorkerName(text, name) {
  const re = /^(\s*)"name"\s*:\s*"[^"]*"/m;
  if (!re.test(text)) throw new Error('wrangler.jsonc に "name" がありません');
  return text.replace(re, `$1"name": ${JSON.stringify(name)}`);
}

/** wrangler.jsonc の R2 の Binding（"binding": "<binding>", "bucket_name": "..."）のバケット名を変える。無ければ例外 */
export function withBucket(text, binding, bucket) {
  const re = new RegExp(`("binding"\\s*:\\s*"${binding}"\\s*,\\s*"bucket_name"\\s*:\\s*)"[^"]*"`);
  if (!re.test(text)) throw new Error(`wrangler.jsonc に R2 の Binding ${binding} がありません`);
  return text.replace(re, `$1${JSON.stringify(bucket)}`);
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
  let workerName;
  let mediaBucket;
  let privateBucket;
  try {
    placement = placementFor(process.env.BANTO_PLACEMENT);
    obsOff = observabilityOff(process.env.BANTO_OBSERVABILITY);
    workerName = workerNameFor(process.env.BANTO_WORKER_NAME);
    mediaBucket = bucketNameFor(process.env.BANTO_MEDIA_BUCKET, "BANTO_MEDIA_BUCKET");
    privateBucket = bucketNameFor(process.env.BANTO_PRIVATE_BUCKET, "BANTO_PRIVATE_BUCKET");
  } catch (e) {
    console.error(`deploy: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const args = ["deploy", ...process.argv.slice(2)];
  const copy = placement !== null || obsOff || workerName !== null || mediaBucket !== null || privateBucket !== null;
  if (copy) {
    let text = readFileSync("wrangler.jsonc", "utf8");
    try {
      if (placement) text = withPlacement(text, placement);
      if (obsOff) text = withoutObservability(text);
      if (workerName) text = withWorkerName(text, workerName);
      if (mediaBucket) text = withBucket(text, "MEDIA", mediaBucket);
      if (privateBucket) text = withBucket(text, "PRIVATE", privateBucket);
    } catch (e) {
      console.error(`deploy: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    writeFileSync(PLACEMENT_CONFIG, text);
    args.push("--config", PLACEMENT_CONFIG);
  }
  console.log(placement ? `deploy: placement ${JSON.stringify(placement)}` : "deploy: BANTO_PLACEMENT が無いので、placement は wrangler.jsonc のまま");
  if (workerName) console.log(`deploy: Worker 名 ${workerName}`);
  if (mediaBucket || privateBucket) console.log(`deploy: R2 のバケット MEDIA=${mediaBucket ?? "（wrangler.jsonc のまま）"} PRIVATE=${privateBucket ?? "（wrangler.jsonc のまま）"}`);
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
