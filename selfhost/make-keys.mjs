#!/usr/bin/env node
// 自前の PostgREST + GoTrue 用の鍵を作る（docs/self-hosted-db.md）。依存なし（Node 18 以上）。
//   node selfhost/make-keys.mjs            → 新しい JWT の秘密と、それで署名した anon / service_role の鍵
//   JWT_SECRET=... node selfhost/make-keys.mjs  → 既にある秘密で鍵だけ作り直す
// 出力は .env にそのまま貼れる形。service_role の鍵と秘密は、Banto の Secret と .env 以外に置かないこと。
import { createHmac, randomBytes } from "node:crypto";

const secret = process.env.JWT_SECRET || randomBytes(48).toString("base64url");
if (secret.length < 32) {
  console.error("JWT_SECRET は 32 文字以上にしてください");
  process.exit(1);
}
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (payload) => {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const now = Math.floor(Date.now() / 1000);
// Supabase の鍵と同じ形（role だけで切り替える）。期限は 10 年
const key = (role) => sign({ role, iss: "banto-selfhost", iat: now, exp: now + 10 * 365 * 24 * 3600 });

console.log(`JWT_SECRET=${secret}`);
console.log(`ANON_KEY=${key("anon")}`);
console.log(`SERVICE_ROLE_KEY=${key("service_role")}`);
console.log(`AUTHENTICATOR_PASSWORD=${randomBytes(24).toString("base64url")}`);
console.log(`AUTH_ADMIN_PASSWORD=${randomBytes(24).toString("base64url")}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(24).toString("base64url")}`);
console.log(`SESSION_SECRET=${randomBytes(48).toString("base64url")}`);
