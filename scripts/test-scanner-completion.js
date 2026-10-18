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
const section = html.slice(html.indexOf('  let etiqPausado = false'), html.indexOf('  async function enviarFila()'));
let timer, clock = 10000, beeps = 0, ids = 0;
const elements = { loja: { value: 'store' }, vendedor: { value: 'seller' }, 'etiq-video': { videoWidth: 100, videoHeight: 200 } };
function element() { return { style: {}, disabled: true, setAttribute() {}, insertBefore(node) { elements[node.id] = node; }, play: () => Promise.resolve() }; }
const doc = { getElementById: id => elements[id] || (elements[id] = element()), createElement: () => ({ ...element(), getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,' + clock }) };
function save(frame) { if (frame) save.baseline.set('id:' + frame.clientScanId, JSON.parse(JSON.stringify(frame))); return Promise.resolve(true); }
save.baseline = new Map();
const ctx = {
  window: { ScannerRound: { requireRound: () => 'round' } }, document: doc, etiqFila: [], etiqCameraContext: null,
  etiqAutoFrames: new Map(), etiqStorageReady: true, etiqStorageFailed: false, etiqBusy: false,
  etiqAuto: { reset() {}, stop() {} }, etiqUltimo: '', etiqUltimoTs: 0,
  localStorage: { getItem: () => 'seller' }, STORAGE_VENDNAME: 's', genClientScanId: () => 'client' + (++ids),
  renderEtiqLista() {}, etiqSave: save, etiqIdentity: item => 'id:' + item.clientScanId,
  enviarFila() { return Promise.resolve(); }, etiqBeep() { beeps++; }, alert() {},
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

  ctx.etiqFila[0].complete = true;
  ctx.etiqFila[0].product = { name: 'Produto confirmado', size: '40' };
  timer();
  assert.equal(doc.getElementById('etiq-confirm').style.display, 'flex');
  assert.equal(doc.getElementById('etiq-confirm').style.inset, '0', 'next-piece panel covers and centers over the camera');
  assert.equal(doc.getElementById('etiq-confirm-btn').textContent, 'PRÓXIMA PEÇA ➡');
  assert.equal(ctx.etiqFila[0].complete, true);
  ctx.window.proximaEtiqueta();
  clock += 6000;
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  assert.equal(ctx.etiqFila.length, 2, 'the operator advances to a new identical physical piece with the center button');

  const autoItem = ctx.etiqFila[1];
  autoItem.complete = true;
  autoItem.product = { name: 'Produto confirmado', size: '40' };
  timer();
  assert.equal(vm.runInContext("etiqAtivo", ctx), autoItem.lid, 'automatic recognition waits for the operator instead of advancing itself');
  assert.equal(autoItem.autoContinued, undefined);
  assert.equal(doc.getElementById('etiq-confirm-btn').textContent, 'PRÓXIMA PEÇA ➡');
  ctx.window.proximaEtiqueta();
  clock += 6000;
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  assert.equal(ctx.etiqFila.length, 3);

  const pending = ctx.etiqFila[2];
  pending.bipeId = 'background-bipe'; pending.st = 'pendente';
  timer();
  assert.equal(doc.getElementById('etiq-confirm-btn').disabled, false);
  assert.equal(doc.getElementById('etiq-confirm-btn').textContent, 'PRÓXIMO — PENDENTE EM SEGUNDO PLANO');
  ctx.window.proximaEtiqueta();
  clock += 6000;
  ctx.window.capturaAutomatica({ ean: cap.barcode });
  await Promise.resolve();
  assert.equal(ctx.etiqFila.length, 4);
  assert.equal(pending.complete, false, 'advancing does not mark a pending piece complete');
  console.log('PASS: scan result pauses for a centered manual next tap; repeated barcodes count as distinct pieces; pending captures remain incomplete');
})().catch(error => { console.error(error); process.exitCode = 1; });
