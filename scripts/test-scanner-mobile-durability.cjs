'use strict';
// Execute the production storage module with an isolated, transactional IDB
// protocol harness. No browser, account, network, camera or production data.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/scanner-photo-storage.js'), 'utf8');
const clone = value => structuredClone(value);
function local() { const rows = new Map(); return { rows, get length() { return rows.size; }, key: i => [...rows.keys()][i], getItem: k => rows.get(k) ?? null, setItem: (k,v) => rows.set(k,v), removeItem: k => rows.delete(k) }; }
function idb() {
  const store = { events: new Map(), photos: new Map() }, settings = { corruptPhoto: false, quota: false, strictUnsupported: false }, accesses = [];
  let chain = Promise.resolve();
  const db = { objectStoreNames: { contains: () => true }, close() {}, transaction(names, mode, options) {
    if (settings.strictUnsupported && options) throw Object.assign(Error('durability option'), { name: 'TypeError' });
    accesses.push({ mode, options });
    let start; const previous = chain, ready = new Promise(resolve => { start = resolve; }); chain = previous.then(() => ready);
    const tx = { pending: 0, finished: false, abort() { if (tx.finished) return; tx.finished = true; tx.onabort?.(); start(); }, objectStore(name) {
      return { getAll: () => run(() => [...store[name].values()].map(clone)), get: key => run(() => {
        const row = clone(store[name].get(key)); if (name === 'photos' && row && settings.corruptPhoto) row.b64 = 'corrupted'; return row;
      }), put: row => run(() => {
        if (settings.quota) throw Object.assign(Error('quota'), { name: 'QuotaExceededError' });
        changes.push({ name, row: clone(row) });
      }) };
    } };
    const changes = [];
    function run(fn) {
      const req = {}; tx.pending++;
      previous.then(() => setImmediate(() => {
        if (tx.finished) return;
        try { req.result = fn(); req.onsuccess?.(); }
        catch (error) { req.error = tx.error = error; req.onerror?.(); tx.finished = true; tx.onerror?.(); start(); }
        finally { tx.pending--; setImmediate(() => {
          if (!tx.pending && !tx.finished) {
            for (const change of changes) store[change.name].set(change.name === 'photos' ? change.row.ref : change.row.key, change.row);
            tx.finished = true; tx.oncomplete?.(); start();
          }
        }); }
      })); return req;
    }
    return tx;
  } };
  return { store, settings, accesses, open() { const req = {}; setImmediate(() => { req.result = db; req.onsuccess?.(); }); return req; } };
}
function harness(indexed = idb(), manager) {
  const root = { indexedDB: indexed, localStorage: local(), crypto: crypto.webcrypto, TextEncoder, navigator: { storage: manager } };
  vm.runInNewContext(source, { window: root, setTimeout, clearTimeout, Uint8Array, TextEncoder });
  return { root, indexed, api: root.ScannerPhotoStorage.create() };
}
const piece = (n, revision = 1) => ({ clientScanId: 'physical-' + n, roundId: 'round-a', storeId: 'store-a', sellerId: 'person-a', operationType: 'replacement', ean: '0196989405971', photoRevision: revision, b64: 'data:image/jpeg;base64,' + Buffer.from('original-' + n + '-' + revision).toString('base64'), st: 'fila' });
(async () => {
  const h = harness(); const first = piece(1), id = h.api.identity(first);
  h.indexed.settings.corruptPhoto = true;
  await assert.rejects(() => h.api.append(id, first), /releitura/);
  assert.equal(h.indexed.store.photos.size, 1, 'Readback failure preserves the original committed bytes');
  h.indexed.settings.corruptPhoto = false;
  const saved = await h.api.append(id, first);
  assert.equal(await h.api.readPhoto(saved.photoRef), first.b64);
  assert.equal((await h.api.read()).length, 1, 'Retry after ambiguous readback is still one physical event');
  assert.ok(h.indexed.accesses.some(a => a.options?.durability === 'strict'));
  h.indexed.settings.quota = true;
  await assert.rejects(() => h.api.append(h.api.identity(piece(2)), piece(2)), error => error.name === 'QuotaExceededError');
  h.indexed.settings.quota = false;
  assert.equal((await h.api.read()).length, 1, 'Failed atomic transaction did not create a second event');
  assert.match(h.api.explainError({ name: 'QuotaExceededError' }), /Não limpe/);
  h.indexed.settings.strictUnsupported = true;
  await h.api.append(id, piece(1, 2));
  assert.equal(h.indexed.store.photos.size, 2, 'Recapture preserves both originals');
  assert.equal(await h.api.readPhoto(saved.photoRef), first.b64);
  const reopened = h.root.ScannerPhotoStorage.create();
  const restored = await reopened.read({ includeImages: false });
  assert.equal(restored.length, 1); assert.equal(restored[0].photoRevision, 2);
  for (const key of ['clientScanId','roundId','storeId','sellerId','operationType','ean']) assert.equal(restored[0][key], first[key]);

  const start = performance.now();
  for (let n = 2; n <= 300; n++) await h.api.append(h.api.identity(piece(n)), piece(n));
  const rows = await h.root.ScannerPhotoStorage.create().read({ includeImages: false });
  assert.equal(rows.length, 300); assert.equal(new Set(rows.map(row => row.clientScanId)).size, 300);
  assert.ok(rows.every(row => row.ean === first.ean && !row.b64));
  assert.equal(h.indexed.store.photos.size, 301);
  console.log('PASS: atomic write + readback; corrupt read fails closed; quota rolls back; retry keeps ID; strict option fallback; 300 equal-EAN events and 301 original revisions restored (' + Math.round(performance.now()-start) + ' ms protocol harness, not phone performance).');

  let requests = 0;
  const health = harness(idb(), { persist: async () => { requests++; return false; }, persisted: async () => false, estimate: async () => ({ usage: 90, quota: 100 }) });
  const denied = await health.api.status({ requestPersistence: true }); await health.api.status({ requestPersistence: true });
  assert.equal(requests, 1); assert.equal(denied.persisted, false); assert.equal(denied.quota, 100);
  await health.api.append(health.api.identity(first), first);
  const unsupported = await harness().api.status(); assert.equal(unsupported.persisted, null); assert.equal(unsupported.persistenceSupported, false);
  const fallback = harness(null); await fallback.api.append(id, first);
  const nativeGet = fallback.root.localStorage.getItem;
  fallback.root.localStorage.getItem = key => key.startsWith('tc_bipe_photo_event_v2:') ? 'wrong-readback' : nativeGet(key);
  await assert.rejects(() => fallback.api.append('second', piece(2)), /releitura/);
  console.log('PASS: denied/unsupported persistence stays honest and does not invalidate successful writes; localStorage fallback also requires exact readback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
