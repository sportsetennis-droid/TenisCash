'use strict';
// Real inventory capture functions with isolated frame/storage stubs; no camera or server.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), { randomUUID } = require('node:crypto');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/bipar.html'), 'utf8');
const captureCode = html.slice(html.indexOf('  window.capturaAutomatica ='), html.indexOf('  function etiqStartOcr('));
const durableCode = html.slice(html.indexOf('  function etiqPhotoDurable('), html.indexOf('  function renderEtiqCaptureState('));
const nodes = new Map(['loja', 'vendedor', 'etiq-video', 'etiq-hint', 'etiq-confirm'].map(id => [id, { value: id + '-original', videoWidth: 400, videoHeight: 800, style: {} }]));
const saved = [], uploads = []; let fail = false, holdSave = false, releaseSave;
const state = { window: { BiparActions: { isInventory: () => true }, ScannerRound: { requireRound: () => 'round-original' }, ScannerTransfer: { start() {} } },
  document: { getElementById: id => nodes.get(id), createElement: () => { let source; return { width: 0, height: 0, getContext: () => ({ drawImage: frame => { source = frame; } }), toDataURL: () => 'data:image/jpeg;base64,' + Buffer.from(source.marker || 'LIVE-VIDEO').toString('base64') }; } },
  localStorage: { getItem: () => 'Original operator' }, STORAGE_VENDNAME: 'operator', genClientScanId: randomUUID,
  etiqCameraContext: null, etiqLeituraArmada: true, etiqPausado: false, etiqIgnoredCode: '', etiqIgnoreUntil: 0,
  etiqFila: [], etiqAtivo: null, etiqRetryAt: 0, etiqStorageReady: true, etiqStorageFailed: false,
  etiqAutoFrames: new Map(), etiqAuto: { stop() {}, reset(value) {state.lastReset=value;} }, etiqWatch: null,
  renderEtiqCaptureState() {}, renderEtiqLista() {}, etiqBeep() {}, clearInterval() {}, setInterval() {}, alert() {},
  etiqSave: async item => {
    if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
    if (fail) { state.etiqStorageFailed = true; return false; }
    if (!item) return true;
    saved.push(structuredClone(item));
    const record = { ...item, photoRef: 'committed-photo-' + saved.length }; delete record.b64;
    state.etiqSave.baseline.set('id:' + item.roundId + ':' + item.clientScanId, record);
    item.photoRef = record.photoRef;
    return true;
  },
  etiqIdentity: item => 'id:' + item.roundId + ':' + item.clientScanId,
  enviarFila: async () => { if (!state.etiqStorageFailed) uploads.push(...saved.slice(uploads.length)); }, etiqStorageNotice() {},
};
state.etiqSave.baseline = new Map();
vm.createContext(state); vm.runInContext(durableCode + captureCode, state);
const settle = () => new Promise(setImmediate);
(async () => {
  const frame = { width: 800, height: 1200, marker: 'EXACT-DECODED-LABEL' };
  holdSave = true;
  state.window.capturaAutomatica({ ean: '4006381333931', frame }); await settle();
  state.window.proximaEtiqueta(); assert.equal(state.etiqAtivo, state.etiqFila[0].lid, 'Local photo commit is required');
  holdSave = false; releaseSave(); await settle();
  assert.equal(saved.length, 1); assert.equal(uploads.length, 1); const item = state.etiqFila[0], id = item.clientScanId;
  assert.equal(item.b64, 'data:image/jpeg;base64,' + Buffer.from(frame.marker).toString('base64'));
  assert.equal(item.autoRecognition, false); assert.equal(item.autoPhoto, true); assert.equal(item.manualPhoto, false);
  assert.equal(item.storeId, 'loja-original'); assert.equal(item.roundId, 'round-original');
  assert.equal(item.capId, undefined); assert.equal(item.bipeId, undefined);
  state.window.proximaEtiqueta(); assert.equal(state.etiqAtivo, null, 'Next never waits for upload or identification');
  state.window.ScannerRound.id=()=>item.roundId;state.window.relerEtiqueta(item.lid);
  // Retake after a transient identification error, keeping this physical piece.
  item.st = 'pendente'; state.etiqPausado = false; state.etiqLeituraArmada = true;
  state.window.capturaAutomatica({ ean: item.ean, frame: { ...frame, marker: 'SECOND-FRAME' } }); await settle();
  assert.equal(state.etiqFila.length, 1); assert.equal(item.clientScanId, id); assert.equal(item.photoRevision, 2);
  assert.notEqual(saved[0].b64, saved[1].b64); assert.equal(saved[0].clientScanId, saved[1].clientScanId);
  item.capId = 'server-photo'; item.capIdPhotoRevision = 2; item.complete = true; item.st = 'vinculado';
  state.window.proximaEtiqueta(); assert.equal(state.etiqAtivo, null);
  assert.equal(state.lastReset,undefined,'Explicit Next accepts another identical code, without an afterCode suppression');
  state.window.capturaAutomatica({ ean: '5901234123457' }); assert.equal(state.etiqFila.length, 1, 'No image means no new photographic scan');
  fail = true; state.window.capturaAutomatica({ ean: '5901234123457', frame }); await settle();
  assert.equal(state.etiqStorageFailed, true); assert.equal(uploads.length, 2); assert.equal(state.etiqFila.length, 2);
  const pending = state.etiqFila[1]; assert.ok(pending.b64); assert.notEqual(pending.clientScanId, id);
  state.window.proximaEtiqueta(); assert.equal(state.etiqAtivo, pending.lid);
  fail=false;state.etiqStorageFailed=false;pending.manualPhoto=true;pending.capId='saved-second';pending.capIdPhotoRevision=pending.photoRevision;pending.st='pendente';
  state.window.proximaEtiqueta();assert.equal(state.etiqAtivo,pending.lid,'Server acknowledgement never replaces an uncommitted local photo');
  await state.etiqSave(pending);
  state.window.proximaEtiqueta();assert.equal(state.etiqAtivo,null,'Archived manual photo with known code advances to a NEW piece');
  state.window.capturaAutomatica({ean:pending.ean,frame});await settle();assert.equal(state.etiqFila.length,3);assert.notEqual(state.etiqFila[2].clientScanId,pending.clientScanId);
  state.window.ScannerRound.id=()=>pending.roundId;state.window.relerEtiqueta(pending.lid);assert.equal(state.etiqAtivo,pending.lid);state.window.capturaAutomatica({ean:pending.ean,frame});await settle();assert.equal(state.etiqFila.length,3);assert.equal(state.etiqFila[1].clientScanId,pending.clientScanId);
  console.log('PASS: local photo/code commit enables Next before server acknowledgement; exact frame, recapture identity, repeated physical codes and failed-storage protection preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
