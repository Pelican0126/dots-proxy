// Minimal raw-TLS WebSocket JSON-RPC client for the hosted codex app-server backend.
// Node's built-in WebSocket gets Cloudflare-challenged; hand-rolled handshake with
// codex-style headers passes.
import tls from 'node:tls';
import crypto from 'node:crypto';

export class CodexWsClient {
  constructor({ host, path = '/', token, accountId, userAgent, originator = 'codex_cli_rs' }) {
    if (!userAgent) {
      const os = process.platform === 'darwin' ? 'Mac OS 26.0.0' : process.platform === 'win32' ? 'Windows 10.0' : 'Linux';
      userAgent = `codex/0.159.2 (${os}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'})`;
    }
    this.host = host;
    this.path = path;
    this.token = token;
    this.accountId = accountId;
    this.userAgent = userAgent;
    this.originator = originator;
    this.buf = Buffer.alloc(0);
    this.upgraded = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = [];
    this.closed = false;
  }

  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = tls.connect(443, this.host, { servername: this.host }, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}\r\n` +
          `Authorization: Bearer ${this.token}\r\n` +
          `chatgpt-account-id: ${this.accountId}\r\n` +
          `User-Agent: ${this.userAgent}\r\n` +
          `originator: ${this.originator}\r\n` +
          `Connection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
        );
      });
      const timer = setTimeout(() => reject(new Error('handshake timeout')), timeoutMs);
      this.sock.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        if (!this.upgraded) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = this.buf.slice(0, idx).toString();
          if (!head.includes(' 101')) {
            clearTimeout(timer);
            reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
            return;
          }
          this.upgraded = true;
          this.buf = this.buf.slice(idx + 4);
          clearTimeout(timer);
          resolve();
        }
        this.#drainFrames();
      });
      this.sock.on('error', (e) => { clearTimeout(timer); this.closed = true; reject(e); });
      this.sock.on('close', () => {
        this.closed = true;
        for (const { reject: rej } of this.pending.values()) rej(new Error('socket closed'));
        this.pending.clear();
        this.#emit({ method: '__closed__' });
      });
    });
  }

  onNotification(fn) { this.notificationHandlers.push(fn); }
  #emit(msg) { for (const fn of this.notificationHandlers) { try { fn(msg); } catch {} } }

  #sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let header;
    const len = payload.length;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  sendText(str) { this.#sendFrame(0x1, Buffer.from(str, 'utf8')); }

  call(method, params = {}) {
    const id = this.nextId++;
    this.sendText(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  #drainFrames() {
    while (true) {
      if (this.buf.length < 2) break;
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) break; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) break;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (opcode === 0x9) { this.#sendFrame(0xa, payload); continue; }
      if (opcode === 0x8) { this.closed = true; this.#emit({ method: '__closed__' }); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        this.#emit(msg);
      }
    }
  }

  close() { try { this.#sendFrame(0x8, Buffer.alloc(0)); } catch {} try { this.sock.destroy(); } catch {} }
}
