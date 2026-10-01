// dots-manager — always-on console + lifecycle manager for dots-proxy.
// Listens on 8788: serves the console page, start/stop API, log API,
// and forwards /v1/responses + /health to the proxy child on 8789.
// Zero deps. Node >= 22.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const CHILD_PORT = 8789;
const CHILD_SCRIPT = join(SCRIPT_DIR, 'dots-proxy.mjs');
const LOG_FILE = join(SCRIPT_DIR, 'dots-proxy-calls.jsonl');
const CONFIG_PATH = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const STATE_FILE = join(SCRIPT_DIR, 'dots-manager-state.json');

const DOTS_CATALOG = (() => {
  const local = join(SCRIPT_DIR, 'dots-model-catalog.local.json');
  try { readFileSync(local); return local; } catch { return join(SCRIPT_DIR, 'dots-model-catalog.json'); }
})();
const DOTS_SCALARS = [
  '# dots: 本地代理入口（picker 裡的 gpt-dot 走 dot 雲端,其餘模型透傳官方後端）',
  'model_provider = "dots"',
  'model_catalog_json = "' + DOTS_CATALOG.replace(/\\/g, '/') + '"',
];
const DOTS_PROVIDER_TABLE = [
  '[model_providers.dots]',
  'name = "dots"',
  'base_url = "http://127.0.0.1:8788/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
].join('\n');
const FALLBACK_MODEL = process.env.DOTS_FALLBACK_MODEL || 'gpt-6.1-sol';
const FALLBACK_EFFORT = process.env.DOTS_FALLBACK_EFFORT || 'low';

function currentMode() {
  try { return readFileSync(CONFIG_PATH, 'utf8').includes('model_provider = "dots"') ? 'dots' : 'direct'; }
  catch { return 'unknown'; }
}
function backupConfig(tag) {
  const p = CONFIG_PATH + '.bak-' + tag;
  try { writeFileSync(p, readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return p;
}
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const st = { ...readState(), ...patch };
  for (const k of Object.keys(st)) if (st[k] == null) delete st[k];
  try { writeFileSync(STATE_FILE, JSON.stringify(st)); } catch {}
}
// insert scalar lines into the top-level (before the first [table]) section
function insertScalars(cfg, scalars) {
  const lines = cfg.split('\n');
  const at = lines.findIndex((l) => /^\s*\[/.test(l));
  let pos = at < 0 ? lines.length : at;
  if (pos > 0 && lines[pos - 1] === '') {
    // a blank line already separates content from the table; insert before it
    lines.splice(pos - 1, 0, ...scalars);
  } else {
    lines.splice(pos, 0, ...scalars, '');
  }
  return lines.join('\n');
}
function removeDotsTables(cfg) {
  const lines = cfg.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[model_providers.dots]');
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) { if (/^\s*\[/.test(lines[i])) { end = i; break; } }
    lines.splice(start, end - start);
  }
  return lines.join('\n');
}
function setMode(mode) {
  let cfg = readFileSync(CONFIG_PATH, 'utf8');
  backupConfig('mode-' + Date.now());
  if (mode === 'direct') {
    // remember the provider dots replaced, then remove all dots lines
    cfg = cfg.split('\n').filter((l) =>
      !l.startsWith('# dots:') && l.trim() !== 'model_provider = "dots"' && !l.trim().startsWith('model_catalog_json =')
    ).join('\n');
    cfg = removeDotsTables(cfg);
    // collapse the blank-line runs left behind by the removed dots block
    cfg = cfg.replace(/\n{3,}/g, '\n\n');
    // restore the provider that was active before dots took over
    const st = readState();
    if (st.savedProvider && st.savedProvider !== 'dots' && !/^model_provider = "/m.test(cfg)) {
      cfg = insertScalars(cfg, [`model_provider = "${st.savedProvider}"`]);
    }
    writeState({ savedProvider: null });
    // if active model is the dot pseudo-model, save it and fall back to a real one
    const m = cfg.match(/^model = "([^"]+)"/m);
    const e = cfg.match(/^model_reasoning_effort = "([^"]+)"/m);
    if (m && /-dot$/.test(m[1])) {
      writeState({ savedModel: m[1], savedEffort: e ? e[1] : null });
      cfg = cfg.replace(/^model = "[^"]+"/m, `model = "${FALLBACK_MODEL}"`);
      if (e) cfg = cfg.replace(/^model_reasoning_effort = "[^"]+"/m, `model_reasoning_effort = "${FALLBACK_EFFORT}"`);
    }
    writeFileSync(CONFIG_PATH, cfg);
    stopChild();
    return { ok: true, mode: 'direct' };
  }
  // mode === 'dots'
  if (currentMode() === 'dots') { startChild(); return { ok: true, mode: 'dots', already: true }; }
  // remember the current provider so "切回官方直連" can restore it verbatim
  const cur = cfg.match(/^model_provider = "([^"]+)"/m);
  if (cur && cur[1] !== 'dots') writeState({ savedProvider: cur[1] });
  // drop existing provider/catalog scalars to avoid duplicate TOML keys, then add ours
  cfg = cfg.split('\n').filter((l) =>
    !l.trim().startsWith('model_provider =') && !l.trim().startsWith('model_catalog_json =')
  ).join('\n');
  cfg = insertScalars(cfg, DOTS_SCALARS).replace(/\s*$/, '\n\n') + DOTS_PROVIDER_TABLE + '\n';
  // restore the model the user had before rollback, if saved
  const st = readState();
  if (st.savedModel && /^model = "/m.test(cfg)) {
    cfg = cfg.replace(/^model = "[^"]+"/m, `model = "${st.savedModel}"`);
    if (st.savedEffort && /^model_reasoning_effort = "/m.test(cfg)) {
      cfg = cfg.replace(/^model_reasoning_effort = "[^"]+"/m, `model_reasoning_effort = "${st.savedEffort}"`);
    }
  }
  writeFileSync(CONFIG_PATH, cfg);
  startChild();
  return { ok: true, mode: 'dots' };
}

