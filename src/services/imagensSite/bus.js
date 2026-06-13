// =====================================================================
// IMAGENS DE SITE — barramento SSE simples (canal único, 1 instância).
// Espelha o liveBus.js, isolado pra não interferir no chat/loja.
// Guarda os últimos eventos pra quem abrir o dashboard ver o histórico
// da rodada em andamento.
// =====================================================================
const clients = new Set();
let _last = [];

function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
  // manda o histórico recente da rodada atual
  for (const e of _last) { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch (_) { /* fechou */ } }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  const close = () => { clearInterval(ping); clients.delete(res); };
  res.on('close', close);
  if (req && typeof req.on === 'function') req.on('close', close);
  clients.add(res);
}

function emit(event) {
  const e = { t: Date.now(), ...event };
  _last.push(e);
  if (_last.length > 600) _last = _last.slice(-600);
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch (_) {} }
  return e;
}

function snapshot() { return _last.slice(); }
function reset() { _last = []; }

module.exports = { openSse, emit, snapshot, reset, clients };
