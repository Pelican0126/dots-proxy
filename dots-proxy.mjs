// dots-proxy — local Responses API endpoint that routes one picker model to the dot cloud.
//   model == DOT_SLUG  -> hosted app-server turn (gpt-6-astra, cloud thread, dot quota family)
//   any other model    -> faithful pass-through to https://chatgpt.com/backend-api/codex/responses
// Zero deps. Node >= 22.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { CodexWsClient as Ws } from './ws-client.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.DOTS_PROXY_PORT || 8789);
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const BIND = '127.0.0.1';
const DOT_SLUG = process.env.DOTS_PROXY_MODEL || 'gpt-6-astra-dot';
const UPSTREAM_HOST = 'codex-cloud-backend.chatgpt.com';
const PASSTHROUGH = { host: 'chatgpt.com', path: '/backend-api/codex/responses' };
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// Codex-style UA for the upstream WS handshake. Version/platform are cosmetic but
// should look like a real client; override with DOTS_UA if Cloudflare gets picky.
const CODEX_UA = process.env.DOTS_UA ||
  `codex/0.159.2 (${process.platform === 'darwin' ? 'Mac OS 26.0.0' : process.platform === 'win32' ? 'Windows 10.0' : 'Linux'}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'})`;

function log(...a) { console.error('[dots-proxy]', ...a); }
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
      signal: AbortSignal.timeout(30000),
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
    writeAtomic(AUTH_PATH, JSON.stringify(cur, null, 2));
    log('token refreshed');
    return cur;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- shared upstream session ----------
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
    await client.connect();
    await client.call('initialize', { clientInfo: { name: 'dots-proxy', version: '0.2.0' } });
    ws = client;
    log('upstream connected');
    return ws;
  })().finally(() => { connecting = null; });
  return connecting;
}
function waitTurnDone(threadId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); const set = threadWaiters.get(threadId); if (set) { set.delete(fn); if (!set.size) threadWaiters.delete(threadId); } };
    const finish = (err, value) => { if (settled) return; settled = true; cleanup(); err ? reject(err) : resolve(value); };
    const onAbort = () => finish(new Error('request aborted'));
    const timer = setTimeout(() => finish(new Error('turn timeout')), timeoutMs);
    const fn = (m) => { if (m.method === 'turn/completed' && m.params?.threadId === threadId) { const turn = m.params.turn || {}; turn.status === 'completed' ? finish(null, turn) : finish(new Error('turn ' + turn.status + (turn.error ? ': ' + JSON.stringify(turn.error) : ''))); } };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
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
  try {
    try { if (statSync(LOG_FILE).size > 8 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  } catch {}
}

function validateDotBody(body) {
  if (typeof body.instructions !== 'undefined' && typeof body.instructions !== 'string') return 'instructions must be a string';
  if (typeof body.input === 'undefined') return 'input is required';
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) return 'input must be a string or array';
  if (Array.isArray(body.input)) for (const item of body.input) {
    if (!item) return 'input item must be an object';
    if (item.type === 'input_text') {
      if (typeof item.text !== 'string') return 'input_text.text must be a string';
      continue;
    }
    if (item.type !== 'message') return 'unsupported input item; only message and input_text items are supported';
    if (typeof item.content !== 'string' && !Array.isArray(item.content)) return 'message content must be a string or array';
    if (Array.isArray(item.content) && item.content.some((part) => typeof part === 'string' ? false : !part || typeof part.text !== 'string')) return 'only text content is supported';
  }
  return null;
}

// ---------- dot turn ----------
function flattenInput(input, instructions = '') {
  const lines = [];
  if (typeof instructions === 'string' && instructions.trim()) lines.push('Instructions: ' + instructions.trim());
  if (typeof input === 'string') { lines.push('User: ' + input); return lines.join('\n\n'); }
  if (!Array.isArray(input)) return lines.join('\n\n');
  for (const item of input) {
    if (!item) continue;
    if (item.type === 'message') {
      const role = item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : item.role;
      const content = typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((p) => typeof p === 'string' ? p : p?.text).filter(Boolean).join('\n') : '';
      if (content) lines.push(role + ': ' + content);
    } else if (item.type === 'input_text' && item.text) lines.push('User: ' + item.text);
  }
  return lines.join('\n\n');
}