function log(...a) { console.error('[dots-manager]', ...a); }

// ---------- child lifecycle ----------
let child = null;
let childStartedAt = null;
function childRunning() { return child !== null && child.exitCode === null && !child.killed; }
function startChild() {
  if (childRunning()) return { ok: true, already: true };
  child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, DOTS_PROXY_PORT: String(CHILD_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  childStartedAt = Date.now();
  child.on('exit', (code) => { log('child exited, code', code); });
  log('child started, pid', child.pid);
  return { ok: true, pid: child.pid };
}
function stopChild() {
  if (!childRunning()) return { ok: true, already: true };
  child.kill();
  return { ok: true };
}

// ---------- logs (read from disk; fold _update lines) ----------
function readLogs() {
  const out = [];
  let raw;
  try { raw = readFileSync(LOG_FILE, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r._update) {
      const old = out.find((x) => x.id === r.id);
      if (old) Object.assign(old, r);
      continue;
    }
    out.push(r);
  }
  if (!childRunning()) for (const r of out) if (r.status === 'running') r.status = 'interrupted';
  else if (childStartedAt) for (const r of out) if (r.status === 'running' && r.ts < childStartedAt) r.status = 'interrupted';
  return out.slice(-500).reverse();
}

// ---------- forward to child ----------
function forward(req, res) {
  if (!childRunning()) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'dots-proxy 未啟動。打開 http://127.0.0.1:8788/ 點「啟動」。' } }));
    return;
  }
  const up = http.request({ host: '127.0.0.1', port: CHILD_PORT, path: req.url, method: req.method, headers: req.headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'proxy child unreachable: ' + e.message } }));
  });
  req.pipe(up);
}

