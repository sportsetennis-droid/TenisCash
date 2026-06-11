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
// FISCAL_EXTRA_AGENTS (env, "url|token;url|token") adiciona agentes fora do
// cadastro de loja — ex: agente da matriz atualizado antes das lojas.
let _agentsCache = { at: 0, list: [] };
async function listAgents() {
  if (Date.now() - _agentsCache.at < 60000) return _agentsCache.list;
  const seen = new Set();
  const list = [];
  const push = (code, url, token) => {
    url = (url || '').replace(/\/$/, '');
    if (!url || !token || seen.has(url)) return;
    seen.add(url);
    list.push({ code, url, token });
  };
  try {
    const stores = await getPrisma().store.findMany({
      where: { fiscalAgentEnabled: true, fiscalAgentUrl: { not: null }, fiscalAgentToken: { not: null } },
      select: { code: true, fiscalAgentUrl: true, fiscalAgentToken: true },
      orderBy: { code: 'asc' },
    });
    for (const s of stores) push(s.code, s.fiscalAgentUrl, s.fiscalAgentToken);
  } catch (err) {
    // sem DB acessível segue só com o agente primário
    console.error('[fiscalAgent] listAgents falhou:', err.message);
  }
  for (const part of String(process.env.FISCAL_EXTRA_AGENTS || '').split(';')) {
    const [url, token] = part.split('|').map(s => (s || '').trim());
    if (url && token) push('EXTRA', url, token);
  }
  _agentsCache = { at: Date.now(), list };
  return _agentsCache.list;
}

// Versão do agente (/health), cache 120s por URL. Troca exige >= 2.1
// (pagamentos múltiplos + NFe de devolução) — agente 2.0 rejeitaria o payload.
const _verCache = new Map();
async function agentVersion(url) {
  const hit = _verCache.get(url);
  if (hit && Date.now() - hit.at < 120000) return hit.ver;
  let ver = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url + '/health', { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (resp.ok) ver = parseFloat(((await resp.json()).version || '0')) || 0;
  } catch { /* fora do ar = versão 0 */ }
  _verCache.set(url, { at: Date.now(), ver });
  return ver;
}

// Payload que só agente v2.1+ atende bem: troca/devolução (payments[]/finNFe)
// e QUALQUER operação em chave modelo 55 (cancelamento/consulta) — o agente 2.0
// aponta NFe 55 pro host morto nfe.sefaz.pb.gov.br; o 2.1 usa a SVRS correta.
function needsV21(body) {
  return !!(body && (
    (Array.isArray(body.payments) && body.payments.length) ||
    body.finNFe === 4 || body.tpNF === 0 || body.refNFe ||
    (body.accessKey && String(body.accessKey).slice(20, 22) === '55')
  ));
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

  // Payload de troca/devolução: roteia SÓ pra agente v2.1+ (2.0 não conhece payments/finNFe).
  if (needsV21(body)) {
    const all = [{ code: store.code, url: primaryUrl, token: store.fiscalAgentToken }, ...(await listAgents()).filter(a => a.url !== primaryUrl)];
    let result = null;
    for (const a of all) {
      if ((await agentVersion(a.url)) < 2.1) continue;
      if (result) console.warn('[fiscalAgent] ' + store.code + ': failover v2.1 via ' + a.code + ' (' + path + ')');
      result = await postAgent(a.url, a.token, path, body);
      if (!isTransportFail(result)) return result;
    }
    return result || { ok: false, error: 'Nenhum agente fiscal v2.1 disponível — atualize o agente das lojas pra usar troca/devolução' };
  }

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
