// =====================================================================
// TenisCash Fiscal Agent — stateless
// =====================================================================
// Recebe TUDO do TenisCash central no body de cada request: issuer
// completo (CNPJ, IE, endereço, CSC), items, payment, nNF.
//
// Localmente só conhece: AGENT_TOKEN, PFX_PATH, PFX_SENHA, PORT.
// Numeração NFCe/NFe é controlada pelo central (sem state local).
// =====================================================================

// .env parser CRLF-safe
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(raw => {
    const l = raw.replace(/^﻿/, '').trim();
    if (!l || l.startsWith('#')) return;
    const m = l.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '8765', 10);
const TOKEN = process.env.AGENT_TOKEN;
const PFX_PATH = process.env.PFX_PATH;
const PFX_SENHA = process.env.PFX_SENHA;
const STORE_LABEL = process.env.STORE_LABEL || 'unknown';
const VERSION = '2.3.1-auto';

function fatal(msg) { console.error('FATAL:', msg); process.exit(1); }
if (!TOKEN || TOKEN.length < 16) fatal('AGENT_TOKEN ausente ou curto (>=16 chars)');
if (!PFX_PATH || !fs.existsSync(PFX_PATH)) fatal('PFX_PATH não encontrado: ' + PFX_PATH);
if (!PFX_SENHA) fatal('PFX_SENHA vazia');

// Log simples
const LOG_FILE = path.resolve('agent.log');
function log(level, ...args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}

// Lazy load do módulo SEFAZ (ESM)
let _sefaz = null;
async function getSefaz() {
  if (!_sefaz) _sefaz = await import('./fiscalSefazDirect.mjs');
  return _sefaz;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// Auth middleware (exceto /health)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.headers['x-agent-token'] !== TOKEN) {
    log('WARN', 'auth fail', req.path, 'from', req.ip);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// Requisições em voo — o self-update espera zerar antes de reiniciar o processo
let _inFlight = 0;
app.use((req, res, next) => { _inFlight++; res.on('close', () => { _inFlight = Math.max(0, _inFlight - 1); }); next(); });

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    store: STORE_LABEL,
    port: PORT,
    pfxExists: fs.existsSync(PFX_PATH),
    pfxSize: fs.existsSync(PFX_PATH) ? fs.statSync(PFX_PATH).size : 0,
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Emissão NFCe (modelo 65) — issuer + items + payment(s) + nNF vêm do central
app.post('/emit-nfce', async (req, res) => {
  try {
    const { issuer, items, payment, payments, customer, nNF } = req.body || {};
    if (!issuer) return res.status(400).json({ ok: false, error: 'issuer obrigatório' });
    if (!items?.length) return res.status(400).json({ ok: false, error: 'items obrigatório' });
    if (!payment && !payments?.length) return res.status(400).json({ ok: false, error: 'payment obrigatório' });
    if (!nNF) return res.status(400).json({ ok: false, error: 'nNF obrigatório' });
    if (issuer.cnpj?.replace(/\D/g, '').length !== 14) return res.status(400).json({ ok: false, error: 'issuer.cnpj inválido' });

    const { emitNFCe } = await getSefaz();
    log('INFO', 'emit-nfce', 'cnpj=' + issuer.cnpj, 'nNF=' + nNF, payments?.length ? ('pagamentos=' + payments.length) : '');
    const result = await emitNFCe({
      issuer: { ...issuer, nfceSerie: issuer.nfceSerie || 1, nfceNextNumber: nNF },
      pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      items, payment, payments, customer, nNF,
    });
    log('INFO', 'emit-nfce', result.ok ? 'OK' : 'FAIL', result.status || '', (result.accessKey || '').slice(-12), result.motivo || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'emit-nfce', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Emissão NFe modelo 55 — normal (saída) ou DEVOLUÇÃO (finNFe=4, tpNF=0, refNFe=chave do cupom)
app.post('/emit-nfe55', async (req, res) => {
  try {
    const { issuer, items, payment, payments, customer, natOp, nNF, finNFe, tpNF, refNFe } = req.body || {};
    if (!issuer || !items?.length || (!payment && !payments?.length) || !nNF || !customer?.cpfCnpj) {
      return res.status(400).json({ ok: false, error: 'issuer, items, payment, nNF e customer.cpfCnpj obrigatórios' });
    }
    const { emitNFe55 } = await getSefaz();
    log('INFO', 'emit-nfe55', 'cnpj=' + issuer.cnpj, 'nNF=' + nNF, finNFe === 4 ? ('DEVOLUCAO ref=' + String(refNFe || '').slice(-12)) : '');
    const result = await emitNFe55({
      issuer: { ...issuer, nfeSerie: issuer.nfeSerie || 1, nfeNextNumber: nNF },
      pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      items, payment, payments, customer, natOp, nNF, finNFe, tpNF, refNFe,
    });
    log('INFO', 'emit-nfe55', result.ok ? 'OK' : 'FAIL', result.status || '', (result.accessKey || '').slice(-12), result.motivo || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'emit-nfe55', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cancelamento
app.post('/cancel', async (req, res) => {
  try {
    const { issuer, accessKey, protocol, reason } = req.body || {};
    if (!issuer || !accessKey || !protocol || !reason) {
      return res.status(400).json({ ok: false, error: 'issuer, accessKey, protocol, reason obrigatórios' });
    }
    const { cancelDocument } = await getSefaz();
    log('INFO', 'cancel', accessKey.slice(-12));
    const result = await cancelDocument({
      issuer, pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      accessKey, protocol, reason,
    });
    log('INFO', 'cancel', result.ok ? 'OK' : 'FAIL', result.motivo || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'cancel', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Consulta situação (retorna protocolo de autorização)
app.post('/consulta', async (req, res) => {
  try {
    const { issuer, accessKey } = req.body || {};
    if (!issuer || !accessKey) return res.status(400).json({ ok: false, error: 'issuer e accessKey obrigatórios' });
    const { consultarNFe } = await getSefaz();
    log('INFO', 'consulta', accessKey.slice(-12));
    const result = await consultarNFe({ issuer, pfxPath: PFX_PATH, pfxSenha: PFX_SENHA, accessKey });
    log('INFO', 'consulta', result.status || '', result.protocol || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'consulta', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// CCe — NFe 55 only
app.post('/correction', async (req, res) => {
  try {
    const { issuer, accessKey, correction, nSeqEvento } = req.body || {};
    if (!issuer || !accessKey || !correction) {
      return res.status(400).json({ ok: false, error: 'issuer, accessKey, correction obrigatórios' });
    }
    const { sendCorrectionLetter } = await getSefaz();
    log('INFO', 'correction', accessKey.slice(-12));
    const result = await sendCorrectionLetter({
      issuer, pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      accessKey, correction, nSeqEvento,
    });
    log('INFO', 'correction', result.ok ? 'OK' : 'FAIL', result.motivo || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'correction', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================================
// AUTO-UPDATE — o agente se atualiza sozinho a partir do central
// (teniscash.com.br), autenticado com o PRÓPRIO token. Valida sha256 do
// manifest, grava com backup .bak e reinicia (a Scheduled Task religa;
// um schtasks /run detached é o cinto extra). Roda 45s após o boot, a
// cada 6h, e sob demanda via POST /selfupdate (permite atualizar TODAS
// as lojas remotamente, sem AnyDesk). Erro = loga e segue na versão atual.
// Dependência nova em package.json NÃO entra aqui (precisa npm install —
// caso raro, usa o instalador /atualizar-agente.ps1 ou setup.ps1).
// =====================================================================
const UPDATE_URL = process.env.UPDATE_URL || 'https://teniscash.com.br/api/auth/agent-update';
const UPDATE_FILES = ['index.js', 'fiscalSefazDirect.mjs', 'fiscalAcquirers.js'];
let _updating = false;
async function selfUpdate(force) {
  if (_updating) return { ok: false, error: 'update já em andamento' };
  _updating = true;
  try {
    const crypto = require('node:crypto');
    const h = { 'X-Agent-Token': TOKEN };
    const man = await (await fetch(UPDATE_URL + '/manifest', { headers: h, signal: AbortSignal.timeout(30000) })).json();
    if (!man.version || !Array.isArray(man.files)) throw new Error('manifest inválido: ' + JSON.stringify(man).slice(0, 120));
    if (man.version === VERSION && !force) return { ok: true, upToDate: true, version: VERSION };
    log('INFO', 'selfupdate', 'baixando v' + man.version + ' (local v' + VERSION + ')');
    const novos = {};
    for (const f of man.files) {
      if (!UPDATE_FILES.includes(f.name)) continue;
      const r = await fetch(UPDATE_URL + '/file/' + f.name, { headers: h, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('download ' + f.name + ': HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (sha !== f.sha256) throw new Error('sha256 divergente em ' + f.name);
      novos[f.name] = buf;
    }
    if (!novos['index.js']) throw new Error('manifest sem index.js');
    for (const [name, buf] of Object.entries(novos)) {
      const dest = path.resolve(name);
      try { if (fs.existsSync(dest)) fs.copyFileSync(dest, dest + '.bak'); } catch {}
      fs.writeFileSync(dest, buf);
    }
    log('INFO', 'selfupdate', 'v' + man.version + ' gravada — reiniciando');
    setTimeout(async () => {
      for (let i = 0; i < 60 && _inFlight > 0; i++) await new Promise(r => setTimeout(r, 1000));
      try {
        require('node:child_process').spawn('cmd', ['/c', 'ping -n 4 127.0.0.1 >nul & schtasks /run /tn TenisCashFiscalAgent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch {}
      process.exit(1); // exit != 0 → a Scheduled Task religa sozinha (restart on failure)
    }, 200);
    return { ok: true, updatingTo: man.version, msg: 'atualizando e reiniciando em segundos' };
  } catch (err) {
    log('WARN', 'selfupdate falhou (segue na versão atual):', err.message);
    return { ok: false, error: err.message };
  } finally {
    _updating = false;
  }
}
app.post('/selfupdate', async (req, res) => {
  res.json(await selfUpdate(!!(req.body && req.body.force)));
});
setTimeout(() => selfUpdate(false).catch(() => {}), 45000);
setInterval(() => selfUpdate(false).catch(() => {}), 6 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'TenisCash Fiscal Agent v' + VERSION + ' iniciado',
    'STORE=' + STORE_LABEL,
    'PORT=' + PORT,
    'PFX=' + path.basename(PFX_PATH));
});
