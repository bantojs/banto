#!/usr/bin/env node
// Node ビルドの起動煙テスト: dist/node/server.js を起動し、/health と /admin/setup が応答することを確認する。
import { spawn } from "node:child_process";

const port = 18787;
const child = spawn(process.execPath, ["dist/node/server.js"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CRON_INTERVAL_SECONDS: "0", PUBLIC_BASE_URL: `http://127.0.0.1:${port}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

const deadline = Date.now() + 20_000;
let ok = false;
try {
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) {
        const body = await health.json();
        const setup = await fetch(`http://127.0.0.1:${port}/admin/setup`);
        const html = await setup.text();
        ok = body.ok === true && setup.status === 200 && html.includes("SUPABASE_URL");
        break;
      }
    } catch {
      /* まだ起動中 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
} finally {
  child.kill("SIGTERM");
}
if (!ok) {
  console.error("smoke-node: FAILED\n" + output);
  process.exit(1);
}
console.log("smoke-node: ok");
