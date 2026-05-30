// =====================================================================
// Live Commerce — barramento SSE em memória (sem dependência nova)
// =====================================================================
// Roteia mensagens entre conexões SSE abertas:
//   - chatClients[chatId]   → visitante + vendedor dentro de UMA conversa
//   - storeClients[storeId] → painel do vendedor (escuta a loja inteira:
//                             novas conversas, novas msgs, badges de não-lida)
//
// Single-instance no Railway → registry em memória basta (sem Redis).
// Se um dia rodar em múltiplas réplicas, trocar isto por Redis pub/sub.
// As mensagens continuam persistidas no Postgres (LiveMessage) — o bus
// é só o "tempo real"; o histórico é a fonte da verdade.
// =====================================================================

const chatClients = new Map(); // chatId  → Set<res>
const storeClients = new Map(); // storeId → Set<res>

// Abre o stream SSE numa resposta Express. Headers críticos pra não
// bufferizar atrás de proxy (Railway / Cloudflare / nginx).
function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: desliga buffering
  });
  res.write('retry: 3000\n\n'); // navegador reconecta em 3s se cair
  res.write(': connected\n\n');
  // Heartbeat: comentário SSE a cada 25s mantém a conexão viva
  // (proxies cortam conexões ociosas por volta de 60s).
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* já fechou */ }
  }, 25000);
  res.on('close', () => clearInterval(ping));
  if (req && typeof req.on === 'function') {
    req.on('close', () => clearInterval(ping));
  }
}

function send(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function addTo(map, key, res) {
  if (!key) return () => {};
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(res);
  // cleanup
  return () => {
    const s = map.get(key);
    if (s) {
      s.delete(res);
      if (s.size === 0) map.delete(key);
    }
  };
}

// ---- Conversa específica (visitante <-> vendedor) ----
function addChatClient(chatId, req, res) {
  openSse(req, res);
  const cleanup = addTo(chatClients, chatId, res);
  res.on('close', cleanup);
  return cleanup;
}

function emitToChat(chatId, payload) {
  const set = chatClients.get(chatId);
  if (!set) return 0;
  let n = 0;
  for (const res of set) { if (send(res, payload)) n++; }
  return n;
}

// ---- Loja inteira (painel do vendedor) ----
function addStoreClient(storeId, req, res) {
  openSse(req, res);
  const cleanup = addTo(storeClients, storeId, res);
  res.on('close', cleanup);
  return cleanup;
}

function emitToStore(storeId, payload) {
  const set = storeClients.get(storeId);
  if (!set) return 0;
  let n = 0;
  for (const res of set) { if (send(res, payload)) n++; }
  return n;
}

// Quantos vendedores estão com o painel aberto pra esta loja agora.
// Usado pra decidir se manda push/WhatsApp (se ninguém está olhando o
// painel, escala a notificação pro celular).
function storeHasListeners(storeId) {
  const set = storeClients.get(storeId);
  return !!(set && set.size > 0);
}

module.exports = {
  addChatClient,
  emitToChat,
  addStoreClient,
  emitToStore,
  storeHasListeners,
};
