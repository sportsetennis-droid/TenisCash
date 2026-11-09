'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/bipar.html'), 'utf8');
const replacement = fs.readFileSync(path.join(__dirname, '../src/services/stockReplacement.js'), 'utf8');
const diagnostics = require('../src/services/stockReplacementDiagnostics');
const reasonContext = {};
vm.runInNewContext(replacement.slice(replacement.indexOf('function reasonText('), replacement.indexOf('function fail(')), reasonContext);
const { reasonText } = reasonContext;
const renderer = html.slice(html.indexOf('  function renderEtiqCaptureState()'), html.indexOf('  window.capturaAutomatica ='));
function render(patch = {}, { durable = true, storageFailed = false, active = true } = {}) {
  const nodes = new Map();
  function node(id) {
    if (id === 'etiq-photo-preview') return null;
    if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '', setAttribute() {},
      set innerHTML(_) { throw Error('Diagnostic messages must use textContent'); } });
    return nodes.get(id);
  }
  const item = { lid: 'scan', ean: '5901234123457', photoRef: 'local', photoRevision: 1, st: 'pendente', complete: false, ...patch };
  const context = { etiqFila: [item], etiqAtivo: active ? item.lid : null, etiqStorageFailed: storageFailed, etiqStorageReady: true,
    etiqPhotoDurable: () => durable, document: { getElementById: node }, navigator: { onLine: true },
    window: { BiparActions: { isInventory: () => true } }, etiqBeep() {}, clearInterval() {},
    etiqWatch: null, etiqAuto: null, etiqPausado: true, etiqLeituraArmada: false };
  vm.runInNewContext(renderer + '\nrenderEtiqCaptureState();', context);
  return { item, panel: node('etiq-confirm'), title: node('etiq-confirm-status').textContent,
    detail: node('etiq-confirm-det').textContent, hint: node('etiq-hint').textContent, next: node('etiq-confirm-btn') };
}
const review = render({ st: 'revisao', msg: 'Rodada encerrada. Foto preservada para revisão.' });
assert.match(review.title, /REVISÃO/);
assert.match(review.detail, /Rodada encerrada/);
assert.doesNotMatch(review.detail, /aguardando confirmação de envio|serão conferidos em segundo plano/);
assert.match(review.next.textContent, /REVISÃO/);
assert.equal(review.next.disabled, true, 'review retains the existing Next block');

const mismatchText = 'O código confirmado na foto é diferente do código lido. Confira a mesma peça.';
const mismatch = render({ capId: 'cap', capIdPhotoRevision: 1, msg: mismatchText });
assert.ok(mismatch.detail.includes(mismatchText));
assert.equal(mismatch.next.disabled, false, 'saved pending scan retains manual Next');
assert.doesNotMatch(mismatch.title, /LEITURA COMPLETA/);
const unsafe = '<img src=x onerror=alert(1)>';
assert.ok(render({ st: 'revisao', msg: unsafe }).detail.includes(unsafe), 'untrusted reason remains literal text');
assert.equal(render({}, { durable: false }).next.disabled, true, 'unsaved original blocks Next');
assert.equal(render({}, { storageFailed: true }).next.disabled, true, 'failed storage blocks Next');
assert.equal(render({ ean: '' }).next.hidden, true, 'missing barcode never gains a Next action');
const decoding = render({ st: 'revisao', ean: '', manualDecodePending: true });
assert.match(decoding.detail, /Lendo o código na própria foto/);
assert.doesNotMatch(decoding.title, /REVISÃO/);
assert.equal(decoding.next.disabled, true);
assert.equal(decoding.next.hidden, true);
assert.equal(render({}, { active: false }).panel.style.display, 'none', 'late results do not reopen a finished piece');
const complete = render({ complete: true, msg: mismatchText, product: { name: 'Produto confirmado', size: '41' } });
assert.match(complete.title, /LEITURA COMPLETA/);
assert.doesNotMatch(complete.detail, /diferente/);
assert.equal(complete.next.disabled, false);
const cancelled = render({ excluded: true, repeatCancelPending: false });
assert.match(cancelled.title, /NÃO CONTADA/);
assert.equal(cancelled.next.disabled, false);

const transient = ['ocr_busy', 'ocr_timeout', 'ocr_unavailable', 'ocr_memory_limit',
  'photo_decode_busy', 'photo_decode_timeout', 'photo_decode_unavailable', 'photo_decode_memory_limit'];
const specific = [...transient, 'photo_input_invalid', 'operator_not_authorized', 'repeat_confirmation_required', 'photo_decode_failed'];
for (const reason of specific) assert.notEqual(reasonText(reason), reasonText('unknown'), reason + ' has a specific message');
assert.match(reasonText('operator_not_authorized'), /operador.*autorização/i);
assert.match(reasonText('repeat_confirmation_required'), /outro par físico/);
assert.match(reasonText('ocr_memory_limit'), /memória/);
function diagnose(reason, state, patches = {}) {
  return diagnostics.build({ bipes: [{ id: 'b', bipedAt: '2026-11-09T18:00:00Z', ...(patches.bipe || {}) }],
    captures: [{ id: 'c', bipeId: 'b' }], checks: [{ bipeId: 'b', reason, reasonText: reasonText(reason), ...(patches.check || {}) }] },
    { available: true, items: [{ jobId: 'j', bipeId: 'b', captureId: 'c', state, attempts: 2 }] });
}
for (const reason of transient) {
  const pending = diagnose(reason, 'retry');
  assert.equal(pending.rows[0].state, 'processing', reason + ' retry is processing');
  assert.equal(pending.totalRecords, 1);
  assert.equal(pending.counts.processing, 1);
  assert.equal(diagnose(reason, 'failed').rows[0].state, 'review', 'failed retry is not claimed active');
}
assert.equal(diagnose('operator_not_authorized', 'retry').rows[0].state, 'review');
assert.equal(diagnose('repeat_confirmation_required', 'retry').rows[0].state, 'review');
assert.equal(diagnose('ocr_memory_limit', 'retry', { bipe: { applied: true }, check: { appliedAt: '2026-11-09T18:01:00Z' } }).rows[0].state, 'applied');
assert.equal(diagnose('ocr_memory_limit', 'retry', { bipe: { excludedAt: '2026-11-09T18:01:00Z' } }).rows[0].state, 'excluded');
console.log('PASS: specific diagnostic causes; safe active-panel review messages; unchanged manual Next gates; eight transient retries classified without changing applied/excluded/counts.');
