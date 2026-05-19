// =====================================================================
// TenisCash Fiscal Agent
// =====================================================================
// HTTP server local que escuta na Tailscale. Recebe ordens de emissão
// NFCe/NFe do TenisCash central e usa o PFX/CSC LOCAIS desta máquina
// pra assinar e enviar pra SEFAZ-PB direto.
//
// O PFX/senha/CSC NUNCA saem desta máquina. Só o XML autorizado retorna.
// =====================================================================

// Inline .env parser
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8765', 10);
const TOKEN = process.env.AGENT_TOKEN;
if (!TOKEN || TOKEN === 'trocar-por-token-32-bytes-hex') {
  console.error('FATAL: AGENT_TOKEN não configurado no .env');
  process.exit(1);
}
if (!fs.existsSync(process.env.PFX_PATH || '')) {
  console.error('FATAL: PFX_PATH não encontrado:', process.env.PFX_PATH);
  process.exit(1);
}
if (!process.env.PFX_SENHA) { console.error('FATAL: PFX_SENHA vazia'); process.exit(1); }

// State persistido em disco — numeração da NFCe/NFe vive aqui
const STATE_FILE = path.resolve('agent-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch {
    return {
      nfceSerie: parseInt(process.env.NFCE_SERIE || '1', 10),
      nfceNextNumber: parseInt(process.env.NFCE_NEXT_NUMBER || '1', 10),
      nfeSerie: parseInt(process.env.NFE_SERIE || '1', 10),
      nfeNextNumber: parseInt(process.env.NFE_NEXT_NUMBER || '1', 10),
    };
  }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
let state = loadState();

// Issuer reconstruído do .env
function issuer() {
  return {
    cnpj: process.env.CNPJ,
    companyName: process.env.COMPANY_NAME,
    fantasyName: process.env.FANTASY_NAME,
    ie: process.env.IE,
    csc: process.env.CSC,
    cscId: process.env.CSC_ID,
    environment: process.env.ENVIRONMENT || 'homologation',
    street: process.env.STREET,
    number: process.env.NUMBER,
    neighborhood: process.env.NEIGHBORHOOD,
    city: process.env.CITY,
    state: process.env.STATE,
    zip: process.env.ZIP,
    cityCode: process.env.CITY_CODE || '2507507',
    phone: process.env.PHONE,
    crt: parseInt(process.env.CRT || '3', 10),
    nfceSerie: state.nfceSerie,
    nfceNextNumber: state.nfceNextNumber,
    nfeSerie: state.nfeSerie,
    nfeNextNumber: state.nfeNextNumber,
  };
}

// Logger simples — arquivo + console
const LOG_FILE = path.resolve('agent.log');
function log(level, ...args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// Dynamic import do módulo ESM fiscalSefazDirect
let _sefaz = null;
async function getSefaz() {
  if (!_sefaz) _sefaz = await import('./fiscalSefazDirect.mjs');
  return _sefaz;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const t = req.headers['x-agent-token'];
  if (t !== TOKEN) {
    log('WARN', 'auth fail', req.path, 'from', req.ip);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    storeCode: process.env.STORE_CODE,
    cnpj: process.env.CNPJ,
    environment: process.env.ENVIRONMENT,
    state,
    pfxExists: fs.existsSync(process.env.PFX_PATH),
    timestamp: new Date().toISOString(),
  });
});

