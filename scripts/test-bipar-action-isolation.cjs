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
    console, Promise, Map, Set, JSON, AbortController, FormData, setTimeout, clearTimeout,
    window: { BiparActions: { isInventory: () => mode.inventory, version: () => mode.version, refresh() {}, storesReady() {} }, ScannerRound: { refresh: async () => {} }, ScannerTransfer: { activity() {} } },
    document: { getElementById: node }, localStorage: { getItem: () => null },
    stores: [], sellers: [], etiqAtivo: null, etiqCameraEpoch: 0, atualizarStatus() {}, etiqRestorePromise: Promise.resolve(), etiqSave: async () => true, renderEtiqLista() {},
    fetch: async path => { writes.push(path); return { json: async () => ({ stores: [], sellers: [] }) }; },
    ...overrides,
  });
  context.window.fecharScanner = () => { context.etiqCameraEpoch++; };
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
  for (let turn = 0; !calls.length && turn < 10; turn++) await Promise.resolve();
  assert.equal(calls.length, 1, 'photo must reach blob decoding before changing mode');
  d.mode.inventory = false; d.mode.version++;
  photo.resolve(new Blob(['photo'])); await sending;
  assert.deepEqual(calls, [item.b64], 'switch during photo decode must prevent inventory POST');
  assert.equal(item.st, 'fila', 'original photograph stays queued for inventory');
  assert.equal(d.context.etiqBusy, false, 'busy must release after guarded return');

  const frozen = deferred(), payloads = [];
  const original = { ...item, lid: 'old-piece', photoRevision: 1, manualPhoto: true };
  const newer = { lid: 'new-piece', st: 'pendente', storeId: 'store-b', roundId: 'round-b', sellerId: 'seller-b', complete: false };
  const sameMode = setup(queueCode, { etiqBusy: false, etiqAtivo: original.lid, etiqFila: [original], etiqStartOcr() {}, renderLista() {},
    setTimeout: () => 0, clearTimeout() {}, fetch: async (url, options) => {
      if (url.startsWith('data:')) return { blob: () => frozen.promise };
      payloads.push(Object.fromEntries(['storeId','roundId','sellerId','clientScanId'].map(key => [key, options.body.get(key)])));
      return { ok: true, json: async () => ({ capId:'old-photo', photoSaved:true, photoRevision:1 }) };
    } });
  const oldUpload = vm.runInContext('enviarFila()', sameMode.context);
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  sameMode.node('loja').value = 'store-b'; sameMode.node('vendedor').value = 'seller-b'; sameMode.mode.version++;
  sameMode.context.etiqFila.push(newer); sameMode.context.etiqAtivo = newer.lid;
  sameMode.node('etiq-confirm-det').textContent = 'Nova peça';
  frozen.resolve(new Blob(['original photo'])); await oldUpload;
  assert.deepEqual(payloads, [{ storeId:'store-a', roundId:'round-a', sellerId:'seller-a', clientScanId:'scan-a' }]);
  assert.equal(original.capId, 'old-photo'); assert.equal(newer.complete, false);
  assert.equal(sameMode.node('etiq-confirm-det').textContent, 'Nova peça');

  for (const missing of ['storeId', 'roundId', 'sellerId']) {
    const legacy = { ...original, st:'fila', sellerName:'' }; delete legacy[missing];
    const legacyMode = setup(queueCode, { etiqBusy:false, etiqFila:[legacy], setTimeout:()=>0, clearTimeout(){} });
    await vm.runInContext('enviarFila()', legacyMode.context);
    assert.equal(legacy.st, 'revisao'); assert.equal(legacyMode.writes.length, 0, 'legacy context must never fall back to currently selected store/operator');
  }

  const timers = new Map(); let timerId = 0, pendingPosts = 0, replyStale = false;
  const retryItem = { ...item, photoRevision: 1 };
  const outbox = setup(queueCode, {
    etiqBusy: false, etiqFila: [retryItem], etiqStartOcr() {},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async url => {
      if (url.startsWith('data:')) return { blob: async () => new Blob(['photo']) };
      pendingPosts++; return { ok: true, status: 200, json: async () => replyStale ? ({ capId: 'saved-photo', photoRevision: 2, photoSaved: true, stale: true }) : ({ capId: 'saved-photo', photoRevision: 1, photoSaved: true, pending: true, error: 'Temporary registration failure' }) };
    },
  });
  await vm.runInContext('enviarFila()', outbox.context);
  assert.equal(retryItem.st, 'fila', 'saved photograph with pending barcode registration must stay in the outbox');
  assert.equal(retryItem.capId, 'saved-photo'); assert.deepEqual([...timers.values()].map(t => t.delay), [2000], 'pending registration waits before retry');
  await vm.runInContext('enviarFila()', outbox.context);
  assert.equal(pendingPosts, 2); assert.deepEqual([...timers.values()].map(t => t.delay), [4000], 'persistent failure increases the backoff rather than looping');
  replyStale = true; vm.runInContext('enviarFila.retryDelay=2000', outbox.context);
  await vm.runInContext('enviarFila()', outbox.context);
  assert.deepEqual([...timers.values()].map(t => t.delay), [2000], 'newer server revision is not progress and cannot create a 100ms retry loop');
  await vm.runInContext('enviarFila()', outbox.context);
  assert.deepEqual([...timers.values()].map(t => t.delay), [4000], 'stale server acknowledgements retain bounded backoff');
  assert.equal(retryItem.photoRevision, 1); assert.equal(retryItem.b64, item.b64); assert.equal(retryItem.st, 'fila', 'local original remains recoverable');
  const waiting = [...timers.values()][0]; outbox.mode.inventory = false; outbox.mode.version++; waiting.fn();
  await Promise.resolve(); assert.equal(pendingPosts, 4, 'changing action prevents scheduled inventory delivery');

  const cameraCode = section('  window.fotografarEtiqueta = async function', '  window.fecharScanner = function');
  const restoring = deferred();
  const g = setup(cameraCode, { etiqRestorePromise: restoring.promise, etiqStorageReady: true, etiqStorageFailed: false });
  let roundChecks = 0;
  g.context.window.ScannerRound.requireRound = () => { roundChecks++; };
  const opening = g.context.window.fotografarEtiqueta();
  g.mode.inventory = false; g.mode.version++;
  restoring.resolve(); await opening;
  assert.equal(roundChecks, 0, 'switch during durable-photo restoration must not open the legacy camera');

  const renderCode = section('  function renderEtiqLista()', '  function comprimirFoto');
  const e = setup(renderCode, { document: { getElementById: () => { throw Error('legacy camera must not access new camera elements'); } } });
  e.mode.inventory = false; vm.runInContext('renderEtiqLista()', e.context);
  const statusCode = section('  async function consultarStatus()', '  function renderEtiqLista');
  const f = setup(statusCode); f.mode.inventory = false; await vm.runInContext('consultarStatus()', f.context);
  assert.equal(f.writes.length, 0, 'action mode must not poll inventory captures');
  console.log('PASS: late store/seller responses, mode isolation, pending registration outbox, bounded retry backoff, and stopped delivery after action change');
})().catch(error => { console.error(error); process.exitCode = 1; });
