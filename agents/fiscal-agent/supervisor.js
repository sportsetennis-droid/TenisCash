// =====================================================================
// TenisCash Supervisor — vigia/watchdog da máquina da loja
// =====================================================================
// Roda como tarefa SEPARADA do fiscal-agent (TenisCashSupervisor).
// Faz 2 coisas, sem nenhuma porta aberta (tudo via PULL pro central):
//   1) WATCHDOG: se o agente fiscal cair/travar, RELIGA ele sozinho.
//   2) COMANDOS REMOTOS: busca ordens no central (reiniciar, atualizar,
//      reconectar tailscale, pegar log) e executa NA máquina da loja.
// Assim a máquina vira gerenciável de fora SEM AnyDesk.
// Credencial = o próprio AGENT_TOKEN (validado contra Store.fiscalAgentToken).
// =====================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// .env parser CRLF-safe (mesmo do agente)
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split(/\r?\n/).forEach(raw => {
    const l = raw.replace(/^﻿/, '').trim();
    if (!l || l.startsWith('#')) return;
    const m = l.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const VERSION = '1.0';
const CENTRAL = (process.env.CENTRAL_URL || 'https://teniscash.com.br').replace(/\/$/, '');
const TOKEN = (process.env.AGENT_TOKEN || '').trim();
const AGENT_PORT = parseInt(process.env.PORT || '8765', 10);
const AGENT_TASK = process.env.AGENT_TASK || 'TenisCashFiscalAgent';
const SUPERVISOR_TASK = process.env.SUPERVISOR_TASK || 'TenisCashSupervisor';
const POLL_MS = parseInt(process.env.SUPERVISOR_POLL_MS || '45000', 10);
const HOST = os.hostname();
const LOG_FILE = path.join(__dirname, 'supervisor.log');

if (!TOKEN || TOKEN.length < 16) { console.error('FATAL: AGENT_TOKEN ausente/curto no .env'); process.exit(1); }

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}

// Executa um comando do PowerShell e devolve {ok, out}. Timeout de segurança.
function ps(command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: ((stdout || '') + (stderr || '')).slice(-4000) }));
  });
}

async function fetchJson(url, opts, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { _raw: txt.slice(0, 300), _status: r.status }; }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

// ---- saúde do agente fiscal local ----
async function checkAgent() {
  const r = await fetchJson(`http://127.0.0.1:${AGENT_PORT}/health`, {}, 8000);
  const healthy = !!(r.json && r.json.ok);
  return { healthy, version: r.json && r.json.version };
}

async function restartAgent() {
  log('WATCHDOG/CMD: reiniciando agente fiscal...');
  const r = await ps(`try { Stop-ScheduledTask -TaskName '${AGENT_TASK}' -ErrorAction SilentlyContinue } catch {}; try { Get-NetTCPConnection -LocalPort ${AGENT_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } } catch {}; Start-Sleep 2; Start-ScheduledTask -TaskName '${AGENT_TASK}'`);
  await new Promise(s => setTimeout(s, 6000));
  const h = await checkAgent();
  return { ok: h.healthy, out: `restart taskOk=${r.ok} agentHealthy=${h.healthy} v=${h.version || '?'}` };
}

// ---- comandos remotos (whitelist — sem exec arbitrário) ----
async function runUpdater() {
  // DETACHED: roda o instalador numa tarefa propria temporaria, pra ele
  // SOBREVIVER caso o update reinicie o proprio supervisor no meio.
  const d = __dirname.replace(/'/g, "''");
  const inner = `$env:AGENT_DIR='${d}'; try { Invoke-RestMethod ${CENTRAL}/atualizar-agente.txt | Invoke-Expression } catch { $_ | Out-File -FilePath '${d}\\update.err' -Encoding utf8 }`;
  const b64 = Buffer.from(inner, 'utf16le').toString('base64');
  const reg = `$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -EncodedCommand ${b64}'; Register-ScheduledTask -TaskName 'TenisCashUpdateOnce' -Action $a -RunLevel Highest -User 'SYSTEM' -Force | Out-Null; Start-ScheduledTask -TaskName 'TenisCashUpdateOnce'`;
  const r = await ps(reg, 30000);
  return { ok: r.ok, out: 'update disparado em tarefa detached — conclui em ~1min (confira depois com capture-list/get-health)' };
}

async function updateSupervisor() {
  // re-baixa este arquivo do central e sai — a tarefa religa com a versão nova
  const r = await fetchJson(`${CENTRAL}/api/auth/agent-update/file/supervisor.js`, { headers: { 'X-Agent-Token': TOKEN } }, 30000);
  if (r.status !== 200 || !r.json) {
    // o endpoint manda octet-stream; refazer como texto
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const resp = await fetch(`${CENTRAL}/api/auth/agent-update/file/supervisor.js`, { headers: { 'X-Agent-Token': TOKEN }, signal: ctrl.signal });
      if (!resp.ok) return { ok: false, out: 'download falhou HTTP ' + resp.status };
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 500) return { ok: false, out: 'arquivo suspeito (curto)' };
      fs.copyFileSync(__filename, __filename + '.bak');
      fs.writeFileSync(__filename, buf);
      log('CMD: supervisor atualizado, reiniciando a tarefa...');
      setTimeout(() => { ps(`Start-ScheduledTask -TaskName '${SUPERVISOR_TASK}'`); process.exit(0); }, 1500);
      return { ok: true, out: 'supervisor atualizado (' + buf.length + ' bytes), reiniciando' };
    } catch (e) { return { ok: false, out: e.message }; } finally { clearTimeout(t); }
  }
  return { ok: false, out: 'resposta inesperada' };
}

