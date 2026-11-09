'use strict';
// Actual capture/save/durability/upload functions; all persistence and HTTP are
// isolated. The held transactions reproduce camera-open/save/capture races.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../public/bipar.html'), 'utf8');
const source = html.slice(html.indexOf('  function etiqIdentity('), html.indexOf('  const etiqRestorePromise =')) +
  html.slice(html.indexOf('  function etiqPhotoDurable('), html.indexOf('  let etiqStatusOffset ='));
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const rows = new Map(), nodes = new Map(), uploads = [], timers = new Map();
  let timerId = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: id === 'loja' ? 'store-a' : id === 'vendedor' ? 'seller-a' : '',
      style: {}, textContent: '', setAttribute() {}, insertBefore() {}, videoWidth: 800, videoHeight: 1200 });
    return nodes.get(id);
  };
  const ctx = {
    window: { BiparActions: { isInventory: () => true, version: () => 1 },
      ScannerRound: { requireRound: () => 'round-a', id: () => 'round-a' },
      ScannerTransfer: { start() {}, update() {}, activity() {} } },
    document: { getElementById: node, createElement: () => ({ getContext: () => ({ drawImage() {} }),
      toDataURL: () => 'data:image/jpeg;base64,' + Buffer.from(ctx.frame).toString('base64') }) },
    localStorage: { getItem: () => 'Operador A' }, STORAGE_VENDNAME: 'operator', genClientScanId: randomUUID,
    etiqFila: [], etiqPendingFrames: [], etiqAutoFrames: new Map(), etiqStorageReady: true,
    etiqStorageFailed: false, etiqRestorePromise: Promise.resolve(), etiqPausado: false, etiqLeituraArmada: true,
    etiqAtivo: null, etiqCameraContext: null, etiqRetryAt: 0, etiqIgnoredCode: '', etiqIgnoreUntil: 0,
    etiqWatch: null, etiqUltimo: '', etiqUltimoTs: 0, etiqBusy: false, etiqAuto: { stop() {}, reset() {} },
    etiqBeep() {}, etiqStorageNotice() {}, renderEtiqLista() {}, renderLista() {}, alert() {}, console,
    frame: 'original-frame', beforeRead: null, beforeAppend: null, beforeBlob: null,
    etiqPhotoStorage: {
      async migrateLegacy() {},
      async read(options = {}) {
        const snapshot = [...rows.values()].map(row => { const value = copy(row); if (options.includeImages === false) delete value.b64; return value; });
        await ctx.beforeRead?.(); return snapshot;
      },
      async readPhoto(ref) { const row = [...rows.values()].find(value => value.photoRef === ref); assert.ok(row); return row.b64; },
      async append(id, fields) {
        await ctx.beforeAppend?.();
        const next = { ...rows.get(id), ...copy(fields) };
        if (fields.b64) next.photoRef = 'photo:' + fields.photoRevision + ':' + createHash('sha256').update(fields.b64).digest('hex');
        rows.set(id, next); return copy(next);
      },
    },
    fetch: async image => ({ blob: async () => { await ctx.beforeBlob?.(); return new Blob([Buffer.from(image.split(',')[1], 'base64')], { type: 'image/jpeg' }); } }),
    stocktakeFetch: async (url, options) => {
      assert.equal(url, '/api/stocktake/etiqueta');
      const pending = deferred(); uploads.push({ form: options.body, pending }); return pending.promise;
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    Blob, FormData, AbortController, Map, Promise, JSON, Date, Number, String, Object,
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  // OCR is independent of these commit-order scenarios.
  ctx.etiqStartOcr = () => {};
  const capture = () => ctx.window.capturaAutomatica({ ean: '0196989405971', frame: { width: 800, height: 1200 } });
  const acknowledge = upload => upload.pending.resolve({ ok: true, status: 200, json: async () => ({
    capId: 'cap-' + upload.form.get('clientScanId'), bipeId: 'bipe-' + upload.form.get('clientScanId'),
    photoSaved: true, photoRevision: Number(upload.form.get('photoRevision')),
  }) });
  return { ctx, rows, uploads, timers, node, capture, acknowledge };
}
(async () => {
  const race = harness(), oldRead = deferred(), commit = deferred();
  race.ctx.beforeRead = () => { race.ctx.beforeRead = null; return oldRead.promise; };
  const openingUpload = race.ctx.enviarFila(); await settle();
  race.ctx.beforeAppend = () => commit.promise;
  race.capture(); await settle();
  const piece = race.ctx.etiqFila[0]; assert.ok(piece);
  oldRead.resolve(); await openingUpload; await settle();
  assert.equal(race.rows.size, 0); assert.equal(race.ctx.etiqPhotoDurable(piece), false);
  assert.equal(race.node('etiq-confirm-btn').disabled, true);
  assert.equal(race.uploads.length, 0, 'An older completed queue save cannot authorize a new uncommitted original');
  assert.equal(race.timers.size, 0, 'Uncommitted originals do not schedule a tight upload retry');
  race.ctx.beforeAppend = null; commit.resolve(); await settle();
  assert.equal(race.rows.size, 1); assert.equal(race.ctx.etiqPhotoDurable(piece), true);
  assert.equal(race.node('etiq-confirm-btn').disabled, false); assert.equal(race.uploads.length, 1);
  assert.equal(race.uploads[0].form.get('clientScanId'), piece.clientScanId);
  assert.equal(await race.uploads[0].form.get('file').text(), 'original-frame');
  race.acknowledge(race.uploads[0]); await settle();

  // An already durable piece remains eligible while a different original waits
  // in the newer capture's transaction behind an older completed save.
  piece.st = 'fila'; await race.ctx.etiqSave(); race.ctx.window.proximaEtiqueta();
  const staleRead = deferred(), secondCommit = deferred();
  race.ctx.beforeRead = () => { race.ctx.beforeRead = null; return staleRead.promise; };
  const existingUpload = race.ctx.enviarFila(); await settle();
  race.ctx.frame = 'second-original'; race.ctx.beforeAppend = () => secondCommit.promise;
  race.capture(); await settle(); const second = race.ctx.etiqFila[1];
  staleRead.resolve(); await settle();
  assert.equal(race.uploads.length, 2); assert.equal(race.uploads[1].form.get('clientScanId'), piece.clientScanId);
  assert.equal(race.ctx.etiqPhotoDurable(second), false);
  race.acknowledge(race.uploads[1]); await existingUpload; await settle();
  assert.equal(race.uploads.length, 2, 'The newer pending transaction is still not uploadable');
  race.ctx.beforeAppend = null; secondCommit.resolve(); await settle();
  assert.equal(race.uploads.length, 3); assert.equal(race.uploads[2].form.get('clientScanId'), second.clientScanId);
  race.acknowledge(race.uploads[2]); await settle();
  assert.equal(race.ctx.etiqFila.length, 2); assert.equal(race.rows.size, 2);

  // Durability must be checked again after both asynchronous image boundaries,
  // even if the numeric revision itself has not changed.
  for (const stage of ['readPhoto', 'blob']) {
    const h = harness(); h.ctx.etiqBusy = true; h.capture(); await settle(); h.ctx.etiqBusy = false;
    const item = h.ctx.etiqFila[0], identity = h.ctx.etiqIdentity(item), originalRead = h.ctx.etiqReadPhoto;
    if (stage === 'readPhoto') h.ctx.etiqReadPhoto = async current => { const image = await originalRead(current); h.ctx.etiqSave.baseline.delete(identity); return image; };
    else h.ctx.beforeBlob = () => { h.ctx.etiqSave.baseline.delete(identity); };
    await h.ctx.enviarFila(); await settle();
    assert.equal(h.uploads.length, 0, stage + ' completion cannot bypass the exact local commit requirement');
    assert.equal(h.ctx.etiqFila.length, 1); assert.equal(item.photoRevision, 1); assert.equal(h.rows.size, 1);
    h.ctx.etiqReadPhoto = originalRead; h.ctx.beforeBlob = null; await h.ctx.etiqSave();
    h.ctx.enviarFila.attempts.get(identity).retryAt = 0; // Simulate the retry deadline passing.
    const retry = h.ctx.enviarFila(); await settle(); assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].form.get('clientScanId'), item.clientScanId);
    h.acknowledge(h.uploads[0]); await retry; await settle();
    assert.equal(h.ctx.etiqFila.length, 1); assert.equal(h.rows.size, 1);
  }
  console.log('PASS: camera-open save racing a held new capture never uploads before its local commit; another durable piece can send; readPhoto/blob awaits recheck exact durability; retry keeps original ID, photo and count.');
})().catch(error => { console.error(error); process.exitCode = 1; });
