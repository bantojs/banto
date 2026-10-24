/**
 * Workers の生の TCP（cloudflare:sockets）。SMTP でメールを送るためだけに使う（src/mail/transports/smtp.ts）。
 * Cloudflare は外向きの 25 番を塞いでいるので、使えるのは 587（STARTTLS）と 465（TLS）。
 * Cloudflare 固有の API はここと src/index.ts 以外に書かない（CLAUDE.md §1-1）。
 */
import { connect } from "cloudflare:sockets";
import type { RawConnection, SocketAdapter } from "../types";

class WorkersConnection implements RawConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(
    private readonly socket: Socket,
    private readonly host: string,
  ) {
    this.reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
    this.writer = (socket.writable as WritableStream<Uint8Array>).getWriter();
  }
  async read() {
    const r = await this.reader.read();
    return r.done ? null : r.value;
  }
  async write(data: Uint8Array) {
    await this.writer.write(data);
  }
  async startTls() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const secure = this.socket.startTls({ expectedServerHostname: this.host });
    return new WorkersConnection(secure, this.host);
  }
  async close() {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {
      // 既に解放済み
    }
    await this.socket.close().catch(() => undefined);
  }
}

export const workersSockets: SocketAdapter = {
  async connect(host, port, tls) {
    const socket = connect({ hostname: host, port }, { secureTransport: tls, allowHalfOpen: false });
    await socket.opened;
    return new WorkersConnection(socket, host);
  },
};
