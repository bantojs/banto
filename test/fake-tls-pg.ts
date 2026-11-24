/**
 * TLS だけを話す偽の PostgreSQL（接続文字列のマイグレーションの証明書の確かめのテスト用）。
 * SSLRequest に 'S' を返し、自己署名の証明書で TLS を始める。TLS が済んだら何も答えずに閉じる。
 * 証明書は openssl で作る（無い環境では available が false）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

export interface FakeTlsPg {
  port: number;
  /** TLS の握手が済んだ数 */
  handshakes: () => number;
  close: () => Promise<void>;
}

function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "banto-tls-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SSLRequest（長さ 8・番号 80877103） */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

export async function startFakeTlsPg(): Promise<FakeTlsPg | null> {
  const pair = selfSigned();
  if (!pair) return null;
  let done = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", (chunk: Buffer | string) => {
      const first = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (!first.subarray(0, 8).equals(SSL_REQUEST)) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const tls = new TLSSocket(socket, { isServer: true, key: pair.key, cert: pair.cert });
      tls.on("error", () => undefined);
      tls.on("secure", () => {
        done += 1;
        // 起動のメッセージには答えずに閉じる（TLS の層まで届いたかだけを見る）
        tls.destroy();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    handshakes: () => done,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
