// dots-proxy — local Responses API endpoint that routes one picker model to the dot cloud.
//   model == DOT_SLUG  -> hosted app-server turn (gpt-6-astra, cloud thread, dot quota family)
//   any other model    -> faithful pass-through to https://chatgpt.com/backend-api/codex/responses
// Zero deps. Node >= 22.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.DOTS_PROXY_PORT || 8789);
const BIND = '127.0.0.1';
const DOT_SLUG = process.env.DOTS_PROXY_MODEL || 'gpt-6-astra-dot';
const UPSTREAM_HOST = 'codex-cloud-backend.chatgpt.com';
const PASSTHROUGH = { host: 'chatgpt.com', path: '/backend-api/codex/responses' };
const CODEX_HOME = process.env.CODEX_HOME || join(process.env.USERPROFILE || '', '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function log(...a) { console.error('[dots-proxy]', ...a); }

// ---------- auth / token refresh ----------
function loadAuth() { return JSON.parse(readFileSync(AUTH_PATH, 'utf8')); }
function jwtExpMs(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp * 1000; }
  catch { return 0; }
}
let refreshing = null;
async function ensureAuth() {
  const auth = loadAuth();
  if (jwtExpMs(auth.tokens.access_token) - Date.now() > 12 * 3600 * 1000) return auth;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    log('refreshing access token');
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: auth.tokens.refresh_token }),
    });
    if (!res.ok) throw new Error('token refresh failed: HTTP ' + res.status);
    const data = await res.json();
    const cur = loadAuth();
    if (cur.tokens.access_token !== auth.tokens.access_token && jwtExpMs(cur.tokens.access_token) - Date.now() > 12 * 3600 * 1000) return cur;
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