// ---------- dot turn ----------
const DEFAULT_WORKSPACE = process.env.DOTS_WORKSPACE || process.cwd();

// DOTS_ENV_ID: explicit id, empty (cloud-only), or "auto" to discover the
// environment-id of the codex exec-server bridge process the desktop app runs.
function discoverEnvId() {
  if (process.platform === 'win32') {
    const commands = [
      'wmic process where "name like \'codex%\'" get CommandLine /format:list',
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"',
    ];
    for (const command of commands) {
      try {
        const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/exec-server\s+.*?--environment-id(?:=|\s+)(\S+)/i);
        if (m) return m[1].replace(/^['"]|['"]$/g, '');
      } catch {}
    }
    return '';
  }
  try {
    const out = execSync('ps axo command', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      if (!line.includes('exec-server') || line.includes('grep')) continue;
      const m = line.match(/--environment-id[=\s]+(\S+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}
const ENV_SETTING = process.env.DOTS_ENV_ID || '';
let lastAutoEnv = null;
function resolveLocalEnv() {
  if (ENV_SETTING && ENV_SETTING !== 'auto') return ENV_SETTING;
  if (ENV_SETTING !== 'auto') return '';
  const id = discoverEnvId();
  if (id !== lastAutoEnv) log(id ? 'auto-discovered bridge environment: ' + id : 'DOTS_ENV_ID=auto but no exec-server bridge found; running cloud-only');
  lastAutoEnv = id;
  return id;
}

function extractCwd(body, flatText) {
  const text = (typeof body.instructions === 'string' ? body.instructions : '') + '\n' + flatText;
  const clean = (value) => value.trim().replace(/\s+(?:then|and)\b.*$/i, '').replace(/[.,;]+$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  // <cwd>/path</cwd> (newer codex environment_context blocks)
  let m = text.match(/<cwd>\s*([^\s<][^<]*?)\s*<\/cwd>/i);
  if (m) return clean(m[1]);
  // Windows drive path: C:\... or C:/...
  m = text.match(/working directory[:\s]+([A-Za-z]:[\/\\][^\n`"<>|]*)/i);
  if (m) return clean(m[1]);
  // POSIX absolute path: /Users/... etc. Stop at whitespace/backtick/quote.
  m = text.match(/working directory[:\s]+(\/[^\n`"<>|]*)/i);
  if (m) return clean(m[1]);
  return null;
}

async function runDotTurn(promptText, cwd, effort, timeoutMs = 280000, signal) {
  const w = await upstream();
  const dir = cwd || DEFAULT_WORKSPACE;
  // env bridge can be briefly unreachable (app restart, reconnect) — retry thread/start
  let t, lastErr;
  const startParams = { model: 'gpt-6-astra', cwd: dir, approvalPolicy: 'never', sandbox: 'danger-full-access' };
  const localEnv = resolveLocalEnv();
  if (localEnv) startParams.environments = [{ environmentId: localEnv, cwd: dir }];
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
  const turnController = new AbortController();
  const relayAbort = () => turnController.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  const done = waitTurnDone(tid, timeoutMs, turnController.signal);
  done.catch(() => {});
  const turnParams = { threadId: tid, input: [{ type: 'text', text: promptText }] };
  if (effort) turnParams.effort = effort;
  try {
    await w.call('turn/start', turnParams);
    await done;
    const items = await w.call('thread/items/list', { threadId: tid, limit: 100 });
    const texts = [];
    for (const it of (items.data || items.items || [])) {
      const i2 = it.item || it;
      if (i2.type === 'agentMessage' && i2.text) texts.push(i2.text);
      else if (i2.type === 'mcpToolCall' && i2.tool === 'user_message.send_message' && i2.arguments?.text) texts.push(i2.arguments.text);
    }
    return { text: texts.join('\n\n') || '(dot completed without a text reply)', tid };
  } catch (e) {
    turnController.abort();
    w.call('turn/interrupt', { threadId: tid }).catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener('abort', relayAbort);
    w.call('thread/archive', { threadId: tid }).catch(() => {});
  }
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
  };
}
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function sendDotError(res, status, message, body = {}) {
  const id = 'resp_' + crypto.randomBytes(12).toString('hex');
  const payload = { error: { message, type: 'server_error' }, id, object: 'response', status: 'failed', model: body.model || DOT_SLUG };
  if (body.stream === false) { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return; }
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
}
function sendDotResponse(req, res, body, text) {
  const id = 'resp_' + crypto.randomBytes(12).toString('hex');
  const model = body.model || DOT_SLUG;
  if (body.stream !== true) {
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
  delete headers['content-encoding'];
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
  up.setTimeout(300000, () => up.destroy(new Error('passthrough timeout')));
  res.once('close', () => { if (!res.writableEnded) up.destroy(new Error('client disconnected')); });
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
<div class="sub">每 2 秒自動刷新 · 調用記錄保存在本機 · 最多顯示 500 條</div>
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
    res.end(JSON.stringify({ ok: true, dotSlug: DOT_SLUG, upstreamConnected: Boolean(ws && !ws.closed) }));
    return;
  }
  if (req.method !== 'POST' || !req.url.replace(/\?.*$/, '').endsWith('/responses')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  const chunks = [];
  const abortController = new AbortController();
  req.on('aborted', () => abortController.abort());
  res.on('close', () => { if (!res.writableEnded) abortController.abort(); });
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on('data', (c) => {
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) { bodyTooLarge = true; return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (bodyTooLarge) { if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'request body too large' } })); return; }
    let raw = Buffer.concat(chunks);
    const enc = req.headers['content-encoding'];
    try {
      if (enc === 'zstd') raw = zlib.zstdDecompressSync(raw, { maxOutputLength: MAX_BODY_BYTES });
      else if (enc === 'gzip') raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad content-encoding: ' + e.message } }));
      return;
    }
    if (raw.length > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request body too large after decompression' } }));
      return;
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch {
      passthrough(req, res, raw, logStart({ type: 'passthrough', model: null, status: 'running' }));
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'request body must be a JSON object' } })); return;
    }
    if (body.model !== DOT_SLUG) {
      passthrough(req, res, raw, logStart({ type: 'passthrough', model: body.model || null, status: 'running', effort: body.reasoning?.effort || null }));
      return;
    }
    const schemaError = validateDotBody(body);
    if (schemaError) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: schemaError } })); return; }
    // dot path
    const promptText = flattenInput(body.input, body.instructions);
    const cwd = extractCwd(body, promptText);
    const userTail = (() => { const i = promptText.lastIndexOf('\n\nUser:'); return (i >= 0 ? promptText.slice(i + 7) : promptText).trim(); })();
    const rec = logStart({ type: 'dot', model: body.model, status: 'running', prompt: userTail.slice(0, 2000), cwd: cwd || null, effort: body.reasoning?.effort || null });
    try {
      if (!promptText) throw new Error('empty input after flattening');
      log('dot turn start, prompt chars:', promptText.length, 'cwd:', cwd || '(default)');
      const { text, tid } = await runDotTurn(promptText, cwd, body.reasoning?.effort || null, 280000, abortController.signal);
      rec.tid = tid;
      log('dot turn done, reply chars:', text.length);
      logEnd(rec, { status: 'ok', reply: text.slice(0, 4000) });
      sendDotResponse(req, res, body, text);
    } catch (e) {
      log('dot turn error:', e.message);
      logEnd(rec, { status: 'error', error: e.message });
      if (!res.destroyed) sendDotError(res, /timeout/i.test(e.message) ? 504 : 502, e.message, body);
    }
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down on', signal);
  try { ws?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
server.listen(PORT, BIND, () => log(`listening on http://${BIND}:${PORT}/v1  (dot slug: ${DOT_SLUG})`));
