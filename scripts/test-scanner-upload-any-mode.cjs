'use strict';
// Dono 14/11/2026: bipe de contagem guardado no aparelho tem que subir mesmo com a tela em outro modo
// (recebimento/transferência). Antes, trocar de modo parava a fila em silêncio (235 bipes presos na Loja 03).
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../public/bipar.html'), 'utf8');
const actions = fs.readFileSync(path.join(__dirname, '../public/bipar-actions.js'), 'utf8');
function section(start, end) { const a = html.indexOf(start); assert.ok(a >= 0, start); const b = html.indexOf(end, a); assert.ok(b > a, end); return html.slice(a, b); }

(async () => {
  // 1) Fila de bipes (código sem foto) envia com a tela em RECEBIMENTO.
  const code = section('  let _retrying = false;', '  // Auto-retry a cada 10s');
  const posts = [];
  let queue = [{ barcode: '7909946336774', storeId: 'loja03', sellerId: 'u1', sellerName: 'Operador', clientScanId: 'csabc12345xyz', roundId: 'r26', operationType: 'replacement' }];
  const ctx = vm.createContext({
    console, JSON, Map, Set, Promise,
    window: { BiparActions: { isInventory: () => false, canUploadStocktake: () => true, headers: () => ({ Authorization: 'Bearer t' }) }, ScannerTransfer: { start() {}, activity() {}, update() {} } },
    loadRetryQueue: () => queue.slice(), saveRetryQueue: rows => { queue = rows; return true; }, retryKey: it => 'id:' + it.clientScanId,
    removeFromQueue: id => { queue = queue.filter(it => it.clientScanId !== id); }, updatePendingBadge() {}, renderLista() {}, renderStats() {},
    genClientScanId: () => 'csnew', bipes: [], queueSizeRequest() {},
    stocktakeFetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { status: 200, ok: true, json: async () => ({ bipeId: 'b1' }) }; },
  });
  vm.runInContext(code, ctx);
  await vm.runInContext('processRetryQueue()', ctx);
  assert.equal(posts.length, 1, 'bipe guardado precisa subir mesmo com a tela em recebimento');
  assert.equal(posts[0].body.roundId, 'r26', 'sobe com a rodada ORIGINAL da leitura');
  assert.equal(posts[0].body.storeId, 'loja03', 'sobe com a loja ORIGINAL da leitura');
  assert.equal(queue.length, 0, 'confirmado pelo servidor sai da fila do aparelho');

  // 2) A permissão de envio não depende do modo atual da tela.
  const start = actions.indexOf('  function canUploadStocktake(item) {');
  const body = actions.slice(start, actions.indexOf('\n  }', start));
  assert.ok(!/isInventory\(\)/.test(body), 'canUploadStocktake não pode recusar por causa do modo da tela');

  // 3) A fila de fotos e a retomada não têm mais trava de modo.
  const fila = section('  async function enviarFila() {', '  let etiqStatusOffset');
  assert.ok(!/isInventory\(\)\) return;/.test(fila), 'enviarFila não pode parar ao trocar de modo');
  const resume = section('  async function resumeInventoryOutbox() {', '  window.ScannerInventoryOutbox');
  assert.ok(!/isInventory/.test(resume), 'retomada da fila não pode depender do modo');
  assert.ok(html.includes('/scanner-recovery.js'), 'bipagem carrega o aviso de bipe preso');
  console.log('PASS: fila de contagem sobe em qualquer modo, com rodada/loja originais; aviso de bipe preso carregado.');
})().catch(e => { console.error(e); process.exit(1); });
