#!/usr/bin/env node
// dots MCP server — stdio JSON-RPC (NDJSON), zero deps.
// Routes prompts to the hosted codex app-server backend (cloud threads, GPT-6 Astra).
import tls from 'node:tls';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');
const UPSTREAM_HOST = 'codex-cloud-backend.chatgpt.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_MODEL = 'gpt-6-astra';
const FALLBACK_DOT_THREAD = process.env.DOT_THREAD_ID || '';

function log(...a) { process.stderr.write('[dots] ' + a.join(' ') + '\n'); }

// ---------- auth / token refresh ----------
function loadAuth() { return JSON.parse(readFileSync(AUTH_PATH, 'utf8')); }
function jwtExpMs(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).exp * 1000;
  } catch { return 0; }
}
let refreshing = null;
async function ensureAuth(force = false) {
  const auth = loadAuth();
  if (!force && jwtExpMs(auth.tokens.access_token) - Date.now() > 12 * 3600 * 1000) return auth;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    log('refreshing access token');
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: auth.tokens.refresh_token,
      }),
    });
    if (!res.ok) throw new Error('token refresh failed: HTTP ' + res.status);
    const data = await res.json();
    const cur = loadAuth();
    if (cur.tokens.access_token !== auth.tokens.access_token &&
        jwtExpMs(cur.tokens.access_token) - Date.now() > 12 * 3600 * 1000) {
      return cur; // codex CLI refreshed meanwhile
    }
    cur.tokens.access_token = data.access_token ?? cur.tokens.access_token;
    cur.tokens.id_token = data.id_token ?? cur.tokens.id_token;
    cur.tokens.refresh_token = data.refresh_token ?? cur.tokens.refresh_token;
    cur.last_refresh = new Date().toISOString();
    writeFileSync(AUTH_PATH, JSON.stringify(cur, null, 2));
    log('token refreshed');
    return cur;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- raw-TLS WebSocket JSON-RPC client (curl-like handshake passes Cloudflare) ----------
