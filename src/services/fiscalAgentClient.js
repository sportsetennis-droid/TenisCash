// =====================================================================
// fiscalAgentClient.js — cliente HTTP que TenisCash central usa pra
// pedir emissão NFCe/NFe pro Fiscal Agent local da loja, via Tailscale.
// =====================================================================
// O agente é stateless: o central manda issuer completo + nNF + items
// no body. Agente assina com PFX local + envia pra SEFAZ + retorna.
// =====================================================================

const TIMEOUT_MS = 60000; // SEFAZ pode demorar; matriz já experimentou ~30s

async function callAgent(store, path, body) {
  if (!store?.fiscalAgentEnabled) {
    throw new Error('Store ' + store?.code + ' sem agent enabled');
  }
  if (!store.fiscalAgentUrl || !store.fiscalAgentToken) {
    throw new Error('Store ' + store.code + ' fiscalAgentUrl/Token não configurado');
  }
  const url = store.fiscalAgentUrl.replace(/\/$/, '') + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': store.fiscalAgentToken,
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
