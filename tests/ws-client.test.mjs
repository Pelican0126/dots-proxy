import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { CodexWsClient } from '../dots-marketplace/plugins/dots/ws-client.mjs';

class MockSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; }
  write(data) { this.writes.push(Buffer.from(data)); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function frame(opcode, payload, fin = true) {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]), body]);
  const h = Buffer.alloc(4); h[0] = (fin ? 0x80 : 0) | opcode; h[1] = 126; h.writeUInt16BE(body.length, 2); return Buffer.concat([h, body]);
}
function acceptFor(request) {
  const key = request.toString().match(/Sec-WebSocket-Key: (.+)\r\n/)[1];
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function makeClient() {
  const socket = new MockSocket();
  const client = new CodexWsClient({ host: 'example.test', token: 't', accountId: 'a', socketFactory: (port, host, options, callback) => { setImmediate(callback); return socket; } });
  return { client, socket };
}

 test('validates handshake and resolves before timeout', async () => {
  const { client, socket } = makeClient();
  const connecting = client.connect(100);
  await new Promise((r) => setImmediate(r));
  const accept = acceptFor(socket.writes[0]);
  socket.emit('data', Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
  await connecting;
  assert.equal(client.upgraded, true);
  client.close();
});

test('rejects handshake immediately on socket close', async () => {
  const { client, socket } = makeClient();
  const connecting = client.connect(1000);
  socket.emit('close');
  await assert.rejects(connecting, /socket closed during handshake/);
  assert.equal(socket.destroyed, true);
});

test('reassembles fragmented JSON-RPC response', async () => {
  const { client, socket } = makeClient();
  const connecting = client.connect(100);
  await new Promise((r) => setImmediate(r));
  const accept = acceptFor(socket.writes[0]);
  socket.emit('data', Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
  await connecting;
  const call = client.call('ping', {}, 100);
  const response = Buffer.from(JSON.stringify({ id: 1, result: { ok: true } }));
  socket.emit('data', frame(1, response.subarray(0, 8), false));
  socket.emit('data', frame(0, response.subarray(8), true));
  assert.deepEqual(await call, { ok: true });
  client.close();
});

test('rejects pending RPC on timeout and socket close', async () => {
  const { client, socket } = makeClient();
  const connecting = client.connect(100);
  await new Promise((r) => setImmediate(r));
  const accept = acceptFor(socket.writes[0]);
  socket.emit('data', Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
  await connecting;
  await assert.rejects(client.call('slow', {}, 10), /RPC timeout: slow/);
  const pending = client.call('never', {}, 1000);
  socket.emit('close');
  await assert.rejects(pending, /socket closed/);
});