class Ws {
  constructor({ host, token, accountId }) {
    this.host = host;
    this.token = token;
    this.accountId = accountId;
    this.buf = Buffer.alloc(0);
    this.upgraded = false;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    this.closed = false;
  }
  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = tls.connect(443, this.host, { servername: this.host }, () => {
        this.sock.write(
          `GET / HTTP/1.1\r\nHost: ${this.host}\r\n` +
          `Authorization: Bearer ${this.token}\r\n` +
          `chatgpt-account-id: ${this.accountId}\r\n` +
          `User-Agent: codex/0.159.2 (${process.platform === 'darwin' ? 'Mac OS 26.0.0' : process.platform === 'win32' ? 'Windows 10.0' : 'Linux'}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'})\r\n` +
          `originator: codex_cli_rs\r\n` +
          `Connection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
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
        this.#drain();
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
  onNotification(fn) { this.handlers.push(fn); }
  #emit(m) { for (const fn of this.handlers) { try { fn(m); } catch {} } }
  #frame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let h;
    const len = payload.length;
    if (len < 126) h = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    const m = Buffer.from(payload);
    for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([h, mask, m]));
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.#frame(0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  #drain() {
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
      if (opcode === 0x9) { this.#frame(0xa, payload); continue; }
      if (opcode === 0x8) { this.closed = true; this.#emit({ method: '__closed__' }); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        this.#emit(msg);
      }
    }
  }
  close() { try { this.#frame(0x8, Buffer.alloc(0)); } catch {} try { this.sock.destroy(); } catch {} }
}

// ---------- upstream session (one shared WS, notifications demuxed by threadId) ----------
let ws = null;
const threadWaiters = new Map();
async function upstream() {
  if (ws && !ws.closed) return ws;
  const auth = await ensureAuth();
  const client = new Ws({ host: UPSTREAM_HOST, token: auth.tokens.access_token, accountId: auth.tokens.account_id });
  client.onNotification((m) => {
    const tid = m.params?.threadId;
    if (tid && threadWaiters.has(tid)) for (const fn of threadWaiters.get(tid)) fn(m);
  });
  await client.connect();
  await client.call('initialize', { clientInfo: { name: 'dots-mcp', version: '0.1.0' } });
  ws = client;
  log('upstream connected');
  return ws;
}
function waitTurnDone(threadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('turn timeout after ' + timeoutMs + 'ms')); }, timeoutMs);
    const fn = (m) => {
      if (m.method === 'turn/completed' && m.params?.threadId === threadId) {
        cleanup();
        const turn = m.params.turn || {};
        if (turn.status === 'completed') resolve(turn);
        else reject(new Error('turn ended with status ' + turn.status + (turn.error ? ': ' + JSON.stringify(turn.error) : '')));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      const set = threadWaiters.get(threadId);
      if (set) { set.delete(fn); if (!set.size) threadWaiters.delete(threadId); }
    };
    if (!threadWaiters.has(threadId)) threadWaiters.set(threadId, new Set());
    threadWaiters.get(threadId).add(fn);
  });
}

function extractReplyText(items) {
  const texts = [];
  for (const it of items) {
    const i2 = it.item || it;
    if (i2.type === 'agentMessage' && i2.text) texts.push(i2.text);
    else if (i2.type === 'mcpToolCall' && i2.tool === 'user_message.send_message' && i2.arguments?.text) texts.push(i2.arguments.text);
  }
  return texts.join('\n\n');
}

// ---------- dot thread discovery (cached) ----------
let dotThreadId = null;
async function getDotThreadId(w) {
  if (dotThreadId) return dotThreadId;
  try {
    const r = await w.call('thread/list', { limit: 100 });
    const threads = r.data || r.threads || [];
    const dot = threads.find((t) => t.threadSource === 'aeon');
    if (dot) { dotThreadId = dot.id; log('discovered dot thread', dotThreadId); return dotThreadId; }
  } catch (e) { log('thread/list discovery failed:', e.message); }
  if (!FALLBACK_DOT_THREAD) throw new Error('dot thread not found; set DOT_THREAD_ID env or open the dot once in the app');
  dotThreadId = FALLBACK_DOT_THREAD;
  return dotThreadId;
}

// ---------- tools ----------
async function toolDotAsk(args) {
  const prompt = String(args.prompt || '');
  if (!prompt) throw new Error('prompt is required');
  const timeoutMs = Math.min(Math.max((args.timeout_sec || 300), 10), 3600) * 1000;
  const w = await upstream();
  const params = { model: args.model || DEFAULT_MODEL };
  if (args.instructions) params.developerInstructions = String(args.instructions);
  const t = await w.call('thread/start', params);
  const tid = t.thread.id;
  log('thread started', tid, 'model', params.model);
  const done = waitTurnDone(tid, timeoutMs);
  await w.call('turn/start', { threadId: tid, input: [{ type: 'text', text: prompt }] });
  await done;
  const items = await w.call('thread/items/list', { threadId: tid, limit: 100 });
  const reply = extractReplyText(items.data || items.items || []);
  w.call('thread/archive', { threadId: tid }).catch(() => {});
  return reply || '(no text reply; task may have completed silently)';
}

async function toolDotMessage(args) {
  const prompt = String(args.prompt || '');
  if (!prompt) throw new Error('prompt is required');
  const timeoutMs = Math.min(Math.max((args.timeout_sec || 300), 10), 3600) * 1000;
  const w = await upstream();
  const tid = await getDotThreadId(w);
  const done = waitTurnDone(tid, timeoutMs);
  await w.call('turn/start', { threadId: tid, input: [{ type: 'text', text: prompt }] });
  await done;
  const items = await w.call('thread/items/list', { threadId: tid, limit: 20 });
  return extractReplyText(items.data || items.items || []) || '(dot acknowledged; reply may arrive in ChatGPT channel)';
}

async function toolDotStatus() {
  const w = await upstream();
  const out = {};
  try {
    const models = await w.call('model/list', {});
    out.models = (models.data || []).map((m) => m.id);
  } catch (e) { out.models = 'unavailable: ' + e.message; }
  try {
    const tid = await getDotThreadId(w);
    const r = await w.call('thread/read', { threadId: tid, includeTurns: false });
    out.dot = { threadId: tid, status: r.thread?.status?.type, model: r.thread?.model, source: r.thread?.threadSource };
  } catch (e) { out.dot = 'unavailable: ' + e.message; }
  return JSON.stringify(out, null, 2);
}

const TOOLS = [
  {
    name: 'dot_ask',
    description: 'Run a one-shot task on a fresh cloud thread (GPT-6 Astra, runs on OpenAI cloud, counts as dot/aeon-family usage). Returns the agent reply text. Use this to offload work from the local/plan quota.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task / prompt for the cloud agent' },
        instructions: { type: 'string', description: 'Optional developer instructions for the new thread' },
        model: { type: 'string', description: 'Model override, default gpt-6-astra' },
        timeout_sec: { type: 'number', description: 'Max wait for the turn, default 300' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'dot_message',
    description: "Send a message to the user's primary dot (the persistent always-on agent with memory). Use for anything that should leverage the dot's accumulated context.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        timeout_sec: { type: 'number' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'dot_status',
    description: 'Report account plan, available models, and dot thread status.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------- MCP stdio loop ----------
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
async function handle(msg) {
  if (msg.id === undefined) return; // notification
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dots', version: '0.1.0' },
      } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      let text;
      if (name === 'dot_ask') text = await toolDotAsk(args);
      else if (name === 'dot_message') text = await toolDotMessage(args);
      else if (name === 'dot_status') text = await toolDotStatus();
      else throw new Error('unknown tool: ' + name);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    }
  } catch (e) {
    log('error in', method, e.message);
    if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}

let inBuf = '';
process.stdin.on('data', (c) => {
  inBuf += c.toString('utf8');
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => { try { ws?.close(); } catch {} process.exit(0); });
log('dots MCP server started');
