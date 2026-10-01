#!/usr/bin/env node
// dots MCP server — stdio JSON-RPC (NDJSON), zero deps.
// Routes prompts to the hosted codex app-server backend (cloud threads, GPT-6 Astra).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CodexWsClient as Ws } from './ws-client.mjs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');
const UPSTREAM_HOST = 'codex-cloud-backend.chatgpt.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_MODEL = 'gpt-6-astra';
const FALLBACK_DOT_THREAD = process.env.DOT_THREAD_ID || '';

function log(...a) { process.stderr.write('[dots] ' + a.join(' ') + '\n'); }
function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    try { renameSync(tmp, path); }
    catch (e) {
      if (!['EEXIST', 'EPERM'].includes(e.code)) throw e;
      const old = `${path}.old-${process.pid}-${Date.now()}`;
      let moved = false;
      try { renameSync(path, old); moved = true; renameSync(tmp, path); try { unlinkSync(old); } catch {} }
      catch (replaceError) { if (moved) { try { renameSync(old, path); } catch {} } throw replaceError; }
    }
  }
  finally { try { if (existsSync(tmp)) unlinkSync(tmp); } catch {} }
}
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

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
    const res = await withTimeout(fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: auth.tokens.refresh_token,
      }),
    }), 30000, 'token refresh');
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
    writeAtomic(AUTH_PATH, JSON.stringify(cur, null, 2));
    log('token refreshed');
    return cur;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- upstream session (one shared WS, notifications demuxed by threadId) ----------
let ws = null;
let connecting = null;
const threadWaiters = new Map();
async function upstream() {
  if (ws && !ws.closed) return ws;
  if (connecting) return connecting;
  connecting = (async () => {
    const auth = await ensureAuth();
    const client = new Ws({ host: UPSTREAM_HOST, token: auth.tokens.access_token, accountId: auth.tokens.account_id });
    client.onNotification((m) => {
      const tid = m.params?.threadId;
      if (tid && threadWaiters.has(tid)) for (const fn of threadWaiters.get(tid)) fn(m);
    });
    await withTimeout(client.connect(), 20000, 'upstream handshake');
    await withTimeout(client.call('initialize', { clientInfo: { name: 'dots-mcp', version: '0.1.0' } }), 20000, 'initialize');
    ws = client;
    log('upstream connected');
    return ws;
  })().finally(() => { connecting = null; });
  return connecting;
}
function waitTurnDone(threadId, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
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
    cancel = () => { cleanup(); reject(new Error('turn wait cancelled')); };
    if (!threadWaiters.has(threadId)) threadWaiters.set(threadId, new Set());
    threadWaiters.get(threadId).add(fn);
  });
  promise.cancel = () => cancel?.();
  return promise;
}

async function runTurn(w, threadId, input, timeoutMs) {
  const done = waitTurnDone(threadId, timeoutMs);
  done.catch(() => {});
  try {
    const turn = await withTimeout(w.call('turn/start', { threadId, input }), 30000, 'turn/start');
    await done;
    return turn;
  } catch (e) {
    done.cancel();
    try { await withTimeout(w.call('turn/interrupt', { threadId }), 5000, 'turn/interrupt'); } catch {}
    throw e;
  }
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
    const r = await withTimeout(w.call('thread/list', { limit: 100 }), 30000, 'thread/list');
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
  const timeoutMs = Math.min(Math.max(Number(args.timeout_sec) || 300, 10), 3600) * 1000;
  const w = await upstream();
  const params = { model: args.model || DEFAULT_MODEL };
  if (args.instructions) params.developerInstructions = String(args.instructions);
  const t = await withTimeout(w.call('thread/start', params), 30000, 'thread/start');
  const tid = t.thread.id;
  log('thread started', tid, 'model', params.model);
  try {
    await runTurn(w, tid, [{ type: 'text', text: prompt }], timeoutMs);
    const items = await withTimeout(w.call('thread/items/list', { threadId: tid, limit: 100 }), 30000, 'thread/items/list');
    const reply = extractReplyText(items.data || items.items || []);
    return reply || '(no text reply; task may have completed silently)';
  } finally {
    withTimeout(w.call('thread/archive', { threadId: tid }), 10000, 'thread/archive').catch(() => {});
  }
}

let dotMessageQueue = Promise.resolve();
async function toolDotMessage(args) {
  const task = dotMessageQueue.then(async () => {
    const prompt = String(args.prompt || '');
    if (!prompt) throw new Error('prompt is required');
    const timeoutMs = Math.min(Math.max(Number(args.timeout_sec) || 300, 10), 3600) * 1000;
    const w = await upstream();
    const tid = await getDotThreadId(w);
    const before = await withTimeout(w.call('thread/items/list', { threadId: tid, limit: 20 }), 30000, 'thread/items/list');
    const beforeIds = new Set((before.data || before.items || []).map((item) => (item.item || item).id).filter(Boolean));
    await runTurn(w, tid, [{ type: 'text', text: prompt }], timeoutMs);
    const items = await withTimeout(w.call('thread/items/list', { threadId: tid, limit: 20 }), 30000, 'thread/items/list');
    const fresh = (items.data || items.items || []).filter((item) => !beforeIds.has((item.item || item).id));
    return extractReplyText(fresh) || '(dot acknowledged; reply may arrive in ChatGPT channel)';
  });
  dotMessageQueue = task.catch(() => {});
  return task;
}

async function toolDotStatus() {
  const w = await upstream();
  const out = {};
  try {
    const models = await withTimeout(w.call('model/list', {}), 30000, 'model/list');
    out.models = (models.data || []).map((m) => m.id);
  } catch (e) { out.models = 'unavailable: ' + e.message; }
  try {
    const tid = await getDotThreadId(w);
    const r = await withTimeout(w.call('thread/read', { threadId: tid, includeTurns: false }), 30000, 'thread/read');
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
  if (inBuf.length > 2 * 1024 * 1024) {
    log('dropping oversized MCP message');
    inBuf = '';
    return;
  }
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