// ---------- console page ----------
const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dots-proxy 調用記錄</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--dot:#a371f7;--ok:#3fb950;--err:#f85149;--run:#58a6ff;--pass:#8b949e}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;padding:20px;max-width:1100px;margin:0 auto}
  h1{font-size:18px}
  .sub{color:var(--dim);font-size:12px;margin-bottom:16px}
  .bar{display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;margin-bottom:16px}
  .pill{padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
  .pill.on{background:rgba(63,185,80,.15);color:var(--ok)}
  .pill.off{background:rgba(248,81,73,.15);color:var(--err)}
  button{background:#21262d;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:4px 14px;cursor:pointer;font-size:13px}
  button:hover{border-color:var(--dim)}
  button:disabled{opacity:.4;cursor:default}
  .uptime{color:var(--dim);font-size:12px;margin-left:auto}
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
  .ms{margin-left:auto}
  .empty{color:var(--dim);text-align:center;padding:40px}
</style>
</head>
<body>
<h1>dots-proxy 調用記錄</h1>
<div class="sub">每 2 秒自動刷新 · 只存本機 · 最多保留 500 條</div>
<div class="bar">
  <span class="pill off" id="pill">檢查中…</span>
  <button id="btnStart" onclick="ctl('start')">啟動</button>
  <button id="btnStop" onclick="ctl('stop')">停止</button>
  <span style="width:1px;height:20px;background:var(--line)"></span>
  <span class="pill off" id="modepill">模式…</span>
  <button id="btnMode" onclick="switchMode()">切回官方直連</button>
  <span class="uptime" id="uptime"></span>
</div>
<div class="stats" id="stats"></div>
<div id="list"></div>
<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtTime(ts){var d=new Date(ts);return d.toLocaleTimeString('zh-TW',{hour12:false});}
function fmtDur(ms){if(ms==null)return '-';return ms<1000?ms+'ms':(ms/1000).toFixed(1)+'s';}
function cut(s,n){s=String(s||'');return s.length>n?s.slice(0,n)+'…':s;}
function dispModel(m){return m==='gpt-6-astra-dot'?'gpt-dot':m;}
async function ctl(action){
  document.getElementById('btnStart').disabled=true;
  document.getElementById('btnStop').disabled=true;
  try{await fetch('/api/'+action,{method:'POST'});}catch(e){}
  setTimeout(refresh,action==='start'?1500:300);
}
async function switchMode(){
  var st=await (await fetch('/api/status')).json();
  var target=st.mode==='dots'?'direct':'dots';
  var msg=target==='direct'
    ?'切回官方直連：codex 將不再經過 dots 代理，所有模型恢復官方通道計費。\\n（會在 config 同目錄留備份；若當前模型是 gpt-dot 會自動切回 gpt-6.1-sol）\\n\\n確定？'
    :'恢復 dots 代理：codex 流量重新走 127.0.0.1:8788，gpt-dot 走 dot 雲端。\\n\\n確定？';
  if(!confirm(msg))return;
  document.getElementById('btnMode').disabled=true;
  try{await fetch('/api/mode',{method:'POST',body:JSON.stringify({mode:target})});}catch(e){}
  setTimeout(refresh,800);
}
async function refresh(){
  try{
    var st=await (await fetch('/api/status')).json();
    var pill=document.getElementById('pill');
    pill.textContent=st.running?'服務運行中':'已停止';
    pill.className='pill '+(st.running?'on':'off');
    document.getElementById('btnStart').disabled=st.running;
    document.getElementById('btnStop').disabled=!st.running;
    var mp=document.getElementById('modepill');
    mp.textContent=st.mode==='dots'?'dots 代理':'官方直連';
    mp.className='pill '+(st.mode==='dots'?'on':'off');
    var bm=document.getElementById('btnMode');
    bm.textContent=st.mode==='dots'?'切回官方直連':'恢復 dots 代理';
    bm.disabled=false;
    document.getElementById('uptime').textContent=st.running&&st.startedAt?('本次啟動 '+new Date(st.startedAt).toLocaleTimeString('zh-TW',{hour12:false})):'';
  }catch(e){}
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
      var stt='<span class="s-'+l.status+'">'+l.status+'</span>';
      var detail='';
      if(l.type==='dot'){
        detail='<div class="prompt">'+esc(cut(l.prompt,300))+'</div>'+
               (l.reply?'<div class="reply">'+esc(l.reply)+'</div>':'')+
               (l.error?'<div class="reply" style="color:var(--err)">'+esc(l.error)+'</div>':'');
      }
      return "<div class='row'>"+
        '<div class="meta">'+badge+stt+'<span>'+esc(dispModel(l.model)||'')+'</span>'+(l.effort?'<span>effort:'+esc(l.effort)+'</span>':'')+'<span>'+fmtTime(l.ts)+'</span>'+
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
const server = http.createServer(async (req, res) => {
  const path = req.url.replace(/\?.*$/, '');
  if (req.method === 'GET' && (path === '/' || path === '/console')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && path === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: childRunning(), pid: childRunning() ? child.pid : null, startedAt: childRunning() ? childStartedAt : null, mode: currentMode() }));
    return;
  }
  if (req.method === 'POST' && path === '/api/mode') {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      let mode = null;
      try { mode = JSON.parse(raw).mode; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'dots' || mode === 'direct') {
        try { res.end(JSON.stringify(setMode(mode))); }
        catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
      } else {
        res.end(JSON.stringify({ ok: false, error: 'bad mode' }));
      }
    });
    return;
  }
  if (req.method === 'POST' && path === '/api/start') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(startChild()));
    return;
  }
  if (req.method === 'POST' && path === '/api/stop') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stopChild()));
    return;
  }
  if (req.method === 'GET' && path === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: readLogs() }));
    return;
  }
  if (path === '/health' || path === '/v1/health' || path.endsWith('/responses')) {
    forward(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`console on http://127.0.0.1:${PORT}/  (proxy child port ${CHILD_PORT})`);
  startChild();
});
