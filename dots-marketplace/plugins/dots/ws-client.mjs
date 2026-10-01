// Raw TLS WebSocket JSON-RPC client for the hosted app-server backend.
import tls from 'node:tls';
import crypto from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class CodexWsClient {
  constructor({ host, path = '/', token, accountId, userAgent, originator = 'codex_cli_rs', socketFactory = tls.connect }) {
    if (!userAgent) {
      const os = process.platform === 'darwin' ? 'Mac OS 26.0.0' : process.platform === 'win32' ? 'Windows 10.0' : 'Linux';
      userAgent = `codex/0.159.2 (${os}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'})`;
    }
    Object.assign(this, { host, path, token, accountId, userAgent, originator, socketFactory });
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.upgraded = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = [];
    this.closed = false;
    this.maxFrameBytes = MAX_BYTES;
    this.defaultCallTimeout = 30000;
  }

  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.closed = true;
          this.sock?.destroy();
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('handshake timeout')), timeoutMs);
      try {
        this.sock = this.socketFactory(443, this.host, { servername: this.host }, () => {
          this.sock.write(
            `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}\r\n` +
            `Authorization: Bearer ${this.token}\r\n` +
            `chatgpt-account-id: ${this.accountId}\r\n` +
            `User-Agent: ${this.userAgent}\r\noriginator: ${this.originator}\r\n` +
            `Connection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
          );
        });
      } catch (error) {
        finish(error);
        return;
      }
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!this.upgraded) {
          const index = this.buf.indexOf('\r\n\r\n');
          if (index === -1) {
            if (this.buf.length > 16 * 1024) finish(new Error('handshake headers too large'));
            return;
          }
          const head = this.buf.subarray(0, index).toString('utf8');
          const status = head.match(/^HTTP\/\d\.\d\s+(\d+)/i)?.[1];
          const accept = head.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
          const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
          if (status !== '101' || accept !== expected) {
            finish(new Error('handshake failed: ' + (head.split('\r\n')[0] || 'invalid response')));
            return;
          }
          this.upgraded = true;
          this.buf = this.buf.subarray(index + 4);
          finish();
        }
        this.#drainFrames();
      });
      this.sock.on('error', (error) => {
        if (!settled) finish(error);
        else this.#failPending(error);
      });
      this.sock.on('close', () => {
        this.closed = true;
        if (!settled) finish(new Error('socket closed during handshake'));
        this.#failPending(new Error('socket closed'));
        this.#emit({ method: '__closed__' });
      });
    });
  }

  onNotification(handler) { this.notificationHandlers.push(handler); }
  #emit(message) {
    for (const handler of this.notificationHandlers) {
      try { handler(message); } catch {}
    }
  }
  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #sendFrame(opcode, payload) {
    if (this.closed || !this.sock || !this.upgraded) throw new Error('websocket is not open');
    if (payload.length > this.maxFrameBytes) throw new Error('websocket payload too large');
    const mask = crypto.randomBytes(4);
    const length = payload.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
    else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  sendText(text) { this.#sendFrame(0x1, Buffer.from(text, 'utf8')); }
  call(method, params = {}, timeoutMs = this.defaultCallTimeout) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.sendText(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #drainFrames() {
    while (this.buf.length >= 2) {
      const first = this.buf[0];
      const opcode = first & 0x0f;
      const final = !!(first & 0x80);
      let length = this.buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buf.length < 4) return;
        length = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buf.length < 10) return;
        const largeLength = this.buf.readBigUInt64BE(2);
        if (largeLength > BigInt(this.maxFrameBytes)) { this.close(); return; }
        length = Number(largeLength);
        offset = 10;
      }
      if (length > this.maxFrameBytes) { this.close(); return; }
      if (this.buf.length < offset + length) return;
      const payload = this.buf.subarray(offset, offset + length);
      this.buf = this.buf.subarray(offset + length);
      if (opcode === 0x9) {
        try { this.#sendFrame(0xa, payload); } catch {}
        continue;
      }
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) { this.close(); return; }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxFrameBytes) { this.close(); return; }
        this.fragments.push(payload);
        if (!final) continue;
        const full = Buffer.concat(this.fragments);
        const messageOpcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
        this.#message(messageOpcode, full);
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) continue;
      if (!final) {
        if (this.fragmentOpcode !== null) { this.close(); return; }
        this.fragmentOpcode = opcode;
        this.fragmentBytes = payload.length;
        this.fragments = [payload];
        continue;
      }
      this.#message(opcode, payload);
    }
  }

  #message(opcode, payload) {
    if (opcode !== 0x1) return;
    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    } else this.#emit(message);
  }

  close() {
    if (this.closed) return;
    try { if (this.upgraded) this.#sendFrame(0x8, Buffer.alloc(0)); } catch {}
    this.closed = true;
    this.#failPending(new Error('websocket closed'));
    this.sock?.destroy();
  }
}