// Emissão NFCe (modelo 65) — payload da venda
app.post('/emit-nfce', async (req, res) => {
  try {
    const b = req.body || {};
    const { items, payment, customer } = b;
    if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });
    if (!payment) return res.status(400).json({ error: 'payment obrigatório' });

    const { emitNFCe } = await getSefaz();
    const iss = issuer();
    const nNF = b.nNF || iss.nfceNextNumber;
    log('INFO', 'emit-nfce start nNF=' + nNF, 'items=' + items.length);

    const result = await emitNFCe({
      issuer: iss, pfxPath: process.env.PFX_PATH, pfxSenha: process.env.PFX_SENHA,
      items, payment, customer, nNF,
    });

    if (result.ok) {
      state.nfceNextNumber = (b.nNF || state.nfceNextNumber) + 1;
      saveState(state);
    }
    log('INFO', 'emit-nfce', result.ok ? 'OK' : 'FAIL', result.accessKey?.slice(-12), result.motivo);
    res.json(result);
  } catch (err) {
    log('ERR', 'emit-nfce', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Emissão NFe modelo 55 (B2B / ecommerce)
app.post('/emit-nfe55', async (req, res) => {
  try {
    const b = req.body || {};
    const { items, payment, customer, natOp } = b;
    if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });
    if (!customer?.cpfCnpj) return res.status(400).json({ error: 'customer.cpfCnpj obrigatório' });
    if (!payment) return res.status(400).json({ error: 'payment obrigatório' });

    const { emitNFe55 } = await getSefaz();
    const iss = issuer();
    const nNF = b.nNF || iss.nfeNextNumber;
    log('INFO', 'emit-nfe55 start nNF=' + nNF);

    const result = await emitNFe55({
      issuer: iss, pfxPath: process.env.PFX_PATH, pfxSenha: process.env.PFX_SENHA,
      items, payment, customer, natOp, nNF,
    });

    if (result.ok) {
      state.nfeNextNumber = (b.nNF || state.nfeNextNumber) + 1;
      saveState(state);
    }
    log('INFO', 'emit-nfe55', result.ok ? 'OK' : 'FAIL', result.accessKey?.slice(-12), result.motivo);
    res.json(result);
  } catch (err) {
    log('ERR', 'emit-nfe55', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cancelamento
app.post('/cancel', async (req, res) => {
  try {
    const { accessKey, protocol, reason } = req.body || {};
    if (!accessKey || !protocol || !reason) return res.status(400).json({ error: 'accessKey, protocol, reason obrigatórios' });
    const { cancelDocument } = await getSefaz();
    log('INFO', 'cancel start', accessKey.slice(-12));
    const result = await cancelDocument({
      issuer: issuer(), pfxPath: process.env.PFX_PATH, pfxSenha: process.env.PFX_SENHA,
      accessKey, protocol, reason,
    });
    log('INFO', 'cancel', result.ok ? 'OK' : 'FAIL', result.motivo);
    res.json(result);
  } catch (err) {
    log('ERR', 'cancel', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Carta de Correção (CCe) — só NFe modelo 55
app.post('/correction', async (req, res) => {
  try {
    const { accessKey, correction, nSeqEvento } = req.body || {};
    if (!accessKey || !correction) return res.status(400).json({ error: 'accessKey, correction obrigatórios' });
    const { sendCorrectionLetter } = await getSefaz();
    log('INFO', 'correction start', accessKey.slice(-12));
    const result = await sendCorrectionLetter({
      issuer: issuer(), pfxPath: process.env.PFX_PATH, pfxSenha: process.env.PFX_SENHA,
      accessKey, correction, nSeqEvento,
    });
    log('INFO', 'correction', result.ok ? 'OK' : 'FAIL', result.motivo);
    res.json(result);
  } catch (err) {
    log('ERR', 'correction', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ajusta numeração manualmente (uso de exceção: ex. retomar após problema)
app.post('/set-numbering', (req, res) => {
  const { nfceNextNumber, nfeNextNumber, nfceSerie, nfeSerie } = req.body || {};
  if (nfceNextNumber != null) state.nfceNextNumber = parseInt(nfceNextNumber, 10);
  if (nfeNextNumber != null) state.nfeNextNumber = parseInt(nfeNextNumber, 10);
  if (nfceSerie != null) state.nfceSerie = parseInt(nfceSerie, 10);
  if (nfeSerie != null) state.nfeSerie = parseInt(nfeSerie, 10);
  saveState(state);
  log('INFO', 'set-numbering', state);
  res.json({ ok: true, state });
});

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'TenisCash Fiscal Agent iniciado',
    'STORE=' + process.env.STORE_CODE,
    'CNPJ=' + process.env.CNPJ,
    'ENV=' + (process.env.ENVIRONMENT || 'homologation'),
    'PORT=' + PORT,
    'nfceNext=' + state.nfceNextNumber);
});
