'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { captureComplete } = require('../src/services/scannerCompletion');
const cap = { status: 'vinculado', barcode: '196974865902' };
const bipe = { found: true, barcode: cap.barcode, productId: 'p', productSizeId: 's' };
const size = { id: 's', productId: 'p', size: '40', product: { active: true } };
assert.equal(captureComplete(cap, bipe, size, false), true);
for (const c of [{ ...cap, status: 'processando' }, { ...cap, status: 'pendente' }, { ...cap, barcode: null }, { ...cap, barcode: 'REF:X' }, { ...cap, excludedAt: new Date() }]) assert.equal(captureComplete(c, bipe, size, false), false);
assert.equal(captureComplete(cap, bipe, size, true), false);
for (const s of [{ ...size, size: '?' }, { ...size, size: 'T-123' }, { ...size, product: { active: false } }, { ...size, productId: 'other' }]) assert.equal(captureComplete(cap, bipe, s, false), false);
assert.equal(captureComplete(cap, { ...bipe, barcode: 'other' }, size, false), false);
const html = fs.readFileSync('public/bipar.html', 'utf8');
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
assert(!html.includes('CÓDIGO JÁ CONTADO'), 'repeated barcodes no longer trigger a confirmation dialog');
const section = html.slice(html.indexOf('  let etiqPausado = true, etiqLeituraArmada = false'), html.indexOf('  async function enviarFila()'));
let timer, clock = 10000, beeps = 0, ids = 0, autoRequests = 0;
const elements = { loja: { value: 'store' }, vendedor: { value: 'seller' }, 'etiq-video': { videoWidth: 100, videoHeight: 200 } };
function element() { return { style: {}, disabled: true, setAttribute() {}, insertBefore(node) { elements[node.id] = node; }, play: () => Promise.resolve() }; }
const doc = { getElementById: id => elements[id] || (elements[id] = element()), createElement: () => ({ ...element(), getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,' + clock }) };
function save(frame) { if (frame) save.baseline.set('id:' + frame.clientScanId, JSON.parse(JSON.stringify(frame))); return Promise.resolve(true); }
save.baseline = new Map();
const ctx = {
  window: { ScannerRound: { requireRound: () => 'round' } }, document: doc, etiqFila: [], etiqCameraContext: null,
  etiqAutoFrames: new Map(), etiqStorageReady: true, etiqStorageFailed: false, etiqBusy: false,
  etiqAuto: { reset() {}, stop() {} }, etiqPausado: true, etiqLeituraArmada: false, etiqAtivo: null, etiqRetryAt: 0,
  etiqUltimo: '', etiqUltimoTs: 0,
  localStorage: { getItem: () => 'seller' }, STORAGE_VENDNAME: 's', genClientScanId: () => 'client' + (++ids),
  renderEtiqLista() {}, etiqSave: save, etiqIdentity: item => 'id:' + item.clientScanId,
  enviarFila() { autoRequests++; return new Promise(() => {}); }, etiqBeep() { beeps++; }, alert() {},
  Date: class extends Date { static now() { return clock; } }, setInterval: fn => (timer = fn, 1), clearInterval() {},
};
vm.createContext(ctx);
vm.runInContext(section, ctx);
(async () => {
  ctx.window.capturaManual();
  await Promise.resolve();
  assert.equal(ctx.etiqFila.length, 1);
  assert.equal(doc.getElementById('etiq-confirm-status').textContent, '✓ FOTO SALVA');
  timer();
  assert.equal(doc.getElementById('etiq-confirm-btn').disabled, true);
  ctx.window.proximaEtiqueta();
  assert.equal(ctx.etiqFila[0].complete, false, 'a saved photo is not a completed physical scan');
  // The automatic-flow checks below model a fresh camera session. The manual
  // photo remains active and must not be auto-advanced or discarded.
  vm.runInContext('etiqAtivo = null; etiqPausado = true; etiqLeituraArmada = false; etiqRetryAt = 0', ctx);
  doc.getElementById('etiq-confirm').style.display = 'none';
  autoRequests = 0;

  const panel = doc.getElementById('etiq-confirm');
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  assert.equal(ctx.etiqFila.length, 1, 'a code cannot be registered before the operator clicks Próximo');
  ctx.window.proximaEtiqueta();
  assert.equal(vm.runInContext('etiqLeituraArmada', ctx), true, 'Próximo authorizes one barcode read');
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  const firstAuto = ctx.etiqFila[1];
  assert.equal(vm.runInContext('etiqAtivo', ctx), firstAuto.lid, 'the read remains selected until confirmed');
  assert.notEqual(panel.style.display, 'none', 'the existing Próximo panel stays available after a read');
  assert.equal(firstAuto.complete, false, 'a queued read remains pending until the server confirms the product and size');
  assert.equal(autoRequests, 1, 'the first read begins server verification without awaiting its response');

  // Another code in view is ignored until the user explicitly clicks Próximo.
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  assert.equal(ctx.etiqFila.length, 2, 'a second visible barcode is ignored without another click');
  assert.equal(autoRequests, 1);
  firstAuto.bipeId = 'bipe1'; firstAuto.st = 'vinculado';
  ctx.window.proximaEtiqueta();
  assert.equal(vm.runInContext('etiqLeituraArmada', ctx), true, 'the next click authorizes the next physical piece');
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  const secondAuto = ctx.etiqFila[2];
  assert(secondAuto, 'a second piece is accepted after the second explicit click');
  assert.notEqual(firstAuto.clientScanId, secondAuto.clientScanId, 'each physical piece has its own idempotent scan ID');
  assert.equal(autoRequests, 2);
  assert.equal(vm.runInContext('etiqLeituraArmada', ctx), false, 'each click is consumed by one barcode read');
  assert.equal(ctx.etiqFila.filter(item => item.ean === cap.barcode).length, 2);
  console.log('PASS: Próximo explicitly authorizes one chosen barcode; further reads stay blocked until another click');
})().catch(error => { console.error(error); process.exitCode = 1; });
