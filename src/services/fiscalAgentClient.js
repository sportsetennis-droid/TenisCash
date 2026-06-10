// =====================================================================
// fiscalAgentClient.js — cliente HTTP que TenisCash central usa pra
// pedir emissão NFCe/NFe pro Fiscal Agent local da loja, via Tailscale.
// =====================================================================
// O agente é stateless: o central manda issuer completo + nNF + items
// no body. Agente assina com PFX local + envia pra SEFAZ + retorna.
// Como TODO agente assina com o cert do grupo (CNPJ-raiz), qualquer
// agente vivo serve qualquer loja → FAILOVER automático: se o agente
// da loja não responder, a chamada sai pelo agente de outra loja.
// =====================================================================

// Cinto-e-suspensorio: o agente tem budget de pior caso ~2x18s + backoff < 40s
// (ver _sefazPost em fiscalSefazDirect.mjs). 90s aqui garante que o agente SEMPRE
// termina e devolve {accessKey, xmlSigned, transmitError} antes do central abortar.
const TIMEOUT_MS = 90000;

let _prisma = null;
function getPrisma() {
  if (!_prisma) {
    const { PrismaClient } = require('@prisma/client');
    _prisma = new PrismaClient();
  }
  return _prisma;
}

// Lista de agentes vivos cadastrados (1 por URL distinta), cache 60s.
let _agentsCache = { at: 0, list: [] };
async function listAgents() {
  if (Date.now() - _agentsCache.at < 60000) return _agentsCache.list;
  try {
    const stores = await getPrisma().store.findMany({
      where: { fiscalAgentEnabled: true, fiscalAgentUrl: { not: null }, fiscalAgentToken: { not: null } },
      select: { code: true, fiscalAgentUrl: true, fiscalAgentToken: true },
      orderBy: { code: 'asc' },
    });
    const seen = new Set();
    const list = [];
    for (const s of stores) {
      const url = (s.fiscalAgentUrl || '').replace(/\/$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      list.push({ code: s.code, url, token: s.fiscalAgentToken });
    }
    _agentsCache = { at: Date.now(), list };
  } catch (err) {
    // sem DB acessível segue só com o agente primário
    console.error('[fiscalAgent] listAgents falhou:', err.message);
  }
  return _agentsCache.list;
}

async function postAgent(url, token, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': token,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: 'invalid_json', raw: text.slice(0, 500) }; }
    if (!resp.ok && !json.error) json.error = 'HTTP ' + resp.status;
    return json;
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'agent timeout' };
    return { ok: false, error: 'agent unreachable: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Falha de TRANSPORTE (agente/funnel fora) = pode tentar outro agente.
// Resposta de NEGÓCIO (SEFAZ respondeu, mesmo rejeitando) = NÃO troca de agente.
// 'agent timeout' também NÃO troca: o pedido pode ter chegado na SEFAZ (evita duplicar).
function isTransportFail(json) {
  if (!json) return true;
  if (json.ok) return false;
  if (json.status) return false; // SEFAZ deu cStat — resposta definitiva
  const e = String(json.error || '');
  if (e === 'agent timeout') return false;
  if (e.startsWith('agent unreachable')) return true;
  if (e === 'invalid_json') return true; // funnel/edge devolveu HTML = sem backend
  if (/^HTTP (401|403|5\d\d)/.test(e)) return true; // auth/funnel/edge — outro agente tem outro token
  return false;
}

async function callAgent(store, path, body) {
  if (!store?.fiscalAgentEnabled) {
    throw new Error('Store ' + store?.code + ' sem agent enabled');
  }
  if (!store.fiscalAgentUrl || !store.fiscalAgentToken) {
    throw new Error('Store ' + store.code + ' fiscalAgentUrl/Token não configurado');
  }
  const primaryUrl = store.fiscalAgentUrl.replace(/\/$/, '');

  // 1) agente da própria loja
  let result = await postAgent(primaryUrl, store.fiscalAgentToken, path, body);
  if (!isTransportFail(result)) return result;

  // 2) failover: outros agentes vivos (stateless — o issuer vai no body)
  const others = (await listAgents()).filter(a => a.url !== primaryUrl);
  for (const a of others) {
    console.warn('[fiscalAgent] ' + store.code + ': agente primário indisponível (' + (result.error || '?') + ') — failover via ' + a.code + ' (' + path + ')');
    result = await postAgent(a.url, a.token, path, body);
    if (!isTransportFail(result)) return result;
  }
  return result; // todos fora — devolve o último erro
}

async function ping(store) {
  if (!store?.fiscalAgentUrl) return { ok: false, error: 'no agentUrl' };
  const url = store.fiscalAgentUrl.replace(/\/$/, '') + '/health';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    return resp.ok ? await resp.json() : { ok: false, error: 'HTTP ' + resp.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function emitNFCe(store, payload) { return callAgent(store, '/emit-nfce', payload); }
function emitNFe55(store, payload) { return callAgent(store, '/emit-nfe55', payload); }
function cancel(store, payload) { return callAgent(store, '/cancel', payload); }
function correction(store, payload) { return callAgent(store, '/correction', payload); }

module.exports = { ping, emitNFCe, emitNFe55, cancel, correction };
