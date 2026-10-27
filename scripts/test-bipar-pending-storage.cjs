'use strict';
// Exercise the real inventory queue code with isolated storage/network mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/bipar.html'), 'utf8');
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { fail: false, get length() { return data.size; }, key: index => [...data.keys()][index] || null, removeItem: key => data.delete(key), getItem: key => data.get(key) || null, setItem(key, value) { if (this.fail) throw Error('QuotaExceededError'); data.set(key, String(value)); } };
}
function retryHarness(localStorage = storage()) {
  const badge = { style: {}, textContent: '' }, requests = [];
  let reply;
  const wait = new Promise(resolve => { reply = resolve; });
  const context = vm.createContext({ localStorage, Date, Math, window: { BiparActions: { isInventory: () => true } },
    document: { getElementById: () => badge }, bipes: [], renderLista() {}, renderStats() {},
    fetch: (_url, options) => { requests.push(JSON.parse(options.body)); return wait; } });
  const source = html.slice(html.indexOf("  const RETRY_KEY = 'tc_bipe_retry_queue';"), html.indexOf('  // Auto-retry a cada 10s'));
  vm.runInContext(source + '\nglobalThis.api={enqueueRetry,processRetryQueue,loadRetryQueue};', context);
  return { api: context.api, localStorage, requests, reply: (status = 200) => reply({ status, ok: status < 400, json: async () => ({ bipeId: 'saved-A' }) }) };
}
const item = id => ({ barcode: '7900373256192', clientScanId: id, storeId: 'store-one', roundId: 'round-one' });
function photoHarness(rows, initial = '[]') {
  const localStorage = storage({ etiqFila: initial }), nodes = new Map();
  let stopped = 0, reset = 0, videoLookups = 0;
  const document = { getElementById(id) { if (id === 'etiq-video') videoLookups++; return nodes.get(id) || null; },
    createElement() { return { style: {}, append(...children) { this.children = children; } }; },
    body: { appendChild(node) { nodes.set(node.id, node); } } };
  const context = vm.createContext({ localStorage, document, window: { addEventListener() {} }, setTimeout, clearTimeout, etiqFila: rows, etiqPendingFrames: [], renderEtiqCaptureState() {}, renderEtiqLista() {}, etiqStorageReady: false, etiqStorageFailed: false, etiqPausado: false,
    etiqAuto: { stop() { stopped++; }, reset() { reset++; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/scanner-photo-storage.js'), 'utf8') + '\nglobalThis.etiqPhotoStorage=window.ScannerPhotoStorage.create({localStorage,indexedDB:null});', context);
  const start = html.indexOf('  function etiqStorageNotice()'), end = html.indexOf('  function etiqBeep()', start);
  const captureStart = html.indexOf('  function capturarFrame('), captureEnd = html.indexOf('  async function enviarFila()', captureStart);
  vm.runInContext(html.slice(start, end) + html.slice(captureStart, captureEnd) + '\nglobalThis.api={etiqSave,capturarFrame,read:()=>etiqPhotoStorage.read(),ready:etiqRestorePromise};', context);
  return { api: context.api, context, localStorage, nodes, counters: () => ({ stopped, reset, videoLookups }) };
}
async function test(name, work) { await work(); console.log('PASS: ' + name); }
(async () => {
  await test('new physical scan with the same barcode survives another scan acknowledgement', async () => {
    const h = retryHarness(); h.api.enqueueRetry(item('A')); const sending = h.api.processRetryQueue();
    h.api.enqueueRetry(item('B')); h.reply(); await sending;
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.loadRetryQueue())).map(row => row.clientScanId), ['B']);
    assert.deepEqual(h.requests.map(row => row.clientScanId), ['A']);
  });
  await test('network failure preserves both the old pending scan and concurrent additions', async () => {
    const h = retryHarness(); h.api.enqueueRetry(item('A')); const sending = h.api.processRetryQueue();
    h.api.enqueueRetry(item('B')); h.reply(503); await sending;
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.loadRetryQueue())).map(row => row.clientScanId), ['A', 'B']);
  });
  await test('blocked old scan preserves its review reason without erasing new pieces', async () => {
    const h = retryHarness(); h.api.enqueueRetry(item('A')); const sending = h.api.processRetryQueue();
    h.api.enqueueRetry(item('B')); h.reply(409); await sending;
    const rows = h.api.loadRetryQueue(); assert.equal(rows.length, 2); assert.ok(rows[0].blocked); assert.equal(rows[1].clientScanId, 'B');
  });
  await test('legacy scan without an ID settles without being recreated while new scans remain', async () => {
    const h = retryHarness(); const old = item('A'); delete old.clientScanId;
    h.localStorage.setItem('tc_bipe_retry_queue', JSON.stringify([old])); const sending = h.api.processRetryQueue();
    h.api.enqueueRetry(item('B')); h.reply(); await sending;
    assert.equal(h.api.loadRetryQueue().length, 1); assert.equal(h.api.loadRetryQueue()[0].clientScanId, 'B'); assert.ok(h.requests[0].clientScanId);
  });
  await test('quota failure on a legacy identity does not post or duplicate the old piece on retry', async () => {
    const h = retryHarness(), old = item('A'); delete old.clientScanId;
    h.localStorage.setItem('tc_bipe_retry_queue', JSON.stringify([old])); h.localStorage.fail = true;
    await h.api.processRetryQueue(); assert.equal(h.requests.length, 0); assert.equal(h.api.loadRetryQueue().length, 1);
    h.localStorage.fail = false; const sending = h.api.processRetryQueue();
    assert.ok(JSON.parse(h.localStorage.getItem('tc_bipe_retry_queue'))[0].clientScanId);
    h.reply(); await sending; assert.equal(h.requests.length, 1); assert.equal(h.api.loadRetryQueue().length, 0);
  });
  await test('two identical legacy rows remain two physical pieces with distinct durable IDs', async () => {
    const h = retryHarness(), old = item('A'); delete old.clientScanId;
    h.localStorage.setItem('tc_bipe_retry_queue', JSON.stringify([old, old]));
    assert.equal(h.api.loadRetryQueue().length, 2); const sending = h.api.processRetryQueue();
    const saved = JSON.parse(h.localStorage.getItem('tc_bipe_retry_queue')); assert.equal(new Set(saved.map(row => row.clientScanId)).size, 2);
    h.reply(); await sending; assert.equal(h.requests.length, 2);
  });
  await test('manual enqueue quota keeps the unsaved piece in memory and reports failure until persistence returns', async () => {
    const h = retryHarness(); h.localStorage.fail = true;
    assert.equal(h.api.enqueueRetry(item('A')), null); assert.equal(h.api.loadRetryQueue().length, 1); assert.equal(h.requests.length, 0);
    h.localStorage.fail = false; const sending = h.api.processRetryQueue();
    assert.equal(JSON.parse(h.localStorage.getItem('tc_bipe_retry_queue'))[0].clientScanId, 'A');
    h.reply(); await sending; assert.equal(h.requests.length, 1); assert.equal(h.api.loadRetryQueue().length, 0);
    assert.match(html, /if \(!enqueueRetry\(payload\)\) return;/);
  });
  await test('a concurrent barcode checkpoint survives aggregate overwrite and reload', () => {
    const local = storage(), a = retryHarness(local), b = retryHarness(local), originalSet = local.setItem.bind(local);
    let interleaved = false;
    local.setItem = (key, value) => {
      if (key === 'tc_bipe_retry_queue' && !interleaved) { interleaved = true; b.api.enqueueRetry(item('B')); }
      originalSet(key, value);
    };
    a.api.enqueueRetry(item('A'));
    assert.deepEqual(Array.from(retryHarness(local).api.loadRetryQueue(), row => row.clientScanId).sort(), ['A', 'B']);
  });
  await test('a late failing tab cannot resurrect a scan already acknowledged by another tab', async () => {
    const local = storage(), a = retryHarness(local), b = retryHarness(local);
    a.api.enqueueRetry(item('A')); const first = a.api.processRetryQueue(), stale = b.api.processRetryQueue();
    a.reply(); await first; b.reply(503); await stale;
    assert.equal(retryHarness(local).api.loadRetryQueue().length, 0);
  });
  await test('all unresolved photos survive persistence beyond the 30 completed-history limit', async () => {
    const pending = Array.from({ length: 31 }, (_, i) => ({ clientScanId: 'pending-' + i, st: i % 2 ? 'fila' : 'revisao', b64: 'data:image/jpeg;base64,synthetic-' + i }));
    const complete = Array.from({ length: 35 }, (_, i) => ({ clientScanId: 'done-' + i, complete: true, capId: 'capture-' + i, b64: '' }));
    const h = photoHarness([...pending, ...complete]); assert.equal(await h.api.etiqSave(), true);
    const saved = JSON.parse(JSON.stringify(await h.api.read()));
    assert.equal(saved.length, 66); assert.deepEqual(saved.filter(row => !row.complete), pending); assert.equal(saved[31].clientScanId, 'done-0');
  });
  await test('storage quota preserves the previous copy and blocks capture before creating a new piece', async () => {
    const initial = JSON.stringify([{ clientScanId: 'old', b64: 'older-photo' }]);
    const rows = [{ clientScanId: 'old', b64: 'older-photo' }, { clientScanId: 'new', b64: 'new-photo' }];
    const h = photoHarness(rows, initial); h.localStorage.fail = true;
    assert.equal(await h.api.etiqSave(), false); assert.equal(h.localStorage.getItem('etiqFila'), initial);
    assert.equal(h.api.capturarFrame('7900373256192'), null); assert.equal(rows.length, 2); assert.equal(h.counters().videoLookups, 0);
    assert.equal(h.context.etiqStorageFailed, true); assert.equal(h.counters().stopped, 1); assert.equal(h.nodes.get('etiq-storage-warning').hidden, false);
  });
  await test('successful persistence resumes the paused scanner with every pending photo intact', async () => {
    const rows = [{ clientScanId: 'one', b64: 'first-photo' }, { clientScanId: 'two', b64: 'second-photo' }];
    const h = photoHarness(rows); h.localStorage.fail = true; await h.api.etiqSave();
    h.localStorage.fail = false; assert.equal(await h.api.etiqSave(), true);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.api.read())), rows); assert.equal(h.context.etiqStorageFailed, false);
    assert.equal(h.counters().reset, 1); assert.equal(h.nodes.get('etiq-storage-warning').hidden, true);
    assert.match(html, /canRead: \(\) => etiqStorageReady && !etiqStorageFailed && etiqLeituraArmada && !etiqPausado && cameraCurrent/);
  });
  await test('a stale tab keeps another tab new photo and cannot restore its completed copy as pending', async () => {
    const old = { clientScanId: 'A', roundId: 'round-one', b64: 'photo-A', st: 'fila' };
    const newcomer = { clientScanId: 'B', roundId: 'round-one', b64: 'photo-B', st: 'fila' };
    const h = photoHarness([{ ...old }], JSON.stringify([{ ...old, complete: true, capId: 'saved-A', b64: '' }, newcomer]));
    assert.equal(await h.api.etiqSave(), true); const saved = JSON.parse(JSON.stringify(await h.api.read()));
    assert.equal(saved.length, 2); assert.equal(saved[0].complete, true); assert.equal(saved[0].capId, 'saved-A'); assert.deepEqual(saved[1], newcomer);
    assert.equal(h.context.etiqFila.length, 2);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
