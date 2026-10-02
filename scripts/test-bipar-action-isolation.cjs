'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/bipar.html'), 'utf8');
function section(start, end) { const a = html.indexOf(start); assert.ok(a >= 0, start); const b = html.indexOf(end, a); assert.ok(b > a, end); return html.slice(a, b); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(code, overrides = {}) {
  const mode = { inventory: true, version: 1 };
  const writes = [], nodes = new Map();
  function node(id) { if (!nodes.has(id)) nodes.set(id, { value: id === 'loja' ? 'store-a' : '', innerHTML: 'original', textContent: 'original', style: {}, className: '' }); return nodes.get(id); }
  const context = vm.createContext({
    console, Promise, Map, Set, JSON, AbortController, FormData,
    window: { BiparActions: { isInventory: () => mode.inventory, version: () => mode.version, refresh() {}, storesReady() {} }, ScannerRound: { refresh: async () => {} }, ScannerTransfer: { activity() {} } },
    document: { getElementById: node }, localStorage: { getItem: () => null },
    stores: [], sellers: [], atualizarStatus() {}, etiqSave() {}, renderEtiqLista() {},
    fetch: async path => { writes.push(path); return { json: async () => ({ stores: [], sellers: [] }) }; },
    ...overrides,
  });
  vm.runInContext(code, context);
  return { context, mode, writes, node };
}
(async () => {
  const storesCode = section('  async function carregarLojas()', '  async function carregarVendedores');
  const response = deferred();
  const a = setup(storesCode, { fetch: async () => ({ json: () => response.promise }) });
  const first = vm.runInContext('carregarLojas()', a.context);
  await Promise.resolve(); a.mode.inventory = false; a.mode.version++;
  response.resolve({ stores: [{ id: 'old', name: 'Loja antiga' }] }); await first;
  assert.equal(a.node('loja').innerHTML, 'original', 'late store list must not replace action destination');

  const sellersCode = section('  async function carregarVendedores', '  function atualizarStatus');
  const round = deferred(); const b = setup(sellersCode);
  b.context.window.ScannerRound.refresh = () => round.promise;
  const sellers = vm.runInContext("carregarVendedores('store-a')", b.context);
  b.mode.inventory = false; b.mode.version++; round.resolve(); await sellers;
  assert.equal(b.writes.length, 0, 'no sellers request may start after switching action while awaiting round');

  const sellerResponse = deferred(); const c = setup(sellersCode, { fetch: async () => ({ json: () => sellerResponse.promise }) });
  const lateSeller = vm.runInContext("carregarVendedores('store-a')", c.context);
  await Promise.resolve(); await Promise.resolve(); c.mode.inventory = false; c.mode.version++;
  sellerResponse.resolve({ sellers: [{ id: 'old', name: 'Vendedor antigo' }] }); await lateSeller;
  assert.equal(c.node('vendedor').innerHTML, 'original', 'late seller result must not overwrite another action');

  const queueCode = section('  async function enviarFila()', '  async function consultarStatus');
  const photo = deferred(), calls = [];
  const item = { st: 'fila', b64: 'data:image/jpeg;base64,AA==', roundId: 'round-a', storeId: 'store-a', sellerId: 'seller-a', sellerName: 'Operador', clientScanId: 'scan-a', ean: '7891234567890', ocrDone: true };
  const d = setup(queueCode, { etiqBusy: false, etiqFila: [item], fetch: async path => { calls.push(path); return { blob: () => photo.promise }; } });
  const sending = vm.runInContext('enviarFila()', d.context);
  await Promise.resolve(); d.mode.inventory = false; d.mode.version++;
  photo.resolve(new Blob(['photo'])); await sending;
  assert.deepEqual(calls, [item.b64], 'switch during photo decode must prevent inventory POST');
  assert.equal(item.st, 'fila', 'original photograph stays queued for inventory');
  assert.equal(d.context.etiqBusy, false, 'busy must release after guarded return');

  const renderCode = section('  function renderEtiqLista()', '  function comprimirFoto');
  const e = setup(renderCode, { document: { getElementById: () => { throw Error('legacy camera must not access new camera elements'); } } });
  e.mode.inventory = false; vm.runInContext('renderEtiqLista()', e.context);
  const statusCode = section('  async function consultarStatus()', '  function renderEtiqLista');
  const f = setup(statusCode); f.mode.inventory = false; await vm.runInContext('consultarStatus()', f.context);
  assert.equal(f.writes.length, 0, 'action mode must not poll inventory captures');
  console.log('PASS: late store/seller responses, switch during round/blob awaits, preserved inventory queue, legacy camera rendering/poll isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