// ---- gravacao de seguranca do caixa (buffer 36h gravado pelo monitor.js) ----
const REC_DIR = path.join(__dirname, 'rec', 'screen');

function captureList(args) {
  try {
    if (!fs.existsSync(REC_DIR)) return { ok: true, out: 'sem gravacao ainda (monitor.js nao rodou nesta maquina?)' };
    const files = fs.readdirSync(REC_DIR).filter(f => f.endsWith('.jpg')).sort();
    if (!files.length) return { ok: true, out: 'buffer vazio' };
    const limit = parseInt((args && args.limit) || '60', 10);
    let bytes = 0; for (const f of files) { try { bytes += fs.statSync(path.join(REC_DIR, f)).size; } catch {} }
    const tail = files.slice(-limit);
    return { ok: true, out: `prints=${files.length}  janela=${files[0]}..${files[files.length - 1]}  tamanho=${(bytes / 1e6).toFixed(0)}MB\nultimos ${tail.length}:\n` + tail.join('\n') };
  } catch (e) { return { ok: false, out: e.message }; }
}

async function capturePull(args) {
  try {
    const name = path.basename(String((args && args.name) || ''));
    if (!name.endsWith('.jpg')) return { ok: false, out: 'informe args.name=<arquivo>.jpg (veja capture-list)' };
    const full = path.join(REC_DIR, name);
    if (!fs.existsSync(full)) return { ok: false, out: 'nao existe no buffer (ja rolou os 36h?)' };
    const buf = fs.readFileSync(full);
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 40000);
    try {
      const r = await fetch(`${CENTRAL}/api/auth/agent-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Agent-Token': TOKEN, 'X-Capture-Name': name },
        body: buf, signal: ctrl.signal,
      });
      return { ok: r.ok, out: r.ok ? `enviado ${name} (${(buf.length / 1024).toFixed(0)}KB)` : `falha HTTP ${r.status} ${(await r.text()).slice(0, 150)}` };
    } finally { clearTimeout(t); }
  } catch (e) { return { ok: false, out: e.message }; }
}

async function executeCommand(cmd) {
  const type = String(cmd.type || '').trim();
  log('CMD recebido:', type, cmd.id || '');
  switch (type) {
    case 'restart-agent': return restartAgent();
    case 'update-agent': { const u = await runUpdater(); return u; }
    case 'update-supervisor': return updateSupervisor();
    case 'tailscale-up': return ps('tailscale up --timeout=30s');
    case 'funnel-up': return ps(`tailscale funnel --bg ${AGENT_PORT}`);
    case 'get-health': { const h = await checkAgent(); return { ok: h.healthy, out: JSON.stringify(h) }; }
    case 'get-log': { try { const a = fs.readFileSync(path.join(__dirname, 'agent.log'), 'utf8'); return { ok: true, out: a.slice(-3500) }; } catch (e) { return { ok: false, out: e.message }; } }
    case 'capture-list': return captureList(cmd.args);
    case 'capture-pull': return capturePull(cmd.args);
    case 'ping': return { ok: true, out: 'pong ' + VERSION };
    default: return { ok: false, out: 'comando desconhecido: ' + type };
  }
}

// ---- loop principal ----
let consecutiveFails = 0;
let lastRestart = 0;

async function tick() {
  // 1) watchdog
  const h = await checkAgent();
  if (h.healthy) { consecutiveFails = 0; }
  else {
    consecutiveFails++;
    log(`agente NÃO saudável (${consecutiveFails}x)`);
    // 2 falhas seguidas + no máximo 1 religada a cada 3 min = sem tempestade de restart
    if (consecutiveFails >= 2 && (Date.now() - lastRestart) > 180000) {
      lastRestart = Date.now();
      const r = await restartAgent();
      log('WATCHDOG religou:', r.out);
      consecutiveFails = 0;
    }
  }

  // 2) heartbeat + buscar comandos no central
  const poll = await fetchJson(`${CENTRAL}/api/auth/agent-control/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
    body: JSON.stringify({ hostname: HOST, agentHealthy: h.healthy, agentVersion: h.version || null, supervisorVersion: VERSION }),
  }, 20000);

  if (poll.status === 200 && poll.json && Array.isArray(poll.json.commands)) {
    for (const cmd of poll.json.commands) {
      let result;
      try { result = await executeCommand(cmd); } catch (e) { result = { ok: false, out: 'erro: ' + e.message }; }
      await fetchJson(`${CENTRAL}/api/auth/agent-control/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
        body: JSON.stringify({ commandId: cmd.id, ok: !!result.ok, output: String(result.out || '').slice(-3500) }),
      }, 20000);
      log('CMD resultado:', cmd.type, result.ok ? 'OK' : 'FALHOU');
    }
  } else if (poll.error) {
    log('poll falhou (central inalcançável):', poll.error);
  }
}

log(`Supervisor v${VERSION} no ar — host=${HOST} agentPort=${AGENT_PORT} central=${CENTRAL} poll=${POLL_MS}ms`);
tick().catch(e => log('tick erro:', e.message));
setInterval(() => tick().catch(e => log('tick erro:', e.message)), POLL_MS);
