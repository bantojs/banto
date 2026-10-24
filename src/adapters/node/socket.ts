/**
 * Node の生の TCP（node:net / node:tls）。SMTP でメールを送るためだけに使う（src/mail/transports/smtp.ts）。
 * STARTTLS は nodemailer と同じ手順: 自分の data のリスナーを外してから tls.connect({ socket }) で同じソケットを包む。
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { RawConnection, SocketAdapter } from "../types";

class NodeConnection implements RawConnection {
  private readonly queue: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array | null) => void) | null = null;
  private ended = false;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => this.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  private readonly onEnd = () => this.finish(null);
  private readonly onError = (e: Error) => this.finish(e);

  constructor(
    private readonly socket: Socket | TLSSocket,
    private readonly host: string,
  ) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  private push(chunk: Uint8Array) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(chunk);
    } else this.queue.push(chunk);
  }

  private finish(e: Error | null) {
    if (e && !this.failure) this.failure = e;
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(null);
    }
  }

  private detach() {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
  }

  async read(): Promise<Uint8Array | null> {
    const q = this.queue.shift();
    if (q) return q;
    if (this.failure) throw this.failure;
    if (this.ended) return null;
    const chunk = await new Promise<Uint8Array | null>((resolve) => {
      this.waiting = resolve;
    });
    if (chunk === null && this.failure) throw this.failure;
    return chunk;
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.socket.write(data, (e) => (e ? reject(e) : resolve()));
    });
  }

  async startTls(): Promise<RawConnection> {
    this.detach();
    const tls = tlsConnect({ socket: this.socket, servername: this.host });
    await new Promise<void>((resolve, reject) => {
      tls.once("secureConnect", resolve);
      tls.once("error", reject);
    });
    return new NodeConnection(tls, this.host);
  }

  async close(): Promise<void> {
    this.detach();
    this.socket.end();
    this.socket.destroy();
  }
}

export const nodeSockets: SocketAdapter = {
  connect(host, port, tls) {
    return new Promise<RawConnection>((resolve, reject) => {
      if (tls === "on") {
        const s = tlsConnect({ host, port, servername: host });
        s.once("secureConnect", () => resolve(new NodeConnection(s, host)));
        s.once("error", reject);
        return;
      }
      const s = netConnect({ host, port });
      s.once("connect", () => resolve(new NodeConnection(s, host)));
      s.once("error", reject);
    });
  },
};
