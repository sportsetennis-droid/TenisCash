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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    store: STORE_LABEL,
    port: PORT,
    pfxExists: fs.existsSync(PFX_PATH),
    pfxSize: fs.existsSync(PFX_PATH) ? fs.statSync(PFX_PATH).size : 0,
    version: '2.0-stateless',
    timestamp: new Date().toISOString(),
  });
});

// Emissão NFCe (modelo 65) — issuer + items + payment + nNF vêm do central
app.post('/emit-nfce', async (req, res) => {
  try {
    const { issuer, items, payment, customer, nNF } = req.body || {};
    if (!issuer) return res.status(400).json({ ok: false, error: 'issuer obrigatório' });
    if (!items?.length) return res.status(400).json({ ok: false, error: 'items obrigatório' });
    if (!payment) return res.status(400).json({ ok: false, error: 'payment obrigatório' });
    if (!nNF) return res.status(400).json({ ok: false, error: 'nNF obrigatório' });
    if (issuer.cnpj?.replace(/\D/g, '').length !== 14) return res.status(400).json({ ok: false, error: 'issuer.cnpj inválido' });

    const { emitNFCe } = await getSefaz();
    log('INFO', 'emit-nfce', 'cnpj=' + issuer.cnpj, 'nNF=' + nNF);
    const result = await emitNFCe({
      issuer: { ...issuer, nfceSerie: issuer.nfceSerie || 1, nfceNextNumber: nNF },
      pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      items, payment, customer, nNF,
    });
    log('INFO', 'emit-nfce', result.ok ? 'OK' : 'FAIL', result.status || '', (result.accessKey || '').slice(-12), result.motivo || '');
    res.json(result);
  } catch (err) {
    log('ERR', 'emit-nfce', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Emissão NFe modelo 55
app.post('/emit-nfe55', async (req, res) => {
  try {
    const { issuer, items, payment, customer, natOp, nNF } = req.body || {};
    if (!issuer || !items?.length || !payment || !nNF || !customer?.cpfCnpj) {
      return res.status(400).json({ ok: false, error: 'issuer, items, payment, nNF e customer.cpfCnpj obrigatórios' });
    }
    const { emitNFe55 } = await getSefaz();
    log('INFO', 'emit-nfe55', 'cnpj=' + issuer.cnpj, 'nNF=' + nNF);
    const result = await emitNFe55({
      issuer: { ...issuer, nfeSerie: issuer.nfeSerie || 1, nfeNextNumber: nNF },
      pfxPath: PFX_PATH, pfxSenha: PFX_SENHA,
      items, payment, customer, natOp, nNF,
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

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'TenisCash Fiscal Agent v2.0 iniciado',
    'STORE=' + STORE_LABEL,
    'PORT=' + PORT,
    'PFX=' + path.basename(PFX_PATH));
});