// ---------- raw-TLS WS JSON-RPC client ----------
class Ws {
  constructor({ host, token, accountId }) {
    Object.assign(this, { host, token, accountId });
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
          `User-Agent: codex/0.145.0 (Windows 10.0; x86_64)\r\n` +
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
          if (!head.includes(' 101')) { clearTimeout(timer); reject(new Error('handshake failed: ' + head.split('\r\n')[0])); return; }
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
      } else this.#emit(msg);
    }
  }
  close() { try { this.#frame(0x8, Buffer.alloc(0)); } catch {} try { this.sock.destroy(); } catch {} }
}

// ---------- shared upstream session ----------
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
  await client.call('initialize', { clientInfo: { name: 'dots-proxy', version: '0.2.0' } });
  ws = client;
  log('upstream connected');
  return ws;
}
function waitTurnDone(threadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('turn timeout')); }, timeoutMs);
    const fn = (m) => {
      if (m.method === 'turn/completed' && m.params?.threadId === threadId) {
        cleanup();
        const turn = m.params.turn || {};
        turn.status === 'completed' ? resolve(turn) : reject(new Error('turn ' + turn.status + (turn.error ? ': ' + JSON.stringify(turn.error) : '')));
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

// ---------- call log store (memory ring + JSONL persistence) ----------
const LOG_FILE = join(SCRIPT_DIR, 'dots-proxy-calls.jsonl');
const LOG_MAX = 500;
const callLogs = [];
try {
  const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(-LOG_MAX)) {
    try {
      const r = JSON.parse(line);
      if (r._update) { const old = callLogs.find((x) => x.id === r.id); if (old) Object.assign(old, r); continue; }
      if (r.status === 'running') r.status = 'interrupted';
      callLogs.push(r);
    } catch {}
  }
} catch {}
let logSeq = callLogs.length ? Math.max(...callLogs.map((r) => r.id)) : 0;
function logStart(rec) {
  rec.id = ++logSeq;
  rec.ts = Date.now();
  callLogs.push(rec);
  if (callLogs.length > LOG_MAX) callLogs.splice(0, callLogs.length - LOG_MAX);
  persist(rec);
  return rec;
}
function logEnd(rec, patch) {
  Object.assign(rec, patch, { ms: Date.now() - rec.ts });
  persist({ ...rec, _update: true });
}
function persist(rec) {
  try { appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n'); } catch {}
}

// ---------- dot turn ----------
function flattenInput(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const lines = [];
  for (const item of input) {
    if (!item || item.type !== 'message') continue;
    const role = item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : item.role;
    const parts = Array.isArray(item.content) ? item.content : [];
    const text = parts.map((p) => p?.text).filter(Boolean).join('\n');
    if (text) lines.push(role + ': ' + text);
  }
  return lines.join('\n\n');
}

// ---------- dot turn ----------
const LOCAL_ENV = process.env.DOTS_ENV_ID || '';
const DEFAULT_WORKSPACE = process.env.DOTS_WORKSPACE || process.cwd();

function extractCwd(body, flatText) {
  const text = (typeof body.instructions === 'string' ? body.instructions : '') + '\n' + flatText;
  const m = text.match(/working directory[:\s]+([A-Za-z]:[\/\\][^\n`"<>|]*)/i);
  if (m) return m[1].trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return null;
}

async function runDotTurn(promptText, cwd, effort, timeoutMs = 280000) {
  const w = await upstream();
  const dir = cwd || DEFAULT_WORKSPACE;
  // env bridge can be briefly unreachable (app restart, reconnect) — retry thread/start
  let t, lastErr;
  const startParams = { model: 'gpt-6-astra', cwd: dir, approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (LOCAL_ENV) startParams.environments = [{ environmentId: LOCAL_ENV, cwd: dir }];
  for (let i = 0; i < 4; i++) {
    try {
      t = await w.call('thread/start', startParams);
      break;
    } catch (e) {
      lastErr = e;
      if (!/environment|invalid argument|unsupported/i.test(e.message)) throw e;
      log(`thread/start attempt ${i + 1} failed, retrying:`, e.message.slice(0, 120));
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  if (!t) throw lastErr;
  const tid = t.thread.id;
  const done = waitTurnDone(tid, timeoutMs);
  const turnParams = { threadId: tid, input: [{ type: 'text', text: promptText }] };
  if (effort) turnParams.effort = effort;
  await w.call('turn/start', turnParams);
  await done;
  const items = await w.call('thread/items/list', { threadId: tid, limit: 100 });
  const texts = [];
  for (const it of (items.data || items.items || [])) {
    const i2 = it.item || it;
    if (i2.type === 'agentMessage' && i2.text) texts.push(i2.text);
    else if (i2.type === 'mcpToolCall' && i2.tool === 'user_message.send_message' && i2.arguments?.text) texts.push(i2.arguments.text);
  }
  w.call('thread/archive', { threadId: tid }).catch(() => {});
  return { text: texts.join('\n\n') || '(dot completed without a text reply)', tid };
}

// ---------- Responses API emission ----------
function responseObject(id, model, text, status = 'completed') {
  const msg = {
    type: 'message', id: 'msg_' + crypto.randomBytes(12).toString('hex'),
    status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status, model, output: [msg],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function sendDotResponse(req, res, body, text) {
  const id = 'resp_' + crypto.randomBytes(12).toString('hex');
  const model = body.model || DOT_SLUG;
  if (body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseObject(id, model, text)));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const resp = responseObject(id, model, text);
  const item = resp.output[0];
  const part = item.content[0];
  sseWrite(res, 'response.created', { type: 'response.created', response: { ...resp, status: 'in_progress', output: [] } });
  sseWrite(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  sseWrite(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
  // chunk the delta for smoother client rendering
  const CH = 400;
  for (let i = 0; i < text.length; i += CH) {
    sseWrite(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text.slice(i, i + CH) });
  }
  sseWrite(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
  sseWrite(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part });
  sseWrite(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  sseWrite(res, 'response.completed', { type: 'response.completed', response: resp });
  res.end();
}

// ---------- pass-through ----------
function passthrough(req, res, rawBody, rec) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  headers['accept-encoding'] = 'identity';
  const up = https.request({
    host: PASSTHROUGH.host,
    path: PASSTHROUGH.path,
    method: 'POST',
    headers,
  }, (upRes) => {
    const h = { ...upRes.headers };
    delete h['content-length'];
    delete h['transfer-encoding'];
    delete h['content-encoding'];
    if (rec) logEnd(rec, { status: (upRes.statusCode || 502) < 400 ? 'ok' : 'error', code: upRes.statusCode });
    res.writeHead(upRes.statusCode || 502, h);
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    log('passthrough error:', e.message);
    if (rec) logEnd(rec, { status: 'error', error: e.message });
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'passthrough failed: ' + e.message } }));
  });
  up.write(rawBody);
  up.end();
}

// ---------- console page ----------
const CONSOLE_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dots-proxy 調用記錄</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--dot:#a371f7;--ok:#3fb950;--err:#f85149;--run:#58a6ff;--pass:#8b949e}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;padding:20px;max-width:1100px;margin:0 auto}
  h1{font-size:18px;margin-bottom:4px}
  .sub{color:var(--dim);font-size:12px;margin-bottom:16px}
  .stats{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px}
  .stat b{font-size:20px;display:block}
  .stat span{color:var(--dim);font-size:12px}
  .row{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:8px;cursor:pointer}
  .row:hover{border-color:var(--dim)}
  .meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dim)}
  .badge{padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .b-dot{background:rgba(163,113,247,.15);color:var(--dot)}
  .b-pass{background:rgba(139,148,158,.15);color:var(--pass)}
  .s-ok{color:var(--ok)} .s-error{color:var(--err)} .s-running{color:var(--run)} .s-interrupted{color:var(--dim)}
  .prompt{color:var(--fg);margin-top:6px;white-space:pre-wrap;word-break:break-all}
  .reply{color:var(--dim);margin-top:4px;white-space:pre-wrap;word-break:break-all;display:none}
  .row.open .reply{display:block}
  .dot-grid td{padding:0}
  .ms{margin-left:auto}
  .empty{color:var(--dim);text-align:center;padding:40px}
</style>
</head>
<body>
<h1>dots-proxy 調用記錄</h1>
<div class="sub">每 2 秒自動刷新 · 只存本機 · 最多保留 500 條</div>
<div class="stats" id="stats"></div>
<div id="list"></div>
<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtTime(ts){var d=new Date(ts);return d.toLocaleTimeString('zh-TW',{hour12:false});}
function fmtDur(ms){if(ms==null)return '-';return ms<1000?ms+'ms':(ms/1000).toFixed(1)+'s';}
function cut(s,n){s=String(s||'');return s.length>n?s.slice(0,n)+'…':s;}
async function refresh(){
  try{
    var r=await fetch('/api/logs');var data=await r.json();
    var logs=data.logs;
    var dot=logs.filter(function(l){return l.type==='dot';});
    var err=logs.filter(function(l){return l.status==='error';});
    var running=logs.filter(function(l){return l.status==='running';});
    document.getElementById('stats').innerHTML=
      '<div class="stat"><b>'+logs.length+'</b><span>總調用</span></div>'+
      '<div class="stat"><b style="color:var(--dot)">'+dot.length+'</b><span>走 dot</span></div>'+
      '<div class="stat"><b style="color:var(--run)">'+running.length+'</b><span>進行中</span></div>'+
      '<div class="stat"><b style="color:var(--err)">'+err.length+'</b><span>失敗</span></div>';
    if(!logs.length){document.getElementById('list').innerHTML='<div class="empty">還沒有調用記錄</div>';return;}
    document.getElementById('list').innerHTML=logs.map(function(l){
      var badge=l.type==='dot'?'<span class="badge b-dot">dot</span>':'<span class="badge b-pass">透傳</span>';
      var st='<span class="s-'+l.status+'">'+l.status+'</span>';
      var detail='';
      if(l.type==='dot'){
        detail='<div class="prompt">'+esc(cut(l.prompt,300))+'</div>'+
               (l.reply?'<div class="reply">'+esc(l.reply)+'</div>':'')+
               (l.error?'<div class="reply" style="color:var(--err)">'+esc(l.error)+'</div>':'');
      }
      return "<div class='row'>"+
        '<div class="meta">'+badge+st+'<span>'+esc(l.model||'')+'</span>'+(l.effort?'<span>effort:'+esc(l.effort)+'</span>':'')+'<span>'+fmtTime(l.ts)+'</span>'+
        (l.cwd?'<span>'+esc(l.cwd)+'</span>':'')+
        (l.code?'<span>HTTP '+l.code+'</span>':'')+
        (l.tid?'<span>'+esc(String(l.tid).slice(0,13))+'</span>':'')+
        '<span class="ms">'+fmtDur(l.ms)+'</span></div>'+detail+'</div>';
    }).join('');
  }catch(e){}
}
refresh();setInterval(refresh,2000);
document.getElementById('list').addEventListener('click',function(e){
  var r=e.target.closest('.row');if(r)r.classList.toggle('open');
});
</script>
</body>
</html>`;

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dotSlug: DOT_SLUG }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/console')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CONSOLE_HTML);
    return;
  }
  if (req.method === 'GET' && req.url === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: [...callLogs].reverse() }));
    return;
  }
  if (req.method !== 'POST' || !req.url.replace(/\?.*$/, '').endsWith('/responses')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let raw = Buffer.concat(chunks);
    const enc = req.headers['content-encoding'];
    try {
      if (enc === 'zstd') raw = zlib.zstdDecompressSync(raw);
      else if (enc === 'gzip') raw = zlib.gunzipSync(raw);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad content-encoding: ' + e.message } }));
      return;
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch {
      passthrough(req, res, raw, logStart({ type: 'passthrough', model: null, status: 'running' }));
      return;
    }
    if (body.model !== DOT_SLUG) {
      passthrough(req, res, raw, logStart({ type: 'passthrough', model: body.model || null, status: 'running', effort: body.reasoning?.effort || null }));
      return;
    }
    // dot path
    const promptText = flattenInput(body.input);
    const cwd = extractCwd(body, promptText);
    const userTail = (() => { const i = promptText.lastIndexOf('\n\nUser:'); return (i >= 0 ? promptText.slice(i + 7) : promptText).trim(); })();
    const rec = logStart({ type: 'dot', model: body.model, status: 'running', prompt: userTail.slice(0, 2000), cwd: cwd || null, effort: body.reasoning?.effort || null });
    try {
      if (!promptText) throw new Error('empty input after flattening');
      log('dot turn start, prompt chars:', promptText.length, 'cwd:', cwd || '(default)');
      const { text, tid } = await runDotTurn(promptText, cwd, body.reasoning?.effort || null);
      rec.tid = tid;
      log('dot turn done, reply chars:', text.length);
      logEnd(rec, { status: 'ok', reply: text.slice(0, 4000) });
      sendDotResponse(req, res, body, text);
    } catch (e) {
      log('dot turn error:', e.message);
      logEnd(rec, { status: 'error', error: e.message });
      const msg = '⚠ dot 調用失敗: ' + e.message;
      try { sendDotResponse(req, res, body, msg); } catch {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    }
  });
});

server.listen(PORT, BIND, () => log(`listening on http://${BIND}:${PORT}/v1  (dot slug: ${DOT_SLUG})`));
